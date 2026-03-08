import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import plugin from "./index.js";

function createPolicyFileName(): string {
  return path.join(
    os.tmpdir(),
    `openclaw-governance-policy-${Date.now()}-${Math.random().toString(36).slice(2)}.json`,
  );
}

type HookMap = Record<string, (event: unknown, ctx: unknown) => Promise<unknown> | unknown>;

function createApi(params?: { pluginConfig?: Record<string, unknown> }) {
  const hooks: HookMap = {};
  const api = {
    id: "frankos-governance",
    name: "FrankOS Governance",
    pluginConfig: params?.pluginConfig ?? {},
    config: {},
    runtime: {
      events: {
        emitDiagnosticEvent: vi.fn(),
      },
    },
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    },
    on: vi.fn((hookName: string, handler: HookMap[string]) => {
      hooks[hookName] = handler;
    }),
  };
  return { api, hooks };
}

describe("frankos-governance plugin", () => {
  const cleanupFiles: string[] = [];

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(async () => {
    await Promise.all(cleanupFiles.map((file) => fs.rm(file, { force: true })));
    cleanupFiles.length = 0;
  });

  it("registers before_tool_call hook", () => {
    const { api } = createApi();
    plugin.register(api as never);
    expect(api.on).toHaveBeenCalledWith("before_tool_call", expect.any(Function));
  });

  it("off mode permits mutating actions without governance diagnostics", async () => {
    const policyFile = createPolicyFileName();
    cleanupFiles.push(policyFile);
    await fs.writeFile(
      policyFile,
      JSON.stringify({
        version: "1.0.0",
        rules: [
          {
            id: "deny-write",
            priority: 100,
            match: { toolName: "write" },
            decision: "prohibit",
            reasonCode: "NO_DIRECT_WRITE",
          },
        ],
      }),
    );

    const { api, hooks } = createApi({
      pluginConfig: {
        mode: "off",
        policyFile,
      },
    });
    plugin.register(api as never);

    const result = await hooks.before_tool_call?.(
      {
        toolName: "write",
        params: { path: "/tmp/off-mode.md", content: "hello" },
        runId: "run-off",
      },
      { sessionId: "session-off", sessionKey: "main:off" },
    );

    expect(result).toBeUndefined();
    expect(api.runtime.events.emitDiagnosticEvent).not.toHaveBeenCalled();
  });

  it("shadow mode allows prohibited action and emits governance telemetry", async () => {
    const policyFile = createPolicyFileName();
    cleanupFiles.push(policyFile);
    await fs.writeFile(
      policyFile,
      JSON.stringify({
        version: "1.0.0",
        rules: [
          {
            id: "deny-write",
            priority: 100,
            match: { toolName: "write" },
            decision: "prohibit",
            reasonCode: "NO_DIRECT_WRITE",
            reasonText: "Direct writes require approval",
          },
        ],
      }),
    );

    const { api, hooks } = createApi({
      pluginConfig: {
        mode: "shadow",
        policyFile,
      },
    });
    plugin.register(api as never);

    const result = await hooks.before_tool_call?.(
      {
        toolName: "write",
        params: { path: "/tmp/a.md", content: "hello" },
        runId: "run-shadow",
      },
      { sessionId: "session-shadow", sessionKey: "main:shadow" },
    );

    expect(result).toBeUndefined();
    expect(api.runtime.events.emitDiagnosticEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "governance.decision",
        runId: "run-shadow",
        sessionId: "session-shadow",
        sessionKey: "main:shadow",
        toolName: "write",
        decision: "prohibit",
        mode: "shadow",
        reasonCode: "NO_DIRECT_WRITE",
      }),
    );
  });

  it("enforce mode blocks prohibited action with stable reason prefix", async () => {
    const policyFile = createPolicyFileName();
    cleanupFiles.push(policyFile);
    await fs.writeFile(
      policyFile,
      JSON.stringify({
        version: "1.0.0",
        rules: [
          {
            id: "deny-write",
            priority: 100,
            match: { toolName: "write" },
            decision: "prohibit",
            reasonCode: "NO_DIRECT_WRITE",
            reasonText: "Direct writes are prohibited",
          },
        ],
      }),
    );

    const { api, hooks } = createApi({
      pluginConfig: {
        mode: "enforce",
        policyFile,
      },
    });
    plugin.register(api as never);

    const result = await hooks.before_tool_call?.(
      {
        toolName: "write",
        params: { path: "/tmp/a.md", content: "hello" },
        runId: "run-enforce",
      },
      { sessionId: "session-enforce", sessionKey: "main:enforce" },
    );

    expect(result).toEqual(
      expect.objectContaining({
        block: true,
        blockReason: expect.stringContaining("GOVERNANCE_PROHIBITED"),
      }),
    );
  });

  it("enforce mode blocks escalation-required action with stable reason prefix", async () => {
    const policyFile = createPolicyFileName();
    cleanupFiles.push(policyFile);
    await fs.writeFile(
      policyFile,
      JSON.stringify({
        version: "1.0.0",
        rules: [
          {
            id: "escalate-security-write",
            priority: 100,
            match: { toolName: "write", pathPattern: "*security*" },
            decision: "escalate",
            reasonCode: "SECURITY_SENSITIVE_PATH",
            reasonText: "Security surfaces require escalation",
          },
        ],
      }),
    );

    const { api, hooks } = createApi({
      pluginConfig: {
        mode: "enforce",
        policyFile,
      },
    });
    plugin.register(api as never);

    const result = await hooks.before_tool_call?.(
      {
        toolName: "write",
        params: { path: "/tmp/security-config.md", content: "hello" },
        runId: "run-escalate",
      },
      { sessionId: "session-escalate", sessionKey: "main:escalate" },
    );

    expect(result).toEqual(
      expect.objectContaining({
        block: true,
        blockReason: expect.stringContaining("GOVERNANCE_ESCALATE_REQUIRED"),
      }),
    );
  });

  it("enforce mode fails closed when policy file is missing", async () => {
    const { api, hooks } = createApi({
      pluginConfig: {
        mode: "enforce",
        policyFile: path.join(os.tmpdir(), "nonexistent-governance-policy.json"),
      },
    });
    plugin.register(api as never);

    const result = await hooks.before_tool_call?.(
      {
        toolName: "write",
        params: { path: "/tmp/a.md", content: "hello" },
        runId: "run-missing-policy",
      },
      { sessionId: "session-missing-policy", sessionKey: "main:missing-policy" },
    );

    expect(result).toEqual(
      expect.objectContaining({
        block: true,
        blockReason: expect.stringContaining("GOVERNANCE_POLICY_EVAL_FAILED"),
      }),
    );
  });

  it("rollback scenario enforce->shadow relaxes enforcement for same prohibited action", async () => {
    const policyFile = createPolicyFileName();
    cleanupFiles.push(policyFile);
    await fs.writeFile(
      policyFile,
      JSON.stringify({
        version: "1.0.0",
        rules: [
          {
            id: "deny-write",
            priority: 100,
            match: { toolName: "write" },
            decision: "prohibit",
            reasonCode: "NO_DIRECT_WRITE",
            reasonText: "Direct writes require approval",
          },
        ],
      }),
    );

    const { api: enforceApi, hooks: enforceHooks } = createApi({
      pluginConfig: {
        mode: "enforce",
        policyFile,
      },
    });
    plugin.register(enforceApi as never);

    const enforceResult = await enforceHooks.before_tool_call?.(
      {
        toolName: "write",
        params: { path: "/tmp/rollback-enforce-shadow.md", content: "hello" },
        runId: "run-rollback-enforce",
      },
      { sessionId: "session-rollback", sessionKey: "main:rollback" },
    );
    expect(enforceResult).toEqual(
      expect.objectContaining({
        block: true,
        blockReason: expect.stringContaining("GOVERNANCE_PROHIBITED"),
      }),
    );

    const { api: shadowApi, hooks: shadowHooks } = createApi({
      pluginConfig: {
        mode: "shadow",
        policyFile,
      },
    });
    plugin.register(shadowApi as never);

    const shadowResult = await shadowHooks.before_tool_call?.(
      {
        toolName: "write",
        params: { path: "/tmp/rollback-enforce-shadow.md", content: "hello" },
        runId: "run-rollback-shadow",
      },
      { sessionId: "session-rollback", sessionKey: "main:rollback" },
    );
    expect(shadowResult).toBeUndefined();
    expect(shadowApi.runtime.events.emitDiagnosticEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "governance.decision",
        mode: "shadow",
        decision: "prohibit",
        reasonCode: "NO_DIRECT_WRITE",
      }),
    );
  });

  it("rollback scenario shadow->off restores passive baseline for same prohibited action", async () => {
    const policyFile = createPolicyFileName();
    cleanupFiles.push(policyFile);
    await fs.writeFile(
      policyFile,
      JSON.stringify({
        version: "1.0.0",
        rules: [
          {
            id: "deny-write",
            priority: 100,
            match: { toolName: "write" },
            decision: "prohibit",
            reasonCode: "NO_DIRECT_WRITE",
            reasonText: "Direct writes require approval",
          },
        ],
      }),
    );

    const { api: shadowApi, hooks: shadowHooks } = createApi({
      pluginConfig: {
        mode: "shadow",
        policyFile,
      },
    });
    plugin.register(shadowApi as never);

    const shadowResult = await shadowHooks.before_tool_call?.(
      {
        toolName: "write",
        params: { path: "/tmp/rollback-shadow-off.md", content: "hello" },
        runId: "run-rollback-shadow",
      },
      { sessionId: "session-rollback-shadow-off", sessionKey: "main:rollback-shadow-off" },
    );
    expect(shadowResult).toBeUndefined();
    expect(shadowApi.runtime.events.emitDiagnosticEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "governance.decision",
        mode: "shadow",
        decision: "prohibit",
        reasonCode: "NO_DIRECT_WRITE",
      }),
    );

    const { api: offApi, hooks: offHooks } = createApi({
      pluginConfig: {
        mode: "off",
        policyFile,
      },
    });
    plugin.register(offApi as never);

    const offResult = await offHooks.before_tool_call?.(
      {
        toolName: "write",
        params: { path: "/tmp/rollback-shadow-off.md", content: "hello" },
        runId: "run-rollback-off",
      },
      { sessionId: "session-rollback-shadow-off", sessionKey: "main:rollback-shadow-off" },
    );
    expect(offResult).toBeUndefined();
    expect(offApi.runtime.events.emitDiagnosticEvent).not.toHaveBeenCalled();
  });
});
