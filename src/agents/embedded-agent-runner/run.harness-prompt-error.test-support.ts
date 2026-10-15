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
  let AgentHarnessPreflightError: typeof import("../harness/errors.js").AgentHarnessPreflightError;
  let session: Awaited<ReturnType<typeof createSharedRunIntegrationSession>>;

  beforeAll(async () => {
    runEmbeddedAgent = await loadSharedRunIntegrationHarness();
    ({ registerAgentHarness } = await import("../harness/registry.js"));
    ({ AgentHarnessPreflightError } = await import("../harness/errors.js"));
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
    { known: true, preflight: false, hadPotentialSideEffects: false },
    { known: false, preflight: false, hadPotentialSideEffects: true },
    { known: false, preflight: true, hadPotentialSideEffects: true },
  ])(
    "surfaces a non-replayable harness prompt failure (known: $known, preflight: $preflight, effects: $hadPotentialSideEffects)",
    async ({ known, preflight, hadPotentialSideEffects }) => {
      const userMessage =
        "Agents API currently requires the original API key to send input to this hosted session. Restore that key, then retry to continue the same session.";
      const error = preflight
        ? new AgentHarnessPreflightError(
            "403 hosted session input requires the API key that created its CCA thread",
            { userMessage },
          )
        : new Error(
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
        preflight
          ? userMessage
          : known
            ? "This model was not found."
            : "couldn't generate a response",
      );
      expect(text).not.toContain(error.message);
      if (known) {
        expect(text).toContain(
          "Choose another model in the Control UI or run `openclaw configure`.",
        );
      }
      if (hadPotentialSideEffects) {
        expect(text).toContain("some tool actions may have already been executed");
        expect(text).toContain("verify before retrying");
      }
    },
  );
});
