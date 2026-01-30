import fs from "node:fs";
import path from "node:path";

import { resolveStateDir } from "../config/paths.js";
import { isTruthyEnvValue } from "../infra/env.js";

const RAW_STREAM_ENABLED = isTruthyEnvValue(process.env.OPENCLAW_RAW_STREAM);
const RAW_STREAM_PATH =
  process.env.OPENCLAW_RAW_STREAM_PATH?.trim() ||
  path.join(resolveStateDir(), "logs", "raw-stream.jsonl");

let rawStreamReady = false;

export function appendRawStream(payload: Record<string, unknown>) {
  if (!RAW_STREAM_ENABLED) return;
  if (!rawStreamReady) {
    rawStreamReady = true;
    try {
      fs.mkdirSync(path.dirname(RAW_STREAM_PATH), { recursive: true });
    } catch {
      // ignore raw stream mkdir failures
    }
  }
  try {
    void fs.promises.appendFile(RAW_STREAM_PATH, `${JSON.stringify(payload)}\n`);
  } catch {
    // ignore raw stream write failures
  }
}
