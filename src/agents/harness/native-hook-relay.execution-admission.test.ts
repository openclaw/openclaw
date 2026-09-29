import { afterEach, describe, expect, it, vi } from "vitest";
import {
  initializeGlobalHookRunner,
  resetGlobalHookRunner,
} from "../../plugins/hook-runner-global.js";
import { createMockPluginRegistry } from "../../plugins/hooks.test-fixtures.js";
import { createEmptyPluginRegistry } from "../../plugins/registry-empty.js";
import { setActivePluginRegistry } from "../../plugins/runtime.js";
import { createDeferredCore } from "../../shared/deferred.js";
import {
  invokeNativeHookRelay,
  registerNativeHookRelay,
  registerOwnedNativeHookRelay,
  resolveNativeHookRelayDeferredToolApproval,
  testing,
} from "./native-hook-relay.js";

afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  resetGlobalHookRunner();
  setActivePluginRegistry(createEmptyPluginRegistry());
  await testing.clearNativeHookRelaysForTests();
});

describe("native hook execution admission", () => {
  it("waits for async native admission and preserves a preparation rejection", async () => {
    const entered = createDeferredCore();
    const prepared = createDeferredCore();
    const relay = registerOwnedNativeHookRelay({
      provider: "codex",
      sessionId: "async-admission",
      runId: "async-admission",
      assertActive: () => {},
      executionAdmission: {
        toolNames: ["exec"],
        admit: async (_invocation, assertCurrent) => {
          entered.resolve();
          await prepared.promise;
          assertCurrent();
          throw new Error("native provider is not qualified");
        },
      },
    });
    const accepted = vi.fn();
    const invocation = invokeNativeHookRelay({
      provider: "codex",
      relayId: relay.relayId,
      event: "pre_tool_use",
      rawPayload: {
        session_id: "native-thread",
        turn_id: "native-turn",
        tool_use_id: "native-call",
        tool_name: "exec_command",
        tool_input: { command: "true" },
      },
    }).then(accepted);
    await Promise.race([
      entered.promise,
      invocation.then(() => {
        throw new Error("Native admission returned before preparation");
      }),
    ]);
    prepared.resolve();
    await expect(invocation).rejects.toThrow("native provider is not qualified");
    expect(accepted).not.toHaveBeenCalled();
  });

  it.each(["owned", "public"] as const)(
    "records native execution custody only through the bundled owner (%s)",
    async (registration) => {
      const admit = vi.fn();
      const params = {
        provider: "codex" as const,
        sessionId: "openclaw-session",
        runId: "execution-admission",
        executionAdmission: { toolNames: ["exec_command"], admit },
      };
      const relay =
        registration === "owned"
          ? registerOwnedNativeHookRelay(params)
          : registerNativeHookRelay(params);
      expect(relay.shouldRelayEvent("pre_tool_use")).toBe(registration === "owned");
      expect(relay.toolMatcherForEvent("pre_tool_use")).toEqual(
        registration === "owned" ? ["exec"] : undefined,
      );
      const rawPayload = {
        session_id: "native-root",
        turn_id: "native-turn",
        tool_use_id: "native-call",
        tool_name: "Bash",
        tool_input: { command: "true" },
      };
      await expect(
        invokeNativeHookRelay({
          provider: "codex",
          relayId: relay.relayId,
          event: "pre_tool_use",
          rawPayload,
        }),
      ).resolves.toEqual({ stdout: "", stderr: "", exitCode: 0 });
      if (registration === "owned") {
        expect(admit).toHaveBeenCalledExactlyOnceWith(
          expect.objectContaining({
            sessionId: "openclaw-session",
            turnId: "native-turn",
            toolUseId: "native-call",
            rawPayload,
          }),
          expect.any(Function),
          expect.objectContaining({ assertCurrent: expect.any(Function) }),
        );
      } else {
        expect(admit).not.toHaveBeenCalled();
      }
      admit.mockClear();
      await invokeNativeHookRelay({
        provider: "codex",
        relayId: relay.relayId,
        event: "pre_tool_use",
        rawPayload: { ...rawPayload, tool_name: "apply_patch" },
      });
      expect(admit).not.toHaveBeenCalled();
    },
  );

  it.each(["scoped policy", "all tools", "loop detection"] as const)(
    "unions execution custody with existing pre-tool work (%s)",
    (work) => {
      if (work !== "loop detection") {
        initializeGlobalHookRunner(
          createMockPluginRegistry([
            {
              hookName: "before_tool_call",
              handler: vi.fn(),
              ...(work === "scoped policy" ? { matcher: ["apply_patch"] } : {}),
            },
          ]),
        );
      }
      const relay = registerOwnedNativeHookRelay({
        provider: "codex",
        sessionId: "execution-admission",
        sessionKey: "agent:main:execution-admission",
        runId: "execution-admission",
        ...(work === "loop detection"
          ? { config: { tools: { loopDetection: { enabled: true } } } }
          : {}),
        executionAdmission: { toolNames: ["exec"], admit: vi.fn() },
      });
      expect(relay.shouldRelayEvent("pre_tool_use")).toBe(true);
      expect(relay.toolMatcherForEvent("pre_tool_use")).toEqual(
        work === "scoped policy" ? ["apply_patch", "exec"] : undefined,
      );
    },
  );

  it.each(["blocked", "rewritten", "failed"] as const)(
    "does not retain execution custody for a %s policy result",
    async (result) => {
      const admit = vi.fn();
      const relay = registerOwnedNativeHookRelay({
        provider: "codex",
        sessionId: "execution-admission",
        runId: "execution-admission",
        executionAdmission: { toolNames: ["exec"], admit },
        runBeforeToolCall: async () => {
          if (result === "failed") {
            throw new Error("fixture policy failed");
          }
          return result === "blocked"
            ? { blocked: true, kind: "veto", reason: "fixture policy blocked" }
            : { blocked: false, params: { command: "rewritten" } };
        },
      });
      const invocation = invokeNativeHookRelay({
        provider: "codex",
        relayId: relay.relayId,
        event: "pre_tool_use",
        rawPayload: { tool_name: "Bash", tool_use_id: "call", tool_input: { command: "true" } },
      });
      if (result === "failed") {
        await expect(invocation).rejects.toThrow("fixture policy failed");
      } else {
        const response = await invocation;
        expect(JSON.parse(response.stdout).hookSpecificOutput.permissionDecision).toBe("deny");
      }
      expect(admit).not.toHaveBeenCalled();
    },
  );

  it.each(["accepted", "failed", "retired"] as const)(
    "preserves deferred approval when execution custody is %s",
    async (result) => {
      const onResolution = vi.fn();
      const relay = registerOwnedNativeHookRelay({
        provider: "codex",
        sessionId: "execution-admission",
        runId: "execution-admission",
        runBeforeToolCall: async () => ({
          blocked: false,
          params: { command: "true" },
          deferredApproval: {
            approval: { title: "fixture", description: "fixture", onResolution },
            toolName: "exec",
            baseParams: { command: "true" },
          },
        }),
        executionAdmission: {
          toolNames: ["exec"],
          admit: () => {
            if (result === "failed") {
              throw new Error("execution custody unavailable");
            }
            if (result === "retired") {
              relay.unregister();
            }
          },
        },
      });
      const invocation = invokeNativeHookRelay({
        provider: "codex",
        relayId: relay.relayId,
        event: "pre_tool_use",
        rawPayload: {
          tool_name: "Bash",
          tool_use_id: "call",
          tool_input: { command: "true" },
          openclaw_approval_mode: "report",
        },
      });
      if (result === "accepted") {
        await expect(invocation).resolves.toEqual({ stdout: "", stderr: "", exitCode: 0 });
        expect(onResolution).not.toHaveBeenCalled();
        relay.unregister();
      } else {
        await expect(invocation).rejects.toThrow(
          result === "failed" ? "execution custody unavailable" : /inactive|foreground/,
        );
      }
      expect(onResolution).toHaveBeenCalledExactlyOnceWith("cancelled");
      await expect(
        resolveNativeHookRelayDeferredToolApproval({ relayId: relay.relayId, toolUseId: "call" }),
      ).resolves.toBeUndefined();
    },
  );
});
