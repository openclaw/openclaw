import { describe, expect, it, vi } from "vitest";
import type { DecisionRuntimeV1 } from "../../decisions/types.js";
import type { AgentMessage } from "../runtime/index.js";
import {
  evaluateCompactionFidelity,
  evaluateCompactionShadowCuration,
} from "./compaction-safeguard-semantic-decisions.js";
import {
  buildCompactionSemanticSnapshot,
  fingerprintCompactionMessages,
} from "./compaction-safeguard-semantic.js";

function message(value: unknown): AgentMessage {
  return value as AgentMessage;
}

function runtimeWithChoices(choices: Record<string, string>): DecisionRuntimeV1 {
  return {
    evaluate: vi.fn<DecisionRuntimeV1["evaluate"]>(async (batch, options) => {
      options.signal.throwIfAborted();
      const answers = Object.fromEntries(
        Object.entries(batch.questions).map(([id, question]) => {
          if (question.type !== "choice") {
            throw new Error("expected choice question");
          }
          const labels = Object.keys(question.criteria);
          const selected = choices[id] ?? labels[0];
          if (selected === undefined) {
            throw new Error("expected nonempty choice criteria");
          }
          return [
            id,
            {
              type: "choice" as const,
              choice: selected,
              probabilities: Object.fromEntries(
                labels.map((label) => [label, label === selected ? 1 : 0]),
              ),
            },
          ];
        }),
      );
      return {
        status: "ok" as const,
        result: {
          model: "test-decision",
          answers,
          usage: { inputTokens: 10, outputTokens: 2 },
        },
        provenance: {
          providerId: "test",
          rubricVersion: "test",
          runtimeGeneration: "generation-1",
        },
      };
    }),
  };
}

describe("compaction semantic snapshot", () => {
  it.each(["branchSummary", "compactionSummary"])(
    "counts native %s payloads without changing their source",
    (role) => {
      const source = message({
        role,
        summary: "Keep staging-only changes and preserve the active approval request.",
      });
      const before = structuredClone(source);
      const snapshot = buildCompactionSemanticSnapshot({ messages: [source] });
      const expected = `${role}: Keep staging-only changes and preserve the active approval request.`;
      expect(snapshot.segments[0]?.text).toBe(expected);
      expect(snapshot.originalChars).toBe(expected.length);
      expect(source).toEqual(before);
    },
  );

  it("protects oversized native summaries and retains their full size for accounting", () => {
    const source = message({ role: "compactionSummary", summary: "x".repeat(7000) });
    const snapshot = buildCompactionSemanticSnapshot({ messages: [source] });
    expect(snapshot.originalChars).toBe("compactionSummary: ".length + 7000);
    expect(snapshot.segments[0]?.protected).toBe(true);
    expect(snapshot.complete).toBe(false);
  });

  it("keeps tool calls and their results in one source segment", () => {
    const user = message({
      role: "user",
      content: [{ type: "text", text: "Update the deployment but keep port 18789." }],
    });
    const assistant = message({
      role: "assistant",
      content: [{ type: "toolCall", id: "call-1", name: "exec", input: { cmd: "deploy" } }],
    });
    const toolResult = message({
      role: "toolResult",
      toolCallId: "call-1",
      toolName: "exec",
      content: [{ type: "text", text: "deployment complete" }],
    });
    const tail = message({
      role: "assistant",
      content: [{ type: "text", text: "Deployment is complete." }],
    });

    const snapshot = buildCompactionSemanticSnapshot({
      messages: [user, assistant, toolResult, tail],
      protectedMessages: new Set([user]),
      identifiers: ["18789"],
      latestUserAsk: "Update the deployment but keep port 18789.",
    });

    expect(snapshot.segments).toHaveLength(3);
    expect(snapshot.segments[1]?.sourceIndexes).toEqual([1, 2]);
    expect(snapshot.segments[0]?.protected).toBe(true);
    expect(snapshot.obligations[0]?.sourceSegmentId).toBe(snapshot.segments[0]?.id);
  });

  it("bounds a combined tool frame even when each result is individually small", () => {
    const assistant = message({
      role: "assistant",
      content: [
        { type: "toolCall", id: "one", name: "read", arguments: {} },
        { type: "toolCall", id: "two", name: "read", arguments: {} },
      ],
    });
    const results = ["one", "two"].map((id) =>
      message({
        role: "toolResult",
        toolCallId: id,
        toolName: "read",
        content: [{ type: "text", text: "x".repeat(4000) }],
      }),
    );
    const snapshot = buildCompactionSemanticSnapshot({ messages: [assistant, ...results] });
    expect(snapshot.segments).toHaveLength(1);
    expect(snapshot.segments[0]?.text).toHaveLength(6000);
    expect(snapshot.segments[0]?.originalChars).toBeGreaterThan(8000);
    expect(snapshot.segments[0]?.protectionReasons).toContain("oversized-segment");
    expect(snapshot.segments[0]?.protected).toBe(true);
    expect(snapshot.complete).toBe(false);
  });

  it("treats oversized source conservatively instead of making it droppable", () => {
    const oversized = message({
      role: "assistant",
      content: [{ type: "text", text: "x".repeat(7_000) }],
    });
    const snapshot = buildCompactionSemanticSnapshot({
      messages: [oversized],
      latestUserAsk: "keep going",
    });

    expect(snapshot.segments[0]?.protected).toBe(true);
    expect(snapshot.segments[0]?.protectionReasons).toContain("oversized-segment");
    expect(snapshot.complete).toBe(false);
  });

  it("protects unsupported non-text source and marks coverage incomplete", () => {
    const image = message({
      role: "user",
      content: [{ type: "image", mimeType: "image/png", data: "synthetic" }],
    });
    const snapshot = buildCompactionSemanticSnapshot({ messages: [image] });

    expect(snapshot.segments[0]?.protected).toBe(true);
    expect(snapshot.segments[0]?.protectionReasons).toContain("unsupported-content");
    expect(snapshot.complete).toBe(false);
  });
});

