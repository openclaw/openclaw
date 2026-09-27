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
  projectCompactionSemanticSelection,
} from "./compaction-safeguard-semantic.js";

function message(value: unknown): AgentMessage {
  return value as AgentMessage;
}

function runtimeWithChoices(choices: Record<string, string>) {
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
  } satisfies DecisionRuntimeV1;
}

describe("compaction semantic snapshot", () => {
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
  it("includes omitted supporting evidence in the fidelity decision", async () => {
    const latestAsk = "Deploy the current release.";
    const supportingFact = message({
      role: "assistant",
      content: "The current production release is 2026.9.4.",
    });
    const snapshot = buildCompactionSemanticSnapshot({
      messages: [supportingFact, message({ role: "user", content: latestAsk })],
      latestUserAsk: latestAsk,
    });
    const omittedSegmentId = snapshot.segments[0]!.id;
    const runtime = runtimeWithChoices({ [snapshot.obligations[0]!.id]: "missing" });

    const result = await evaluateCompactionFidelity({
      runtime,
      snapshot,
      candidateSummary: "Deploy the current release.",
      omittedSegmentIds: [omittedSegmentId],
      signal: new AbortController().signal,
    });

    expect(result.status).toBe("ok");
    const evaluate = vi.mocked(runtime.evaluate);
    expect(evaluate).toHaveBeenCalledWith(
      expect.objectContaining({
        state: expect.objectContaining({
          omittedEvidence: [
            expect.objectContaining({
              id: omittedSegmentId,
              text: expect.stringContaining("2026.9.4"),
            }),
          ],
        }),
      }),
      expect.anything(),
    );
  });

  it("fails closed when omitted evidence cannot be represented", async () => {
    const latestAsk = "Deploy the current release.";
    const snapshot = buildCompactionSemanticSnapshot({
      messages: [message({ role: "user", content: latestAsk })],
      latestUserAsk: latestAsk,
    });
    const runtime = runtimeWithChoices({});

    const result = await evaluateCompactionFidelity({
      runtime,
      snapshot,
      candidateSummary: latestAsk,
      omittedSegmentIds: ["missing-segment"],
      signal: new AbortController().signal,
    });

    expect(result).toMatchObject({ status: "unavailable", reason: "omitted-evidence-stale" });
    expect(runtime.evaluate).not.toHaveBeenCalled();
  });

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

  it("projects only a complete validated selection and preserves source order", async () => {
    const user = message({
      role: "user",
      content: [{ type: "text", text: "Deploy production." }],
    });
    const oldFact = message({
      role: "assistant",
      content: [{ type: "text", text: "Old unrelated weather." }],
    });
    const usefulFact = message({
      role: "assistant",
      content: [{ type: "text", text: "Production uses the current release." }],
    });
    const messages = [user, oldFact, usefulFact];
    const snapshot = buildCompactionSemanticSnapshot({
      messages,
      latestUserAsk: "Deploy production.",
    });
    const discretionary = snapshot.segments.filter((segment) => !segment.protected);
    const runtime = runtimeWithChoices({
      [discretionary[0]!.id]: "drop",
      [discretionary[1]!.id]: "keep",
    });
    const selection = await evaluateCompactionShadowCuration({
      runtime,
      snapshot,
      signal: new AbortController().signal,
    });
    const projected = projectCompactionSemanticSelection({
      messages,
      snapshot,
      selection,
    });

    expect(projected).toEqual([user, usefulFact]);
  });

  it("refuses an incomplete semantic selection", () => {
    const user = message({
      role: "user",
      content: [{ type: "text", text: "Keep this request." }],
    });
    const fact = message({
      role: "assistant",
      content: [{ type: "text", text: "Optional detail." }],
    });
    const messages = [user, fact];
    const snapshot = buildCompactionSemanticSnapshot({
      messages,
      latestUserAsk: "Keep this request.",
    });

    expect(
      projectCompactionSemanticSelection({
        messages,
        snapshot,
        selection: {
          status: "skipped",
          sourceFingerprint: snapshot.sourceFingerprint,
          reason: "test",
          selectedSegmentIds: snapshot.segments.map((segment) => segment.id),
          excludedSegmentIds: [],
          uncertainSegmentIds: [],
          evaluatedSegmentIds: [],
          originalChars: snapshot.originalChars,
          selectedChars: snapshot.originalChars,
          reductionRatio: 0,
          complete: false,
        },
      }),
    ).toBeNull();
  });

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

  it("changes the source fingerprint when judgment-relevant source changes", () => {
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
