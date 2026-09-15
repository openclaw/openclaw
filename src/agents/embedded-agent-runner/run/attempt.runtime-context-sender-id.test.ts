// The recall path must hand context engines the same runtime identity the
// capture path gets: engines that route recall by senderId silently lose
// per-user namespacing when assemble() receives no runtimeContext.
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { clearMemoryPluginState } from "../../../plugins/memory-state.test-fixtures.js";
import { projectAgentRunAttemptTerminal } from "../../agent-run-terminal-outcome.js";
import type { AttemptContextEngine } from "./attempt-context-engine-helpers.js";
import {
  cleanupTempPaths,
  createContextEngineAttemptRunner,
  getHoisted,
  preloadRunEmbeddedAttemptForTests,
  resetEmbeddedAttemptHarness,
} from "./attempt-spawn-workspace.test-support.js";

const hoisted = getHoisted();

type CapturedRuntimeContext = Record<string, unknown> | undefined;

function capturedComplete(
  runtimeContext: CapturedRuntimeContext,
): ((request: unknown) => Promise<unknown>) | undefined {
  return (runtimeContext?.llm as { complete?: (request: unknown) => Promise<unknown> } | undefined)
    ?.complete;
}

function makeCapturingContextEngine(bucket: {
  assemble: CapturedRuntimeContext[];
  afterTurn: CapturedRuntimeContext[];
}): AttemptContextEngine {
  return {
    info: {
      id: "test-context-engine",
      name: "Test Context Engine",
      version: "0.0.1",
    },
    assemble: async (params) => {
      bucket.assemble.push(params.runtimeContext);
      return { messages: params.messages, estimatedTokens: 1 };
    },
    ingest: async () => ({ ingested: true }),
    compact: async () => ({ ok: true, compacted: false }),
    afterTurn: async (params) => {
      bucket.afterTurn.push(params.runtimeContext);
    },
  };
}

describe("runEmbeddedAttempt runtime context sender identity", () => {
  const sessionKey = "agent:main:guildchat:channel:test-runtime-sender";
  const tempPaths: string[] = [];

  beforeAll(async () => {
    await preloadRunEmbeddedAttemptForTests();
  });

  beforeEach(() => {
    resetEmbeddedAttemptHarness();
    clearMemoryPluginState();
    hoisted.runContextEngineMaintenanceMock.mockReset().mockResolvedValue(undefined);
    hoisted.detectAndLoadPromptImagesMock.mockClear();
  });

  afterEach(async () => {
    await cleanupTempPaths(tempPaths);
    clearMemoryPluginState();
    vi.restoreAllMocks();
  });

  it("threads the attempt sender identity into pre-turn assemble like afterTurn", async () => {
    const captured = { assemble: [], afterTurn: [] } as {
      assemble: CapturedRuntimeContext[];
      afterTurn: CapturedRuntimeContext[];
    };
    const result = await createContextEngineAttemptRunner({
      contextEngine: makeCapturingContextEngine(captured),
      sessionKey,
      tempPaths,
      attemptOverrides: {
        senderId: "user-42",
      },
    });

    expect(projectAgentRunAttemptTerminal(result.terminal).promptError).toBeNull();
    expect(captured.assemble.length).toBeGreaterThan(0);
    expect(captured.assemble[0]?.senderId).toBe("user-42");
    // Recall receives the same executable capability face as capture; the
    // runtime-llm suite owns the proof that its completion policy binding holds.
    expect(capturedComplete(captured.assemble[0])).toBeTypeOf("function");
    expect(captured.afterTurn.length).toBeGreaterThan(0);
    expect(captured.afterTurn[0]?.senderId).toBe("user-42");
  });

  it("revokes retained engine completion authority once the admitting run closes", async () => {
    const captured = { assemble: [], afterTurn: [] } as {
      assemble: CapturedRuntimeContext[];
      afterTurn: CapturedRuntimeContext[];
    };
    const result = await createContextEngineAttemptRunner({
      contextEngine: makeCapturingContextEngine(captured),
      sessionKey,
      tempPaths,
      attemptOverrides: {
        senderId: "user-42",
      },
    });

    expect(projectAgentRunAttemptTerminal(result.terminal).promptError).toBeNull();
    const retainedAssembleComplete = capturedComplete(captured.assemble[0]);
    const retainedAfterTurnComplete = capturedComplete(captured.afterTurn[0]);
    expect(retainedAssembleComplete).toBeTypeOf("function");
    expect(retainedAfterTurnComplete).toBeTypeOf("function");

    // The harness closed the admission before returning, so a callback the
    // engine retained across turns must refuse to act on stale run authority.
    const staleRequest = {
      messages: [{ role: "user", content: "retained call" }],
    } as Parameters<NonNullable<typeof retainedAssembleComplete>>[0];
    await expect(retainedAssembleComplete?.(staleRequest)).rejects.toThrow(
      /admitted run authority is no longer active/u,
    );
    await expect(retainedAfterTurnComplete?.(staleRequest)).rejects.toThrow(
      /admitted run authority is no longer active/u,
    );
  });
});
