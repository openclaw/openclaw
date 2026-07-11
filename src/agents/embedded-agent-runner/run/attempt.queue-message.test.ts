// Coverage for queued steering message commit and cancellation behavior.
import { describe, expect, it, vi } from "vitest";
import { createUserTurnTranscriptRecorder } from "../../../sessions/user-turn-transcript.js";
import {
  cancelQueuedSteeringMessage,
  resolveQueuedRawBody,
  steerActiveSessionWithOptionalDeliveryWait,
  steerAndWaitForTranscriptCommit,
  steerQueuedMessageThenResolveRawBody,
  type EmbeddedAgentActiveSessionSteerTarget,
} from "./attempt.queue-message.js";

describe("embedded OpenClaw queued steering cancellation", () => {
  it("forwards prepared transcript context with a queued steering message", async () => {
    const steer = vi.fn(async () => undefined);
    const recorder = createUserTurnTranscriptRecorder({
      input: { text: "visible prompt", sender: { id: "user-42" } },
      target: { transcriptPath: "/tmp/unused-session.jsonl" },
    });
    const activeSession: EmbeddedAgentActiveSessionSteerTarget = {
      steer,
      subscribe: () => () => {},
    };

    await steerActiveSessionWithOptionalDeliveryWait(activeSession, "runtime prompt", {
      userTurnTranscriptRecorder: recorder,
    });

    expect(steer).toHaveBeenCalledWith("runtime prompt", undefined, recorder);
  });

  it("waits for the queued user message_end transcript boundary", async () => {
    // A queued steer is only durable once the user message_end event lands in
    // the active transcript.
    let emit!: (event: unknown) => void;
    const activeSession: EmbeddedAgentActiveSessionSteerTarget = {
      getSteeringMessages: () => [],
      steer: async () => {},
      subscribe: (listener) => {
        emit = listener;
        return () => {};
      },
    };
    const wait = steerAndWaitForTranscriptCommit(activeSession, "queued completion", 10_000);
    let settled = false;
    void wait.then(() => {
      settled = true;
    });

    emit({
      type: "message_start",
      message: {
        role: "user",
        content: [{ type: "text", text: "queued completion" }],
      },
    });
    await Promise.resolve();
    expect(settled).toBe(false);

    emit({
      type: "message_end",
      message: {
        role: "user",
        content: [{ type: "text", text: "queued completion" }],
      },
    });

    await expect(wait).resolves.toBeUndefined();
    expect(settled).toBe(true);
  });

  it("removes only the timed-out steering message and preserves unrelated payloads", async () => {
    // Timeout cleanup must surgically remove the queued text entry without
    // damaging rich unrelated queued content.
    const unrelatedImage = {
      type: "image",
      source: { type: "base64", data: "abc", media_type: "image/png" },
    };
    const unrelatedMessage = {
      role: "user",
      content: [{ type: "text", text: "keep this rich payload" }, unrelatedImage],
      timestamp: 1,
    };
    const targetMessage = {
      role: "user",
      content: [{ type: "text", text: "timed-out completion announce" }],
      timestamp: 2,
    };
    const trailingMessage = {
      role: "custom",
      customType: "notice",
      content: "preserve custom queued message",
      timestamp: 3,
    };
    const steeringUiMessages = ["keep this rich payload", "timed-out completion announce"];
    const queueMessages = [unrelatedMessage, targetMessage, trailingMessage];
    const activeSession: EmbeddedAgentActiveSessionSteerTarget = {
      agent: {
        steeringQueue: {
          messages: queueMessages,
        },
      },
      getSteeringMessages: () => steeringUiMessages,
      steer: async () => {},
      subscribe: () => () => {},
    };

    await expect(
      cancelQueuedSteeringMessage(activeSession, "timed-out completion announce"),
    ).resolves.toBe(true);

    expect(queueMessages).toEqual([unrelatedMessage, trailingMessage]);
    expect(queueMessages[0]).toBe(unrelatedMessage);
    expect(queueMessages[0]?.content[1]).toBe(unrelatedImage);
    expect(queueMessages[1]).toBe(trailingMessage);
    expect(steeringUiMessages).toEqual(["keep this rich payload"]);
  });

  it("rejects and removes the queued steering message when the session ends first", async () => {
    vi.useFakeTimers();
    let emit!: (event: unknown) => void;
    const targetMessage = {
      role: "user",
      content: [{ type: "text", text: "completion after parent stopped" }],
      timestamp: 2,
    };
    const keepMessage = {
      role: "user",
      content: [{ type: "text", text: "keep unrelated queue entry" }],
      timestamp: 3,
    };
    const steeringUiMessages = ["completion after parent stopped", "keep unrelated queue entry"];
    const queueMessages = [targetMessage, keepMessage];
    let unsubscribed = false;
    const activeSession: EmbeddedAgentActiveSessionSteerTarget = {
      agent: {
        steeringQueue: {
          messages: queueMessages,
        },
      },
      getSteeringMessages: () => steeringUiMessages,
      steer: async () => {},
      subscribe: (listener) => {
        emit = listener;
        return () => {
          unsubscribed = true;
        };
      },
    };

    const wait = steerAndWaitForTranscriptCommit(
      activeSession,
      "completion after parent stopped",
      10_000,
    );
    const rejection = expect(wait).rejects.toThrow(
      "active session ended before queued steering message was committed to the transcript",
    );

    emit({ type: "agent_end", messages: [] });
    await vi.advanceTimersByTimeAsync(0);

    try {
      await rejection;
      expect(queueMessages).toEqual([keepMessage]);
      expect(steeringUiMessages).toEqual(["keep unrelated queue entry"]);
      expect(unsubscribed).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps queued steering pending when auto-retry starts after agent_end", async () => {
    // agent_end can be followed by an automatic retry; do not cancel the queued
    // steer until the retry path either commits it or truly terminates.
    vi.useFakeTimers();
    try {
      let emit!: (event: unknown) => void;
      const targetMessage = {
        role: "user",
        content: [{ type: "text", text: "completion survives retry" }],
        timestamp: 2,
      };
      const steeringUiMessages = ["completion survives retry"];
      const queueMessages = [targetMessage];
      const activeSession: EmbeddedAgentActiveSessionSteerTarget = {
        agent: {
          steeringQueue: {
            messages: queueMessages,
          },
        },
        getSteeringMessages: () => steeringUiMessages,
        steer: async () => {},
        subscribe: (listener) => {
          emit = listener;
          return () => {};
        },
      };

      const wait = steerAndWaitForTranscriptCommit(
        activeSession,
        "completion survives retry",
        10_000,
      );

      emit({ type: "agent_end", messages: [] });
      emit({ type: "auto_retry_start", attempt: 1, maxAttempts: 3, delayMs: 1_000 });
      await vi.advanceTimersByTimeAsync(0);

      expect(queueMessages).toEqual([targetMessage]);
      expect(steeringUiMessages).toEqual(["completion survives retry"]);

      emit({
        type: "message_end",
        message: {
          role: "user",
          content: [{ type: "text", text: "completion survives retry" }],
        },
      });

      await expect(wait).resolves.toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps queued steering pending when auto-compaction starts after agent_end", async () => {
    vi.useFakeTimers();
    try {
      let emit!: (event: unknown) => void;
      const targetMessage = {
        role: "user",
        content: [{ type: "text", text: "completion survives compaction" }],
        timestamp: 2,
      };
      const steeringUiMessages = ["completion survives compaction"];
      const queueMessages = [targetMessage];
      const activeSession: EmbeddedAgentActiveSessionSteerTarget = {
        agent: {
          steeringQueue: {
            messages: queueMessages,
          },
        },
        getSteeringMessages: () => steeringUiMessages,
        steer: async () => {},
        subscribe: (listener) => {
          emit = listener;
          return () => {};
        },
      };

      const wait = steerAndWaitForTranscriptCommit(
        activeSession,
        "completion survives compaction",
        10_000,
      );

      emit({ type: "agent_end", messages: [] });
      emit({ type: "compaction_start", reason: "threshold" });
      await vi.advanceTimersByTimeAsync(0);

      expect(queueMessages).toEqual([targetMessage]);
      expect(steeringUiMessages).toEqual(["completion survives compaction"]);

      emit({
        type: "message_end",
        message: {
          role: "user",
          content: [{ type: "text", text: "completion survives compaction" }],
        },
      });

      await expect(wait).resolves.toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });
});

// PR #52664: the active embedded run reports rawBody on before_prompt_build /
// agent_end. A queued injection must re-derive that value rather than leaving
// the previous direct-user text in place, or internal injections leak it.
describe("resolveQueuedRawBody", () => {
  it("uses the queued turn's clean text when a direct-user steer provides it", () => {
    expect(resolveQueuedRawBody({ steeringMode: "all", rawBody: "hello steer" })).toBe(
      "hello steer",
    );
  });

  it("clears stale rawBody when an internal injection omits the key", () => {
    // sessions_send / Talk active-run control / subagent active wakes build
    // queue options without rawBody; they must not inherit the prior turn's.
    expect(resolveQueuedRawBody({ steeringMode: "all" })).toBeUndefined();
    expect(resolveQueuedRawBody(undefined)).toBeUndefined();
  });

  it("clears rawBody when a provenance-gated steer passes an explicit undefined", () => {
    expect(resolveQueuedRawBody({ steeringMode: "all", rawBody: undefined })).toBeUndefined();
  });
});

// The rawBody tracker may only change after queue delivery succeeds. A
// rejected or timed-out steer was never accepted into the active run, so its
// rawBody must not surface on later before_prompt_build / agent_end events.
describe("steerQueuedMessageThenResolveRawBody", () => {
  it("resolves the queued turn's rawBody after successful delivery", async () => {
    const activeSession: EmbeddedAgentActiveSessionSteerTarget = {
      steer: async () => {},
      subscribe: () => () => {},
    };

    await expect(
      steerQueuedMessageThenResolveRawBody(activeSession, "steered text", {
        steeringMode: "all",
        rawBody: "steered text",
      }),
    ).resolves.toBe("steered text");
  });

  it("rejects without resolving a rawBody when steering fails", async () => {
    const activeSession: EmbeddedAgentActiveSessionSteerTarget = {
      steer: async () => {
        throw new Error("steer rejected");
      },
      subscribe: () => () => {},
    };

    await expect(
      steerQueuedMessageThenResolveRawBody(activeSession, "rejected text", {
        steeringMode: "all",
        rawBody: "rejected text",
      }),
    ).rejects.toThrow("steer rejected");
  });

  it("rejects when the transcript-commit wait times out", async () => {
    vi.useFakeTimers();
    try {
      const activeSession: EmbeddedAgentActiveSessionSteerTarget = {
        getSteeringMessages: () => [],
        steer: async () => {},
        subscribe: () => () => {},
      };

      const pending = steerQueuedMessageThenResolveRawBody(activeSession, "timed out text", {
        steeringMode: "all",
        waitForTranscriptCommit: true,
        deliveryTimeoutMs: 50,
        rawBody: "timed out text",
      });
      const outcome = expect(pending).rejects.toThrow(
        "queued steering message was not committed to the transcript before timeout",
      );
      await vi.advanceTimersByTimeAsync(60);
      await outcome;
    } finally {
      vi.useRealTimers();
    }
  });
});
