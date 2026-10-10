// Logbook node-host command: screen capture for headless node hosts (macOS).
// Nodes without the OpenClaw app (plain `openclaw node host run`) advertise
// logbook.snapshot so capture works anywhere the plugin is enabled.
import { randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { coerceErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import { runExec } from "openclaw/plugin-sdk/process-runtime";
import { asFiniteNumber, asRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { resolvePreferredOpenClawTmpDir } from "openclaw/plugin-sdk/temp-path";

type LogbookSnapshotPayload = { format: "jpeg"; base64: string } | { error: string };

const LOGBOOK_SNAPSHOT_EXEC_TIMEOUT_MS = 25_000;

export async function handleLogbookSnapshot(rawParams: unknown): Promise<LogbookSnapshotPayload> {
  if (process.platform !== "darwin") {
    return { error: `logbook.snapshot is not supported on ${process.platform}` };
  }
  const params = asRecord(rawParams);
  const screenIndex = Math.max(0, Math.round(asFiniteNumber(params.screenIndex) ?? 0));
  const width = asFiniteNumber(params.maxWidth);
  const maxWidth = width && width >= 480 ? Math.round(width) : 1440;
  const quality = asFiniteNumber(params.quality);
  const qualityPct = Math.min(
    100,
    Math.max(10, Math.round((quality && quality > 0 && quality <= 1 ? quality : 0.6) * 100)),
  );
  // The shared helper rejects unsafe temp roots; the private subdirectory
  // keeps captures out of the broader OpenClaw temp namespace.
  const captureDir = path.join(resolvePreferredOpenClawTmpDir(), "logbook");
  await mkdir(captureDir, { recursive: true, mode: 0o700 });
  await chmod(captureDir, 0o700);
  const filePath = path.join(captureDir, `logbook-snapshot-${randomUUID()}.jpg`);
  try {
    // Pre-create owner-only: screencapture truncates the existing inode, so
    // the capture never becomes world-readable even if the dir mode drifts.
    await writeFile(filePath, "", { mode: 0o600 });
    // node.invoke stops waiting after 30 seconds but cannot reap node-host children.
    // Share an earlier deadline so both commands terminate before that outer boundary.
    const execSignal = AbortSignal.timeout(LOGBOOK_SNAPSHOT_EXEC_TIMEOUT_MS);
    // -x: no capture sound; -C: include cursor; -D is 1-based display index.
    await runExec(
      "screencapture",
      ["-x", "-C", "-D", String(screenIndex + 1), "-t", "jpg", filePath],
      { logOutput: false, signal: execSignal },
    );
    await runExec(
      "sips",
      [
        "--resampleHeightWidthMax",
        String(maxWidth),
        "-s",
        "format",
        "jpeg",
        "-s",
        "formatOptions",
        String(qualityPct),
        filePath,
      ],
      { logOutput: false, signal: execSignal },
    );
    const buffer = await readFile(filePath);
    return { format: "jpeg", base64: buffer.toString("base64") };
  } catch (err) {
    return { error: coerceErrorMessage(err) };
  } finally {
    await rm(filePath, { force: true });
  }
}
