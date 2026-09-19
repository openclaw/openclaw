import { beforeEach, describe, expect, it, vi } from "vitest";
import { createOperationalRunInstanceRef } from "../../admitted-run-context.js";
import { makeEmbeddedRunnerAttempt } from "../../test-helpers/embedded-agent-runner-e2e-fixtures.js";
import {
  getCoreTtsAttemptResultMediaUrls,
  markCoreTtsAttemptResult,
} from "../../tools/tts-tool-result-provenance.js";
import { runEmbeddedAttemptWithBackend } from "./backend.js";

const harnessMocks = vi.hoisted(() => ({
  runAttempt: vi.fn(),
}));

vi.mock("../../harness/selection.js", () => ({
  runAgentHarnessAttempt: harnessMocks.runAttempt,
  runAgentHarnessSettledTurnFinalization: vi.fn(),
}));

describe("embedded attempt backend", () => {
  beforeEach(() => {
    harnessMocks.runAttempt.mockReset();
  });

  it("carries child receipts across model candidates only for the same admitted instance", async () => {
    const instance = createOperationalRunInstanceRef("parent");
    const accepted = {
      runId: "child",
      childSessionKey: "agent:main:subagent:child",
      expectsCompletionMessage: true,
    };
    harnessMocks.runAttempt
      .mockResolvedValueOnce(makeEmbeddedRunnerAttempt({ acceptedSessionSpawns: [accepted] }))
      .mockResolvedValueOnce(makeEmbeddedRunnerAttempt({}))
      .mockResolvedValueOnce(makeEmbeddedRunnerAttempt({}));
    await runEmbeddedAttemptWithBackend({
      modelId: "first-model",
      admittedRunContext: { operationalRunInstance: instance },
    } as never);
    const fallback = await runEmbeddedAttemptWithBackend({
      modelId: "second-model",
      admittedRunContext: { operationalRunInstance: instance },
    } as never);
    const replacement = await runEmbeddedAttemptWithBackend({
      admittedRunContext: { operationalRunInstance: createOperationalRunInstanceRef("parent") },
    } as never);
    expect(fallback.acceptedSessionSpawns).toEqual([accepted]);
    expect(replacement.acceptedSessionSpawns ?? []).toEqual([]);
  });

  it.each(["openclaw", "codex"])(
    "does not trust attempt-supplied settlement from %s",
    async (agentHarnessId) => {
      harnessMocks.runAttempt.mockResolvedValueOnce(
        makeEmbeddedRunnerAttempt({
          agentHarnessId,
          yieldDetected: true,
          requesterContinuationSettled: true,
          acceptedSessionSpawns: [{ runId: "child", childSessionKey: "agent:main:subagent:child" }],
        }),
      );
      const result = await runEmbeddedAttemptWithBackend({
        admittedRunContext: { operationalRunInstance: createOperationalRunInstanceRef("test") },
      } as never);
      expect(result.requesterContinuationSettled).toBeUndefined();
      expect(result.acceptedSessionSpawns).toEqual([
        { runId: "child", childSessionKey: "agent:main:subagent:child" },
      ]);
    },
  );

  it.each([true, false])(
    "keeps runtime model selection only for prepared ownership (%s)",
    async (runtimeOwned) => {
      const selection = { provider: "native-provider", model: "native-model" };
      harnessMocks.runAttempt.mockResolvedValueOnce({
        agentHarnessId: "native-runtime",
        runtimeModelSelection: selection,
      });
      const nativeRuntime: NonNullable<Parameters<typeof runEmbeddedAttemptWithBackend>[1]> = {
        harness: {
          id: "native-runtime",
          label: "Native runtime",
          supports: () => ({ supported: true }),
          runAttempt: async () => {
            throw new Error("unexpected direct harness call");
          },
        },
        auth: "native",
        assertCurrent: async () => {},
      };
      const result = await runEmbeddedAttemptWithBackend(
        {
          admittedRunContext: { operationalRunInstance: createOperationalRunInstanceRef("test") },
        } as never,
        runtimeOwned ? nativeRuntime : undefined,
      );
      if (runtimeOwned) {
        expect(result).toMatchObject({ runtimeModelSelection: selection });
      } else {
        expect(result).not.toHaveProperty("runtimeModelSelection");
      }
    },
  );

  it("preserves core TTS delivery provenance through backend projection", async () => {
    const operationalRunInstance = {};
    const attempt = markCoreTtsAttemptResult(
      {
        agentHarnessId: "openclaw",
        toolMediaUrls: ["/tmp/reply.opus"],
      },
      ["/tmp/reply.opus"],
      operationalRunInstance,
    );
    harnessMocks.runAttempt.mockResolvedValueOnce(attempt);

    const result = await runEmbeddedAttemptWithBackend({
      admittedRunContext: { operationalRunInstance: createOperationalRunInstanceRef("test") },
    } as never);

    expect(
      getCoreTtsAttemptResultMediaUrls(result, result.toolMediaUrls, operationalRunInstance),
    ).toEqual(["/tmp/reply.opus"]);
  });

  it.each([
    {
      name: "replaces stale harness provenance",
      credentialSource: {
        kind: "direct" as const,
        evidence: "environment" as const,
        authorization: "ambient" as const,
      },
      expected: {
        provider: "groq",
        model: "openai/gpt-oss-120b",
        credentialSource: {
          kind: "direct",
          evidence: "environment",
          authorization: "ambient",
        },
      },
    },
    {
      name: "clears provenance when the runtime does not own auth selection",
      credentialSource: undefined,
      expected: undefined,
    },
  ])("$name", async ({ credentialSource, expected }) => {
    harnessMocks.runAttempt.mockResolvedValueOnce({
      agentHarnessId: "openclaw",
      modelAttempt: {
        provider: "stale-provider",
        model: "stale-model",
        credentialSource: { kind: "profile" },
      },
    });

    const result = await runEmbeddedAttemptWithBackend({
      admittedRunContext: { operationalRunInstance: createOperationalRunInstanceRef("test") },
      runtimePlan: {
        resolvedRef: { provider: "groq", modelId: "openai/gpt-oss-120b" },
        auth: credentialSource ? { credentialSource } : {},
      },
    } as never);

    expect(result.modelAttempt).toEqual(expected);
  });
});
