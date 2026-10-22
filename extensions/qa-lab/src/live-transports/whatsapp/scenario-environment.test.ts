import { WhatsAppChannelConfigSchema } from "@openclaw/whatsapp/channel-config-api.js";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { validateJsonSchemaValue } from "openclaw/plugin-sdk/json-schema-runtime";
import { expect, it, vi } from "vitest";
import { readQaScenarioById } from "../../scenario-catalog.js";
import { runtimeEnv } from "./runtime.test-support.js";
import { createWhatsAppQaScenarioEnvironment } from "./scenario-environment.js";

type Environment = ReturnType<typeof createWhatsAppQaScenarioEnvironment>;
type GatewayCall = Parameters<Environment["prepareFlow"]>[0]["gateway"]["call"];

function prepare(scenarioId: string, call: GatewayCall) {
  const scenario = readQaScenarioById(scenarioId);
  return createWhatsAppQaScenarioEnvironment({
    accountId: "work",
    driverAuthDir: "/tmp/whatsapp-driver",
    explicitScenarioSelection: true,
    getDriver: () => {
      throw new Error("config preparation must not use the driver");
    },
    replaceDriver: vi.fn(),
    runtimeEnv: { ...runtimeEnv, groupJid: undefined },
    sutAuthDir: "/tmp/whatsapp-sut",
  }).prepareFlow({
    config: scenario.execution.config ?? {},
    gateway: {
      baseUrl: "http://127.0.0.1:1",
      tempRoot: "/tmp/whatsapp-gateway",
      workspaceDir: "/tmp/whatsapp-workspace",
      runtimeEnv: {},
      call,
    },
    outputDir: "/tmp/whatsapp-output",
    scenarioId,
    scenarioTitle: scenario.title,
    timeoutMs: 60_000,
    waitForConfigRestartSettle: vi.fn(),
  });
}

function messages(enabled: boolean) {
  return {
    ackReaction: enabled ? "👀" : "💬",
    ackReactionScope: enabled ? "direct" : "group-mentions",
    statusReactions: { enabled },
  } satisfies OpenClawConfig["messages"];
}

it.each([
  { id: "whatsapp-agent-message-action-react", statusReactions: false },
  { id: "whatsapp-status-reaction-lifecycle", statusReactions: true },
])("configures $id through the current WhatsApp schema", async ({ id, statusReactions }) => {
  const baseMessages = messages(false);
  const account = {
    accountId: "work",
    busy: false,
    connected: true,
    lastConnectedAt: Date.now() - 30_000,
    restartPending: false,
    running: true,
  };
  const gatewayCall = vi.fn(async (method: string, _params?: unknown) => {
    if (method === "config.get") {
      return { config: { messages: baseMessages }, hash: "config-hash" };
    }
    if (method === "config.patch") {
      const { raw, replacePaths } = _params as { raw: string; replacePaths: string[] };
      const cfg = JSON.parse(raw) as OpenClawConfig;
      const validation = validateJsonSchemaValue({
        schema: WhatsAppChannelConfigSchema.schema,
        value: cfg.channels?.whatsapp,
        applyDefaults: true,
      });
      expect(validation.ok, JSON.stringify(validation)).toBe(true);
      expect(cfg.messages).toEqual(messages(statusReactions));
      expect(replacePaths).toContain("channels.whatsapp.accounts.work.allowFrom");
      expect(replacePaths).not.toContain("channels.whatsapp.accounts.sut.allowFrom");
      return { noop: true };
    }
    if (method === "channels.status") {
      return { channelAccounts: { whatsapp: [account] } };
    }
    throw new Error(`unexpected gateway method: ${method}`);
  });
  await prepare(id, gatewayCall);

  expect(gatewayCall.mock.calls.map(([method]) => method)).toContain("config.patch");
});

it("leaves generic declarative flows to their own config preparation", async () => {
  const gatewayCall = vi.fn();
  const id = "whatsapp-access-control-dm-disabled";
  const prepared = await prepare(id, gatewayCall);
  expect(prepared.whatsappScenarioContext.scenario.id).toBe(id);
  expect(gatewayCall).not.toHaveBeenCalled();
});
