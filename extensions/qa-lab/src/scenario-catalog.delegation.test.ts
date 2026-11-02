import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { buildQaTarget, qaChannelPlugin } from "@openclaw/qa-channel/api.js";
import { createOpenClawCodingTools } from "openclaw/plugin-sdk/agent-harness";
import { resolveCommandAuthorization } from "openclaw/plugin-sdk/command-auth-native";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { expectDefined } from "openclaw/plugin-sdk/expect-runtime";
import {
  createTestRegistry,
  resetPluginRuntimeStateForTest,
  setActivePluginRegistry,
  waitForPluginCacheRetirement,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import { buildAgentSessionKey } from "openclaw/plugin-sdk/routing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createQaBusState } from "./bus-state.js";
import { createQaChannelTransport } from "./qa-channel-transport.js";
import { buildQaGatewayConfig } from "./qa-gateway-config.js";
import { readQaScenarioById } from "./scenario-catalog.js";
import { runLoadedScenarioFlow } from "./scenario-flow-runner.test-support.js";
import { applyQaMergePatch } from "./suite-merge-patch.js";

const scenario = readQaScenarioById("system-agent-delegation-generation");
const denyDelegation = { conversationToolPolicy: { deny: ["openclaw"] } };

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
    baseline.plugins = {
      allow: ["qa-channel"],
      slots: { memory: "none" },
      entries: { "qa-channel": { enabled: true } },
    };
    config = applyQaMergePatch(baseline, scenario.gatewayConfigPatch ?? {}) as OpenClawConfig;
  });

  afterEach(async () => {
    resetPluginRuntimeStateForTest();
    const { failures } = await waitForPluginCacheRetirement(true);
    expect(failures).toEqual([]);
    await fs.rm(workspaceDir, { recursive: true, force: true });
  });

  function policyFor(
    toolConfig: OpenClawConfig,
    options: {
      senderId?: string;
      provider?: string;
      conversationToolPolicy?: { deny: string[] };
    } = {},
  ) {
    const provider = options.provider ?? "qa-channel";
    const { senderIsOwner } = resolveCommandAuthorization({
      cfg: toolConfig,
      ctx: {
        Provider: provider,
        Surface: provider,
        AccountId: "default",
        SenderId: options.senderId ?? "alice",
        ChatType: "group",
      },
      commandAuthorized: true,
    });
    const tools = createOpenClawCodingTools({
      config: toolConfig,
      agentId: "qa",
      sessionKey: "agent:qa:qa-channel:group:qa-system-agent-delegation",
      messageProvider: provider,
      senderIsOwner,
      modelProvider: "mock-openai",
      modelId: "gpt-5.6-luna",
      workspaceDir,
      cwd: workspaceDir,
      conversationToolPolicy: options.conversationToolPolicy,
    });
    return {
      senderIsOwner,
      delegate: tools.find((tool) => tool.name === "openclaw"),
    };
  }

  it.each([
    ["baseline", () => baseline, {}, false, "absent"],
    ["owner only", () => ({ ...baseline, commands: config.commands }), {}, true, "absent"],
    ["authorized and granted", () => config, {}, true, "granted"],
    ["other sender", () => config, { senderId: "bob" }, false, "gated"],
    ["other provider", () => config, { provider: "webchat" }, false, "gated"],
    ["conversation deny", () => config, denyDelegation, true, "absent"],
  ] as const)(
    "enforces delegation policy: %s",
    async (_label, getConfig, options, owner, outcome) => {
      const policy = policyFor(getConfig(), options);
      expect(policy.senderIsOwner).toBe(owner);
      if (outcome === "absent") {
        expect(policy.delegate).toBeUndefined();
      } else if (outcome === "gated") {
        const result = await expectDefined(policy.delegate, "offered openclaw tool").execute(
          "non-owner-delegation",
          {},
        );
        expect(result.details).toMatchObject({ gated: true });
        expect(JSON.stringify(result.content)).toContain("openclaw needs the owner's authority");
      } else {
        expect(policy.delegate).toBeDefined();
      }
    },
  );

  it("rejects duplicate visible replies after observing the routed session", async () => {
    const scenarioConfig = scenario.execution.config ?? {};
    const marker = String(scenarioConfig.expectedMarker);
    const delegateMarker = String(scenarioConfig.delegateReplyMarker);
    const state = createQaBusState();
    const transport = createQaChannelTransport(state);
    let listCalls = 0;
    const transcriptKeys: string[] = [];
    const inboundTarget = () => {
      const inbound = expectDefined(
        state.getSnapshot().messages.find((message) => message.direction === "inbound"),
        "scenario channel input",
      );
      return buildQaTarget({
        chatType: inbound.conversation.kind,
        conversationId: inbound.conversation.id,
        threadId: inbound.threadId,
      });
    };
    const routedSessionKey = async () =>
      expectDefined(
        await qaChannelPlugin.messaging?.resolveOutboundSessionRoute?.({
          cfg: config,
          agentId: "qa",
          accountId: transport.accountId,
          target: inboundTarget(),
        }),
        "captured input's QA route",
      ).sessionKey;
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
              return {
                sessions: [{ key: await routedSessionKey(), hasActiveRun: ++listCalls === 1 }],
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
        for (let count = 0; count < 2; count += 1) {
          state.addOutboundMessage(reply);
        }
      },
    });
    await expect(result).rejects.toThrow("expected one visible channel reply, saw 2");
    expect(listCalls).toBe(2);
    expect(transcriptKeys).toEqual([await routedSessionKey()]);
  });
});
