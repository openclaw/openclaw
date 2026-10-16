import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import {
  initializeGlobalHookRunner,
  resetGlobalHookRunner,
} from "../../plugins/hook-runner-global.js";
import { createMockPluginRegistry } from "../../plugins/hooks.test-fixtures.js";
import { createEmptyPluginRegistry } from "../../plugins/registry-empty.js";
import { setActivePluginRegistry } from "../../plugins/runtime.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { useSessionStoreTempDirs } from "../../test-utils/session-state-cleanup.js";
import { resolveNativeHookRelayDeferredToolApproval, testing } from "./native-hook-relay.js";
import {
  clearNativeHookRelaysForTests,
  invokeRelay,
  registerAgentRelay,
} from "./native-hook-relay.test-support.js";

// Codex gates MCP tool calls through its own in-process elicitation, so a plugin
// `requireApproval` on an `mcp__*` PreToolUse event must be parked on the relay
// instead of waiting inside the short-lived hook subprocess.
describe("native hook relay MCP approval deferral", () => {
  useSessionStoreTempDirs(afterAll, "openclaw-native-relay-mcp-defer-");

  afterEach(async () => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    resetGlobalHookRunner();
    setActivePluginRegistry(createEmptyPluginRegistry());
    await clearNativeHookRelaysForTests();
  });

  it("parks a plugin-gated MCP approval on the relay for Codex to resolve", async () => {
    initializeGlobalHookRunner(
      createMockPluginRegistry([
        {
          hookName: "before_tool_call",
          handler: vi.fn(async () => ({
            requireApproval: {
              title: "Needs approval",
              description: "MCP tool needs approval",
            },
          })),
        },
      ]),
    );
    const relay = registerAgentRelay({
      config: { mcp: { servers: { probe: { command: "probe-mcp" } } } },
    });
    const toolUseId = "mcp-defer-call-1";
    await invokeRelay(relay.relayId, "pre_tool_use", {
      hook_event_name: "PreToolUse",
      cwd: "/repo",
      tool_name: "mcp__probe__probe",
      tool_use_id: toolUseId,
      tool_input: { q: "reconcile" },
    });

    const pending =
      createDeferredCore<
        Awaited<
          ReturnType<
            Parameters<typeof testing.setNativeHookRelayDeferredToolApprovalRequesterForTests>[0]
          >
        >
      >();
    const approvalRequester = vi.fn(() => pending.promise);
    testing.setNativeHookRelayDeferredToolApprovalRequesterForTests(approvalRequester);
    const approval = resolveNativeHookRelayDeferredToolApproval({
      relayId: relay.relayId,
      toolUseId,
    });
    // The deferral only exists if the hook returned no native decision; an
    // in-custody hook would never reach the deferred requester.
    await vi.waitFor(() => expect(approvalRequester).toHaveBeenCalledTimes(1));
    pending.resolve({
      blocked: false,
      params: {},
      approvalResolution: "allow-once",
    });
    await approval;
  });
});
