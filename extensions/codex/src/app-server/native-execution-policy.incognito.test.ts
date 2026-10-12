import "openclaw/plugin-sdk/compiled-subprocess-testing";
import {
  deleteSessionEntry,
  patchSessionEntry,
  resolveStorePath,
  upsertSessionEntry,
} from "openclaw/plugin-sdk/session-store-runtime";
import { observeHostDataSql } from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { Type } from "typebox";
import { afterEach, expect, it, vi } from "vitest";
import { createCodexDynamicToolBridge } from "./dynamic-tools.js";
import { prepareCodexNativeExecutionPolicy } from "./native-execution-policy.js";
import {
  prepareCodexAppServerDirectSandboxBypassBlock,
  prepareCodexNativeExecutionBlock,
} from "./sandbox-guard.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => vi.unstubAllEnvs());

it("keeps actor execution policy and rejects a retained tool after policy or generation replacement", async () => {
  const env = { OPENCLAW_STATE_DIR: tempDirs.make("codex-actor-policy-") };
  vi.stubEnv("OPENCLAW_STATE_DIR", env.OPENCLAW_STATE_DIR);
  const target = {
    agentId: "main",
    sessionKey: "agent:main:dashboard:incognito-policy",
    storePath: resolveStorePath(undefined, { agentId: "main", env }),
  };
  try {
    await upsertSessionEntry({
      ...target,
      entry: {
        sessionId: "policy-session",
        updatedAt: 1,
        incognito: true,
        execHost: "node",
        execNode: "synthetic-node",
      },
    });
    const sql = observeHostDataSql();
    try {
      const params: Parameters<typeof prepareCodexNativeExecutionPolicy>[0] = {
        config: { tools: { exec: { host: "gateway" as const } } },
        agentId: "main",
        sessionKey: "harness:codex:durable-catalog-key",
        sessionTarget: { ...target },
        readRuntimeSessionEntry: true,
        sandboxAvailable: false,
      };
      const pendingNode = prepareCodexNativeExecutionPolicy(params);
      // Pending preparation retains its captured policy inputs despite later caller changes.
      params.execOverrides = { host: "gateway" };
      params.sessionTarget = { ...target, sessionKey: "agent:main:replacement" };
      const node = await pendingNode;
      expect(node.policy).toMatchObject({
        nativeToolSurfaceAllowed: false,
        effectiveExecHost: "node",
        node: "synthetic-node",
      });
      await patchSessionEntry({ ...target, update: () => ({ execHost: "gateway" }) });
      expect(node.assertCurrent).toThrow("execution policy changed");

      const gateway = await prepareCodexNativeExecutionPolicy({
        ...params,
        sessionTarget: target,
        execOverrides: undefined,
      });
      const execute = vi.fn(async () => ({
        content: [{ type: "text" as const, text: "executed" }],
        details: {},
      }));
      const bridge = createCodexDynamicToolBridge({
        tools: [
          {
            name: "synthetic",
            label: "Synthetic",
            description: "Synthetic effect",
            parameters: Type.Object({}),
            execute,
          },
        ],
        signal: new AbortController().signal,
        assertCurrent: gateway.assertCurrent,
        loading: "direct",
      });
      await patchSessionEntry({
        ...target,
        update: () => ({ sessionId: "replacement-session" }),
      });
      const response = await bridge.handleToolCall({
        threadId: "synthetic-thread",
        turnId: "synthetic-turn",
        callId: "synthetic-call",
        namespace: null,
        tool: "synthetic",
        arguments: {},
      });
      expect(response.success).toBe(false);
      expect(execute).not.toHaveBeenCalled();
      expect(gateway.assertCurrent).toThrow();
      expect(sql.queries).toEqual([]);
    } finally {
      sql.restore();
    }
  } finally {
    await deleteSessionEntry(target);
  }
});

it("guards an explicit private sandbox policy while preserving the catalog key's classification", async () => {
  const env = { OPENCLAW_STATE_DIR: tempDirs.make("codex-actor-sandbox-") };
  vi.stubEnv("OPENCLAW_STATE_DIR", env.OPENCLAW_STATE_DIR);
  const target = {
    agentId: "main",
    sessionKey: "agent:main:dashboard:incognito-sandbox",
    storePath: resolveStorePath(undefined, { agentId: "main", env }),
  };
  try {
    await upsertSessionEntry({
      ...target,
      entry: {
        sessionId: "sandbox-session",
        updatedAt: 1,
        incognito: true,
        sandboxMode: "off",
      },
    });
    const sql = observeHostDataSql();
    try {
      const params: Parameters<typeof prepareCodexNativeExecutionBlock>[0] = {
        config: { agents: { defaults: { sandbox: { mode: "non-main" } } } },
        agentId: "main",
        sessionKey: "harness:codex:durable-catalog-key",
        sessionTarget: target,
        surface: "synthetic native request",
      };
      const native = await prepareCodexNativeExecutionBlock(params);
      const request = await prepareCodexAppServerDirectSandboxBypassBlock({
        ...params,
        method: "turn/start",
      });
      expect(native.block).toBeUndefined();
      expect(request.block).toBeUndefined();
      native.assertCurrent();
      request.assertCurrent();

      await patchSessionEntry({ ...target, update: () => ({ sandboxMode: undefined }) });
      expect(native.assertCurrent).toThrow("execution policy changed");
      expect(request.assertCurrent).toThrow("execution policy changed");
      const blockedNative = await prepareCodexNativeExecutionBlock(params);
      const blockedRequest = await prepareCodexAppServerDirectSandboxBypassBlock({
        ...params,
        method: "turn/start",
      });
      expect(blockedNative.block).toContain("OpenClaw sandboxing is active");
      expect(blockedRequest.block).toContain("OpenClaw sandboxing is active");

      // The source's private key supplies policy, not the independent main/non-main identity.
      const main = await prepareCodexNativeExecutionBlock({
        ...params,
        sessionKey: "agent:main:main",
      });
      expect(main.block).toBeUndefined();
      expect(sql.queries).toEqual([]);
    } finally {
      sql.restore();
    }
  } finally {
    await deleteSessionEntry(target);
  }
});
