// Qa Lab tests cover canonical live transport adapter factory routing.
import { describe, expect, it, vi } from "vitest";
import { createQaBusState } from "../bus-state.js";
import { createQaChannelTransport } from "../qa-channel-transport.js";
import { createQaTransportAdapter } from "../qa-transport-registry.js";

const { createSlack, createTelegram, createWhatsApp } = vi.hoisted(() => ({
  createSlack: vi.fn(),
  createTelegram: vi.fn(),
  createWhatsApp: vi.fn(),
}));

vi.mock("./slack/adapter.runtime.js", () => ({ createSlackQaTransportAdapter: createSlack }));
vi.mock("./telegram/adapter.runtime.js", () => ({
  createTelegramQaTransportAdapter: createTelegram,
}));
vi.mock("./whatsapp/adapter.runtime.js", () => ({
  createWhatsAppQaTransportAdapter: createWhatsApp,
}));

import { slackQaCliRegistration } from "./slack/cli.js";
import { SLACK_QA_DEFAULT_SCENARIO_IDS } from "./slack/profiles.js";
import { telegramQaCliRegistration } from "./telegram/cli.js";
import { whatsappQaCliRegistration } from "./whatsapp/cli.js";
import { resolveWhatsAppQaScenarioIds } from "./whatsapp/profiles.js";

const slackQaAdapterFactory = slackQaCliRegistration.adapterFactory;
const telegramQaAdapterFactory = telegramQaCliRegistration.adapterFactory;
const whatsappQaAdapterFactory = whatsappQaCliRegistration.adapterFactory;
if (!slackQaAdapterFactory || !telegramQaAdapterFactory || !whatsappQaAdapterFactory) {
  throw new Error("expected live transport adapter factories");
}

const factories = [
  telegramQaAdapterFactory,
  slackQaAdapterFactory,
  whatsappQaAdapterFactory,
] as const;

describe("live transport adapter factories", () => {
  it("assigns the canonical live scenario defaults to Slack", () => {
    expect(slackQaAdapterFactory.scenarioIds).toEqual(SLACK_QA_DEFAULT_SCENARIO_IDS);
  });

  it("assigns the canonical live-frontier scenario defaults to WhatsApp", () => {
    expect(whatsappQaAdapterFactory.scenarioIds).toEqual(
      resolveWhatsAppQaScenarioIds({ providerMode: "live-frontier" }),
    );
  });

  it.each([
    ["telegram", createTelegram],
    ["slack", createSlack],
    ["whatsapp", createWhatsApp],
  ] as const)(
    "creates the canonical %s adapter through the shared registry",
    async (channelId, create) => {
      const adapterOptions = { sutAccountId: `${channelId}-sut` };
      const state = createQaBusState();
      const adapter = createQaChannelTransport(state);
      create.mockResolvedValueOnce(adapter);
      const created = await createQaTransportAdapter(
        {
          channelId,
          adapterOptions,
          driver: "live",
          outputDir: ".artifacts/qa-e2e",
          state,
        },
        factories,
      );

      expect(created.adapter.id).toBe(adapter.id);
      expect(create).toHaveBeenCalledWith(
        expect.objectContaining({
          adapterOptions,
          channelId,
          driver: "live",
          messages: expect.objectContaining({
            addInboundMessage: expect.any(Function),
            addOutboundMessage: expect.any(Function),
            editMessage: expect.any(Function),
          }),
        }),
      );
    },
  );
});
