import crypto from "node:crypto";
import { getMSTeamsRuntime } from "./runtime.js";

const LEARNINGS_NAMESPACE = "feedback-learnings";
const MAX_LEARNING_ENTRIES = 10_000;

type FeedbackLearningEntry = {
  sessionKey: string;
  learnings: string[];
  updatedAt: number;
};

function learningStoreKey(storePath: string, sessionKey: string): string {
  return crypto.createHash("sha256").update(`${storePath}\0${sessionKey}`, "utf8").digest("hex");
}

function appendFeedbackLearning(
  current: FeedbackLearningEntry | undefined,
  prepared: { sessionKey: string; learning: string; updatedAt: number },
): FeedbackLearningEntry {
  return {
    sessionKey: prepared.sessionKey,
    learnings: [...(current?.learnings ?? []), prepared.learning].slice(-10),
    updatedAt: prepared.updatedAt,
  };
}

export async function storeSessionLearning(params: {
  storePath: string;
  sessionKey: string;
  learning: string;
}): Promise<void> {
  const store = getMSTeamsRuntime().state.openKeyedStore<FeedbackLearningEntry>({
    namespace: LEARNINGS_NAMESPACE,
    maxEntries: MAX_LEARNING_ENTRIES,
  });
  const key = learningStoreKey(params.storePath, params.sessionKey);
  if (!store.observe || !store.compareAndApply) {
    throw new Error("plugin state atomic comparison is unavailable");
  }
  const prepared = {
    sessionKey: params.sessionKey,
    learning: params.learning,
    updatedAt: Date.now(),
  };
  let observed = await store.observe(key);
  while (true) {
    const result = await store.compareAndApply(key, observed.comparison, {
      operation: "update",
      action: "set",
      value: appendFeedbackLearning(observed.value, prepared),
    });
    if (result.status !== "conflict") {
      return;
    }
    observed = result.current;
  }
}
