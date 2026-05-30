import type { PluginRuntime } from "openclaw/plugin-sdk/channel-core";
import type { AskFeedbackEvent, AskSession } from "./types.js";

type AskKeyedStore<T> = {
  register: (key: string, value: T, opts?: { ttlMs?: number }) => Promise<void>;
  lookup: (key: string) => Promise<T | undefined>;
  entries: () => Promise<Array<{ key: string; value: T; createdAt: number }>>;
};

export const ASK_SESSION_TTL_MS = 30 * 60 * 1000;
export const ASK_FEEDBACK_TTL_MS = 14 * 24 * 60 * 60 * 1000;

export type AskStores = {
  sessions: AskKeyedStore<AskSession>;
  feedback: AskKeyedStore<AskFeedbackEvent>;
};

export function openAskStores(runtime: PluginRuntime): AskStores {
  return {
    sessions: runtime.state.openKeyedStore<AskSession>({
      namespace: "ask.sessions",
      maxEntries: 1000,
      defaultTtlMs: ASK_SESSION_TTL_MS,
    }),
    feedback: runtime.state.openKeyedStore<AskFeedbackEvent>({
      namespace: "ask.feedback",
      maxEntries: 2000,
      defaultTtlMs: ASK_FEEDBACK_TTL_MS,
    }),
  };
}

export async function recordAskFeedback(
  stores: Pick<AskStores, "feedback">,
  event: AskFeedbackEvent,
): Promise<void> {
  await stores.feedback.register(event.eventId, event, { ttlMs: ASK_FEEDBACK_TTL_MS });
}
