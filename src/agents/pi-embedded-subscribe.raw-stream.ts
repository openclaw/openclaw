import fs from "node:fs";
import path from "node:path";
import { resolveStateDir } from "../config/paths.js";
import { isTruthyEnvValue } from "../infra/env.js";

type RawStreamConfig = { enabled: boolean; path: string };

let _config: RawStreamConfig | undefined;

function getRawStreamConfig(): RawStreamConfig {
  if (!_config) {
    _config = {
      enabled: isTruthyEnvValue(process.env.OPENCLAW_RAW_STREAM),
      path:
        process.env.OPENCLAW_RAW_STREAM_PATH?.trim() ||
        path.join(resolveStateDir(), "logs", "raw-stream.jsonl"),
    };
  }
  return _config;
}

let rawStreamReady = false;

export function appendRawStream(payload: Record<string, unknown>) {
  const config = getRawStreamConfig();
  if (!config.enabled) {
    return;
  }
  if (!rawStreamReady) {
    rawStreamReady = true;
    try {
      fs.mkdirSync(path.dirname(config.path), { recursive: true });
    } catch {
      // ignore raw stream mkdir failures
    }
  }
  try {
    void fs.promises.appendFile(config.path, `${JSON.stringify(payload)}\n`);
  } catch {
    // ignore raw stream write failures
  }
}
