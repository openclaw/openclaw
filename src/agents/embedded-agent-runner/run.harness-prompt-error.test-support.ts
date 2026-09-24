import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentHarness } from "../harness/types.js";
import {
  resetSharedRunIntegrationHarnessMocks,
  useOpenAIPlatformAuthFixture,
} from "./run.overflow-compaction.harness.js";
import {
  createSharedRunIntegrationSession,
  loadSharedRunIntegrationHarness,
} from "./run.shared-integration-harness.test-support.js";

describe("harness prompt failure presentation", () => {
  let runEmbeddedAgent: Awaited<ReturnType<typeof loadSharedRunIntegrationHarness>>;
  let registerAgentHarness: typeof import("../harness/registry.js").registerAgentHarness;
  let session: Awaited<ReturnType<typeof createSharedRunIntegrationSession>>;

  beforeAll(async () => {
    runEmbeddedAgent = await loadSharedRunIntegrationHarness();
    ({ registerAgentHarness } = await import("../harness/registry.js"));
  });

  beforeEach(async () => {
    resetSharedRunIntegrationHarnessMocks();
    useOpenAIPlatformAuthFixture();
    session = await createSharedRunIntegrationSession();
  });

  afterEach(async () => {
    await session?.cleanup();
  });

  it.each([
    { known: true, hadPotentialSideEffects: false },
    { known: true, hadPotentialSideEffects: true },
    { known: false, hadPotentialSideEffects: false },
    { known: false, hadPotentialSideEffects: true },
  ])(
    "surfaces a non-replayable harness prompt failure (known: $known, effects: $hadPotentialSideEffects)",
    async ({ known, hadPotentialSideEffects }) => {
      const error = new Error(
        known
          ? "The model `missing-model` does not exist or you do not have access to it."
          : "Opaque provider diagnostic: synthetic-private-detail",
      );
      const runAttempt = vi.fn<AgentHarness["runAttempt"]>(async () =>
        session.makeAttemptResult({
          terminal: { kind: "failed", source: "prompt", error },
          assistantTexts: [],
          replayMetadata: { replaySafe: false, hadPotentialSideEffects },
        }),
      );
      registerAgentHarness({
        id: "terminal-error-fixture",
        label: "Terminal error fixture",
        supports: () => ({ supported: true }),
        runAttempt,
      });

      const result = await runEmbeddedAgent({
        ...session.runParams,
        provider: "openai",
        model: "missing-model",
        agentHarnessId: "terminal-error-fixture",
      });

      expect(runAttempt).toHaveBeenCalledOnce();
      expect(result.meta.error).toMatchObject({ message: error.message, fallbackSafe: false });
      expect(result.payloads).toHaveLength(1);
      expect(result.payloads?.[0]?.isError).toBe(true);
      const text = result.payloads?.[0]?.text;
      expect(text).toContain(
        known ? "selected model is unavailable from the provider" : "couldn't generate a response",
      );
      expect(text).not.toContain(error.message);
      if (known) {
        expect(text).toContain(
          "Select an available model or update the model configuration, then try again.",
        );
      }
      if (hadPotentialSideEffects) {
        expect(text).toContain("some tool actions may have already been executed");
        expect(text).toContain("verify before retrying");
      }
    },
  );
});
