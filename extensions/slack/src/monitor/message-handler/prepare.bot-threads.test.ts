import type { App } from "@slack/bolt";
import { createOpenClawCodingToolsAsync } from "openclaw/plugin-sdk/agent-harness";
import { withRegisteredChannelIngress } from "openclaw/plugin-sdk/channel-ingress-test-runtime";
import { resolveCommandAuthorizationAsync } from "openclaw/plugin-sdk/command-auth-native";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import {
  createTestRegistry,
  getActivePluginRegistry,
  resetPluginRuntimeStateForTest,
  setActivePluginRegistry,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "openclaw/plugin-sdk/runtime-config-snapshot";
import { enqueueRoutedSystemEvent } from "openclaw/plugin-sdk/system-event-runtime";
import { withOpenClawTestState } from "openclaw/plugin-sdk/test-state";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { slackPlugin } from "../../../channel-plugin-api.js";
import { mergeSlackAccountConfig } from "../../accounts.js";
import { SlackConfigSchema } from "../../config-schema.js";
import * as slackRuntime from "../../runtime.js";
import {
  clearSlackThreadParticipationCache,
  recordSlackThreadParticipation,
} from "../../sent-thread-cache.js";
import type { SlackMessageEvent } from "../../types.js";
import { createSlackMessageHandler } from "../message-handler.js";
import { prepareSlackMessage } from "./prepare.js";
import {
  createInboundSlackTestContext,
  createSlackSessionStoreFixture,
  createSlackTestAccount,
} from "./prepare.test-helpers.js";

vi.mock("openclaw/plugin-sdk/system-event-runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/system-event-runtime")>()),
  enqueueRoutedSystemEvent: vi.fn(),
}));
const store = createSlackSessionStoreFixture("slack-bot-thread-mentions-");
beforeEach(() => {
  clearSlackThreadParticipationCache();
  vi.mocked(enqueueRoutedSystemEvent).mockClear();
});
afterEach(() => {
  clearRuntimeConfigSnapshot();
  vi.restoreAllMocks();
});

type SlackConfig = NonNullable<NonNullable<OpenClawConfig["channels"]>["slack"]>;
const botThreads = (required: boolean) => ({ requireMentionInBotThreads: required });
let caseId = 0;
function fixture(
  slack: SlackConfig = {},
  accountId = "default",
  messages?: OpenClawConfig["messages"],
  options: { commands?: OpenClawConfig["commands"]; senderId?: string } = {},
) {
  const threadTs = `${1700000000 + caseId++}.000000`;
  const cfg: OpenClawConfig = {
    session: { store: store.makeTmpStorePath().storePath },
    messages,
    commands: options.commands,
    channels: {
      slack: {
        enabled: true,
        groupPolicy: "open",
        implicitMentions: { replyToBot: false, threadParticipation: false },
        ...slack,
      },
    },
  };
  setRuntimeConfigSnapshot(cfg, cfg);
  const config = mergeSlackAccountConfig(cfg, accountId);
  const account = { ...createSlackTestAccount(config), accountId };
  const replies = vi.fn().mockResolvedValue({ messages: [] });
  const addReaction = vi.fn().mockResolvedValue({ ok: true });
  const ctx = createInboundSlackTestContext({
    cfg,
    accountId,
    defaultRequireMention: config.requireMention,
    channelsConfig: config.channels,
    groupPolicy: config.groupPolicy,
    appClient: {
      conversations: { replies },
      reactions: { add: addReaction },
    } as unknown as App["client"],
  });
  ctx.resolveUserName = async () => ({ name: "Synthetic sender" });
  ctx.resolveChannelName = async () => ({ name: "synthetic-room", type: "channel" });
  const info = vi.spyOn(ctx.logger, "info").mockImplementation(() => undefined);
  const message: SlackMessageEvent = {
    type: "message",
    channel: "C123",
    channel_type: "channel",
    user: options.senderId ?? "U1",
    ts: threadTs.replace(".000000", ".000001"),
    thread_ts: threadTs,
    parent_user_id: "B1",
    text: "Continue here",
  };
  const prepare = () => prepareSlackMessage({ ctx, account, message, opts: { source: "message" } });
  const expectDrop = (reason: string) =>
    expect(info).toHaveBeenCalledWith(expect.objectContaining({ reason }), expect.any(String));
  return { cfg, ctx, message, replies, addReaction, prepare, threadTs, expectDrop };
}

it("validates scoped boolean overrides without adding a default", () => {
  const parsed = SlackConfigSchema.parse({
    ...botThreads(false),
    channels: { "*": botThreads(true) },
    accounts: { work: { ...botThreads(true), channels: { C123: botThreads(false) } } },
  });
  expect(parsed.accounts?.work?.channels?.C123?.requireMentionInBotThreads).toBe(false);
  expect(SlackConfigSchema.parse({}).requireMentionInBotThreads).toBeUndefined();
  expect(SlackConfigSchema.safeParse({ requireMentionInBotThreads: "false" }).success).toBe(false);
});

it.each<[string, SlackConfig, string, boolean]>([
  ["account", { ...botThreads(true), accounts: { work: botThreads(false) } }, "work", true],
  [
    "disabled room",
    { ...botThreads(false), channels: { C123: { enabled: false } } },
    "default",
    false,
  ],
])("applies the %s override to unmentioned replies", async (_, slack, accountId, allowed) => {
  const test = fixture(slack, accountId);
  const prepared = await test.prepare();
  if (allowed) {
    expect(prepared?.ctxPayload).toMatchObject({
      RawBody: "Continue here",
      MentionSource: "none",
      MessageThreadId: test.threadTs,
    });
  } else {
    expect(prepared).toBeNull();
    test.expectDrop("channel-not-allowed");
  }
});

