import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { LegacyContextEngine } from "../../../context-engine/legacy.js";
import type { AssembleResult } from "../../../context-engine/types.js";
import type { observeSemanticTurnContext } from "../../harness/semantic-turn-context.js";
import {
  cleanupTempPaths,
  createContextEngineAttemptRunner,
  createContextEngineBootstrapAndAssemble,
  preloadRunEmbeddedAttemptForTests,
  resetEmbeddedAttemptHarness,
} from "./attempt-spawn-workspace.test-support.js";

const { observe } = vi.hoisted(() => ({ observe: vi.fn<typeof observeSemanticTurnContext>() }));
vi.mock("../../harness/semantic-turn-context.js", () => ({ observeSemanticTurnContext: observe }));
const tempPaths: string[] = [];

describe("admitted embedded turn-context observation", () => {
  beforeAll(preloadRunEmbeddedAttemptForTests);
  beforeEach(() => {
    resetEmbeddedAttemptHarness();
    observe.mockReset().mockImplementation(async (assembled: AssembleResult, options) => {
      options.assertActive();
      options.signal.throwIfAborted();
      return assembled;
    });
  });
  afterEach(async () => {
    await cleanupTempPaths(tempPaths);
    tempPaths.length = 0;
  });

  it.each(["legacy", "custom"] as const)(
    "reaches the observer from admitted %s runs without plugin capabilities",
    async (kind) => {
      await createContextEngineAttemptRunner({
        contextEngine: createContextEngineBootstrapAndAssemble(),
        sessionKey: `agent:main:context-shadow-${kind}`,
        tempPaths,
        attemptOverrides: {
          ...(kind === "legacy" ? { contextEngine: undefined } : {}),
          config: {
            agents: {
              defaults: {
                experimental: { decisionAssistance: true },
                decisionModel: "fixture/default",
                turnContextCuration: { mode: "shadow", minEstimatedTokens: 1 },
              },
            },
          },
        },
      });
      expect(observe).toHaveBeenCalledOnce();
      const [assembled, options] = observe.mock.calls[0]!;
      expect(assembled.messages).toEqual(
        expect.arrayContaining([expect.objectContaining({ role: "user", content: "seed" })]),
      );
      expect(options.config?.mode).toBe("shadow");
      // Captured owner must become unusable once this admitted run has closed.
      expect(() => options.assertActive()).toThrow();
    },
  );

  it.each(["off", undefined] as const)(
    "keeps mode=%s legacy execution on the original path",
    async (mode) => {
      const assemble = vi.spyOn(LegacyContextEngine.prototype, "assemble");
      await createContextEngineAttemptRunner({
        contextEngine: createContextEngineBootstrapAndAssemble(),
        sessionKey: "agent:main:context-off",
        tempPaths,
        attemptOverrides: {
          contextEngine: undefined,
          config: {
            agents: {
              defaults: {
                experimental: { decisionAssistance: true },
                decisionModel: "fixture/default",
                turnContextCuration: { mode },
              },
            },
          },
        },
      });
      expect(observe).not.toHaveBeenCalled();
      expect(assemble).not.toHaveBeenCalled();
      assemble.mockRestore();
    },
  );
});
