import fs from "node:fs/promises";
import path from "node:path";
import { resolveStateDir } from "../config/paths.js";
import { isTruthyEnvValue } from "../infra/env.js";
import { appendRegularFile } from "../infra/fs-safe.js";
import { isIncognitoSessionKey } from "../shared/incognito-session-key.js";

export function appendRawStream(
  createPayload: () => Record<string, unknown>,
  sessionKey: string | undefined,
) {
  if (!isTruthyEnvValue(process.env.OPENCLAW_RAW_STREAM) || isIncognitoSessionKey(sessionKey)) {
    return;
  }
  const rawStreamPath =
    process.env.OPENCLAW_RAW_STREAM_PATH?.trim() ||
    path.join(resolveStateDir(), "logs", "raw-stream.jsonl");
  try {
    // Evaluate and serialize before the async append while the message snapshot is current.
    const content = `${JSON.stringify(createPayload())}\n`;
    void fs
      .mkdir(path.dirname(rawStreamPath), { recursive: true })
      .then(() =>
        appendRegularFile({ filePath: rawStreamPath, content, rejectSymlinkParents: true }),
      )
      .catch(() => {
        // Raw diagnostics are best-effort; filesystem failures must not terminate agent runs.
      });
  } catch {
    // JSON serialization can fail synchronously, for example with cyclic payloads.
  }
}
