import { beforeEach, describe, expect, it } from "vitest";
import {
  warnGroupAllowlistDropPerChatOnce,
  warnGroupAllowlistMisconfigOnce,
} from "./group-allowlist-warnings.js";

let accountSequence = 0;
let accountId = "";
let messages: string[];
const log = (message: string) => messages.push(message);
const warnMisconfig = (
  overrides: Partial<Parameters<typeof warnGroupAllowlistMisconfigOnce>[0]> = {},
) =>
  warnGroupAllowlistMisconfigOnce({
    groupPolicy: "allowlist",
    hasGroupAllowFrom: false,
    accountId,
    log,
    ...overrides,
  });
const warnChat = (chatId: string | number | undefined) =>
  warnGroupAllowlistDropPerChatOnce({ accountId, chatId, log });

function resetLog() {
  accountId = `test-${++accountSequence}`;
  messages = [];
}

describe("warnGroupAllowlistMisconfigOnce", () => {
  beforeEach(resetLog);
  it("warns once per account when allowlist has no effective groupAllowFrom", () => {
    expect(warnMisconfig()).toBe(true);
    expect(warnMisconfig()).toBe(false);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain('groupPolicy="allowlist"');
    expect(messages[0]).toContain("channels.imessage.groupAllowFrom");
    expect(messages[0]).toContain(accountId);
  });

  it.each([{ groupPolicy: "open" }, { hasGroupAllowFrom: true }])(
    "does not warn for an admissible configuration: %j",
    (config) => {
      expect(warnMisconfig(config)).toBe(false);
      expect(messages).toHaveLength(0);
    },
  );

  it("fires separately for distinct accountIds", () => {
    warnMisconfig({ accountId: `${accountId}-primary` });
    warnMisconfig({ accountId: `${accountId}-secondary` });
    expect(messages).toHaveLength(2);
  });
});

describe("warnGroupAllowlistDropPerChatOnce", () => {
  beforeEach(resetLog);
  it("fires once per accountId:chat_id pair", () => {
    expect(warnChat(42)).toBe(true);
    expect(warnChat(42)).toBe(false);
    expect(warnChat("42")).toBe(false);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain("chat_id=42");
    expect(messages[0]).toContain(accountId);
    expect(messages[0]).toContain('channels.imessage.groups["42"]');
  });

  it("skips when chat_id is undefined or empty", () => {
    expect(warnChat(undefined)).toBe(false);
    expect(warnChat("")).toBe(false);
    expect(messages).toHaveLength(0);
  });

  it("bounds warn-once state by least-recently-used account/chat pairs", () => {
    for (let chatId = 0; chatId < 512; chatId += 1) {
      expect(warnChat(chatId)).toBe(true);
    }
    expect(warnChat(0)).toBe(false);
    expect(warnChat(512)).toBe(true);

    messages.length = 0;
    expect(warnChat(0)).toBe(false);
    expect(warnChat(1)).toBe(true);
    expect(warnChat(512)).toBe(false);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain("chat_id=1");
  });
});
