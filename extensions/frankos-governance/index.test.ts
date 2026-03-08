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
});
