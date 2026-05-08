import fs from "node:fs";
import path from "node:path";
import { isTruthyEnvValue } from "../infra/env.js";
import { appendRegularFile } from "../infra/fs-safe.js";
import { getStateDiagnosticWriter, type StateDiagnosticWriter } from "./state-diagnostic-writer.js";

let rawStreamReady = false;
const rawStreamStateWriters = new Map<string, StateDiagnosticWriter>();
const RAW_STREAM_SQLITE_LABEL = "sqlite://state/diagnostics/raw-stream";
const RAW_STREAM_SQLITE_SCOPE = "diagnostics.raw_stream";

function isRawStreamEnabled(): boolean {
  return isTruthyEnvValue(process.env.OPENCLAW_RAW_STREAM);
}

function resolveRawStreamPath(): string {
  return process.env.OPENCLAW_RAW_STREAM_PATH?.trim() || RAW_STREAM_SQLITE_LABEL;
}

export function appendRawStream(payload: Record<string, unknown>) {
  if (!isRawStreamEnabled()) {
    return;
  }
  const rawStreamPath = resolveRawStreamPath();
  if (rawStreamPath === RAW_STREAM_SQLITE_LABEL) {
    getStateDiagnosticWriter(rawStreamStateWriters, {
      label: rawStreamPath,
      scope: RAW_STREAM_SQLITE_SCOPE,
    }).write(`${JSON.stringify(payload)}\n`);
    return;
  }
  if (!rawStreamReady) {
    rawStreamReady = true;
    try {
      fs.mkdirSync(path.dirname(rawStreamPath), { recursive: true });
    } catch {
      // ignore raw stream mkdir failures
    }
  }
  try {
    void appendRegularFile({
      filePath: rawStreamPath,
      content: `${JSON.stringify(payload)}\n`,
      rejectSymlinkParents: true,
    });
  } catch {
    // ignore raw stream write failures
  }
}
