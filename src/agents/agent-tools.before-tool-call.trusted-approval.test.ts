import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setEmbeddedMode } from "../infra/embedded-mode.js";
import {
  EmbeddedPluginApprovalBroker,
  setEmbeddedPluginApprovalBroker,
} from "../infra/embedded-plugin-approval-broker.js";
import type { PluginApprovalRequest } from "../infra/plugin-approvals.js";
import { getGlobalHookRunner, resetGlobalHookRunner } from "../plugins/hook-runner-global.js";
import { createHookRunner, type HookRunner } from "../plugins/hooks.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import { setActivePluginRegistry } from "../plugins/runtime.js";
import { PluginApprovalResolutions } from "../plugins/types.js";
import { runBeforeToolCallHook } from "./agent-tools.before-tool-call.js";

vi.mock("../plugins/hook-runner-global.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../plugins/hook-runner-global.js")>();
  return { ...actual, getGlobalHookRunner: vi.fn() };
});

describe("trusted approval rewrite isolation", () => {
  const runBeforeToolCallMock = vi.fn<HookRunner["runBeforeToolCall"]>();

  beforeEach(() => {
    resetGlobalHookRunner();
    runBeforeToolCallMock.mockReset();
    vi.mocked(getGlobalHookRunner).mockReturnValue({
      ...createHookRunner(createEmptyPluginRegistry()),
      hasHooks: () => true,
      runBeforeToolCall: runBeforeToolCallMock,
    });
  });

  afterEach(() => {
    setEmbeddedPluginApprovalBroker(null);
    setEmbeddedMode(false);
    setActivePluginRegistry(createEmptyPluginRegistry());
    resetGlobalHookRunner();
  });

  function installTrustedApprovalPolicy(): void {
    const registry = createEmptyPluginRegistry();
    registry.trustedToolPolicies = [
      {
        pluginId: "trusted-policy",
        source: "test",
        policy: {
          id: "approval-policy",
          description: "Approval policy",
          evaluate: () => ({
            requireApproval: {
              pluginId: "trusted-policy",
              title: "Policy approval",
              description: "Policy requested approval",
            },
          }),
        },
      },
    ];
    setActivePluginRegistry(registry);
  }

  it.each(["allow-once", "deny"] as const)(
    "keeps an ordinary hook rewrite pending until its separate approval: %s",
    async (decision) => {
      installTrustedApprovalPolicy();
      const hookResult = {
        params: { code: "return 'separately-approved';" },
        requireApproval: {
          title: "Rewrite approval",
          description: "Approve the rewritten command",
        },
      };
      runBeforeToolCallMock.mockResolvedValue(hookResult);
      const trustedRequestEvent = Promise.withResolvers<PluginApprovalRequest>();
      const rewriteRequestEvent = Promise.withResolvers<PluginApprovalRequest>();
      let onRequest = trustedRequestEvent.resolve;
      const broker = new EmbeddedPluginApprovalBroker((event) => {
        if (event.event === "plugin.approval.requested") {
          onRequest(event.payload);
        }
      });
      setEmbeddedMode(true);
      setEmbeddedPluginApprovalBroker(broker);
      let settled = false;
      const pending = runBeforeToolCallHook({
        toolName: "exec",
        toolKind: "code_mode_exec",
        params: { code: "return 'approved';", command: "return 'approved';" },
      }).then((result) => {
        settled = true;
        return result;
      });
      try {
        const trustedRequest = await trustedRequestEvent.promise;
        expect(trustedRequest.request.title).toBe("Policy approval");
        expect(runBeforeToolCallMock).not.toHaveBeenCalled();
        onRequest = rewriteRequestEvent.resolve;
        expect(broker.resolve(trustedRequest.id, "allow-once")).toBe(true);

        const rewriteRequest = await rewriteRequestEvent.promise;
        expect(rewriteRequest.id).not.toBe(trustedRequest.id);
        expect(rewriteRequest.request.title).toBe("Rewrite approval");
        expect(settled).toBe(false);
        // Retained mock output tests policy isolation, not plugin-runner mutation reachability.
        hookResult.params.code = "return 'unapproved-late-mutation';";
        expect(broker.resolve(rewriteRequest.id, decision)).toBe(true);
        if (decision === "deny") {
          await expect(pending).resolves.toMatchObject({
            blocked: true,
            deniedReason: "plugin-approval",
          });
        } else {
          await expect(pending).resolves.toEqual({
            blocked: false,
            params: {
              code: "return 'separately-approved';",
              command: "return 'separately-approved';",
            },
            approvalResolution: PluginApprovalResolutions.ALLOW_ONCE,
          });
        }
        expect(broker.listPending()).toHaveLength(0);
      } finally {
        broker.stop();
        await pending;
      }
    },
  );
});
