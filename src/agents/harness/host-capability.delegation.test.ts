import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  GATEWAY_CLIENT_CAPS,
  GATEWAY_CLIENT_IDS,
} from "../../../packages/gateway-protocol/src/client-info.js";
import { ensureSessionEntrySync } from "../../config/sessions/session-accessor.js";
import { createDirectChatContext } from "../../gateway/server-chat.agent-events.test-helpers.js";
import { environmentsSessionHandlers } from "../../gateway/server-methods/environments.session.js";
import type { GatewayClient, RespondFn } from "../../gateway/server-methods/types.js";
import { createSyntheticPluginRuntimeClient } from "../../gateway/server-plugin-runtime-client.js";
import * as support from "../../gateway/worker-environments/service.test-support.js";
import { resetAgentRunRegistryForTest } from "../../infra/agent-run-registry.js";
import { PluginInstance } from "../../plugins/plugin-instance.js";
import { closeOpenClawAgentDatabases } from "../../state/openclaw-agent-db.js";
import type { ToolOutcomeObserver } from "../agent-tools.before-tool-call.types.js";
import { wrapToolWithBeforeToolCallHook } from "../agent-tools.before-tool-call.wrapper.js";
import { createCodingToolsGatewayCaller } from "../agent-tools.caller.js";
import { resolveConversationCapabilityProfile } from "../conversation-capability-profile.js";
import {
  clearToolSearchCatalog,
  createToolSearchCatalogRef,
  registerHeadlessToolSearchCatalog,
} from "../tool-search-catalog.js";
import { resolveToolSearchConfig } from "../tool-search-config.js";
import { ToolSearchRuntime } from "../tool-search-runtime.js";
import { jsonResult, type AnyAgentTool } from "../tools/common.js";
import { wrapToolWithGatewayCallerIdentity } from "../tools/gateway-caller-context.js";
import { createAdmittedHostCapabilityTestFixture } from "./host-capability.test-support.js";

async function callCatalog(
  host: Awaited<ReturnType<typeof createAdmittedHostCapabilityTestFixture>>,
  identity: Pick<
    Parameters<typeof createAdmittedHostCapabilityTestFixture>[0],
    "agentId" | "sessionId" | "sessionKey" | "runId" | "config"
  >,
  tool: AnyAgentTool,
  options: { instance?: PluginInstance; outcome?: ToolOutcomeObserver } = {},
) {
  const catalogRef = createToolSearchCatalogRef();
  const bound = host.hostCapabilities.bindToolSurface([tool]);
  try {
    registerHeadlessToolSearchCatalog({
      catalogRef,
      tools: options.instance ? options.instance.wrap(bound) : bound,
      hookContext: { ...identity, onToolOutcome: options.outcome },
    });
    const runtime = new ToolSearchRuntime(
      { ...identity, catalogRef },
      resolveToolSearchConfig(identity.config),
      { prepareInput: true, validateInput: true },
    );
    return await runtime.call(tool.name, {});
  } finally {
    clearToolSearchCatalog({ catalogRef });
  }
}

