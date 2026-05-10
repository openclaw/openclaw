import crypto from "node:crypto";
import { writeOpenClawStateKvJson } from "../state/openclaw-state-kv.js";

export type StateDiagnosticWriter = {
  destination: string;
  write: (value: unknown) => unknown;
};

type StateDiagnosticWriterOptions = {
  env?: NodeJS.ProcessEnv;
  label: string;
  scope: string;
};

function serializeDiagnosticValue(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

export function getStateDiagnosticWriter(
  writers: Map<string, StateDiagnosticWriter>,
  options: StateDiagnosticWriterOptions,
): StateDiagnosticWriter {
  const key = `${options.scope}:${options.label}`;
  const existing = writers.get(key);
  if (existing) {
    return existing;
  }

  let seq = 0;
  const writer: StateDiagnosticWriter = {
    destination: options.label,
    write: (value: unknown) => {
      const digest = crypto
        .createHash("sha256")
        .update(serializeDiagnosticValue(value))
        .digest("hex")
        .slice(0, 16);
      const entryKey = `${Date.now().toString(36)}-${(seq += 1).toString(36)}-${digest}`;
      writeOpenClawStateKvJson(options.scope, entryKey, value, { env: options.env });
      return "queued";
    },
  };
  writers.set(key, writer);
  return writer;
}
