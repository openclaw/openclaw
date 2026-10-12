import type { AgentMessage } from "./runtime/index.js";

/** Defers failed-attempt display without changing the append-only transcript. */
export function createAssistantErrorTranscript() {
  const streamOutputs = new WeakMap<AgentMessage, (visible: boolean) => void>();
  let pending:
    | {
        source: AgentMessage;
        replaceStream?: (visible: boolean) => void;
      }
    | undefined;
  const clear = () => {
    const failure = pending;
    pending = undefined;
    failure?.replaceStream?.(false);
  };
  return {
    clear,
    bindStream(source: AgentMessage, replaceStream: (visible: boolean) => void): void {
      if (pending?.source === source) {
        pending.replaceStream = replaceStream;
      } else {
        streamOutputs.set(source, replaceStream);
      }
    },
    snapshot(): typeof pending {
      return pending;
    },
    restore(snapshot: typeof pending): void {
      clear();
      pending = snapshot;
      pending?.replaceStream?.(true);
    },
    record(source: AgentMessage): void {
      pending = { source, replaceStream: streamOutputs.get(source) };
      streamOutputs.delete(source);
    },
    settle(failed: boolean): void {
      if (!failed) {
        clear();
      } else {
        pending = undefined;
      }
    },
  };
}

export type AssistantErrorTranscript = ReturnType<typeof createAssistantErrorTranscript>;
