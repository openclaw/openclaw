import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import {
  readTelegramPrivateProductionDescriptor,
  requestTelegramPrivateAppTurn,
  resolveTelegramPrivateProductionBot,
} from "./private-production.runtime.js";

const { fetchWithSsrFGuardMock, requestToken } = vi.hoisted(() => ({
  fetchWithSsrFGuardMock: vi.fn(),
  requestToken: "11111111-2222-4333-8444-555555555555",
}));
vi.mock("node:crypto", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:crypto")>()),
  randomUUID: () => requestToken,
}));
vi.mock("openclaw/plugin-sdk/ssrf-runtime", () => ({
  fetchWithSsrFGuard: fetchWithSsrFGuardMock,
}));

const roots: string[] = [];
const requestName = `${requestToken}.request.json`;
const sendSignal = `TELEGRAM_PRIVATE_APP_SEND_REQUIRED ${requestToken}\n`;
const writeJson = (file: string, value: unknown) =>
  fs.writeFileSync(file, JSON.stringify(value), { mode: 0o600 });

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "telegram-private-apps-test-"));
  roots.push(root);
  const file = path.join(root, "descriptor.json");
  writeJson(file, {
    mode: "private-production-local-apps",
    forumGroupId: "-100456",
    forumTopicId: 42,
    topicTitle: "Private proof",
    participants: [
      { alias: "primary", host: "mainframe", userId: "100" },
      { alias: "second", host: "macbook", userId: "101" },
    ],
  });
  const descriptor = readTelegramPrivateProductionDescriptor(file)!;
  const proofRoot = `${file}.app-proof`;
  const send = (destination: "bot-dm" | "forum-topic", text: string) =>
    requestTelegramPrivateAppTurn({
      descriptor,
      destination,
      text,
      participant: descriptor.participants[destination === "bot-dm" ? 0 : 1]!,
    });
  return { proofRoot, requestPath: path.join(proofRoot, requestName), send };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  fetchWithSsrFGuardMock.mockReset();
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { force: true, recursive: true });
  }
});

it("resolves the bot through the guarded network boundary and releases it", async () => {
  const release = vi.fn();
  fetchWithSsrFGuardMock.mockResolvedValue({
    response: Response.json({ ok: true, result: { id: 700000001, username: "qa_bot" } }),
    release,
  });

  await expect(
    resolveTelegramPrivateProductionBot({ TELEGRAM_BOT_TOKEN: "test-token" }),
  ).resolves.toEqual({
    id: "700000001",
    token: "test-token",
    username: "qa_bot",
  });
  expect(fetchWithSsrFGuardMock).toHaveBeenCalledWith({
    url: "https://api.telegram.org/bottest-token/getMe",
    init: { method: "POST" },
    timeoutMs: 30_000,
    maxRedirects: 0,
    auditContext: "qa-lab-telegram-private-production-bot-api",
  });
  expect(release).toHaveBeenCalledOnce();
});

it("publishes complete private handoffs before accepting native UI acknowledgements", async () => {
  const { proofRoot, requestPath, send } = fixture();
  const text = "@qa_bot Reply exactly: marker";
  const creations: { emptyRegularFile: boolean; visibleRequests: string[] }[] = [];
  const observationErrors: unknown[] = [];
  let request: unknown;
  let requestMode: number | undefined;
  let signals = 0;

  vi.stubEnv("FS_SAFE_NATIVE_MODE", "off");
  const realOpen = fsp.open.bind(fsp);
  vi.spyOn(fsp, "open").mockImplementation(async (file, flags, mode) => {
    const handle = await realOpen(file, flags, mode);
    const exclusiveWrite =
      typeof flags === "string"
        ? flags === "wx" || flags === "wx+"
        : typeof flags === "number" &&
          (flags & fs.constants.O_CREAT) !== 0 &&
          (flags & fs.constants.O_EXCL) !== 0 &&
          (flags & (fs.constants.O_WRONLY | fs.constants.O_RDWR)) !== 0;
    if (typeof file === "string" && exclusiveWrite) {
      try {
        if (fs.realpathSync(path.dirname(file)) !== fs.realpathSync(proofRoot)) {
          return handle;
        }
        const stat = await handle.stat();
        creations.push({
          emptyRegularFile: stat.isFile() && stat.size === 0,
          visibleRequests: fs
            .readdirSync(proofRoot)
            .filter((name) => name.endsWith(".request.json")),
        });
      } catch (error) {
        observationErrors.push(error);
      }
    }
    return handle;
  });

  // Expose Node's direct writeFile open/write boundary to the same real-FS observer.
  const realWriteFile = fsp.writeFile.bind(fsp);
  vi.spyOn(fsp, "writeFile").mockImplementation(async (file, data, options) => {
    if (file !== requestPath || typeof file !== "string") {
      return realWriteFile(file, data, options);
    }
    const settings = typeof options === "object" && options !== null ? options : undefined;
    const handle = await fsp.open(file, settings?.flag ?? "w", settings?.mode);
    try {
      await handle.writeFile(data, options);
    } finally {
      await handle.close();
    }
  });

  const realStdoutWrite = process.stdout.write.bind(process.stdout);
  vi.spyOn(process.stdout, "write").mockImplementation((...args) => {
    const [chunk] = args;
    if (chunk !== sendSignal) {
      return realStdoutWrite(...args);
    }
    signals += 1;
    try {
      request = JSON.parse(fs.readFileSync(requestPath, "utf8"));
      requestMode = fs.statSync(requestPath).mode & 0o777;
    } catch (error) {
      observationErrors.push(error);
    }
    // Settle the real producer even if the captured handoff is invalid; assert after cleanup.
    writeJson(path.join(proofRoot, `${requestToken}.ack.json`), {
      schemaVersion: 1,
      token: requestToken,
      sentText: text,
      replyText: "marker",
      replyObservedIn: "forum-topic",
      replyToRequestedMessage: true,
    });
    return true;
  });

  await expect(send("forum-topic", text)).resolves.toEqual({ replyText: "marker" });

  expect(observationErrors).toEqual([]);
  expect(creations.length).toBeGreaterThan(0);
  for (const creation of creations) {
    expect(creation).toEqual({ emptyRegularFile: true, visibleRequests: [] });
  }
  expect(signals).toBe(1);
  expect(request).toEqual({
    schemaVersion: 1,
    token: requestToken,
    participant: { alias: "second", host: "macbook" },
    destination: "forum-topic",
    topicTitle: "Private proof",
    text,
  });
  if (process.platform !== "win32") {
    expect(requestMode).toBe(0o600);
    expect(fs.statSync(proofRoot).mode & 0o777).toBe(0o700);
  }
  expect(fs.readdirSync(proofRoot)).toEqual([]);
});

it("preserves an existing handoff and does not announce a failed publication", async () => {
  const { proofRoot, requestPath, send } = fixture();
  fs.mkdirSync(proofRoot, { mode: 0o700 });
  const existing = "existing request bytes\n";
  fs.writeFileSync(requestPath, existing, { mode: 0o600 });
  const stdout = vi.spyOn(process.stdout, "write");

  await expect(send("bot-dm", "new request")).rejects.toThrow();

  expect(fs.readFileSync(requestPath, "utf8")).toBe(existing);
  expect(fs.readdirSync(proofRoot)).toEqual([requestName]);
  expect(stdout).not.toHaveBeenCalledWith(sendSignal);
});
