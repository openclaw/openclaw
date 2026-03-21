import { beforeEach, describe, expect, it, vi } from "vitest";

const buildTelegramMessageContext = vi.hoisted(() => vi.fn());
const dispatchTelegramMessage = vi.hoisted(() => vi.fn());
const maybeRunTelegramIngressMiddlewares = vi.hoisted(() => vi.fn());

vi.mock("./bot-message-context.js", () => ({
  buildTelegramMessageContext,
}));

vi.mock("./bot-message-dispatch.js", () => ({
  dispatchTelegramMessage,
}));

vi.mock("./ingress-runtime.js", () => ({
  maybeRunTelegramIngressMiddlewares,
}));

import { createTelegramMessageProcessor } from "./bot-message.js";

describe("telegram ingress middleware integration", () => {
  beforeEach(() => {
    buildTelegramMessageContext.mockReset();
    dispatchTelegramMessage.mockReset();
    maybeRunTelegramIngressMiddlewares.mockReset();
  });

  it("runs ingress middleware before telegram dispatch when configured", async () => {
    const order: string[] = [];
    const context = {
      route: { agentId: "public", sessionKey: "agent:public:telegram:direct:1" },
      ctxPayload: { SessionKey: "agent:public:telegram:direct:1" },
      msg: { from: { id: 1 }, chat: { id: 1, type: "private" } },
      isGroup: false,
      chatId: 1,
    };
    buildTelegramMessageContext.mockImplementation(async () => context);
    maybeRunTelegramIngressMiddlewares.mockImplementation(async () => {
      order.push("ingress");
      return { middlewareCount: 1, outcomes: [] };
    });
    dispatchTelegramMessage.mockImplementation(async () => {
      order.push("dispatch");
    });

    const processor = createTelegramMessageProcessor({
      bot: {} as never,
      cfg: {} as never,
      account: {} as never,
      telegramCfg: { ingressMiddlewares: ["file:///tmp/test.mjs"] } as never,
      historyLimit: 0,
      groupHistories: new Map(),
      dmPolicy: "pairing",
      allowFrom: [],
      groupAllowFrom: [],
      ackReactionScope: "off",
      logger: { info() {}, warn() {}, error() {} } as never,
      resolveGroupActivation: () => ({ allowed: true }) as never,
      resolveGroupRequireMention: () => false,
      resolveTelegramGroupConfig: () => ({ groupConfig: undefined, topicConfig: undefined }),
      loadFreshConfig: () => ({}) as never,
      sendChatActionHandler: { sendChatAction: vi.fn() } as never,
      runtime: { info() {}, warn() {}, error() {} } as never,
      replyToMode: "off",
      streamMode: "off",
      textLimit: 4000,
      telegramDeps: { upsertChannelPairingRequest: vi.fn() } as never,
      opts: { token: "x" },
    });

    await processor({ message: { chat: { id: 1, type: "private" } } } as never, [], []);

    expect(order).toEqual(["ingress", "dispatch"]);
    expect(maybeRunTelegramIngressMiddlewares).toHaveBeenCalledTimes(1);
    expect(dispatchTelegramMessage).toHaveBeenCalledTimes(1);
  });
});