describe("compaction semantic decisions", () => {
  it("retains an older user constraint outside the tracked obligations", async () => {
    const olderConstraint = message({ role: "user", content: "Keep all existing behavior." });
    const latestAsk = "Finish the report.";
    const messages = [
      olderConstraint,
      message({ role: "assistant", content: "Unrelated old discussion." }),
      message({ role: "user", content: latestAsk }),
    ];
    const snapshot = buildCompactionSemanticSnapshot({ messages, latestUserAsk: latestAsk });
    const runtime = runtimeWithChoices(
      Object.fromEntries(snapshot.segments.map((segment) => [segment.id, "drop"])),
    );
    const result = await evaluateCompactionShadowCuration({
      runtime,
      snapshot,
      signal: new AbortController().signal,
    });

    expect(result.selectedSegmentIds).toEqual(["segment-0", "segment-2"]);
    expect(result.evaluatedSegmentIds).toEqual(["segment-1"]);
    expect(snapshot.segments[0]?.protectionReasons).toContain("user-authored");
  });

  it.each(["preserved", "missing", "contradicted"])(
    "does not report %s for incomplete or unanchored obligations",
    async (choice) => {
      const oversizedAsk = "Continue with the full request. ".repeat(250);
      const snapshot = buildCompactionSemanticSnapshot({
        messages: [message({ role: "user", content: oversizedAsk })],
        latestUnresolvedUserRequest: oversizedAsk,
        latestUserAsk: "An ask absent from the source.",
      });
      const runtime = runtimeWithChoices(
        Object.fromEntries(snapshot.obligations.map((obligation) => [obligation.id, choice])),
      );
      const result = await evaluateCompactionFidelity({
        runtime,
        snapshot,
        candidateSummary: "Only the visible prefix is retained.",
        signal: new AbortController().signal,
      });

      expect(result.status).toBe("ok");
      if (result.status !== "ok") {
        throw new Error("Expected fidelity assessments");
      }
      expect(result.assessments.map((assessment) => assessment.classification)).toEqual([
        "uncertain",
        "uncertain",
      ]);
    },
  );

  it("produces a conservative shadow selection without mutating source", async () => {
    const user = message({
      role: "user",
      content: [{ type: "text", text: "Finish the current deployment." }],
    });
    const oldFact = message({
      role: "assistant",
      content: [{ type: "text", text: "Old unrelated weather discussion." }],
    });
    const usefulFact = message({
      role: "assistant",
      content: [{ type: "text", text: "Deployment target is production." }],
    });
    const snapshot = buildCompactionSemanticSnapshot({
      messages: [user, oldFact, usefulFact],
      latestUserAsk: "Finish the current deployment.",
    });
    const discretionary = snapshot.segments.filter((segment) => !segment.protected);
    expect(discretionary).toHaveLength(2);

    const runtime = runtimeWithChoices({
      [discretionary[0]!.id]: "drop",
      [discretionary[1]!.id]: "uncertain",
    });
    const controller = new AbortController();
    const result = await evaluateCompactionShadowCuration({
      runtime,
      snapshot,
      signal: controller.signal,
      timeoutMs: 500,
    });

    expect(result.status).toBe("ok");
    if (result.status !== "ok") {
      return;
    }
    expect(result.excludedSegmentIds).toEqual([discretionary[0]!.id]);
    expect(result.uncertainSegmentIds).toEqual([discretionary[1]!.id]);
    expect(result.selectedSegmentIds).toContain(discretionary[1]!.id);
    expect(snapshot.segments).toHaveLength(3);
  });

  it("changes the source fingerprint when decision-relevant source changes", () => {
    const user = message({
      role: "user",
      content: [{ type: "text", text: "Deploy production." }],
    });
    const releaseA = message({
      role: "assistant",
      content: [{ type: "text", text: "Production uses release A." }],
    });
    const releaseB = message({
      role: "assistant",
      content: [{ type: "text", text: "Production uses release B." }],
    });
    const snapshot = buildCompactionSemanticSnapshot({
      messages: [user, releaseA],
      latestUserAsk: "Deploy production.",
    });

    expect(fingerprintCompactionMessages([user, releaseB])).not.toBe(snapshot.sourceFingerprint);
  });

  it("classifies finalized context against source-backed obligations", async () => {
    const user = message({
      role: "user",
      content: [{ type: "text", text: "Keep the production port at 18789." }],
    });
    const snapshot = buildCompactionSemanticSnapshot({
      messages: [user],
      latestUnresolvedUserRequest: "Keep the production port at 18789.",
    });
    const obligationId = snapshot.obligations[0]!.id;
    const runtime = runtimeWithChoices({ [obligationId]: "preserved" });
    const controller = new AbortController();

    const result = await evaluateCompactionFidelity({
      runtime,
      snapshot,
      candidateSummary: "## Constraints/Rules\nKeep production port 18789.",
      signal: controller.signal,
    });

    expect(result.status).toBe("ok");
    if (result.status !== "ok") {
      return;
    }
    expect(result.assessments).toEqual([
      expect.objectContaining({
        obligationId,
        classification: "preserved",
      }),
    ]);
  });
});
