import { StringDecoder } from "node:string_decoder";

const FINALIZATION_PHASES = [
  "preflight",
  "targetConfigValidation",
  "configSnapshot",
  "doctor",
  "plugins",
  "targetConfigConvergence",
  "completionCache",
];
const PREFIX = "[update finalize] ";
const MAX_LINE_LENGTH = 8_192;

/** Only new finalizer phase boundaries renew repair's bounded inactivity deadline. */
export function createQaRepairProgressObserver(onProgress: () => void) {
  const decoder = new StringDecoder("utf8");
  let pending = "";
  let discarded = false;
  let lastBoundary = -1;
  return (chunk: Buffer | string) => {
    const text = typeof chunk === "string" ? chunk : decoder.write(chunk);
    for (const segment of text.split(/(?<=\n)/u)) {
      const complete = segment.endsWith("\n");
      if (!discarded) {
        pending += segment;
        if (pending.length > MAX_LINE_LENGTH) {
          pending = "";
          discarded = true;
        }
      }
      if (!complete) {
        continue;
      }
      const line = pending.trimEnd();
      pending = "";
      if (discarded) {
        discarded = false;
        continue;
      }
      if (!line.startsWith(PREFIX)) {
        continue;
      }
      let value: unknown;
      try {
        value = JSON.parse(line.slice(PREFIX.length));
      } catch {
        continue;
      }
      if (!value || typeof value !== "object" || !("step" in value) || !("status" in value)) {
        continue;
      }
      const step = value.step;
      const phase = FINALIZATION_PHASES.findIndex((name) => step === `finalize:${name}`);
      if (phase < 0 || (value.status !== "in_progress" && value.status !== "completed")) {
        continue;
      }
      const boundary = phase * 2 + (value.status === "completed" ? 1 : 0);
      // Repeated steps, warnings, partial lines and arbitrary output are not progress.
      if (boundary > lastBoundary) {
        lastBoundary = boundary;
        onProgress();
      }
    }
  };
}
