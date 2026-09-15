// Feishu tests cover per-account markdown table mode on the send and edit paths.
import {
  createEmptyPluginRegistry,
  createTestRegistry,
  resetPluginRuntimeStateForTest,
  setActivePluginRegistry,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ClawdbotConfig } from "../runtime-api.js";

const createFeishuClientMock = vi.hoisted(() => vi.fn());

vi.mock("./client.js", () => ({
  createFeishuClient: createFeishuClientMock,
}));

let editMessageFeishu: typeof import("./send.js").editMessageFeishu;
let sendMessageFeishu: typeof import("./send.js").sendMessageFeishu;

const tableMarkdown = "| Name | Role |\n| --- | --- |\n| Ada | Lead |";
const tableBullets = "**Ada**  \n• Role: Lead";
// Root credentials make the implicit default account configured, so the real
// account resolver runs and defaultAccount selection is exercised as shipped.
const cfg: ClawdbotConfig = {
  channels: {
    feishu: {
      appId: "cli_a1",
      appSecret: "local-test-placeholder", // pragma: allowlist secret
      markdown: { tables: "bullets" },
      accounts: { work: { markdown: { tables: "off" } } },
    },
  },
};
const defaultAccountCfg: ClawdbotConfig = {
  channels: {
    feishu: {
      appId: "cli_a1",
      appSecret: "local-test-placeholder", // pragma: allowlist secret
      defaultAccount: "work",
      markdown: { tables: "off" },
      accounts: { work: { markdown: { tables: "bullets" } } },
    },
  },
};

function postText(request: unknown): string {
  const content = (request as { data?: { content?: string } } | undefined)?.data?.content;
  return JSON.parse(content ?? "null").zh_cn.content[0][0].text;
}

describe("feishu markdown table mode per account", () => {
  const create = vi.fn();
  const update = vi.fn();

  beforeAll(async () => {
    // The shared resolver reads config only for a registered channel id, and this
    // harness does not load the runtime setup, so register a minimal feishu plugin.
    setActivePluginRegistry(
      createTestRegistry([
        { pluginId: "feishu", source: "test", plugin: { id: "feishu", meta: { id: "feishu" } } },
      ]),
    );
    ({ editMessageFeishu, sendMessageFeishu } = await import("./send.js"));
  });

  afterAll(() => {
    resetPluginRuntimeStateForTest();
    setActivePluginRegistry(createEmptyPluginRegistry());
    vi.doUnmock("./client.js");
    vi.resetModules();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    create.mockResolvedValue({ code: 0, data: { message_id: "om_table" } });
    update.mockResolvedValue({ code: 0 });
    createFeishuClientMock.mockReturnValue({ im: { message: { create, reply: vi.fn(), update } } });
  });

  it("sends the named account's table mode and keeps the channel mode without an account", async () => {
    await sendMessageFeishu({ cfg, to: "oc_send", text: tableMarkdown, accountId: "work" });
    await sendMessageFeishu({ cfg, to: "oc_send", text: tableMarkdown });

    expect(postText(create.mock.calls[0]?.[0])).toBe(tableMarkdown);
    expect(postText(create.mock.calls[1]?.[0])).toBe(tableBullets);
  });

  it("edits rich posts with the named account's table mode", async () => {
    await editMessageFeishu({ cfg, messageId: "om_edit", text: tableMarkdown, accountId: "work" });
    await editMessageFeishu({ cfg, messageId: "om_edit", text: tableMarkdown });

    expect(postText(update.mock.calls[0]?.[0])).toBe(tableMarkdown);
    expect(postText(update.mock.calls[1]?.[0])).toBe(tableBullets);
  });

  it("follows defaultAccount when the account id is omitted", async () => {
    await sendMessageFeishu({ cfg: defaultAccountCfg, to: "oc_send", text: tableMarkdown });
    await editMessageFeishu({ cfg: defaultAccountCfg, messageId: "om_edit", text: tableMarkdown });

    expect(postText(create.mock.calls[0]?.[0])).toBe(tableBullets);
    expect(postText(update.mock.calls[0]?.[0])).toBe(tableBullets);
  });
});
