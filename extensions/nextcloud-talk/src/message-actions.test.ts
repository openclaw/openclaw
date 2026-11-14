import { beforeEach, expect, it, vi } from "vitest";
import type { CoreConfig, NextcloudTalkAccountConfig } from "./types.js";

const sendReactionNextcloudTalk = vi.hoisted(() => vi.fn());
// mock-isolation: Message actions stop at the send boundary without making HTTP requests.
vi.mock("./send.js", () => ({ sendReactionNextcloudTalk }));
const { nextcloudTalkMessageActions: actions } = await import("./message-actions.js");
const configured = { baseUrl: "https://nc.example.com", botSecret: "bot-secret" };
const unconfigured = { baseUrl: "", botSecret: "" };
const disabled = { ...configured, enabled: false };
const missingSecret = { ...configured, botSecret: "" };
const missingBaseUrl = { ...configured, baseUrl: "" };
const config = (work: NextcloudTalkAccountConfig = configured): CoreConfig => ({
  channels: { "nextcloud-talk": { defaultAccount: "work", accounts: { work } } },
});
const cfg = config();
const reaction = { to: "room:abc123", messageId: "1", emoji: "👍" };
type ActionContext = Parameters<NonNullable<typeof actions.handleAction>>[0];
const act = (params: ActionContext["params"], context: Partial<ActionContext> = {}) =>
  actions.handleAction!({ channel: "nextcloud-talk", action: "react", params, cfg, ...context });

beforeEach(() => {
  sendReactionNextcloudTalk.mockReset().mockResolvedValue(undefined);
});

it("returns null when no account is configured", () => {
  expect(actions.describeMessageTool?.({ cfg: config(unconfigured) })).toBeNull();
});

it.each([
  ["disabled account", disabled],
  ["missing secret", missingSecret],
  ["missing base URL", missingBaseUrl],
] as const)("returns null for %s", (_name, account) => {
  expect(actions.describeMessageTool?.({ cfg: config(account), accountId: "work" })).toBeNull();
});

it("scopes discovery to a specific account instead of another configured account", () => {
  const multi: CoreConfig = {
    channels: {
      "nextcloud-talk": {
        accounts: { work: configured, empty: unconfigured },
      },
    },
  };
  expect(actions.describeMessageTool?.({ cfg: multi, accountId: "work" })?.actions).toEqual([
    "send",
    "react",
  ]);
  expect(actions.describeMessageTool?.({ cfg: multi, accountId: "empty" })).toBeNull();
});

it.each([
  ["disabled account", disabled, reaction, /is disabled or not configured/],
  ["unconfigured account", unconfigured, reaction, /is disabled or not configured/],
  ["missing secret", missingSecret, reaction, /is disabled or not configured/],
  ["missing base URL", missingBaseUrl, reaction, /is disabled or not configured/],
  ["missing id", configured, { to: reaction.to, emoji: reaction.emoji }, /messageId required/],
  ["removal", configured, { ...reaction, remove: true }, /removal is not supported/],
] as const)("rejects %s before reaching the sender", async (_name, account, params, error) => {
  await expect(act(params, { cfg: config(account), accountId: "work" })).rejects.toThrow(error);
  expect(sendReactionNextcloudTalk).not.toHaveBeenCalled();
});

it("uses toolContext.currentMessageId when params.messageId is missing", async () => {
  expect(actions.supportsAction?.({ action: "react" })).toBe(true);
  await act(
    { to: "room:abc123", emoji: "✅", remove: false },
    { accountId: null, toolContext: { currentMessageId: 99 } },
  );
  expect(sendReactionNextcloudTalk).toHaveBeenCalledWith("room:abc123", "99", "✅", {
    accountId: undefined,
    cfg,
  });
});

it.each([
  ["send", /handled by outbound/],
  ["delete", /Action delete not supported for nextcloud-talk/],
] as const)("rejects %s through the action handler", async (action, error) => {
  await expect(act({ to: "room:abc123", text: "hi" }, { action })).rejects.toThrow(error);
});
