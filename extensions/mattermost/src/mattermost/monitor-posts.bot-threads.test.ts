import { resolveChannelGroupRequireMention } from "openclaw/plugin-sdk/channel-policy";
import { createPluginRuntimeMock } from "openclaw/plugin-sdk/channel-test-helpers";
import { isControlCommandMessage } from "openclaw/plugin-sdk/command-detection";
import { shouldHandleTextCommands } from "openclaw/plugin-sdk/command-surface";
import { expect, it, vi } from "vitest";
import { setMattermostRuntime } from "../runtime.js";
import type { MattermostConfig } from "../types.js";
import { resolveMattermostAccount } from "./accounts.js";
import { createMattermostPostHandler } from "./monitor-posts.js";
import type { MattermostMonitorContext } from "./monitor-types.js";
import type { OpenClawConfig } from "./runtime-api.js";

const dispatch = vi.hoisted(() => vi.fn());
const hasParticipation = vi.hoisted(() => vi.fn());
const body = "Continue the discussion";
const threadPolicy = (requireMentionInBotThreads: boolean) => ({ requireMentionInBotThreads });

vi.mock("./monitor-turn.js", () => ({ dispatchMattermostInboundTurn: dispatch }));
vi.mock("./thread-participation.js", () => ({
  hasMattermostThreadParticipationWithPersistence: hasParticipation,
}));
vi.mock("openclaw/plugin-sdk/channel-inbound", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/channel-inbound")>()),
  resolveInboundSessionEnvelopeContextAsync: async () => ({ envelopeOptions: {} }),
}));

function setup(config: Partial<MattermostConfig> = {}, botUsername = "bot", accountId = "default") {
  dispatch.mockReset();
  hasParticipation.mockReset().mockResolvedValue(false);
  const mattermost: MattermostConfig = {
    requireMention: true,
    groupPolicy: "open",
    historyLimit: 0,
    ...config,
  };
  const cfg: OpenClawConfig = { channels: { mattermost } };
  const account = resolveMattermostAccount({ cfg, accountId });
  const core = createPluginRuntimeMock();
  core.channel.mentions.buildMentionRegexes = () => [];
  core.channel.groups.resolveRequireMention = resolveChannelGroupRequireMention;
  core.channel.commands.shouldHandleTextCommands = () => false;
  setMattermostRuntime(core);
  const root = { id: "root", channel_id: "room", user_id: "bot" };
  const request = vi.fn(async (endpoint: string) => {
    expect(endpoint).toBe("/posts/root");
    return root;
  });
  const monitor = {
    cfg,
    account,
    core,
    client: { request },
    botUserId: "bot",
    botUsername,
    groupPolicy: account.config.groupPolicy ?? "open",
    pairing: { readAllowFromStore: async () => [] },
    resources: {
      resolveChannelInfo: async () => ({ id: "room", type: "O" }),
      resolveMattermostMedia: async () => [],
    },
    runtime: { log: vi.fn(), error: vi.fn() },
    logVerboseMessage: vi.fn(),
  } as unknown as MattermostMonitorContext;
  const handler = createMattermostPostHandler(monitor);
  const receive = (message = body, id = "follow-up") =>
    handler(
      { id, root_id: "root", channel_id: "room", user_id: "sender", message },
      { data: { sender_name: "sender" } },
    );
  return { core, root, request, receive };
}

const policy = {
  implicitMentions: { threadParticipation: true },
  accounts: { work: { implicitMentions: { threadParticipation: false } } },
};
const relaxedThread = { ...threadPolicy(true), groups: { "*": threadPolicy(false) } };
const explicitOnly = {
  implicitMentions: { threadParticipation: false },
  groupAllowFrom: ["sender"],
};
const mention = "@bot continue the discussion";
const mentioned = { BodyForAgent: "continue the discussion", WasMentioned: true };
const commanded = {
  ...mentioned,
  BodyForAgent: "/reset",
  CommandAuthorized: true,
  CommandSource: "text",
};
const threadReply = { BodyForAgent: body, MessageThreadId: "root" };
const accountRequirement = { requireMention: false, ...threadPolicy(true) };
const groupRequirement = {
  ...threadPolicy(false),
  groups: { "*": threadPolicy(false), room: threadPolicy(true) },
};
type Options = {
  activation?: string;
  commands?: boolean;
  accountId?: string;
  engaged?: boolean;
  botUsername?: string;
  rootAuthor?: string;
  rootError?: boolean;
  request?: boolean;
};
const explicit = { activation: mention, commands: true };
const noMention = threadPolicy(false);
const noDetector = { botUsername: "", rootAuthor: "someone-else", engaged: false };
const disabled = { ...noMention, groupPolicy: "disabled" } satisfies Partial<MattermostConfig>;
const denied = {
  ...noMention,
  groupPolicy: "allowlist",
  groupAllowFrom: ["trusted"],
} satisfies Partial<MattermostConfig>;
it.each([
  ["default follow-up", {}, { BodyForAgent: body, WasMentioned: true }],
  ["channel policy", policy, { AccountId: "default", WasMentioned: true }],
  ["account participation override", policy, null, { accountId: "work" }],
  ["wildcard bot-thread override", relaxedThread, threadReply, { engaged: false }],
  ["explicit mention", explicitOnly, mentioned, explicit],
  ["authorized command", explicitOnly, commanded, { ...explicit, activation: "/reset" }],
  ["account bot-thread requirement", accountRequirement, true, { activation: mention }],
  ["exact group bot-thread requirement", groupRequirement, true, { activation: mention }],
  ["another author's thread without detectors", threadPolicy(true), true, noDetector],
  ["unreadable root", noMention, null, { rootError: true, request: true, engaged: false }],
  ["disabled group", disabled, null, { request: false }],
  ["unlisted sender", denied, null, { request: false }],
] satisfies Array<[string, Partial<MattermostConfig>, object | true | null, Options?]>)(
  "applies %s",
  async (_name, config, expected, options: Options = {}) => {
    const { activation, commands, accountId = "default", engaged = true } = options;
    const f = setup(config, options.botUsername ?? "bot", accountId);
    if (options.rootAuthor) {
      f.root.user_id = options.rootAuthor;
    }
    if (options.rootError) {
      f.request.mockRejectedValue(new Error("Mattermost API 403 Forbidden"));
    }
    if (commands) {
      f.core.channel.commands.isControlCommandMessage = isControlCommandMessage;
      f.core.channel.commands.shouldHandleTextCommands = shouldHandleTextCommands;
    }
    hasParticipation.mockResolvedValue(engaged);
    if (activation) {
      await f.receive();
      expect(dispatch).not.toHaveBeenCalled();
    }
    await f.receive(activation, activation ? "activated-follow-up" : undefined);
    expect(dispatch).toHaveBeenCalledTimes(expected ? 1 : 0);
    if (expected && expected !== true) {
      expect(dispatch.mock.calls[0]?.[1].ctxPayload).toMatchObject(expected);
    }
    if (options.request !== undefined) {
      expect(f.request.mock.calls.length > 0).toBe(options.request);
    }
  },
);
