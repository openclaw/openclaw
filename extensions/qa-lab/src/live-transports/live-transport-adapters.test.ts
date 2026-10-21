import { describe, expect, it, vi } from "vitest";
import { createQaBusState } from "../bus-state.js";
import { createQaChannelTransport } from "../qa-channel-transport.js";
import { createQaTransportAdapter } from "../qa-transport-registry.js";
import type { QaTransportAdapter } from "../qa-transport.js";

const mock = vi.hoisted(() => ({
  discord: vi.fn(),
  matrix: vi.fn(),
  slack: vi.fn(),
  telegram: vi.fn(),
  whatsapp: vi.fn(),
}));

vi.mock("./discord/adapter.runtime.js", () => ({
  createDiscordQaTransportAdapter: mock.discord,
}));
vi.mock("./matrix/adapter.runtime.js", () => ({ createMatrixQaTransportAdapter: mock.matrix }));
vi.mock("./slack/adapter.runtime.js", () => ({ createSlackQaTransportAdapter: mock.slack }));
vi.mock("./telegram/adapter.runtime.js", () => ({
  createTelegramQaTransportAdapter: mock.telegram,
}));
vi.mock("./whatsapp/adapter.runtime.js", () => ({
  createWhatsAppQaTransportAdapter: mock.whatsapp,
}));

import { discordQaCliRegistration as discord } from "./discord/cli.js";
import { matrixQaCliRegistration as matrix } from "./matrix/cli.js";
import { slackQaCliRegistration as slack } from "./slack/cli.js";
import { telegramQaCliRegistration as telegram } from "./telegram/cli.js";
import { whatsappQaCliRegistration as whatsapp } from "./whatsapp/cli.js";

const factories = [telegram, discord, matrix, slack, whatsapp].map(({ adapterFactory }) => {
  if (!adapterFactory) {
    throw new Error("expected live transport adapter factory");
  }
  return adapterFactory;
});

describe("live transport adapter factories", () => {
  it("opts only the disposable Matrix adapter into same-channel parallelism", () => {
    expect(factories.map((factory) => factory.isolatesInstances)).toEqual([
      undefined,
      undefined,
      true,
      undefined,
      undefined,
    ]);
  });

  it("declares module-flow support only for adapters that prepare module context", () => {
    expect(factories.map((factory) => factory.supportsModuleFlows)).toEqual([
      undefined,
      true,
      true,
      true,
      true,
    ]);
  });

  it.each(Object.entries(mock))(
    "creates the canonical %s adapter through the shared registry",
    async (channelId, create) => {
      const adapterOptions = { sutAccountId: `${channelId}-sut` };
      const state = createQaBusState();
      const adapter: QaTransportAdapter = createQaChannelTransport(state);
      if (channelId !== "telegram") {
        adapter.prepareFlow = async () => ({});
      }
      create.mockResolvedValueOnce(adapter);
      const context = { channelId, adapterOptions, driver: "live" as const };
      const created = await createQaTransportAdapter(
        { ...context, outputDir: ".artifacts/qa-e2e", state },
        factories,
      );

      expect(created.adapter.id).toBe(adapter.id);
      expect(create).toHaveBeenCalledWith(
        expect.objectContaining({
          ...context,
          credentials: {
            acquire: expect.any(Function),
            startHeartbeat: expect.any(Function),
          },
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
