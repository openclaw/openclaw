import os from "node:os";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createSubagentSpawnTestConfig,
  loadSubagentSpawnModuleForTest,
} from "./subagent-spawn.test-helpers.js";

// Covers the gap that mofolo's #64864 hook cannot fill on its own: when the
// tool-wiring layer (pi-tools / tool-resolution) doesn't populate
// ctx.agent{To,ThreadId} on the spawn call (e.g. router-style top-level-agent
// flows where the current invocation isn't a fresh inbound), the spawned child
// must still inherit the parent session's stored deliveryContext so outbound
// replies route back to the originating thread.

const hoisted = vi.hoisted(() => ({
  callGatewayMock: vi.fn(),
  updateSessionStoreMock: vi.fn(),
  configOverride: {} as Record<string, unknown>,
  parentEntry: undefined as Record<string, unknown> | undefined,
}));

let spawnSubagentDirect: typeof import("./subagent-spawn.js").spawnSubagentDirect;
let resetSubagentRegistryForTests: typeof import("./subagent-registry.js").resetSubagentRegistryForTests;

function configWithMain() {
  return createSubagentSpawnTestConfig(os.tmpdir(), {
    agents: {
      defaults: { workspace: os.tmpdir() },
      list: [{ id: "main", workspace: "/tmp/workspace-main" }],
    },
  });
}

function captureSessionsPatchForChild(childKeyPattern: RegExp) {
  const patches: Array<Record<string, unknown>> = [];
  hoisted.callGatewayMock.mockImplementation(
    async (request: { method?: string; params?: unknown }) => {
      if (request.method === "agent") {
        return { runId: "run-1" };
      }
      if (request.method === "sessions.patch") {
        const params = request.params as { key?: string } & Record<string, unknown>;
        if (typeof params?.key === "string" && childKeyPattern.test(params.key)) {
          patches.push(params);
        }
        return { ok: true };
      }
      if (request.method?.startsWith("sessions.")) {
        return { ok: true };
      }
      return { ok: true };
    },
  );
  return patches;
}

