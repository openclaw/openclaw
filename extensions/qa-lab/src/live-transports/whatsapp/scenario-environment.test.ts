import { WhatsAppChannelConfigSchema } from "@openclaw/whatsapp/channel-config-api.js";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { validateJsonSchemaValue } from "openclaw/plugin-sdk/json-schema-runtime";
import { describe, expect, it, vi } from "vitest";
import { readQaScenarioById } from "../../scenario-catalog.js";
import { createWhatsAppQaScenarioEnvironment } from "./scenario-environment.js";

type FlowPreparationInput = Parameters<
  ReturnType<typeof createWhatsAppQaScenarioEnvironment>["prepareFlow"]
>[0];

async function prepareWhatsAppFlowFixture(
  scenarioId: string,
  gatewayCall: FlowPreparationInput["gateway"]["call"],
) {
  const scenario = readQaScenarioById(scenarioId);
  const { prepareFlow } = createWhatsAppQaScenarioEnvironment({
    accountId: "work",
    driverAuthDir: "/tmp/whatsapp-driver",
    explicitScenarioSelection: true,
    getDriver: () => {
      throw new Error("config preparation must not use the driver");
    },
    replaceDriver: vi.fn(),
    runtimeEnv: {
      driverAuthArchiveBase64: "driver-auth",
      driverPhoneE164: "+15550000001",
      sutAuthArchiveBase64: "sut-auth",
      sutPhoneE164: "+15550000002",
    },
    sutAuthDir: "/tmp/whatsapp-sut",
  });
  return await prepareFlow({
    config: scenario.execution.config ?? {},
    gateway: {
      baseUrl: "http://127.0.0.1:1",
      tempRoot: "/tmp/whatsapp-gateway",
      workspaceDir: "/tmp/whatsapp-workspace",
      runtimeEnv: {},
      call: gatewayCall,
    },
    outputDir: "/tmp/whatsapp-output",
    primaryModel: "mock-openai/gpt-5.6-luna",
    scenarioId,
    scenarioTitle: scenario.title,
    timeoutMs: 60_000,
    waitForConfigRestartSettle: vi.fn(),
  });
}

describe("WhatsApp QA scenario environment", () => {
  it.each([
    { id: "whatsapp-agent-message-action-react", statusReactions: false },
    { id: "whatsapp-status-reaction-lifecycle", statusReactions: true },
  ])("configures $id through the current WhatsApp schema", async ({ id, statusReactions }) => {
    const baseMessages = {
      ackReaction: "💬",
      ackReactionScope: "group-mentions" as const,
      statusReactions: { enabled: false },
    };
    const gatewayCall = vi.fn(async (method: string, _params?: unknown) => {
      if (method === "config.get") {
        return { config: { messages: baseMessages }, hash: "config-hash" };
      }
      if (method === "config.patch") {
        const { raw } = _params as { raw: string };
        const cfg = JSON.parse(raw) as OpenClawConfig;
        const validation = validateJsonSchemaValue({
          schema: WhatsAppChannelConfigSchema.schema,
          value: cfg.channels?.whatsapp,
          applyDefaults: true,
        });
        expect(validation.ok, JSON.stringify(validation)).toBe(true);
        expect(cfg.messages).toEqual(
          statusReactions
            ? {
                ackReaction: "👀",
                ackReactionScope: "direct",
                statusReactions: { enabled: true },
              }
            : baseMessages,
        );
        return { noop: true };
      }
      if (method === "channels.status") {
        return {
          channelAccounts: {
            whatsapp: [
              {
                accountId: "work",
                busy: false,
                connected: true,
                lastConnectedAt: Date.now() - 30_000,
                restartPending: false,
                running: true,
              },
            ],
          },
        };
      }
      throw new Error(`unexpected gateway method: ${method}`);
    });
    await prepareWhatsAppFlowFixture(id, gatewayCall);

    const patchCall = gatewayCall.mock.calls.find(([method]) => method === "config.patch");
    if (!patchCall) {
      throw new Error("config.patch was not called");
    }
    expect(patchCall[1]).toMatchObject({
      replacePaths: expect.arrayContaining(["channels.whatsapp.accounts.work.allowFrom"]),
    });
    expect((patchCall[1] as { replacePaths?: string[] }).replacePaths).not.toContain(
      "channels.whatsapp.accounts.sut.allowFrom",
    );
  });

  it("leaves generic declarative flows to their own config preparation", async () => {
    const gatewayCall = vi.fn();
    const prepared = await prepareWhatsAppFlowFixture(
      "whatsapp-access-control-dm-disabled",
      gatewayCall,
    );
    expect(prepared.whatsappScenarioContext.scenario.id).toBe(
      "whatsapp-access-control-dm-disabled",
    );
    expect(gatewayCall).not.toHaveBeenCalled();
  });
});
