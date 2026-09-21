import { Type } from "typebox";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { codeModeSwarmHandlers } from "./code-mode-swarm.runtime.js";
import type { ToolSearchToolContext } from "./tool-search-types.js";
import { waitForCollectorCompletion } from "./tools/agents-wait-tool.js";

const state = vi.hoisted(() => ({
  enabled: true,
  blocked: false,
  groupReads: 0,
  existing: undefined as
    | undefined
    | {
        runId: string;
        childSessionKey: string;
        swarmLaunchRequestFingerprint: string;
      },
}));

vi.mock("../sessions/session-lifecycle-events.js", () => ({
  emitSessionLifecycleEvent: vi.fn(),
}));
vi.mock("./agent-tool-source-execution-guard.js", () => ({
  captureAgentToolSourceExecutionGuard: (signal?: AbortSignal) => () => signal?.throwIfAborted(),
  runAgentToolSourceExecutionGuard: () => {
    if (state.blocked) {
      throw new Error("source revoked");
    }
  },
}));
vi.mock("./subagents/registry/subagent-registry.js", () => ({
  getSwarmRunByLaunchReplayKey: () => state.existing,
  initSubagentRegistry: vi.fn(),
  listSwarmRunsForGroup: () => {
    state.groupReads += 1;
    return [];
  },
}));
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
vi.mock("./subagents/swarm/swarm-config.js", () => ({
  resolveSwarmConfig: () => ({ enabled: state.enabled }),
}));
vi.mock("./tool-policy-shared.js", () => ({
  isToolExecutionAllowed: (allow: readonly string[], name: string) => allow.includes(name),
}));
vi.mock("./tools/agents-wait-tool.js", () => ({
  waitForCollectorCompletion: vi.fn(),
}));
vi.mock("./tools/common.js", () => ({
  ToolInputError: class ToolInputError extends Error {},
}));
vi.mock("./tools/sessions-resolution.js", () => ({
  resolveMainSessionAlias: () => ({ mainKey: "main", alias: "main" }),
  resolveInternalSessionKey: ({ key }: { key: string }) => key,
}));

function setup(dynamics?: unknown) {
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
        args: ["Check the candidate", dynamics === undefined ? {} : { dynamics }],
      },
    },
  };
}

beforeEach(() => {
  state.enabled = true;
  state.blocked = false;
  state.groupReads = 0;
  state.existing = undefined;
  vi.mocked(waitForCollectorCompletion).mockReset();
});

describe("dynamics through the actual native spawn bridge", () => {
  it("dispatches a filtered sandbox-required verifier through the existing native tool", async () => {
    const fixture = setup({
      profile: "independent-verifier",
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
    const fixture = setup({ profile: "explorer" });
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
    const fixture = setup({ profile: "explorer" });
    fixture.callExactId.mockImplementation(async () => {
      state.blocked = true;
      return { result: { details: { status: "accepted", runId: "child-run" } } };
    });
    await expect(codeModeSwarmHandlers.agentSpawn(fixture.params)).rejects.toThrow(
      "source revoked",
    );
  });

  it("rejects an inherited profile before dispatch", async () => {
    const fixture = setup({ profile: "constructor" });
    await expect(codeModeSwarmHandlers.agentSpawn(fixture.params)).rejects.toThrow(
      "Unknown cognitive dynamics profile",
    );
    expect(fixture.callExactId).not.toHaveBeenCalled();
  });

  it("keeps tracking across a recoverable wait error", async () => {
    const fixture = setup({ profile: "explorer" });
    await codeModeSwarmHandlers.agentSpawn(fixture.params);
    vi.mocked(waitForCollectorCompletion)
      .mockRejectedValueOnce(new Error("not found"))
      .mockResolvedValueOnce({
        runId: "child-run",
        status: "done",
        result: "done",
        sessionKey: "agent:main:child",
      });

    const waitParams = {
      request: {
        id: "wait-1",
        method: "agentWait" as const,
        args: ["child-run"],
      },
      ctx: fixture.ctx,
    };
    await expect(codeModeSwarmHandlers.agentWait(waitParams)).rejects.toThrow("not found");
    await expect(codeModeSwarmHandlers.agentWait(waitParams)).resolves.toMatchObject({
      status: "done",
    });
    expect(state.groupReads).toBe(1);
  });

  it("releases tracking when the owning parent catalog is disposed", async () => {
    const fixture = setup({ profile: "explorer" });
    await codeModeSwarmHandlers.agentSpawn(fixture.params);
    expect(fixture.ctx.catalogRef?.onDispose?.size).toBe(1);

    fixture.ctx.catalogRef?.onDispose?.forEach((dispose) => dispose());
    expect(fixture.ctx.catalogRef?.onDispose?.size).toBe(0);

    vi.mocked(waitForCollectorCompletion).mockResolvedValue({
      runId: "child-run",
      status: "done",
      result: "done",
      sessionKey: "agent:main:child",
    });
    await expect(
      codeModeSwarmHandlers.agentWait({
        request: {
          id: "wait-1",
          method: "agentWait" as const,
          args: ["child-run"],
        },
        ctx: fixture.ctx,
      }),
    ).resolves.toMatchObject({ status: "done" });
    expect(state.groupReads).toBe(0);
  });

  it("does not silently downgrade a sandbox-required spawn rejected by the owner", async () => {
    const fixture = setup({
      profile: "independent-verifier",
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
