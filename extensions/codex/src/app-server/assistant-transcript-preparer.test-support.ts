import type { EmbeddedRunAttemptParamsV2 } from "openclaw/plugin-sdk/agent-harness-runtime";
import { vi } from "vitest";

type Preparer = NonNullable<EmbeddedRunAttemptParamsV2["prepareAssistantTranscriptMessage"]>;
export type AssistantTranscriptMessage = Parameters<Preparer>[0];

/** Observe calls without erasing the historical-or-live input subtype. */
export function createObservedTranscriptPreparer(mediaUrls?: string[]) {
  const prepareSpy = vi.fn();
  const prepareAssistantTranscriptMessage: Preparer = (message, sourceText) => {
    prepareSpy(message, sourceText);
    return mediaUrls ? { ...message, openclawDelivery: { mediaUrls } } : message;
  };
  return { prepareSpy, prepareAssistantTranscriptMessage };
}