describe("harness tool delegation through the catalog", () => {
  support.setupWorkerEnvironmentServiceSuite();

  it.each([true, false])(
    "preserves captured screen permission=%s when presenting an environment",
    async (screenAllowed) => {
      const identity = {
        agentId: "main",
        sessionId: "delegation-preview",
        sessionKey: "agent:main:delegation-preview",
      };
      const runId = "delegation-preview-run";
      const config = support.testState.config;
      config.tools = { profile: "full" };
      config.session = { store: path.join(support.testState.root, "sessions.json") };
      ensureSessionEntrySync(
        { ...identity, storePath: config.session.store },
        { sessionId: identity.sessionId, updatedAt: 1 },
      );
      const provision = vi.fn(async () => ({
        leaseId: "preview-lease",
        ssh: support.SSH_ENDPOINT,
      }));
      const service = support.createService(support.createProvider({ provision }));
      const requester: GatewayClient = {
        connId: "preview-browser",
        connect: {
          minProtocol: 1,
          maxProtocol: 1,
          client: {
            id: GATEWAY_CLIENT_IDS.CONTROL_UI,
            version: "test",
            platform: "web",
            mode: "ui",
          },
          caps: [GATEWAY_CLIENT_CAPS.UI_COMMANDS],
        },
      };
      const context = createDirectChatContext({
        getRuntimeConfig: () => config,
        workerEnvironmentService: service,
        getClientConnIds: (filter) =>
          new Set(!filter || filter(requester) ? [requester.connId!] : []),
      });
      const respond = vi.fn<RespondFn>();
      const plugin: AnyAgentTool = {
        name: "crabbox",
        label: "Crabbox",
        description: "Present the conversation environment",
        parameters: { type: "object", properties: {} },
        async execute() {
          await environmentsSessionHandlers["environments.session.create"]!({
            req: { type: "req", id: "create-preview", method: "environments.session.create" },
            params: {
              profileId: "development",
              idempotencyKey: "create-preview",
              presentation: "portal",
            },
            context,
            client: createSyntheticPluginRuntimeClient({ pluginRuntimeOwnerId: "crabbox" }),
            isWebchatConnect: () => false,
            respond,
          });
          return jsonResult({ handled: true });
        },
      };
      const capabilityProfile = resolveConversationCapabilityProfile({
        ...identity,
        config,
        runtimeToolAllowlist: screenAllowed ? ["crabbox", "screen"] : ["crabbox"],
        inheritRuntimeToolAllowlist: true,
      });
      const capturePolicy = createCodingToolsGatewayCaller({
        ...identity,
        options: {},
        capabilityProfile,
      });
      const routed = wrapToolWithGatewayCallerIdentity(plugin, {
        ...identity,
        gatewayUiCommandTarget: { connId: requester.connId! },
      });
      const assembled = capturePolicy(
        wrapToolWithBeforeToolCallHook(routed, { ...identity, runId }),
      );
      const host = await createAdmittedHostCapabilityTestFixture({ ...identity, runId, config });
      try {
        await callCatalog(host, { ...identity, runId, config }, assembled);

        if (screenAllowed) {
          expect(respond).toHaveBeenCalledWith(
            true,
            expect.objectContaining({
              environment: expect.objectContaining({ status: "available" }),
            }),
          );
          expect(context.broadcastToConnIds).toHaveBeenCalledWith(
            "ui.command",
            expect.objectContaining({
              command: expect.objectContaining({ panel: "portal", open: true }),
            }),
            new Set([requester.connId]),
          );
          expect(provision).toHaveBeenCalledOnce();
        } else {
          expect(respond).toHaveBeenCalledWith(
            false,
            undefined,
            expect.objectContaining({
              message: "screen is not allowed by this conversation's tool policy",
            }),
          );
          expect(provision).not.toHaveBeenCalled();
          expect(context.broadcastToConnIds).not.toHaveBeenCalled();
          expect(service.getSessionAttachmentStatus(identity.sessionId)).toBeUndefined();
        }
      } finally {
        host.closeHost();
        host.closeAdmission();
        resetAgentRunRegistryForTest();
        closeOpenClawAgentDatabases();
      }
    },
  );
});

it("rejects a catalog result when its admitted owner ends during hook finalization", async () => {
  const identity = {
    agentId: "main",
    sessionId: "delegation-result",
    sessionKey: "agent:main:delegation-result",
    runId: "delegation-result-run",
  };
  const host = await createAdmittedHostCapabilityTestFixture(identity);
  const outcome = vi.fn<ToolOutcomeObserver>((observation) => {
    if (!observation.presentationOnly) {
      host.closeAdmission();
    }
  });
  const execute = vi.fn(async () => jsonResult({ marker: "finished-source" }));
  const tool: AnyAgentTool = {
    name: "delegation_result",
    label: "Delegation result",
    description: "Return a result through its current owner",
    parameters: { type: "object", properties: {} },
    execute,
  };
  try {
    await expect(callCatalog(host, identity, tool, { outcome })).rejects.toThrow(
      "no longer active",
    );
    expect(execute).toHaveBeenCalledOnce();
    expect(
      outcome.mock.calls.filter(([observation]) => !observation.presentationOnly),
    ).toHaveLength(1);
  } finally {
    host.closeHost();
    host.closeAdmission();
    resetAgentRunRegistryForTest();
  }
});

it("stops source execution after preparation revokes its owner through a plugin view", async () => {
  const identity = {
    agentId: "main",
    sessionId: "delegation-preparation",
    sessionKey: "agent:main:delegation-preparation",
    runId: "delegation-preparation-run",
  };
  const host = await createAdmittedHostCapabilityTestFixture(identity);
  const instance = new PluginInstance("delegation-view");
  const execute = vi.fn(async () => jsonResult({ effect: "must-not-run" }));
  const tool: AnyAgentTool = {
    name: "delegation_preparation",
    label: "Delegation preparation",
    description: "Retain source authority through preparation",
    parameters: { type: "object", properties: {} },
    prepareBeforeToolCallParams: (args) => {
      host.closeAdmission();
      return args;
    },
    execute,
  };
  try {
    await expect(callCatalog(host, identity, tool, { instance })).rejects.toThrow(
      "no longer active",
    );
    expect(execute).not.toHaveBeenCalled();
  } finally {
    host.closeHost();
    host.closeAdmission();
    await instance.dispose();
    resetAgentRunRegistryForTest();
  }
});
