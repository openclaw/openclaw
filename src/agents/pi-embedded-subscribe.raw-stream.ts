import { isTruthyEnvValue } from "../infra/env.js";
import { getStateDiagnosticWriter, type StateDiagnosticWriter } from "./state-diagnostic-writer.js";

const rawStreamStateWriters = new Map<string, StateDiagnosticWriter>();
const RAW_STREAM_SQLITE_LABEL = "sqlite://state/diagnostics/raw-stream";
const RAW_STREAM_SQLITE_SCOPE = "diagnostics.raw_stream";

function isRawStreamEnabled(): boolean {
  return isTruthyEnvValue(process.env.OPENCLAW_RAW_STREAM);
}

export function appendRawStream(payload: Record<string, unknown>) {
  if (!isRawStreamEnabled()) {
    return;
  }
  getStateDiagnosticWriter(rawStreamStateWriters, {
    label: RAW_STREAM_SQLITE_LABEL,
    scope: RAW_STREAM_SQLITE_SCOPE,
  }).write(`${JSON.stringify(payload)}\n`);
}
