import { afterEach, describe, expect, it, vi } from "vitest";
import { resetGlobalHookRunner } from "../plugins/hook-runner-global.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import { setActivePluginRegistry } from "../plugins/runtime.js";
import { wrapToolWithBeforeToolCallHook } from "./agent-tools.before-tool-call.js";
import type { AnyAgentTool } from "./tools/common.js";

afterEach(() => {
  resetGlobalHookRunner();
  setActivePluginRegistry(createEmptyPluginRegistry());
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
