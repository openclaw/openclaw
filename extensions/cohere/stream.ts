import type { StreamFn } from "openclaw/plugin-sdk/agent-core";
import { createPayloadPatchStreamWrapper } from "openclaw/plugin-sdk/provider-stream-shared";

function patchCoherePayload(payload: Record<string, unknown>): void {
  if (Array.isArray(payload.messages)) {
    payload.messages = payload.messages.map((message) =>
      message &&
      typeof message === "object" &&
      (message as Record<string, unknown>).role === "system"
        ? { ...(message as Record<string, unknown>), role: "developer" }
        : message,
    );
  }

  delete payload.tool_choice;
}

export function createCohereCompletionsWrapper(baseStreamFn: StreamFn | undefined): StreamFn {
  return createPayloadPatchStreamWrapper(baseStreamFn, ({ payload }) =>
    patchCoherePayload(payload),
  );
}
