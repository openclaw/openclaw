import type {
  AgentMessage,
  EmbeddedRunAttemptParamsV2 as EmbeddedRunAttemptParams,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import type { AssistantMessage } from "openclaw/plugin-sdk/llm";
import { describe, expect, it } from "vitest";
import { createNativeCommandItem } from "./event-projector-command.test-support.js";
import { buildCodexMessagesSnapshot } from "./event-projector-snapshot.js";
import {
  buildEmptyToolTelemetry,
  createCodexTestModel,
  createProjector,
  forCurrentTurn,
  registerCodexEventProjectorTestLifecycle,
  turnCompleted,
} from "./event-projector.test-harness.js";
import { readMirrorIdentity } from "./upstream-prompt-provenance.js";

registerCodexEventProjectorTestLifecycle();

function commitSteeringPrefix(
  projector: Awaited<ReturnType<typeof createProjector>>,
  messages: AgentMessage[],
) {
  for (const message of messages) {
    const identity = readMirrorIdentity(message);
    if (identity) {
      projector.markSteeringTranscriptMessagePersisted(identity);
    }
  }
}

function buildSnapshot(trigger: EmbeddedRunAttemptParams["trigger"]): AgentMessage[] {
  const model = createCodexTestModel();
  return buildCodexMessagesSnapshot({
    runParams: {
      prompt: "Pre-compaction memory flush",
      sessionId: "session-1",
      provider: model.provider,
      modelId: model.id,
      model,
      trigger,
    } as EmbeddedRunAttemptParams,
    turnId: "turn-1",
    upstreamUserText: undefined,
    reasoningText: "checking memory",
    asyncMessages: [],
    commentaryMessages: [],
    toolMessages: [
      {
        role: "toolResult",
        toolCallId: "call-1",
        toolName: "write",
        content: [{ type: "text", text: "saved" }],
        isError: false,
        timestamp: Date.now(),
      } as AgentMessage,
    ],
    lastAssistant: {
      role: "assistant",
      content: [{ type: "text", text: "NO_REPLY" }],
      timestamp: Date.now() + 1,
    } as AssistantMessage,
  });
}

describe("buildCodexMessagesSnapshot", () => {
  it("marks every current memory-maintenance message as hidden for durable replay", () => {
    const messages = buildSnapshot("memory");

    expect(messages.length).toBeGreaterThan(1);
    expect(messages.every((message) => (message as { display?: boolean }).display === false)).toBe(
      true,
    );
  });

  it("leaves ordinary current-turn messages visible", () => {
    const messages = buildSnapshot("user");

    expect(messages.every((message) => (message as { display?: boolean }).display !== false)).toBe(
      true,
    );
  });

  it.each([
    "completed replacement",
    "replaceable stream",
    "cumulative replacement",
    "append-only streams",
  ] as const)(
    "captures only visible assistant items at the first steer (%s)",
    async (replacement) => {
      const projector = await createProjector();
      const phase = replacement === "replaceable stream" ? {} : { phase: "final_answer" };
      await projector.handleNotification(
        forCurrentTurn("item/started", {
          item: { type: "agentMessage", id: "preview", text: "", ...phase },
        }),
      );
      await projector.handleNotification(
        forCurrentTurn("item/agentMessage/delta", {
          itemId: "preview",
          delta: replacement === "completed replacement" ? "Authoritative" : "First preview",
        }),
      );
      if (replacement === "cumulative replacement" || replacement === "append-only streams") {
        await projector.handleNotification(
          forCurrentTurn("item/started", {
            item: { type: "agentMessage", id: "second-preview", text: "", phase: "final_answer" },
          }),
        );
        await projector.handleNotification(
          forCurrentTurn("item/agentMessage/delta", {
            itemId: "second-preview",
            delta: "Second preview",
          }),
        );
      }
      if (replacement === "completed replacement") {
        await projector.handleNotification(
          forCurrentTurn("item/completed", {
            item: {
              type: "agentMessage",
              id: "replacement",
              text: "Authoritative answer",
              ...phase,
            },
          }),
        );
      } else if (replacement !== "append-only streams") {
        await projector.handleNotification(
          forCurrentTurn("item/started", {
            item: { type: "agentMessage", id: "replacement", text: "" },
          }),
        );
        await projector.handleNotification(
          forCurrentTurn("item/agentMessage/delta", {
            itemId: "replacement",
            delta: "Authoritative answer",
          }),
        );
      }
      const expected =
        replacement === "append-only streams"
          ? ["First preview", "Second preview"]
          : ["Authoritative answer"];
      expect(
        projector
          .buildSteeringTranscriptPrefix()
          .map((message) => (message.role === "assistant" ? message.content : message.role)),
      ).toEqual(expected.map((text) => [{ type: "text", text }]));
    },
  );

  it("keeps newly streamed text after tools observed since its assistant item started", async () => {
    const projector = await createProjector();
    await projector.handleNotification(
      forCurrentTurn("item/started", {
        item: { type: "agentMessage", id: "early-start", phase: "final_answer", text: "" },
      }),
    );
    const tool = createNativeCommandItem({
      id: "earlier-tool",
      aggregatedOutput: "Tool completed",
    });
    await projector.handleNotification(forCurrentTurn("item/started", { item: tool }));
    await projector.handleNotification(forCurrentTurn("item/completed", { item: tool }));
    await projector.handleNotification(
      forCurrentTurn("item/agentMessage/delta", {
        itemId: "early-start",
        delta: "Visible tail",
      }),
    );
    const prefix = projector.buildSteeringTranscriptPrefix();
    expect(prefix.at(-1)).toMatchObject({
      role: "assistant",
      content: [{ type: "text", text: "Visible tail" }],
    });
    expect(prefix.slice(0, -1)).toContainEqual(
      expect.objectContaining({ role: "toolResult", toolCallId: "earlier-tool" }),
    );
  });

  it.each(["streamed", "raw-completed"])(
    "adopts the saved prefix for an accepted raw completion under %s",
    async (completionId) => {
      const projector = await createProjector();
      await projector.handleNotification(
        forCurrentTurn("item/started", {
          item: { type: "agentMessage", id: "streamed", phase: "final_answer", text: "" },
        }),
      );
      await projector.handleNotification(
        forCurrentTurn("item/agentMessage/delta", {
          itemId: "streamed",
          delta: "Before steer.",
        }),
      );
      commitSteeringPrefix(projector, projector.buildSteeringTranscriptPrefix());
      await projector.handleNotification(
        forCurrentTurn("rawResponseItem/completed", {
          item: {
            type: "message",
            role: "assistant",
            phase: "final_answer",
            id: completionId,
            content: [{ type: "output_text", text: "Before steer. After steer." }],
          },
        }),
      );
      await projector.handleNotification(
        turnCompleted([
          {
            type: "agentMessage",
            id: completionId,
            phase: "final_answer",
            text: "Before steer. After steer.",
          },
        ]),
      );
      expect(projector.buildResult(buildEmptyToolTelemetry()).assistantTexts).toEqual([
        "After steer.",
      ]);
    },
  );

  it.each([true, false])(
    "respects the first completion boundary across a native tool (completed before tool: %s)",
    async (completedBeforeTool) => {
      const projector = await createProjector();
      const started = { type: "agentMessage", id: "split-answer", phase: "final_answer", text: "" };
      await projector.handleNotification(forCurrentTurn("item/started", { item: started }));
      await projector.handleNotification(
        forCurrentTurn("item/agentMessage/delta", {
          itemId: started.id,
          delta: "Before steer.",
        }),
      );
      commitSteeringPrefix(projector, projector.buildSteeringTranscriptPrefix());
      const completed = { ...started, text: "Before steer. Split answer tail." };
      if (completedBeforeTool) {
        await projector.handleNotification(forCurrentTurn("item/completed", { item: completed }));
      }
      const tool = createNativeCommandItem({ id: "handoff", aggregatedOutput: "Tool completed" });
      await projector.handleNotification(forCurrentTurn("item/started", { item: tool }));
      await projector.handleNotification(forCurrentTurn("item/completed", { item: tool }));
      // Duplicate completion and the terminal snapshot cannot move the first completion.
      await projector.handleNotification(forCurrentTurn("item/completed", { item: completed }));
      const final = { ...started, id: "post-tool-answer", text: "After tool." };
      await projector.handleNotification(forCurrentTurn("item/completed", { item: final }));
      await projector.handleNotification(turnCompleted([completed, final]));
      expect(projector.buildResult(buildEmptyToolTelemetry()).assistantTexts).toEqual(
        completedBeforeTool ? ["After tool."] : ["Split answer tail.", "After tool."],
      );
    },
  );

  it("retains distinct completed item identities across steers without replaying the terminal answer", async () => {
    const projector = await createProjector();
    for (const id of ["answer-a", "answer-b"]) {
      await projector.handleNotification(
        forCurrentTurn("item/completed", {
          item: { type: "agentMessage", id, phase: "final_answer", text: "Same answer." },
        }),
      );
    }
    const sleep = { type: "sleep", id: "sleep", durationMs: 250 };
    await projector.handleNotification(forCurrentTurn("item/started", { item: sleep }));
    const pending = { type: "agentMessage", id: "pending", phase: "final_answer", text: "" };
    await projector.handleNotification(forCurrentTurn("item/started", { item: pending }));
    await projector.handleNotification(
      forCurrentTurn("item/agentMessage/delta", {
        itemId: pending.id,
        delta: "Still writing.",
      }),
    );

    const prefix = projector.buildSteeringTranscriptPrefix();
    expect(prefix.map(readMirrorIdentity)).toEqual([
      "turn-1:assistant:answer-a",
      "turn-1:assistant:answer-b",
      "turn-1:assistant:pending:segment:0",
    ]);
    expect(prefix).toMatchObject([
      { role: "assistant", content: [{ type: "text", text: "Same answer." }] },
      { role: "assistant", content: [{ type: "text", text: "Same answer." }] },
      { role: "assistant", content: [{ type: "text", text: "Still writing." }] },
    ]);
    commitSteeringPrefix(projector, prefix);
    expect(projector.buildSteeringTranscriptPrefix()).toEqual(prefix.slice(0, 2));

    // A late completion for the same handoff must not invalidate the later answer.
    await projector.handleNotification(forCurrentTurn("item/completed", { item: sleep }));
    const completed = { ...pending, text: "Still writing. More after steer." };
    await projector.handleNotification(forCurrentTurn("item/completed", { item: completed }));
    const continuedPrefix = projector.buildSteeringTranscriptPrefix();
    expect(continuedPrefix.map(readMirrorIdentity)).toEqual([
      "turn-1:assistant:answer-a",
      "turn-1:assistant:answer-b",
      "turn-1:assistant:pending:segment:1",
    ]);
    commitSteeringPrefix(projector, continuedPrefix);
    await projector.handleNotification(turnCompleted([completed]));
    expect(projector.buildResult(buildEmptyToolTelemetry()).assistantTexts).toEqual([]);
  });

  it.each(["same", "replacement", "independent", "handoff", "async"] as const)(
    "retains the captured raw cutoff when %s completion arrives before the mirror settles",
    async (identity) => {
      const projector = await createProjector();
      const started = { type: "agentMessage", id: "streamed", phase: "final_answer", text: "" };
      const beforeSteer = " \t🦞 prefix\n";
      await projector.handleNotification(forCurrentTurn("item/started", { item: started }));
      await projector.handleNotification(
        forCurrentTurn("item/agentMessage/delta", {
          itemId: started.id,
          delta: beforeSteer,
        }),
      );
      const prefix = projector.buildSteeringTranscriptPrefix();
      expect(prefix).toMatchObject([
        { role: "assistant", content: [{ type: "text", text: beforeSteer }] },
      ]);
      await projector.handleNotification(
        forCurrentTurn("item/agentMessage/delta", {
          itemId: started.id,
          delta: "continued",
        }),
      );
      const completed = {
        ...started,
        id:
          identity === "same" || identity === "handoff" || identity === "async"
            ? started.id
            : identity,
        text: `${beforeSteer}continued and done`,
      };
      if (identity === "handoff") {
        const item = { type: "sleep", id: "handoff", durationMs: 1 };
        await projector.handleNotification(forCurrentTurn("item/started", { item }));
        await projector.handleNotification(forCurrentTurn("item/completed", { item }));
      }
      if (identity === "independent") {
        await projector.handleNotification(
          forCurrentTurn("item/started", {
            item: { ...completed, text: "" },
          }),
        );
      }
      if (identity === "async") {
        await projector.handleNotification(
          forCurrentTurn("item/completed", {
            item: { ...completed, id: "independent-async", delivery: "async" },
          }),
        );
      }
      await projector.handleNotification(forCurrentTurn("item/completed", { item: completed }));
      commitSteeringPrefix(projector, prefix);
      await projector.handleNotification(turnCompleted([completed]));
      expect(projector.buildResult(buildEmptyToolTelemetry()).assistantTexts).toEqual([
        identity === "independent"
          ? `${beforeSteer}continued and done`.trim()
          : "continued and done",
      ]);
    },
  );
});
