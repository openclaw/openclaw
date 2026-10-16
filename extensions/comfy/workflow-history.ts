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
      ? messages.findLast(
          (message): message is unknown[] =>
            Array.isArray(message) && message[0] === "execution_error",
        )
      : undefined;
    const errorDetails = executionError?.[1];
    const detail = isRecord(errorDetails)
      ? normalizeOptionalString(errorDetails.exception_message)
      : undefined;
    throw new Error(
      `Comfy workflow failed${detail ? `: ${redactProviderResponseErrorText(detail, headers)}` : ""}`,
    );
  }
  return (
    entry.status?.completed === true || Boolean(entry.outputs && Object.keys(entry.outputs).length)
  );
}
