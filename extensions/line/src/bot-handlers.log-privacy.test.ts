import type { webhook } from "@line/bot-sdk";
import { createPluginRuntimeMock } from "openclaw/plugin-sdk/channel-test-helpers";
import { afterAll, expect, it, vi } from "vitest";
import { setLineRuntime } from "./runtime.js";

const logVerbose = vi.hoisted(() => vi.fn());
vi.mock("openclaw/plugin-sdk/runtime-env", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/runtime-env")>()),
  logVerbose,
}));
const postbackContext = {
  ctxPayload: { From: "line:user:privacy-test" },
  replyToken: "synthetic-reply-token",
  route: { agentId: "default" },
  isGroup: false,
  accountId: "default",
};
vi.mock("./bot-message-context.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./bot-message-context.js")>()),
  buildLinePostbackContext: vi.fn(async () => postbackContext),
}));
const { handleLineWebhookEvents } = await import("./bot-handlers.js");

afterAll(() => {
  vi.doUnmock("openclaw/plugin-sdk/runtime-env");
  vi.doUnmock("./bot-message-context.js");
  vi.resetModules();
});

it("dispatches an admitted ordinary postback without logging its private payload", async () => {
  setLineRuntime(createPluginRuntimeMock());
  logVerbose.mockClear();
  const processMessage = vi.fn(async () => {});
  const lineConfig = { dmPolicy: "open" as const, allowFrom: ["*"] };
  const context: Parameters<typeof handleLineWebhookEvents>[1] = {
    cfg: { channels: { line: lineConfig } },
    account: {
      accountId: "default",
      enabled: true,
      channelAccessToken: "synthetic-access-token",
      channelSecret: "synthetic-channel-secret",
      tokenSource: "config",
      config: lineConfig,
    },
    runtime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() },
    mediaMaxBytes: 1,
    processMessage,
  };
  const event: webhook.PostbackEvent = {
    type: "postback",
    replyToken: "synthetic-reply-token",
    timestamp: 1,
    source: { type: "user", userId: "privacy-test" },
    mode: "active",
    webhookEventId: "privacy-postback",
    deliveryContext: { isRedelivery: false },
    postback: { data: "line.action=play&line.device=private-device" },
  };

  await handleLineWebhookEvents([event], context);

  expect(processMessage).toHaveBeenCalledWith(postbackContext, { cfg: context.cfg });
  expect(logVerbose.mock.calls.flat().join(" ")).not.toContain(event.postback.data);
});
