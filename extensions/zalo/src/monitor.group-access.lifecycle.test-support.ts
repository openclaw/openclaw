import type { PluginRuntime } from "openclaw/plugin-sdk/runtime-store";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createLifecycleMonitorSetup,
  replayLifecycleWebhook,
  withStoppedMonitor,
} from "./test-support/lifecycle-test-support.js";
import {
  loadCachedLifecycleMonitorModule,
  resetLifecycleTestState,
  setLifecycleRuntimeCore,
  startWebhookLifecycleMonitor,
} from "./test-support/monitor-mocks-test-support.js";
import type { ZaloAccountConfig } from "./types.js";

type Reply = PluginRuntime["channel"]["reply"];
type Media = PluginRuntime["channel"]["media"];
type GroupAccessCase = {
  name: string;
  groupAccess: Pick<ZaloAccountConfig, "groupPolicy" | "groupAllowFrom" | "groups">;
  allowFrom?: string[];
  chatId?: string;
  expected: number;
};

const LISTED_GROUP = "zgr-listed";
const OTHER_GROUP = "zgr-other";
const MEMBER = "member-1";
const OWNER = "owner-1";

describe("Zalo group allowlist lifecycle", () => {
  const dispatchReply = vi.fn();
  const isControlCommandMessage = vi.fn(() => false);
  const saveRemoteMedia = vi.fn(async () => ({
    id: "zalo-group.jpg",
    path: "/tmp/zalo-group.jpg",
    size: 3,
    contentType: "image/jpeg",
  }));

  beforeAll(async () => {
    await loadCachedLifecycleMonitorModule("zalo-group-access-lifecycle");
  });

  beforeEach(async () => {
    await resetLifecycleTestState();
    isControlCommandMessage.mockReturnValue(false);
    setLifecycleRuntimeCore({
      reply: {
        dispatchReplyWithBufferedBlockDispatcher:
          dispatchReply as unknown as Reply["dispatchReplyWithBufferedBlockDispatcher"],
      },
      media: {
        saveRemoteMedia: saveRemoteMedia as unknown as Media["saveRemoteMedia"],
      },
      commands: {
        isControlCommandMessage,
        shouldComputeCommandAuthorized: vi.fn(() => true),
      },
    });
  });

  afterAll(resetLifecycleTestState);

  async function sendGroupMessage(params: {
    groupAccess: Pick<ZaloAccountConfig, "groupPolicy" | "groupAllowFrom" | "groups">;
    allowFrom?: string[];
    chatId?: string;
    text?: string;
    image?: boolean;
    rootGroups?: ZaloAccountConfig["groups"];
    extraAccount?: boolean;
  }) {
    const accountId = "acct-zalo-groups";
    const setup = createLifecycleMonitorSetup({
      accountId,
      dmPolicy: "pairing",
      allowFrom: params.allowFrom ?? [],
    });
    const accountConfig = { ...setup.account.config, ...params.groupAccess };
    const monitor = await startWebhookLifecycleMonitor({
      cacheKey: "zalo-group-access-lifecycle",
      account: { ...setup.account, config: accountConfig },
      config: {
        channels: {
          zalo: {
            enabled: true,
            ...(params.rootGroups ? { groups: params.rootGroups } : {}),
            accounts: {
              [accountId]: accountConfig,
              ...(params.extraAccount ? { other: { enabled: true } } : {}),
            },
          },
        },
      },
    });
    await withStoppedMonitor(monitor, async () => {
      const message = {
        from: { id: MEMBER, name: "Member" },
        chat: { id: params.chatId ?? LISTED_GROUP, chat_type: "GROUP" },
        message_id: `zalo-group-${Math.random()}`,
        date: Math.floor(Date.now() / 1000),
      };
      await replayLifecycleWebhook(
        monitor,
        params.image
          ? {
              event_name: "message.image.received",
              message: { ...message, photo_url: "https://example.com/group.jpg", caption: "" },
            }
          : {
              event_name: "message.text.received",
              message: { ...message, text: params.text ?? "hello group" },
            },
      );
    });
    return dispatchReply.mock.calls.length;
  }

  it.each<GroupAccessCase>([
    {
      name: "admits any member of a listed group without a sender allowlist",
      groupAccess: { groupPolicy: "allowlist", groups: { [LISTED_GROUP]: {} } },
      expected: 1,
    },
    {
      name: "drops groups missing from the groups map",
      groupAccess: { groupPolicy: "allowlist", groups: { [LISTED_GROUP]: {} } },
      chatId: OTHER_GROUP,
      expected: 0,
    },
    {
      name: "drops groups missing from the groups map even under open policy",
      groupAccess: { groupPolicy: "open", groups: { [LISTED_GROUP]: {} } },
      chatId: OTHER_GROUP,
      expected: 0,
    },
    {
      name: "drops a listed group with enabled=false",
      groupAccess: { groupPolicy: "allowlist", groups: { [LISTED_GROUP]: { enabled: false } } },
      expected: 0,
    },
    {
      name: "still requires an effective sender allowlist match in a listed group",
      groupAccess: {
        groupPolicy: "allowlist",
        groupAllowFrom: [OWNER],
        groups: { [LISTED_GROUP]: {} },
      },
      expected: 0,
    },
    {
      name: "applies the allowFrom fallback inside a listed group",
      groupAccess: { groupPolicy: "allowlist", groups: { [LISTED_GROUP]: {} } },
      allowFrom: [OWNER],
      expected: 0,
    },
    {
      name: "admits any member with groupAllowFrom wildcard alongside allowFrom",
      groupAccess: {
        groupPolicy: "allowlist",
        groupAllowFrom: ["*"],
        groups: { [LISTED_GROUP]: {} },
      },
      allowFrom: [OWNER],
      expected: 1,
    },
    {
      name: "does not let the wildcard group entry bypass sender checks",
      groupAccess: { groupPolicy: "allowlist", groups: { "*": {} } },
      chatId: OTHER_GROUP,
      expected: 0,
    },
    {
      name: "admits a wildcard-matched group when the sender matches groupAllowFrom",
      groupAccess: { groupPolicy: "allowlist", groupAllowFrom: [MEMBER], groups: { "*": {} } },
      chatId: OTHER_GROUP,
      expected: 1,
    },
    {
      name: "lets a listed group's own entry override a disabled wildcard",
      groupAccess: {
        groupPolicy: "allowlist",
        groups: { "*": { enabled: false }, [LISTED_GROUP]: {} },
      },
      expected: 1,
    },
    {
      name: "admits any member of a listed group under open policy",
      groupAccess: { groupPolicy: "open", groups: { [LISTED_GROUP]: {} } },
      expected: 1,
    },
    {
      name: "keeps disabled policy dropping listed groups",
      groupAccess: { groupPolicy: "disabled", groups: { [LISTED_GROUP]: {} } },
      expected: 0,
    },
    {
      name: "treats an empty groups map like no map",
      groupAccess: { groupPolicy: "open", groups: {} },
      chatId: OTHER_GROUP,
      expected: 1,
    },
    {
      name: "keeps sender-only allowlists working when no groups map is set",
      groupAccess: { groupPolicy: "allowlist", groupAllowFrom: [MEMBER] },
      chatId: OTHER_GROUP,
      expected: 1,
    },
  ])("$name", async ({ groupAccess, allowFrom, chatId, expected }) => {
    expect(await sendGroupMessage({ groupAccess, allowFrom, chatId })).toBe(expected);
  });

  it.each([
    [LISTED_GROUP, 1],
    [OTHER_GROUP, 0],
  ] as const)("gates image messages from %s before downloading media", async (chatId, expected) => {
    expect(
      await sendGroupMessage({
        groupAccess: { groupPolicy: "allowlist", groups: { [LISTED_GROUP]: {} } },
        chatId,
        image: true,
      }),
    ).toBe(expected);
    expect(saveRemoteMedia).toHaveBeenCalledTimes(expected);
  });

  it.each([
    [LISTED_GROUP, 1],
    [OTHER_GROUP, 0],
  ] as const)(
    "uses the account groups map in place of the channel map for %s",
    async (chatId, expected) => {
      expect(
        await sendGroupMessage({
          groupAccess: { groupPolicy: "allowlist", groups: { [LISTED_GROUP]: {} } },
          rootGroups: { [OTHER_GROUP]: {} },
          chatId,
        }),
      ).toBe(expected);
    },
  );

  it.each([
    ["inherits the channel map with one account", false, 0],
    ["opts out of the channel map with several accounts", true, 1],
  ] as const)("an empty account groups map %s", async (_label, extraAccount, expected) => {
    expect(
      await sendGroupMessage({
        groupAccess: { groupPolicy: "open", groups: {} },
        rootGroups: { [LISTED_GROUP]: {} },
        chatId: OTHER_GROUP,
        extraAccount,
      }),
    ).toBe(expected);
  });

  it("inherits the channel groups map when the account sets none", async () => {
    expect(
      await sendGroupMessage({
        groupAccess: { groupPolicy: "allowlist" },
        rootGroups: { [LISTED_GROUP]: {} },
      }),
    ).toBe(1);
  });

  it.each([
    ["drops", [], 0],
    ["keeps", [MEMBER], 1],
  ] as const)(
    "%s control commands in a listed group by sender authorization",
    async (_label, allowFrom, expected) => {
      isControlCommandMessage.mockReturnValue(true);
      expect(
        await sendGroupMessage({
          groupAccess: { groupPolicy: "allowlist", groups: { [LISTED_GROUP]: {} } },
          allowFrom: [...allowFrom],
          text: "/new",
        }),
      ).toBe(expected);
    },
  );
});
