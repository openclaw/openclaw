import fs from "node:fs";
import path from "node:path";
import { resolveStateDir } from "../config/paths.js";
import { isTruthyEnvValue } from "../infra/env.js";

let rawStreamReady = false;

function isRawStreamEnabled(): boolean {
  return isTruthyEnvValue(process.env.OPENCLAW_RAW_STREAM);
}

function resolveRawStreamPath(): string {
  return (
    process.env.OPENCLAW_RAW_STREAM_PATH?.trim() ||
    path.join(resolveStateDir(), "logs", "raw-stream.jsonl")
  );
}

export function appendRawStream(payload: Record<string, unknown>) {
  if (!isRawStreamEnabled()) {
    return;
  }
  const rawStreamPath = resolveRawStreamPath();
  if (!rawStreamReady) {
    rawStreamReady = true;
    try {
      fs.mkdirSync(path.dirname(rawStreamPath), { recursive: true });
    } catch {
      // ignore raw stream mkdir failures
    }
  }
  try {
    void fs.promises.appendFile(rawStreamPath, `${JSON.stringify(payload)}\n`);
  } catch {
    // ignore raw stream write failures
  }
}
