import type { SessionMetadataChange } from "../../config/sessions/transcript-write-context-store.js";
import { CURRENT_SESSION_VERSION } from "../../config/sessions/version.js";
import type { SessionInitialMetadataFacts } from "./session-initial-metadata.types.js";
import type { SessionHeader } from "./session-manager-types.js";

/** Shared SDK initialization policy; bounded callers supply owner-prepared history facts. */
export function prepareSessionInitialMetadata(
  facts: SessionInitialMetadataFacts,
  model: { provider: string; modelId: string; thinkingLevel: string },
):
  | {
      change: Extract<SessionMetadataChange, { type: "thinking_level_change" }>;
      initialModelChange?: Extract<SessionMetadataChange, { type: "model_change" }>;
    }
  | undefined {
  if (facts.hasExistingSession && facts.hasThinkingEntry) {
    return undefined;
  }
  return {
    change: { type: "thinking_level_change", thinkingLevel: model.thinkingLevel },
    ...(!facts.hasExistingSession
      ? {
          initialModelChange: {
            type: "model_change" as const,
            provider: model.provider,
            modelId: model.modelId,
          },
        }
      : {}),
  };
}

/** New native and SDK sessions share the same current-version header. */
export function createSessionHeader(
  id: string,
  cwd: string,
  parentSession?: string,
): SessionHeader {
  return {
    type: "session",
    version: CURRENT_SESSION_VERSION,
    id,
    timestamp: new Date().toISOString(),
    cwd,
    parentSession,
  };
}
