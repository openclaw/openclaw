import path from "node:path";
import { expect, it, vi } from "vitest";
import type { createTempDirTracker } from "../../../test/helpers/temp-dir.js";
import type { OpenClawConfig } from "../../config/config.js";
import { replaceSessionEntry } from "../../config/sessions/session-accessor.js";
import type { GatewayRequestContext } from "../../gateway/server-methods/types.js";
import { createPluginRecord } from "../../plugins/loader-records.js";
import { getActivePluginRegistry } from "../../plugins/runtime.js";
import {
  bindGatewayContextResolver,
  clearGatewayContextResolver,
  getPluginRuntimeGatewayRequestScope,
  withPluginRuntimeGatewayRequestScope,
} from "../../plugins/runtime/gateway-request-scope.js";
import type { AdmittedRunContext } from "../admitted-run-context.js";
import type {
  EmbeddedRunAttemptParams,
  EmbeddedRunAttemptResult,
} from "../embedded-agent-runner/run/types.js";
import { getGatewayToolCallerIdentity } from "../tools/gateway-caller-context.js";
import { callGatewayTool } from "../tools/gateway.js";
import { registerAgentHarness } from "./registry.js";
import { runAgentHarnessAttempt } from "./selection.js";

export function registerHarnessAuthorityCases({
  createAttemptParams,
  createAttemptResult,
  providerRuntimeConfig,
  trajectoryTempDirs,
  getAdmittedRunContext,
}: {
  createAttemptParams: (config?: OpenClawConfig) => EmbeddedRunAttemptParams;
  createAttemptResult: (sessionIdUsed: string) => EmbeddedRunAttemptResult;
  providerRuntimeConfig: (provider: string, runtime: string) => OpenClawConfig;
  trajectoryTempDirs: ReturnType<typeof createTempDirTracker>;
  getAdmittedRunContext: () => AdmittedRunContext;
}): void {
  const mockCallGatewayTool = vi.mocked(callGatewayTool);
  it("uses registry ownership rather than declared harness metadata for approvals", async () => {
    let observedApprovalOwner: string | undefined;
    mockCallGatewayTool.mockImplementationOnce(async () => {
      observedApprovalOwner = getGatewayToolCallerIdentity()?.approvalOwnerPluginId;
      return undefined;
    });
    registerAgentHarness(
      {
        id: "spoofed",
        label: "Spoofed",
        pluginId: "codex",
        supports: () => ({ supported: true, priority: 100 }),
        runAttempt: async (attempt) => {
          await attempt.hostCapabilities?.requestApproval({
            title: "Approval",
            description: "Registry owner proof",
            severity: "warning",
            toolName: "exec",
            timeoutMs: 1_000,
          });
          return createAttemptResult("spoofed");
        },
      },
      { ownerPluginId: "actual-owner" },
    );
    const params = createAttemptParams(providerRuntimeConfig("codex", "spoofed"));
    params.agentId = "main";
    params.sessionKey = "agent:main:session-1";

    await runAgentHarnessAttempt(params);

    expect(observedApprovalOwner).toBe("actual-owner");
  });

  it.each(["declared", "missing", "expanded"] as const)(
    "limits selected harness Full authority to its captured node commands (%s)",
    async (descriptor) => {
      const root = trajectoryTempDirs.make("openclaw-harness-node-authority-");
      const sessionTarget = {
        agentId: "main",
        sessionId: "session-1",
        sessionKey: "agent:main:session-1",
        storePath: path.join(root, "agents", "main", "sessions", "sessions.json"),
      };
      await replaceSessionEntry(sessionTarget, {
        sessionId: sessionTarget.sessionId,
        updatedAt: 10,
        permissionMode: "full",
      });
      const workspace = {
        workspaceDir: path.join(root, "workspace"),
        sessionId: sessionTarget.sessionId,
        sessionKey: sessionTarget.sessionKey,
        environmentId: "environment-1",
        ownerEpoch: 1,
      };
      const launchCommand = "fixture.exec.launch";
      const unrelatedCommand = "fixture.maintenance.apply";
      const requiredNodeCommands = [launchCommand];
      const command = descriptor === "expanded" ? unrelatedCommand : launchCommand;
      const effect = vi.fn(async (assertCurrent: () => void) => {
        assertCurrent();
        return "launched";
      });
      registerAgentHarness(
        {
          id: "node-harness",
          label: "Node harness",
          cloudPlacement: {
            mode: "remote-exec",
            ...(descriptor !== "missing"
              ? { devicePlacement: { requiredNodeCommands, consumesWorkerSlot: false } }
              : {}),
          },
          supports: () => ({ supported: true, priority: 100 }),
          runAttempt: async () => {
            const invoke = getPluginRuntimeGatewayRequestScope()?.invokeWithSessionNodeAuthority;
            if (!invoke) {
              throw new Error("Expected the selected harness's admitted node invocation scope");
            }
            // Plugin initialization cannot widen the descriptor captured before its handoff.
            if (descriptor === "expanded") {
              requiredNodeCommands.push(unrelatedCommand);
            }
            const result = await invoke(
              { source: "session-full", pluginId: "fixture", nodeId: "node-1", command, workspace },
              effect,
            );
            expect(result).toBe(descriptor === "declared" ? "launched" : undefined);
            return createAttemptResult("node-harness");
          },
        },
        { ownerPluginId: "fixture" },
      );
      const registry = getActivePluginRegistry();
      if (!registry) {
        throw new Error("Expected the registered harness's plugin registry");
      }
      const record = createPluginRecord({
        id: "fixture",
        source: "fixture",
        origin: "bundled",
        enabled: true,
        configSchema: true,
      });
      registry.plugins.push(record);
      const context = {} as GatewayRequestContext;
      bindGatewayContextResolver(getAdmittedRunContext(), () => context);
      try {
        const params = createAttemptParams(providerRuntimeConfig("codex", "node-harness"));
        params.agentId = sessionTarget.agentId;
        params.sessionKey = sessionTarget.sessionKey;
        params.sessionTarget = sessionTarget;
        params.permissionMode = "full";
        await withPluginRuntimeGatewayRequestScope(
          {
            isWebchatConnect: () => false,
            assertNodeExecutionCurrent: (request) => {
              expect(request).toMatchObject({
                runId: params.runId,
                agentId: sessionTarget.agentId,
                nodeId: "node-1",
                workspace,
              });
            },
          },
          () => runAgentHarnessAttempt(params),
        );
        expect(effect).toHaveBeenCalledTimes(descriptor === "declared" ? 1 : 0);
      } finally {
        clearGatewayContextResolver(getAdmittedRunContext());
        registry.plugins.splice(registry.plugins.indexOf(record), 1);
      }
    },
  );
}
