import { afterEach, describe, expect, it } from "vitest";
import {
  ABANDONED_EMBEDDED_RUNS_BY_SESSION_ID,
  ABANDONED_EMBEDDED_RUN_SESSION_IDS_BY_FILE,
  ABANDONED_EMBEDDED_RUN_SESSION_IDS_BY_KEY,
  ACTIVE_EMBEDDED_RUNS,
  ACTIVE_EMBEDDED_RUN_SESSION_IDS_BY_FILE,
  ACTIVE_EMBEDDED_RUN_SESSION_IDS_BY_KEY,
  getEmbeddedRunDiagnosticSnapshot,
} from "./run-state.js";
import { resolveEmbeddedSessionFileKey } from "./session-file-key.js";

afterEach(() => {
  ACTIVE_EMBEDDED_RUNS.clear();
  ACTIVE_EMBEDDED_RUN_SESSION_IDS_BY_FILE.clear();
  ACTIVE_EMBEDDED_RUN_SESSION_IDS_BY_KEY.clear();
  ABANDONED_EMBEDDED_RUNS_BY_SESSION_ID.clear();
  ABANDONED_EMBEDDED_RUN_SESSION_IDS_BY_FILE.clear();
  ABANDONED_EMBEDDED_RUN_SESSION_IDS_BY_KEY.clear();
});

describe("getEmbeddedRunDiagnosticSnapshot", () => {
  it("uses sessionFile for lookup without returning local paths", () => {
    ACTIVE_EMBEDDED_RUN_SESSION_IDS_BY_FILE.set(
      resolveEmbeddedSessionFileKey("/tmp/session-1.jsonl"),
      "session-1",
    );
    ACTIVE_EMBEDDED_RUNS.set("session-1", {
      isStreaming: () => true,
      isCompacting: () => false,
      queueMessage: async () => {},
      abort: () => {},
      sourceReplyDeliveryMode: "automatic",
    });

    expect(
      getEmbeddedRunDiagnosticSnapshot({
        sessionFile: "/tmp/session-1.jsonl",
      }),
    ).toEqual({
      active: true,
      sessionId: "session-1",
      streaming: true,
      compacting: false,
      sourceReplyDeliveryMode: "automatic",
      hasTranscriptSnapshot: false,
    });
  });

  it("omits abandoned run sessionFile details from diagnosis output", () => {
    ABANDONED_EMBEDDED_RUN_SESSION_IDS_BY_FILE.set(
      resolveEmbeddedSessionFileKey("/tmp/session-2.jsonl"),
      "session-2",
    );
    ABANDONED_EMBEDDED_RUNS_BY_SESSION_ID.set("session-2", {
      sessionId: "session-2",
      sessionFile: "/tmp/session-2.jsonl",
      abandonedAtMs: 10,
      reason: "timeout",
    });

    expect(
      getEmbeddedRunDiagnosticSnapshot({
        sessionFile: "/tmp/session-2.jsonl",
      }),
    ).toEqual({
      active: false,
      sessionId: "session-2",
      hasTranscriptSnapshot: false,
      abandoned: {
        sessionId: "session-2",
        abandonedAtMs: 10,
        reason: "timeout",
      },
    });
  });

  it("prefers the current session-key active id over a stale stored session id", () => {
    ACTIVE_EMBEDDED_RUN_SESSION_IDS_BY_KEY.set("agent:main:main", "session-current");
    ACTIVE_EMBEDDED_RUNS.set("session-current", {
      isStreaming: () => false,
      isCompacting: () => true,
      queueMessage: async () => {},
      abort: () => {},
    });

    expect(
      getEmbeddedRunDiagnosticSnapshot({
        sessionId: "session-stale",
        sessionKey: "agent:main:main",
      }),
    ).toEqual({
      active: true,
      sessionId: "session-current",
      sessionKey: "agent:main:main",
      streaming: false,
      compacting: true,
      hasTranscriptSnapshot: false,
    });
  });

  it("does not trust an active stored session id indexed to another key", () => {
    ACTIVE_EMBEDDED_RUN_SESSION_IDS_BY_KEY.set("agent:main:other", "session-shared");
    ACTIVE_EMBEDDED_RUNS.set("session-shared", {
      isStreaming: () => true,
      isCompacting: () => false,
      queueMessage: async () => {},
      abort: () => {},
    });

    expect(
      getEmbeddedRunDiagnosticSnapshot({
        sessionId: "session-shared",
        sessionKey: "agent:main:target",
      }),
    ).toEqual({
      active: false,
      sessionKey: "agent:main:target",
    });
  });

  it("prefers active file-indexed runs over abandoned key-indexed runs", () => {
    ABANDONED_EMBEDDED_RUN_SESSION_IDS_BY_KEY.set("agent:main:main", "session-old");
    ABANDONED_EMBEDDED_RUNS_BY_SESSION_ID.set("session-old", {
      sessionId: "session-old",
      sessionKey: "agent:main:main",
      abandonedAtMs: 10,
      reason: "timeout",
    });
    ACTIVE_EMBEDDED_RUN_SESSION_IDS_BY_FILE.set(
      resolveEmbeddedSessionFileKey("/tmp/session-current.jsonl"),
      "session-current",
    );
    ACTIVE_EMBEDDED_RUNS.set("session-current", {
      isStreaming: () => true,
      isCompacting: () => false,
      queueMessage: async () => {},
      abort: () => {},
    });

    expect(
      getEmbeddedRunDiagnosticSnapshot({
        sessionKey: "agent:main:main",
        sessionFile: "/tmp/session-current.jsonl",
      }),
    ).toEqual({
      active: true,
      sessionId: "session-current",
      sessionKey: "agent:main:main",
      streaming: true,
      compacting: false,
      hasTranscriptSnapshot: false,
    });
  });
});
