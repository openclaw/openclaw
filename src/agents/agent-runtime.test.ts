import { describe, expect, it } from "vitest";
import type { AgentRuntimeSession, AgentRuntimeHints } from "./agent-runtime.js";

describe("AgentRuntimeSession interface", () => {
  it("can be satisfied by a minimal mock object", () => {
    const hints: AgentRuntimeHints = {
      allowSyntheticToolResults: true,
      enforceFinalTag: true,
      managesOwnHistory: false,
      supportsStreamFnWrapping: true,
      sessionFile: "/tmp/test-session.jsonl",
    };
    const mock: AgentRuntimeSession = {
      subscribe: () => () => {},
      prompt: async () => {},
      steer: async () => {},
      abort: async () => {},
      abortCompaction: () => {},
      dispose: () => {},
      replaceMessages: () => {},
      isStreaming: false,
      isCompacting: false,
      messages: [],
      sessionId: "test-session",
      runtimeHints: hints,
    };
    expect(mock.runtimeHints.allowSyntheticToolResults).toBe(true);
    expect(mock.runtimeHints.enforceFinalTag).toBe(true);
    expect(mock.sessionId).toBe("test-session");
  });
});
