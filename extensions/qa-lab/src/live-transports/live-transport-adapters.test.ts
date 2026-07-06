// Qa Lab tests cover canonical live transport adapter factory routing.
import { describe, expect, it, vi } from "vitest";
import { createQaBusState } from "../bus-state.js";
import { createQaChannelTransport } from "../qa-channel-transport.js";
import { createQaTransportAdapterFactoryRegistry } from "../qa-transport-registry.js";

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

import { slackQaAdapterFactory } from "./slack/cli.js";
import { telegramQaAdapterFactory } from "./telegram/cli.js";
import { whatsappQaAdapterFactory } from "./whatsapp/cli.js";

const factories = [
  telegramQaAdapterFactory,
  slackQaAdapterFactory,
  whatsappQaAdapterFactory,
] as const;

describe("live transport adapter factories", () => {
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
      const registry = createQaTransportAdapterFactoryRegistry(factories);

      const created = await registry.create({
        channelId,
        adapterOptions,
        driver: "live",
        outputDir: ".artifacts/qa-e2e",
        state,
      });

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