describe("spawnSubagentDirect parent-context backfill", () => {
  beforeAll(async () => {
    ({ spawnSubagentDirect, resetSubagentRegistryForTests } = await loadSubagentSpawnModuleForTest({
      callGatewayMock: hoisted.callGatewayMock,
      loadConfig: () => hoisted.configOverride,
      updateSessionStoreMock: hoisted.updateSessionStoreMock,
      resolveAgentConfig: () => undefined,
      resolveSubagentSpawnModelSelection: () => "openai-codex/gpt-5.4",
      resolveSandboxRuntimeStatus: () => ({ sandboxed: false }),
      sessionStorePath: "/tmp/subagent-spawn-backfill.json",
      resetModules: false,
      parentSessionEntry: undefined,
    }));
  });

  beforeEach(() => {
    resetSubagentRegistryForTests();
    hoisted.callGatewayMock.mockReset();
    hoisted.updateSessionStoreMock.mockReset();
    hoisted.configOverride = configWithMain();
    hoisted.parentEntry = undefined;

    hoisted.updateSessionStoreMock.mockImplementation(
      async (
        _storePath: string,
        mutator: (store: Record<string, Record<string, unknown>>) => unknown,
      ) => {
        const store: Record<string, Record<string, unknown>> = {};
        await mutator(store);
        return store;
      },
    );
  });

  it("inherits parent deliveryContext when ctx.agent{To,ThreadId} are absent", async () => {
    // Reload the module with a parent entry that mimics a Slack thread session.
    ({ spawnSubagentDirect, resetSubagentRegistryForTests } = await loadSubagentSpawnModuleForTest({
      callGatewayMock: hoisted.callGatewayMock,
      loadConfig: () => hoisted.configOverride,
      updateSessionStoreMock: hoisted.updateSessionStoreMock,
      resolveAgentConfig: () => undefined,
      resolveSubagentSpawnModelSelection: () => "openai-codex/gpt-5.4",
      resolveSandboxRuntimeStatus: () => ({ sandboxed: false }),
      sessionStorePath: "/tmp/subagent-spawn-backfill.json",
      resetModules: true,
      parentSessionEntry: {
        deliveryContext: {
          channel: "slack",
          to: "channel:C0ACJ9D6E4W",
          threadId: "1775970111.589749",
        },
      },
    }));

    const patches = captureSessionsPatchForChild(/^agent:main:subagent:/);

    const result = await spawnSubagentDirect(
      {
        task: "do thing",
        runTimeoutSeconds: 1,
        cleanup: "keep",
      },
      {
        agentSessionKey: "main",
        // Intentionally omit agentTo / agentThreadId — this is the failure mode.
      },
    );

    expect(result.status).toBe("accepted");

    const initialPatch = patches[0];
    expect(initialPatch).toBeDefined();
    expect(initialPatch).toMatchObject({
      deliveryContext: {
        channel: "slack",
        to: "channel:C0ACJ9D6E4W",
        threadId: "1775970111.589749",
      },
      lastChannel: "slack",
      lastTo: "channel:C0ACJ9D6E4W",
      lastThreadId: "1775970111.589749",
    });
  });

  it("does not cross channels when ctx and parent disagree", async () => {
    ({ spawnSubagentDirect, resetSubagentRegistryForTests } = await loadSubagentSpawnModuleForTest({
      callGatewayMock: hoisted.callGatewayMock,
      loadConfig: () => hoisted.configOverride,
      updateSessionStoreMock: hoisted.updateSessionStoreMock,
      resolveAgentConfig: () => undefined,
      resolveSubagentSpawnModelSelection: () => "openai-codex/gpt-5.4",
      resolveSandboxRuntimeStatus: () => ({ sandboxed: false }),
      sessionStorePath: "/tmp/subagent-spawn-backfill.json",
      resetModules: true,
      parentSessionEntry: {
        deliveryContext: {
          channel: "slack",
          to: "channel:C0ACJ9D6E4W",
          threadId: "1775970111.589749",
        },
      },
    }));

    const patches = captureSessionsPatchForChild(/^agent:main:subagent:/);

    const result = await spawnSubagentDirect(
      {
        task: "do thing",
        runTimeoutSeconds: 1,
        cleanup: "keep",
      },
      {
        agentSessionKey: "main",
        agentChannel: "discord",
        // No discord to/threadId — and parent's slack to/threadId must NOT leak.
      },
    );

    expect(result.status).toBe("accepted");

    const initialPatch = patches[0];
    expect(initialPatch).toBeDefined();
    // mergeDeliveryContext's channelsConflict guard drops the parent's
    // route fields when channels disagree.
    expect(initialPatch?.deliveryContext).toMatchObject({ channel: "discord" });
    expect((initialPatch?.deliveryContext as Record<string, unknown>)?.to).toBeUndefined();
    expect((initialPatch?.deliveryContext as Record<string, unknown>)?.threadId).toBeUndefined();
  });

  it("ctx values win over parent deliveryContext when both are present", async () => {
    ({ spawnSubagentDirect, resetSubagentRegistryForTests } = await loadSubagentSpawnModuleForTest({
      callGatewayMock: hoisted.callGatewayMock,
      loadConfig: () => hoisted.configOverride,
      updateSessionStoreMock: hoisted.updateSessionStoreMock,
      resolveAgentConfig: () => undefined,
      resolveSubagentSpawnModelSelection: () => "openai-codex/gpt-5.4",
      resolveSandboxRuntimeStatus: () => ({ sandboxed: false }),
      sessionStorePath: "/tmp/subagent-spawn-backfill.json",
      resetModules: true,
      parentSessionEntry: {
        deliveryContext: {
          channel: "slack",
          to: "channel:STALE",
          threadId: "1700000000.000000",
        },
      },
    }));

    const patches = captureSessionsPatchForChild(/^agent:main:subagent:/);

    const result = await spawnSubagentDirect(
      {
        task: "do thing",
        runTimeoutSeconds: 1,
        cleanup: "keep",
      },
      {
        agentSessionKey: "main",
        agentChannel: "slack",
        agentTo: "channel:CURRENT",
        agentThreadId: "1776000000.111111",
      },
    );

    expect(result.status).toBe("accepted");

    const initialPatch = patches[0];
    expect(initialPatch).toBeDefined();
    expect(initialPatch?.deliveryContext).toMatchObject({
      channel: "slack",
      to: "channel:CURRENT",
      threadId: "1776000000.111111",
    });
  });
});
