import type {
  AgentMessage,
  EmbeddedRunAttemptParamsV2 as EmbeddedRunAttemptParams,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import type { AssistantMessage } from "openclaw/plugin-sdk/llm";
import { describe, expect, it } from "vitest";
import { createNativeCommandItem } from "./event-projector-command.test-support.js";
import { buildCodexMessagesSnapshot } from "./event-projector-snapshot.js";
import { finalMessage as finalItem } from "./event-projector.compact.test-support.js";
import * as fixture from "./event-projector.compact.test-support.js";
import {
  buildEmptyToolTelemetry,
  createCodexTestModel,
  createProjector,
  registerCodexEventProjectorTestLifecycle,
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
        content: fixture.text("saved"),
        isError: false,
        timestamp: Date.now(),
      } as AgentMessage,
    ],
    lastAssistant: {
      role: "assistant",
      content: fixture.text("NO_REPLY"),
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

  it.each(["completed replacement", "cumulative replacement", "append-only streams"] as const)(
    "captures only visible assistant items at the first steer (%s)",
    async (replacement) => {
      const projector = await createProjector();
      await fixture.start(projector, finalItem("preview", ""));
      await fixture.delta(
        projector,
        replacement === "completed replacement" ? "Authoritative" : "First preview",
        "preview",
      );
      if (replacement === "cumulative replacement" || replacement === "append-only streams") {
        await fixture.start(projector, finalItem("second-preview", ""));
        await fixture.delta(projector, "Second preview", "second-preview");
      }
      if (replacement === "completed replacement") {
        await fixture.complete(projector, finalItem("replacement", "Authoritative answer"));
      } else if (replacement !== "append-only streams") {
        await fixture.start(projector, fixture.message("replacement", ""));
        await fixture.delta(projector, "Authoritative answer", "replacement");
      }
      const expected =
        replacement === "append-only streams"
          ? ["First preview", "Second preview"]
          : ["Authoritative answer"];
      expect(
        projector
          .buildSteeringTranscriptPrefix()
          .map((message) => (message.role === "assistant" ? message.content : message.role)),
      ).toEqual(expected.map((text) => fixture.text(text)));
    },
  );

  it("keeps newly streamed text after tools observed since its assistant item started", async () => {
    const projector = await createProjector();
    await fixture.start(projector, finalItem("early-start", ""));
    const tool = createNativeCommandItem({
      id: "earlier-tool",
      aggregatedOutput: "Tool completed",
    });
    await fixture.start(projector, tool);
    await fixture.complete(projector, tool);
    await fixture.delta(projector, "Visible tail", "early-start");
    const prefix = projector.buildSteeringTranscriptPrefix();
    expect(prefix.at(-1)).toMatchObject({
      role: "assistant",
      content: fixture.text("Visible tail"),
    });
    expect(prefix.slice(0, -1)).toContainEqual(
      expect.objectContaining({ role: "toolResult", toolCallId: "earlier-tool" }),
    );
  });

  it("keeps a persisted earlier answer separate from a later tool-authored reply", async () => {
    const projector = await createProjector();
    await fixture.complete(projector, finalItem("earlier-answer", "Earlier answer."));
    const prefix = projector.buildSteeringTranscriptPrefix();
    commitSteeringPrefix(projector, prefix);

    const result = projector.buildResult({
      ...buildEmptyToolTelemetry(),
      messagingToolSourceReplyPayloads: [
        {
          text: "Later tool reply.",
          sourceReplyFinal: true,
          toolAuthored: true,
          toolAuthoredForToolCallId: "later-call",
          toolAuthoredForTurnId: "turn-1",
        },
      ],
    });

    expect(result.assistantTexts).toEqual([]);
    expect(result.lastAssistant).toBeUndefined();
    expect(result.currentAttemptAssistant).toMatchObject({ turnId: "turn-1" });
    expect(prefix).toMatchObject([{ role: "assistant", content: fixture.text("Earlier answer.") }]);
    expect(prefix[0]).not.toHaveProperty("turnId");
    expect(prefix.map(readMirrorIdentity)).toEqual(["turn-1:assistant:earlier-answer"]);
  });

  it("adopts the saved prefix for a raw completion with a replacement identity", async () => {
    const completionId = "raw-completed";
    const projector = await createProjector();
    await fixture.start(projector, finalItem("streamed", ""));
    await fixture.delta(projector, "Before steer.", "streamed");
    commitSteeringPrefix(projector, projector.buildSteeringTranscriptPrefix());
    await fixture.rawAssistant(projector, "Before steer. After steer.", {
      id: completionId,
      phase: "final_answer",
    });
    await fixture.finish(projector, [finalItem(completionId, "Before steer. After steer.")]);
    expect(fixture.result(projector).assistantTexts).toEqual([" After steer."]);
  });

  it.each([true, false])(
    "respects the first completion boundary across a native tool (completed before tool: %s)",
    async (completedBeforeTool) => {
      const projector = await createProjector();
      const started = finalItem("split-answer", "");
      await fixture.start(projector, started);
      await fixture.delta(projector, "Before steer.", started.id);
      commitSteeringPrefix(projector, projector.buildSteeringTranscriptPrefix());
      const completed = { ...started, text: "Before steer. Split answer tail." };
      if (completedBeforeTool) {
        await fixture.complete(projector, completed);
      }
      const tool = createNativeCommandItem({ id: "handoff", aggregatedOutput: "Tool completed" });
      await fixture.start(projector, tool);
      await fixture.complete(projector, tool);
      // Duplicate completion and the terminal snapshot cannot move the first completion.
      await fixture.complete(projector, completed);
      const final = { ...started, id: "post-tool-answer", text: "After tool." };
      await fixture.complete(projector, final);
      await fixture.finish(projector, [completed, final]);
      expect(fixture.result(projector).assistantTexts).toEqual(
        completedBeforeTool ? ["After tool."] : [" Split answer tail.", "After tool."],
      );
    },
  );

  it("retains distinct completed item identities across steers without replaying the terminal answer", async () => {
    const projector = await createProjector();
    for (const id of ["answer-a", "answer-b"]) {
      await fixture.complete(projector, finalItem(id, "Same answer."));
    }
    const sleep = { type: "sleep", id: "sleep", durationMs: 250 };
    await fixture.start(projector, sleep);
    const pending = finalItem("pending", "");
    await fixture.start(projector, pending);
    await fixture.delta(projector, "Still writing.", pending.id);

    const prefix = projector.buildSteeringTranscriptPrefix();
    expect(prefix.map(readMirrorIdentity)).toEqual([
      "turn-1:assistant:answer-a",
      "turn-1:assistant:answer-b",
      "turn-1:assistant:pending:segment:0",
    ]);
    expect(prefix).toMatchObject([
      { role: "assistant", content: fixture.text("Same answer.") },
      { role: "assistant", content: fixture.text("Same answer.") },
      { role: "assistant", content: fixture.text("Still writing.") },
    ]);
    commitSteeringPrefix(projector, prefix);
    expect(projector.buildSteeringTranscriptPrefix()).toEqual(prefix.slice(0, 2));

    // A late completion for the same handoff must not invalidate the later answer.
    await fixture.complete(projector, sleep);
    const completed = { ...pending, text: "Still writing. More after steer." };
    await fixture.complete(projector, completed);
    const continuedPrefix = projector.buildSteeringTranscriptPrefix();
    expect(continuedPrefix.map(readMirrorIdentity)).toEqual([
      "turn-1:assistant:answer-a",
      "turn-1:assistant:answer-b",
      "turn-1:assistant:pending:segment:1",
    ]);
    commitSteeringPrefix(projector, continuedPrefix);
    await fixture.finish(projector, [completed]);
    expect(fixture.result(projector).assistantTexts).toEqual([]);
  });

  it.each(["same", "replacement", "independent", "handoff", "async"] as const)(
    "retains the captured raw cutoff when %s completion arrives before the mirror settles",
    async (identity) => {
      const projector = await createProjector();
      const started = finalItem("streamed", "");
      const beforeSteer = " \t🦞 prefix\n";
      await fixture.start(projector, started);
      await fixture.delta(projector, beforeSteer, started.id);
      const prefix = projector.buildSteeringTranscriptPrefix();
      expect(prefix).toMatchObject([{ role: "assistant", content: fixture.text(beforeSteer) }]);
      await fixture.delta(projector, "continued", started.id);
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
        await fixture.start(projector, item);
        await fixture.complete(projector, item);
      }
      if (identity === "independent") {
        await fixture.start(projector, { ...completed, text: "" });
      }
      if (identity === "async") {
        await fixture.complete(projector, {
          ...completed,
          id: "independent-async",
          delivery: "async",
        });
      }
      await fixture.complete(projector, completed);
      commitSteeringPrefix(projector, prefix);
      await fixture.finish(projector, [completed]);
      expect(fixture.result(projector).assistantTexts).toEqual([
        identity === "independent" ? `${beforeSteer}continued and done` : "continued and done",
      ]);
    },
  );
});
