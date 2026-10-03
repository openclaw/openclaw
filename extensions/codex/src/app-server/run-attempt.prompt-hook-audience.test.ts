import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  createParams,
  createStartedThreadHarness,
  runCodexAppServerAttempt,
  setupRunAttemptTestHooks,
  tempDir,
} from "./run-attempt-test-harness.js";
import { attachSqliteSessionTarget } from "./sqlite-session.test-helpers.js";

const hoisted = vi.hoisted(() => ({ promptHookContexts: [] as Array<Record<string, unknown>> }));

// Records the hook context the Codex adapter hands to the shared prompt-build helper.
// The fixture audience is not host-minted, so it is removed before delegating; the
// shared builder's currency guard is covered by core tests.
vi.mock("openclaw/plugin-sdk/agent-harness-runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/agent-harness-runtime")>();
  return {
    ...actual,
    resolveAgentHarnessBeforePromptBuildResult: (
      params: Parameters<typeof actual.resolveAgentHarnessBeforePromptBuildResult>[0],
    ) => {
      hoisted.promptHookContexts.push({ ...params.ctx });
      const { memoryAudience: _fixtureAudience, ...ctx } = params.ctx;
      return actual.resolveAgentHarnessBeforePromptBuildResult({ ...params, ctx });
    },
  };
});

setupRunAttemptTestHooks();

type MemoryAudience = NonNullable<ReturnType<typeof createParams>["memoryAudience"]>;

async function runWithAudience(memoryAudience: MemoryAudience) {
  hoisted.promptHookContexts.length = 0;
  const sessionId = "prompt-hook-audience";
  const params = createParams(`agent:main:${sessionId}`, path.join(tempDir, "workspace"));
  await attachSqliteSessionTarget(params, path.join(tempDir, "session.sqlite"), sessionId);
  params.prompt = "hello";
  params.memoryAudience = memoryAudience;
  const harness = createStartedThreadHarness();
  const run = runCodexAppServerAttempt(params);
  await harness.waitForMethod("turn/start");
  await harness.completeTurn({ threadId: "thread-1", turnId: "turn-1" });
  await run;
  return hoisted.promptHookContexts;
}

describe("Codex prompt-hook memory audience", () => {
  it("forwards the turn's exact memory audience and sandbox state to prompt hooks", async () => {
    const audience = Object.freeze({ kind: "owner-private", agentId: "main" }) as MemoryAudience;
    const contexts = await runWithAudience(audience);

    expect(contexts.length).toBeGreaterThan(0);
    for (const ctx of contexts) {
      expect(ctx.memoryAudience).toBe(audience);
      expect(ctx.sandboxed).toBe(false);
    }
  });
});
