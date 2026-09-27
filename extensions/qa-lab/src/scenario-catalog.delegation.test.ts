import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { buildQaTarget, qaChannelPlugin } from "@openclaw/qa-channel/api.js";
import { createOpenClawCodingTools } from "openclaw/plugin-sdk/agent-harness";
import { resolveCommandAuthorization } from "openclaw/plugin-sdk/command-auth-native";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import {
  createTestRegistry,
  resetPluginRuntimeStateForTest,
  setActivePluginRegistry,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import { buildAgentSessionKey } from "openclaw/plugin-sdk/routing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createQaBusState } from "./bus-state.js";
import { createQaChannelTransport } from "./qa-channel-transport.js";
import { buildQaGatewayConfig } from "./qa-gateway-config.js";
import { readQaScenarioById } from "./scenario-catalog.js";
import { runLoadedScenarioFlow } from "./scenario-flow-runner.test-support.js";
import { applyQaMergePatch } from "./suite-merge-patch.js";

describe("system-agent delegation scenario tool policy", () => {
  let workspaceDir: string;
  let baseline: OpenClawConfig;
  let config: OpenClawConfig;

  beforeEach(async () => {
    setActivePluginRegistry(
      createTestRegistry([{ pluginId: "qa-channel", plugin: qaChannelPlugin, source: "test" }]),
    );
    workspaceDir = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), "qa-delegate-tools-")),
    );
    baseline = buildQaGatewayConfig({
      bind: "loopback",
      gatewayPort: 18789,
      gatewayToken: "qa-test-token",
      workspaceDir,
    });
    const scenario = readQaScenarioById("system-agent-delegation-generation");
    // Match the suite owner's merge of validated catalog patches into the typed QA config.
    config = applyQaMergePatch(baseline, scenario.gatewayConfigPatch ?? {}) as OpenClawConfig;
  });

  afterEach(async () => {
    resetPluginRuntimeStateForTest();
    await fs.rm(workspaceDir, { recursive: true, force: true });
  });

  function authorizationFor(
    toolConfig: OpenClawConfig,
    senderId = "alice",
    provider = "qa-channel",
  ) {
    return resolveCommandAuthorization({
      cfg: toolConfig,
      ctx: {
        Provider: provider,
        Surface: provider,
        AccountId: "default",
        SenderId: senderId,
        ChatType: "group",
      },
      commandAuthorized: true,
    });
  }

  function toolsFor(
    toolConfig: OpenClawConfig,
    options: {
      senderId?: string;
      provider?: string;
      conversationToolPolicy?: { deny: string[] };
    } = {},
  ) {
    const authority = authorizationFor(toolConfig, options.senderId, options.provider);
    return createOpenClawCodingTools({
      config: toolConfig,
      agentId: "qa",
      sessionKey: "agent:qa:qa-channel:group:qa-system-agent-delegation",
      messageProvider: options.provider ?? "qa-channel",
      senderIsOwner: authority.senderIsOwner,
      modelProvider: "mock-openai",
      modelId: "gpt-5.6-luna",
      workspaceDir,
      cwd: workspaceDir,
      conversationToolPolicy: options.conversationToolPolicy,
    });
  }

  it("grants the real delegate to the scenario's explicitly authorized sender", () => {
    expect(authorizationFor(baseline).senderIsOwner).toBe(false);
    expect(toolsFor(baseline).map((tool) => tool.name)).not.toContain("openclaw");
    expect(authorizationFor(config).senderIsOwner).toBe(true);
    const tools = toolsFor(config);
    expect(tools.map((tool) => tool.name)).toContain("read");
    expect(tools.find((tool) => tool.name === "openclaw")?.catalogMode).toBe("direct-only");
    expect(config.tools).toEqual(baseline.tools);
    expect(baseline.agents?.entries?.qa?.tools).toEqual({ profile: "coding" });
  });

  it("requires sender ownership even when the coding profile grants the delegate", () => {
    config.commands = { ...config.commands, ownerAllowFrom: [] };
    expect(authorizationFor(config).senderIsOwner).toBe(false);
    expect(toolsFor(config).map((tool) => tool.name)).not.toContain("openclaw");
  });

  it("requires the explicit coding-profile grant even for the authorized sender", () => {
    const ownerOnlyConfig = { ...baseline, commands: config.commands };
    expect(authorizationFor(ownerOnlyConfig).senderIsOwner).toBe(true);
    expect(toolsFor(ownerOnlyConfig).map((tool) => tool.name)).not.toContain("openclaw");
  });

  it.each([
    { senderId: "bob", provider: "qa-channel" },
    { senderId: "alice", provider: "webchat" },
  ])("does not grant ownership to $provider:$senderId", ({ senderId, provider }) => {
    expect(authorizationFor(config, senderId, provider).senderIsOwner).toBe(false);
    expect(toolsFor(config, { senderId, provider }).map((tool) => tool.name)).not.toContain(
      "openclaw",
    );
  });

  it("does not bypass an explicit tool deny", () => {
    config.tools = { ...config.tools, deny: ["openclaw"] };
    expect(toolsFor(config).map((tool) => tool.name)).not.toContain("openclaw");
  });

  it("does not bypass conversation-scoped tool policy", () => {
    expect(
      toolsFor(config, { conversationToolPolicy: { deny: ["openclaw"] } }).map((tool) => tool.name),
    ).not.toContain("openclaw");
  });

  it.each([1, 2])(
    "observes the routed session and counts only visible replies (%i live)",
    async (liveReplies) => {
      const scenario = readQaScenarioById("system-agent-delegation-generation");
      const scenarioConfig = scenario.execution.config ?? {};
      const marker = String(scenarioConfig.expectedMarker);
      const delegateMarker = String(scenarioConfig.delegateReplyMarker);
      const state = createQaBusState();
      const transport = createQaChannelTransport(state);
      let listCalls = 0;
      const transcriptKeys: string[] = [];
      const inboundTarget = () => {
        const inbound = state
          .getSnapshot()
          .messages.find((message) => message.direction === "inbound");
        if (!inbound) {
          throw new Error("scenario did not send its channel input");
        }
        return buildQaTarget({
          chatType: inbound.conversation.kind,
          conversationId: inbound.conversation.id,
          threadId: inbound.threadId,
        });
      };
      const routedSessionKey = async () => {
        const route = await qaChannelPlugin.messaging?.resolveOutboundSessionRoute?.({
          cfg: config,
          agentId: "qa",
          accountId: transport.accountId,
          target: inboundTarget(),
        });
        if (!route) {
          throw new Error("QA channel did not resolve the captured input's route");
        }
        return route.sessionKey;
      };
      const result = runLoadedScenarioFlow(scenario.id, {
        state,
        api: {
          transport,
          buildAgentSessionKey,
          env: {
            providerMode: "mock-openai",
            cfg: config,
            mock: { baseUrl: "http://mock.invalid" },
            gateway: {
              call: async (method: string) => {
                expect(method).toBe("sessions.list");
                listCalls += 1;
                return {
                  sessions: [{ key: await routedSessionKey(), hasActiveRun: listCalls === 1 }],
                };
              },
            },
          },
          fetchJson: async (url: string) =>
            url.endsWith("/debug/request-cursor")
              ? { cursor: 0 }
              : [
                  {
                    allInputText: scenarioConfig.promptSnippet,
                    plannedToolName: "openclaw",
                    plannedToolCallId: "delegate-call",
                    plannedToolArgs: {
                      message: `Reply exactly ${delegateMarker}. Do not call tools.`,
                    },
                  },
                  {
                    allInputText: scenarioConfig.promptSnippet,
                    toolOutputCallId: "delegate-call",
                    toolOutput: JSON.stringify({ reply: delegateMarker }),
                  },
                ],
          readSessionTranscriptSummary: async (_env: unknown, key: string) => {
            expect(key).toBe(await routedSessionKey());
            transcriptKeys.push(key);
            return { successfulToolCallCounts: { openclaw: 1 }, finalText: marker };
          },
        },
        onWaitForOutboundMessage: () => {
          const reply = { accountId: transport.accountId, to: inboundTarget(), text: marker };
          const preview = state.addOutboundMessage(reply);
          state.deleteMessage({ accountId: transport.accountId, messageId: preview.id });
          for (let count = 0; count < liveReplies; count += 1) {
            state.addOutboundMessage(reply);
          }
        },
      });
      if (liveReplies === 1) {
        await expect(result).resolves.toMatchObject({ status: "pass" });
      } else {
        await expect(result).rejects.toThrow("expected one visible channel reply, saw 2");
      }
      expect(listCalls).toBe(2);
      expect(transcriptKeys).toEqual([await routedSessionKey()]);
    },
  );
});
