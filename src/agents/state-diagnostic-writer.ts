import crypto from "node:crypto";
import { writeOpenClawStateKvJson } from "../state/openclaw-state-kv.js";

export type StateDiagnosticWriter = {
  destination: string;
  write: (line: string) => unknown;
  flush: () => Promise<void>;
};

type StateDiagnosticWriterOptions = {
  env?: NodeJS.ProcessEnv;
  label: string;
  scope: string;
};

function parseLineValue(line: string): unknown {
  const trimmed = line.trim();
  if (!trimmed) {
    return { line: "" };
  }
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return { line };
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
    write: (line: string) => {
      const value = parseLineValue(line);
      const digest = crypto.createHash("sha256").update(line).digest("hex").slice(0, 16);
      const entryKey = `${Date.now().toString(36)}-${(seq += 1).toString(36)}-${digest}`;
      writeOpenClawStateKvJson(options.scope, entryKey, value, { env: options.env });
      return "queued";
    },
    flush: async () => undefined,
  };
  writers.set(key, writer);
  return writer;
}
