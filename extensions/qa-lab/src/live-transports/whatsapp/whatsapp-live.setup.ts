import fs from "node:fs/promises";
import path from "node:path";
import { runExec } from "openclaw/plugin-sdk/process-runtime";
import { sleep } from "openclaw/plugin-sdk/runtime-env";
import { normalizeStringEntries } from "openclaw/plugin-sdk/string-coerce-runtime";
import type { QaGatewayChild } from "../../gateway-child.js";
import { waitForLiveQaChannelAccount } from "../shared/live-channel-status.js";

const WHATSAPP_QA_READY_TIMEOUT_MS = 150_000;
const WHATSAPP_QA_READY_STABILITY_MS = 20_000;
const WHATSAPP_QA_AUTH_ARCHIVE_TIMEOUT_MS = 60_000;
const WHATSAPP_QA_SIGNAL_SESSION_FILE_RE = /^session-[^/\\]+\.json$/u;

export async function waitForWhatsAppChannelStable(gateway: QaGatewayChild, accountId: string) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < WHATSAPP_QA_READY_TIMEOUT_MS) {
    const readyStatus = await waitForLiveQaChannelAccount({
      gateway,
      channel: "whatsapp",
      accountId,
      timeoutMs: WHATSAPP_QA_READY_TIMEOUT_MS,
      pollMs: 750,
      isReady: (status) =>
        status.running === true &&
        status.connected === true &&
        status.restartPending !== true &&
        status.busy !== true,
      describeTimeout: (status) => {
        const lastStatus = status && {
          busy: status.busy,
          connected: status.connected,
          lastConnectedAt: status.lastConnectedAt,
          lastDisconnect: status.lastDisconnect,
          lastError: status.lastError,
          lastRunActivityAt: status.lastRunActivityAt,
          restartPending: status.restartPending,
          running: status.running,
        };
        return (
          `whatsapp account "${accountId}" did not become ready` +
          (lastStatus ? `; last status: ${JSON.stringify(lastStatus)}` : "")
        );
      },
    });
    const connectedAt =
      typeof readyStatus.lastConnectedAt === "number" && readyStatus.lastConnectedAt > 0
        ? readyStatus.lastConnectedAt
        : Date.now();
    const connectedForMs = Date.now() - connectedAt;
    if (connectedForMs >= WHATSAPP_QA_READY_STABILITY_MS) {
      return;
    }
    await sleep(Math.max(750, WHATSAPP_QA_READY_STABILITY_MS - connectedForMs));
  }
  throw new Error(
    `whatsapp account "${accountId}" did not remain ready for ${WHATSAPP_QA_READY_STABILITY_MS}ms`,
  );
}

async function listTarEntries(archivePath: string): Promise<string[]> {
  const { stdout } = await runExec("tar", ["-tzf", archivePath], {
    logOutput: false,
    timeoutMs: WHATSAPP_QA_AUTH_ARCHIVE_TIMEOUT_MS,
  });
  return normalizeStringEntries(stdout.split("\n"));
}

function assertSafeArchiveEntries(entries: string[]) {
  if (entries.length === 0) {
    throw new Error("WhatsApp auth archive is empty.");
  }
  for (const entry of entries) {
    if (path.isAbsolute(entry) || entry.split(/[\\/]/u).includes("..")) {
      throw new Error(`WhatsApp auth archive contains unsafe entry "${entry}".`);
    }
  }
}

export async function unpackWhatsAppAuthArchive(params: {
  archiveBase64: string;
  clearSignalSessions?: boolean;
  label: string;
  parentDir: string;
}): Promise<string> {
  const authDir = path.join(params.parentDir, params.label);
  await fs.mkdir(authDir, { recursive: true, mode: 0o700 });
  const archivePath = path.join(params.parentDir, `${params.label}.tgz`);
  await fs.writeFile(archivePath, Buffer.from(params.archiveBase64, "base64"), { mode: 0o600 });
  const entries = await listTarEntries(archivePath);
  assertSafeArchiveEntries(entries);
  await runExec("tar", ["-xzf", archivePath, "-C", authDir], {
    logOutput: false,
    timeoutMs: WHATSAPP_QA_AUTH_ARCHIVE_TIMEOUT_MS,
  });
  await fs.rm(archivePath, { force: true });
  if (params.clearSignalSessions === true) {
    await clearWhatsAppAuthSignalSessions(authDir);
  }
  return authDir;
}

async function clearWhatsAppAuthSignalSessions(authDir: string): Promise<void> {
  const entries = await fs.readdir(authDir, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isFile() || !WHATSAPP_QA_SIGNAL_SESSION_FILE_RE.test(entry.name)) {
      continue;
    }
    await fs.rm(path.join(authDir, entry.name), { force: true });
  }
}