it("stops the real handler when mention policy changes during root lookup", async () => {
  const test = fixture({ ...botThreads(false), historyLimit: 0 }, "default", {
    ackReaction: "eyes",
    ackReactionScope: "all",
    inbound: { debounceMs: 0 },
  });
  test.message.parent_user_id = undefined;
  test.replies.mockImplementation(async () => {
    const next: OpenClawConfig = {
      ...test.ctx.cfg,
      channels: { slack: { ...test.ctx.cfg.channels?.slack, ...botThreads(true) } },
    };
    setRuntimeConfigSnapshot(next, next);
    return { messages: [{ ts: test.threadTs, text: "Bot root", user: "B1" }] };
  });
  const onPrepared = vi.fn();
  await createSlackMessageHandler({ ctx: test.ctx, onPrepared })(test.message, {
    source: "message",
    awaitDispatch: true,
  });
  expect(test.replies).toHaveBeenCalledTimes(1);
  test.expectDrop("final-route-denied");
  expect(test.addReaction).not.toHaveBeenCalled();
  expect(enqueueRoutedSystemEvent).not.toHaveBeenCalled();
  expect(onPrepared).not.toHaveBeenCalled();
});

it("requires an explicit mention despite reply and participation exemptions when the channel overrides true", async () => {
  const test = fixture({
    requireMention: false,
    ...botThreads(false),
    implicitMentions: { replyToBot: true, threadParticipation: true },
    channels: { C123: botThreads(true) },
  });
  recordSlackThreadParticipation("default", "C123", test.threadTs);
  expect(await test.prepare()).toBeNull();
  test.expectDrop("missing-mention");
  test.message.text = "<@B1> Continue here";
  expect((await test.prepare())?.ctxPayload.MentionSource).toBe("explicit_bot");
});

it("admits replies to roots verified by bot ID when bot-thread mentions are disabled", async () => {
  const test = fixture({ requireMention: true, ...botThreads(false) });
  test.message.parent_user_id = undefined;
  test.replies.mockResolvedValue({
    messages: [{ ts: test.threadTs, bot_id: "B1", text: "Bot root" }],
  });
  const prepared = await test.prepare();
  expect(prepared?.ctxPayload.RawBody).toBe("Continue here");
  expect(test.replies).toHaveBeenCalledTimes(1);
});

it("grants only the current configured owner the OpenClaw tool in a bot-created thread", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const ownerId = "U123OWNER";
    const test = fixture({ requireMention: true, ...botThreads(false) }, "default", undefined, {
      commands: { ownerAllowFrom: [`slack:user:${ownerId}`] },
      senderId: ownerId,
    });
    test.cfg.agents = {
      entries: { main: { tools: { alsoAllow: ["openclaw"] } } },
      defaults: { workspace: state.workspaceDir, skipBootstrap: true },
    };
    setRuntimeConfigSnapshot(test.cfg, test.cfg);

    const previousRegistry = getActivePluginRegistry();
    setActivePluginRegistry(
      createTestRegistry([{ pluginId: slackPlugin.id, plugin: slackPlugin, source: "test" }], {
        config: test.cfg,
      }),
    );

    try {
      await withRegisteredChannelIngress(
        {
          plugin: slackPlugin,
          config: test.cfg,
          setRuntime: (runtime) => {
            vi.spyOn(slackRuntime, "getSlackRuntime").mockReturnValue(runtime);
          },
        },
        async (runtime) => {
          test.ctx.buildContext = runtime.channel.inbound.buildContext;
          const prepared = await test.prepare();
          expect(prepared?.ctxPayload).toMatchObject({
            SenderId: ownerId,
            MessageThreadId: test.threadTs,
          });
          const authorization = await resolveCommandAuthorizationAsync({
            ctx: prepared!.ctxPayload,
            cfg: test.cfg,
            commandAuthorized: true,
          });
          expect(authorization).toMatchObject({
            senderIsOwner: true,
            ownerList: [ownerId.toLowerCase()],
          });
          expect(() => authorization.assertOwnerCurrent?.()).not.toThrow();

          const tools = (senderIsOwner: boolean) =>
            createOpenClawCodingToolsAsync({
              config: test.cfg,
              agentId: "main",
              sessionKey: `agent:main:slack:channel:C123:thread:${test.threadTs}`,
              messageProvider: "slack",
              senderIsOwner,
              modelProvider: "test-provider",
              modelId: "test-model",
              workspaceDir: state.workspaceDir,
              cwd: state.workspaceDir,
            });
          expect(
            (await tools(authorization.senderIsOwner)).find((tool) => tool.name === "openclaw"),
          ).toBeDefined();

          test.message.user = "U999OTHER";
          const nonOwner = await test.prepare();
          const denied = await resolveCommandAuthorizationAsync({
            ctx: nonOwner!.ctxPayload,
            cfg: test.cfg,
            commandAuthorized: true,
          });
          expect(denied.senderIsOwner).toBe(false);
          const deniedTool = (await tools(denied.senderIsOwner)).find(
            (tool) => tool.name === "openclaw",
          );
          expect(deniedTool).toBeDefined();
          expect(JSON.stringify((await deniedTool!.execute("non-owner", {})).content)).toContain(
            "openclaw needs the owner's authority",
          );

          test.message.user = undefined;
          test.message.bot_id = "B123BOT";
          expect(await test.prepare()).toBeNull();

          test.cfg.commands = { ownerAllowFrom: [] };
          setRuntimeConfigSnapshot(test.cfg, test.cfg);
          expect(() => authorization.assertOwnerCurrent?.()).toThrow("authority changed");
        },
      );
    } finally {
      if (previousRegistry) {
        setActivePluginRegistry(previousRegistry);
      } else {
        resetPluginRuntimeStateForTest();
      }
    }
  });
});
