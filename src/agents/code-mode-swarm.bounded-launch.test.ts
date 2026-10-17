import { Type } from "typebox";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { codeModeSwarmHandlers } from "./code-mode-swarm.runtime.js";
import type { ToolSearchToolContext } from "./tool-search-types.js";

const state = vi.hoisted(() => ({
  enabled: true,
  blocked: false,
  existing: undefined as
    | undefined
    | {
        runId: string;
        childSessionKey: string;
        swarmLaunchRequestFingerprint: string;
      },
}));

// mock-isolation: Keep session lifecycle side effects outside the launch-bridge unit fixture.
vi.mock("../sessions/session-lifecycle-events.js", () => ({
  emitSessionLifecycleEvent: vi.fn(),
}));
// mock-isolation: Drive source revocation deterministically without loading ambient guard state.
vi.mock("./agent-tool-source-execution-guard.js", () => ({
  captureAgentToolSourceExecutionGuard: (signal?: AbortSignal) => () => signal?.throwIfAborted(),
  runAgentToolSourceExecutionGuard: () => {
    if (state.blocked) {
      throw new Error("source revoked");
    }
  },
}));
// mock-isolation: Keep persistent collector registry state outside the launch-bridge unit fixture.
vi.mock("./subagents/registry/subagent-registry.js", () => ({
  getSwarmRunByLaunchReplayKey: () => state.existing,
  initSubagentRegistry: vi.fn(),
}));
// mock-isolation: Exercise joined-collector behavior without admitting scheduler or registry state.
vi.mock("./subagents/swarm/swarm-collector-capability.js", () => ({
  isCollectorSpawnTool: () => true,
  runWithJoinedCollectorSpawn: async (
    _tool: unknown,
    check: () => void,
    run: () => Promise<unknown>,
  ) => {
    check();
    return await run();
  },
}));
// mock-isolation: Use deterministic swarm enablement and concurrency without ambient config resolution.
vi.mock("./subagents/swarm/swarm-config.js", () => ({
  resolveSwarmConfig: () => ({ enabled: state.enabled, maxConcurrent: 4 }),
}));
// mock-isolation: Control allow/deny behavior locally without process-wide tool policy state.
vi.mock("./tool-policy-shared.js", () => ({
  isToolExecutionAllowed: (allow: readonly string[], name: string) => allow.includes(name),
}));
// mock-isolation: Collector completion is outside these launch-only bridge cases.
vi.mock("./tools/agents-wait-tool.js", () => ({
  waitForCollectorCompletion: vi.fn(),
}));
// mock-isolation: Use a local input-error type without loading unrelated tool runtime state.
vi.mock("./tools/common.js", () => ({
  ToolInputError: class ToolInputError extends Error {},
}));
// mock-isolation: Resolve synthetic session keys without opening session-store state.
vi.mock("./tools/sessions-resolution.js", () => ({
  resolveMainSessionAlias: () => ({ mainKey: "main", alias: "main" }),
  resolveInternalSessionKey: ({ key }: { key: string }) => key,
}));

function setup(boundedLaunch?: unknown, options: Record<string, unknown> = {}) {
  const tool = {
    name: "sessions_spawn",
    label: "Sessions",
    description: "Native collector",
    parameters: Type.Object({}),
    execute: vi.fn(),
  };
  const ctx: ToolSearchToolContext = {
    agentId: "main",
    sessionKey: "agent:main:main",
    runId: "parent-run",
    catalogRef: {
      current: {
        counterScope: "test",
        searchCount: 0,
        describeCount: 0,
        callCount: 0,
        entries: [
          {
            id: "native-spawn",
            source: "openclaw",
            name: "sessions_spawn",
            description: "Native collector",
            tool,
          },
        ],
      },
    },
  };
  const callExactId = vi
    .fn()
    .mockResolvedValue({ result: { details: { status: "accepted", runId: "child-run" } } });
  return {
    ctx,
    callExactId,
    params: {
      runtime: { callExactId },
      parentToolCallId: "tool-call",
      codeModeRunId: "code-run",
      ctx,
      request: {
        id: "request-1",
        method: "agentSpawn" as const,
        args: [
          "Check the candidate",
          { ...options, ...(boundedLaunch === undefined ? {} : { boundedLaunch }) },
        ],
      },
    },
  };
}

beforeEach(() => {
  state.enabled = true;
  state.blocked = false;
  state.existing = undefined;
});

