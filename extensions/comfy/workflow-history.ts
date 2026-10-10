import { redactProviderResponseErrorText } from "openclaw/plugin-sdk/provider-http";
import { isRecord, normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";

export type ComfyOutputKind = "audio" | "gifs" | "images" | "videos";
export type ComfyOutputFile = {
  filename?: string;
  name?: string;
  subfolder?: string;
  type?: string;
};
type ComfyHistoryOutputEntry = Partial<Record<ComfyOutputKind, ComfyOutputFile[]>>;
export type ComfyHistoryEntry = {
  outputs?: Record<string, ComfyHistoryOutputEntry>;
  status?: { completed?: boolean; status_str?: string; messages?: unknown[] };
};

export function isTerminalComfyHistory(entry: ComfyHistoryEntry, headers: Headers): boolean {
  if (entry.status?.status_str === "error") {
    const messages = entry.status.messages;
    const executionError = Array.isArray(messages)
      ? messages.findLast((message) => Array.isArray(message) && message[0] === "execution_error")
      : undefined;
    const detail =
      Array.isArray(executionError) && isRecord(executionError[1])
        ? normalizeOptionalString(executionError[1].exception_message)
        : undefined;
    throw new Error(
      `Comfy workflow failed${detail ? `: ${redactProviderResponseErrorText(detail, headers)}` : ""}`,
    );
  }
  return (
    entry.status?.completed === true || Boolean(entry.outputs && Object.keys(entry.outputs).length)
  );
}
