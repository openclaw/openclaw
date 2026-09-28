import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { expect, it, vi } from "vitest";
import type { SlackMessageEvent } from "../../types.js";
import type { SlackEventScope } from "../event-scope.js";
import { prepareSlackMessage } from "./prepare.js";
import { createInboundSlackTestContext, createSlackTestAccount } from "./prepare.test-helpers.js";

vi.mock("openclaw/plugin-sdk/system-event-runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/system-event-runtime")>()),
  enqueueRoutedSystemEvent: vi.fn(),
}));

it("records the admitted Slack sender and validated workspace for approval review", async () => {
  const ctx = createInboundSlackTestContext({
    cfg: { channels: { slack: { enabled: true } } } as OpenClawConfig,
  });
  ctx.teamId = "";
  ctx.resolveUserName = async () => ({ name: "Alice" });
  const eventScope = {
    teamId: "T123ENTERPRISE",
    client: {} as SlackEventScope["client"],
  } satisfies SlackEventScope;
  const message: SlackMessageEvent = {
    type: "message",
    channel: "D999",
    channel_type: "im",
    user: "U123",
    text: "hello",
    ts: "1.000",
  };

  const prepared = await prepareSlackMessage({
    ctx,
    account: createSlackTestAccount(),
    message,
    opts: { source: "message", eventScope },
  });

  expect(prepared?.ctxPayload.ApprovalSource).toEqual({
    channel: "slack",
    senderId: "U123",
    senderName: "Alice",
    workspaceId: "T123ENTERPRISE",
    conversationKind: "direct",
    includeUserMessageExcerpt: true,
  });
});
