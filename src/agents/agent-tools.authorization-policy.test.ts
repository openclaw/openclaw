import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetGlobalHookRunner } from "../plugins/hook-runner-global.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../plugins/runtime.js";
import { wrapToolWithBeforeToolCallHook } from "./agent-tools.before-tool-call.js";
import { REQUIRED_PARAM_GROUPS, wrapToolParamValidation } from "./agent-tools.params.js";
import type { AnyAgentTool } from "./tools/common.js";

beforeEach(() => {
  resetPluginRuntimeStateForTest();
  setActivePluginRegistry(createEmptyPluginRegistry());
});

afterEach(() => {
  resetGlobalHookRunner();
  resetPluginRuntimeStateForTest();
});

describe("final tool authorization", () => {
  it("evaluates finalized input after ordinary hook preparation and before execution", async () => {
    const seen: unknown[] = [];
    const registry = createEmptyPluginRegistry();
    registry.authorizationPolicies.push({
      pluginId: "sender-access",
      pluginName: "Sender Access",
      origin: "workspace",
      source: "/plugins/sender-access/index.ts",
      policy: {
        id: "maintainer-actions",
        description: "Limit maintainer actions",
        handlers: {
          "tool.call": (request, context) => {
            seen.push({ request, context });
            return request.input.final === true
              ? { effect: "deny", code: "final-input-denied" }
              : { effect: "pass" };
          },
        },
      },
    });
    setActivePluginRegistry(registry);
    const execute = vi.fn();
    const tool = {
      name: "message",
      prepareBeforeToolCallParams: (params: unknown) => ({
        ...(params as Record<string, unknown>),
        prepared: true,
      }),
      finalizeBeforeToolCallParams: (params: unknown) => ({
        ...(params as Record<string, unknown>),
        final: true,
      }),
      execute,
    } as unknown as AnyAgentTool;
    const wrapped = wrapToolWithBeforeToolCallHook(tool, {
      agentId: "main",
      sessionKey: "agent:main:discord:channel:maintenance",
      authorization: {
        principal: {
          kind: "sender",
          provider: "discord",
          senderId: "maintainer-1",
          roleIds: ["maintainers"],
        },
        conversationId: "maintenance",
        threadId: "thread-1",
      },
      loopDetection: { enabled: false },
    });

    const result = await wrapped.execute?.("call-1", { action: "reply" }, undefined, undefined);

    expect(execute).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      details: {
        status: "blocked",
        reason: "Operation blocked by authorization policy.",
        deniedReason: "authorization-policy",
      },
    });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({
      request: {
        operation: "tool.call",
        toolName: "message",
        phase: "final",
        action: "reply",
        input: { action: "reply", prepared: true, final: true },
      },
      context: {
        principal: { kind: "sender", senderId: "maintainer-1" },
        conversationId: "maintenance",
        threadId: "thread-1",
      },
    });
  });

  it("does not freeze the executable input passed to the tool", async () => {
    const registry = createEmptyPluginRegistry();
    registry.authorizationPolicies.push({
      pluginId: "freeze",
      source: "/plugins/freeze/index.ts",
      policy: {
        id: "freeze",
        description: "Allow while sealing input",
        handlers: { "tool.call": () => ({ effect: "pass" }) },
      },
    });
    setActivePluginRegistry(registry);
    const execute = vi.fn((_id, params) => ({
      content: [{ type: "text", text: JSON.stringify(params) }],
    }));
    const wrapped = wrapToolWithBeforeToolCallHook(
      { name: "message", execute } as unknown as AnyAgentTool,
      { loopDetection: { enabled: false } },
    );

    await wrapped.execute?.(
      "call-2",
      { action: "react", nested: { emoji: "🦞" } },
      undefined,
      undefined,
    );

    const executedInput = execute.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(Object.isFrozen(executedInput)).toBe(false);
    expect(Object.isFrozen(executedInput.nested)).toBe(false);
  });

  it("executes the detached input approved before a retained alias mutates", async () => {
    let releasePolicy: (() => void) | undefined;
    let notifyPolicyStarted: (() => void) | undefined;
    const policyStarted = new Promise<void>((resolve) => {
      notifyPolicyStarted = resolve;
    });
    const registry = createEmptyPluginRegistry();
    const policyInputs: unknown[] = [];
    registry.authorizationPolicies.push({
      pluginId: "async-policy",
      source: "/plugins/async-policy/index.ts",
      policy: {
        id: "async-policy",
        description: "Wait before allowing",
        handlers: {
          "tool.call": async (request) => {
            policyInputs.push(request.input);
            notifyPolicyStarted?.();
            await new Promise<void>((resolve) => {
              releasePolicy = resolve;
            });
            return { effect: "pass" };
          },
        },
      },
    });
    setActivePluginRegistry(registry);
    const execute = vi.fn((_id, params) => ({
      content: [{ type: "text", text: JSON.stringify(params) }],
    }));
    const wrapped = wrapToolWithBeforeToolCallHook(
      { name: "message", execute } as unknown as AnyAgentTool,
      { loopDetection: { enabled: false } },
    );
    const retainedInput = { action: "reply", nested: { target: "approved" } };

    const pending = wrapped.execute?.("call-async", retainedInput, undefined, undefined);
    await policyStarted;
    retainedInput.action = "delete";
    retainedInput.nested.target = "mutated";
    releasePolicy?.();
    await pending;

    expect(policyInputs).toEqual([{ action: "reply", nested: { target: "approved" } }]);
    expect(execute).toHaveBeenCalledWith(
      "call-async",
      { action: "reply", nested: { target: "approved" } },
      undefined,
      undefined,
    );
    expect(execute.mock.calls[0]?.[1]).not.toBe(retainedInput);
  });

  it("preserves non-JSON tool input identity when no authorization policy is active", async () => {
    const execute = vi.fn((_id, params) => ({
      content: [{ type: "text", text: String(params) }],
    }));
    const wrapped = wrapToolWithBeforeToolCallHook(
      { name: "custom", execute } as unknown as AnyAgentTool,
      { config: {}, loopDetection: { enabled: false } },
    );
    const input = { createdAt: new Date("2026-07-19T00:00:00.000Z") };

    await wrapped.execute?.("call-non-json", input, undefined, undefined);

    expect(execute.mock.calls[0]?.[1]).toBe(input);
  });

  it("authorizes and executes the same normalized file-tool path", async () => {
    const policyInputs: unknown[] = [];
    const registry = createEmptyPluginRegistry();
    registry.authorizationPolicies.push({
      pluginId: "file-policy",
      source: "/plugins/file-policy/index.ts",
      policy: {
        id: "file-policy",
        description: "Observe canonical file effects",
        handlers: {
          "tool.call": (request) => {
            policyInputs.push(request.input);
            return { effect: "pass" };
          },
        },
      },
    });
    setActivePluginRegistry(registry);
    const execute = vi.fn((_id, params) => ({
      content: [{ type: "text", text: JSON.stringify(params) }],
    }));
    const fileTool = wrapToolParamValidation(
      { name: "write", execute } as unknown as AnyAgentTool,
      REQUIRED_PARAM_GROUPS.write,
    );
    const wrapped = wrapToolWithBeforeToolCallHook(fileTool, {
      loopDetection: { enabled: false },
    });

    await wrapped.execute?.(
      "call-file",
      { path: "reports/final.docodex</arg_value>>", content: "done" },
      undefined,
      undefined,
    );

    const expected = { path: "reports/final.docx", content: "done" };
    expect(policyInputs).toEqual([expected]);
    expect(execute.mock.calls[0]?.[1]).toEqual(expected);
  });

  it("blocks execution when an operator-required policy is absent", async () => {
    setActivePluginRegistry(createEmptyPluginRegistry());
    const execute = vi.fn();
    const wrapped = wrapToolWithBeforeToolCallHook(
      { name: "message", execute } as unknown as AnyAgentTool,
      {
        config: {
          plugins: {
            entries: {
              "sender-access": {
                authorization: {
                  requiredPolicies: [{ id: "maintainer-actions", operations: ["tool.call"] }],
                },
              },
            },
          },
        },
        loopDetection: { enabled: false },
      },
    );

    const result = await wrapped.execute?.("call-3", { action: "reply" }, undefined, undefined);

    expect(execute).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      details: {
        status: "blocked",
        deniedReason: "authorization-policy",
      },
    });
  });
});