describe("bounded launch through the actual native spawn bridge", () => {
  it("dispatches a filtered sandbox-required verifier through the existing native tool", async () => {
    const fixture = setup({
      boundary: "artifact-only",
      requirements: {
        sandbox: "require",
        candidateDigest: "required",
        artifactRefs: "required",
      },
      handoff: {
        candidateDigest: "candidate:a",
        artifactRefs: ["artifact:a"],
        summary: "builder-secret-rationale",
      },
    });
    await codeModeSwarmHandlers.agentSpawn(fixture.params);
    const input = fixture.callExactId.mock.calls[0]![1];
    expect(input).toMatchObject({
      collect: true,
      context: "isolated",
      sandbox: "require",
    });
    expect(input.task).not.toContain("builder-secret-rationale");
    expect(input.task).toContain("artifact:a");
  });

  it("composes with heterogeneous target agents, models, and reasoning levels", async () => {
    const cheap = setup(
      { boundary: "isolated" },
      {
        label: "cheap-explorer",
        agentId: "explorer",
        model: "provider/fast-model",
        thinking: "low",
        fastMode: true,
      },
    );
    await codeModeSwarmHandlers.agentSpawn(cheap.params);
    expect(cheap.callExactId.mock.calls[0]![1]).toMatchObject({
      label: "cheap-explorer",
      agentId: "explorer",
      model: "provider/fast-model",
      thinking: "low",
      fastMode: true,
    });

    const deep = setup(
      { boundary: "evidence-only" },
      {
        label: "deep-discriminator",
        agentId: "verifier",
        model: "provider/deep-model",
        thinking: "high",
        fastMode: false,
      },
    );
    await codeModeSwarmHandlers.agentSpawn(deep.params);
    expect(deep.callExactId.mock.calls[0]![1]).toMatchObject({
      label: "deep-discriminator",
      agentId: "verifier",
      model: "provider/deep-model",
      thinking: "high",
      fastMode: false,
    });
  });

  it("leaves legacy calls untouched", async () => {
    const fixture = setup();
    await codeModeSwarmHandlers.agentSpawn(fixture.params);
    expect(fixture.callExactId.mock.calls[0]![1]).toMatchObject({
      task: "Check the candidate",
      collect: true,
    });
    expect(fixture.callExactId.mock.calls[0]![1].sandbox).toBeUndefined();
  });

  it("does not dispatch on disabled swarm, denied policy, or revoked source", async () => {
    const fixture = setup({ boundary: "isolated" });
    state.enabled = false;
    await expect(codeModeSwarmHandlers.agentSpawn(fixture.params)).rejects.toThrow();
    state.enabled = true;
    fixture.ctx.toolExecutionAllow = [];
    await expect(codeModeSwarmHandlers.agentSpawn(fixture.params)).rejects.toThrow();
    fixture.ctx.toolExecutionAllow = ["sessions_spawn"];
    state.blocked = true;
    await expect(codeModeSwarmHandlers.agentSpawn(fixture.params)).rejects.toThrow(
      "source revoked",
    );
    expect(fixture.callExactId).not.toHaveBeenCalled();
  });

  it("rechecks the source after awaited dispatch", async () => {
    const fixture = setup({ boundary: "isolated" });
    fixture.callExactId.mockImplementation(async () => {
      state.blocked = true;
      return { result: { details: { status: "accepted", runId: "child-run" } } };
    });
    await expect(codeModeSwarmHandlers.agentSpawn(fixture.params)).rejects.toThrow(
      "source revoked",
    );
  });

  it("rejects an invalid bounded launch boundary before dispatch", async () => {
    const fixture = setup({ boundary: "constructor" });
    await expect(codeModeSwarmHandlers.agentSpawn(fixture.params)).rejects.toThrow(
      "boundedLaunch.boundary must be",
    );
    expect(fixture.callExactId).not.toHaveBeenCalled();
  });

  it("does not silently downgrade a sandbox-required spawn rejected by the owner", async () => {
    const fixture = setup({
      boundary: "artifact-only",
      requirements: {
        sandbox: "require",
        candidateDigest: "required",
        artifactRefs: "required",
      },
      handoff: {
        candidateDigest: "candidate:a",
        artifactRefs: ["artifact:a"],
      },
    });
    fixture.callExactId.mockResolvedValue({
      result: {
        details: {
          status: "forbidden",
          error: "sandbox unavailable",
        },
      },
    });
    await expect(codeModeSwarmHandlers.agentSpawn(fixture.params)).rejects.toThrow(
      "sandbox unavailable",
    );
    expect(fixture.callExactId).toHaveBeenCalledTimes(1);
  });
});
