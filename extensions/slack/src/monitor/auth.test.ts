import { WebAPIPlatformError, WebAPIRequestError } from "@slack/web-api";
import { createPluginRuntimeMock } from "openclaw/plugin-sdk/channel-test-helpers";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { addChannelAllowFromStoreEntry } from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { withOpenClawTestState } from "openclaw/plugin-sdk/test-state";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { setSlackRuntime } from "../runtime.js";
import type { SlackMonitorContext } from "./context.js";
import { authorizeSlackDirectMessage } from "./dm-auth.js";
import { slackIngressIdentity } from "./ingress-identity.js";

const upsertChannelPairingRequestMock = vi.hoisted(() => vi.fn());

vi.mock("openclaw/plugin-sdk/conversation-runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/conversation-runtime")>()),
  upsertChannelPairingRequest: upsertChannelPairingRequestMock,
}));

const readChannelIngressStoreAllowFromForDmPolicyMock = vi.hoisted(() => vi.fn());
const {
  authorizeSlackBotRoomMessage,
  authorizeSlackSystemEventSender,
  resolveSlackCommandIngress,
  resolveSlackEffectiveAllowFrom,
  SlackSystemEventAuthRetryError,
} = await import("./auth.js");

beforeEach(() => {
  setSlackRuntime(createPluginRuntimeMock());
  readChannelIngressStoreAllowFromForDmPolicyMock.mockReset().mockResolvedValue([]);
});

vi.mock("openclaw/plugin-sdk/channel-ingress-runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/channel-ingress-runtime")>()),
  readChannelIngressStoreAllowFromForDmPolicy: (...args: unknown[]) =>
    readChannelIngressStoreAllowFromForDmPolicyMock(...args),
}));

function makeAuthorizeCtx(
  params: {
    allowFrom?: string[];
    allowNameMatching?: boolean;
    channelsConfig?: Record<string, { users?: string[] }>;
    dmPolicy?: SlackMonitorContext["dmPolicy"];
    installationIdentity?: SlackMonitorContext["installationIdentity"];
    isChannelAllowed?: () => boolean;
    resolveUserName?: (userId: string) => Promise<{ name?: string; error?: unknown }>;
    resolveChannelName?: (
      channelId: string,
    ) => Promise<{ name?: string; type?: "im" | "mpim" | "channel" | "group" }>;
  } = {},
) {
  return {
    allowFrom: [],
    accountId: "main",
    dmPolicy: "open",
    dmEnabled: true,
    allowNameMatching: false,
    channelsConfig: {},
    defaultRequireMention: true,
    installationIdentity: { kind: "workspace", teamId: "T_MAIN" },
    ...params,
    channelsConfigKeys: Object.keys(params.channelsConfig ?? {}),
    isChannelAllowed: vi.fn(params.isChannelAllowed ?? (() => true)),
    resolveUserName: vi.fn(params.resolveUserName ?? (async () => ({ name: undefined }))),
    resolveChannelName: vi.fn(
      params.resolveChannelName ?? (async () => ({ name: "general", type: "channel" })),
    ),
  } as unknown as SlackMonitorContext;
}

type AuthorizeContextOptions = Parameters<typeof makeAuthorizeCtx>[0];
type AuthorizeRequest = Omit<Parameters<typeof authorizeSlackSystemEventSender>[0], "ctx">;
type AuthorizeExpected = Awaited<ReturnType<typeof authorizeSlackSystemEventSender>>;
type AuthorizeCase = [string, AuthorizeContextOptions, AuthorizeRequest, AuthorizeExpected];
const authorizeSystemEvent = (ctx: AuthorizeContextOptions, request: AuthorizeRequest) =>
  authorizeSlackSystemEventSender({ ctx: makeAuthorizeCtx(ctx), ...request });

const allowedChannel: AuthorizeExpected = {
  allowed: true,
  channelType: "channel",
  channelName: "general",
};
const deniedChannel: AuthorizeExpected = {
  allowed: false,
  reason: "sender-not-channel-allowed",
  channelType: "channel",
  channelName: "general",
};
const channelUsers = { C1: { users: ["U_ALLOWED"] } };
const owner = { allowFrom: ["U_OWNER"] };
const ownerAndChannel = { ...owner, channelsConfig: channelUsers };
const channelSender = (senderId: string): AuthorizeRequest => ({ senderId, channelId: "C1" });
type MembersResponse = { members: string[]; response_metadata: { next_cursor?: string } };

function interactiveRequest(
  senderId: string,
  request: Omit<
    Partial<AuthorizeRequest>,
    "senderId" | "expectedSenderId" | "interactiveEvent"
  > = {},
): AuthorizeRequest {
  return { senderId, expectedSenderId: senderId, interactiveEvent: true, ...request };
}

function makeChannelMemberAuth(
  conversationsMembers = vi.fn(async () => ({ members: ["UOWNER"], response_metadata: {} })),
) {
  const ctx = {
    allowFrom: [],
    accountId: "main",
    allowNameMatching: false,
    app: { client: { conversations: { members: conversationsMembers } } },
    botToken: "xoxb-test",
  } as unknown as SlackMonitorContext;
  const authorize = () =>
    authorizeSlackBotRoomMessage({
      ctx,
      channelId: "C1",
      senderId: "U_BOT",
      allowFromLower: ["uowner"],
    });
  return { authorize, conversationsMembers };
}

function commandIngress(params: Partial<Parameters<typeof resolveSlackCommandIngress>[0]>) {
  return resolveSlackCommandIngress({
    ctx: makeAuthorizeCtx(),
    senderId: "U123",
    channelId: "D123",
    channelType: "im",
    ownerAllowFromLower: [],
    allowTextCommands: false,
    hasControlCommand: false,
    ...params,
  });
}

describe("resolveSlackEffectiveAllowFrom", () => {
  it("reads only the current Enterprise workspace's pairing approvals", async () => {
    readChannelIngressStoreAllowFromForDmPolicyMock.mockResolvedValue([
      "ULEGACY123",
      "team:T11111111:user:U11111111",
      "team:T22222222:user:U22222222",
    ]);
    const ctx = makeAuthorizeCtx({
      allowFrom: ["UCONFIG123"],
      dmPolicy: "pairing",
      installationIdentity: { kind: "enterprise", enterpriseId: "E11111111" },
    });

    await expect(
      resolveSlackEffectiveAllowFrom(ctx, {
        includePairingStore: true,
        eventScope: { teamId: "T11111111", client: {} as never },
      }),
    ).resolves.toEqual(["uconfig123", "ulegacy123", "team:t11111111:user:u11111111"]);
    await expect(
      resolveSlackEffectiveAllowFrom(ctx, {
        includePairingStore: true,
        eventScope: { teamId: "T22222222", client: {} as never },
      }),
    ).resolves.toEqual(["uconfig123", "ulegacy123", "team:t22222222:user:u22222222"]);
    await expect(
      resolveSlackEffectiveAllowFrom(ctx, { includePairingStore: true }),
    ).resolves.toEqual(["uconfig123", "ulegacy123"]);
  });
});

describe("authorizeSlackSystemEventSender", () => {
  it("checks the channel gate and stable ID before resolving a member name", async () => {
    const deniedCtx = makeAuthorizeCtx({
      allowNameMatching: true,
      channelsConfig: { C1: { users: ["alice"] } },
      isChannelAllowed: () => false,
    });
    await expect(
      authorizeSlackSystemEventSender({
        ctx: deniedCtx,
        senderId: "U_DENIED",
        channelId: "C1",
        retryNameLookup: true,
      }),
    ).resolves.toMatchObject({ allowed: false, reason: "channel-not-allowed" });
    expect(deniedCtx.resolveUserName).not.toHaveBeenCalled();

    const allowedCtx = makeAuthorizeCtx({
      allowNameMatching: true,
      channelsConfig: channelUsers,
    });
    await expect(
      authorizeSlackSystemEventSender({
        ctx: allowedCtx,
        senderId: "U_ALLOWED",
        channelId: "C1",
        retryNameLookup: true,
      }),
    ).resolves.toEqual(allowedChannel);
    expect(allowedCtx.resolveUserName).not.toHaveBeenCalled();
  });

  it("retries only transient direct-name lookup failures", async () => {
    const authorize = (error: unknown) =>
      authorizeSystemEvent(
        {
          allowNameMatching: true,
          channelsConfig: { C1: { users: ["alice"] } },
          resolveUserName: async () => ({ error }),
        },
        { senderId: "U_PENDING", channelId: "C1", retryNameLookup: true },
      );
    for (const error of [
      new WebAPIRequestError(Object.assign(new Error("socket reset"), { code: "ECONNRESET" })),
      new WebAPIPlatformError({ ok: false, error: "service_unavailable" }),
    ]) {
      await expect(authorize(error)).rejects.toBeInstanceOf(SlackSystemEventAuthRetryError);
    }

    for (const error of [
      new WebAPIPlatformError({ ok: false, error: "user_not_found" }),
      new WebAPIRequestError(new DOMException("request was canceled", "AbortError")),
      new TypeError("invalid URL"),
    ]) {
      await expect(authorize(error)).resolves.toMatchObject({
        allowed: false,
        reason: "sender-not-channel-allowed",
      });
    }
  });

  it("reuses cached channel members", async () => {
    const { authorize, conversationsMembers } = makeChannelMemberAuth();
    await expect(authorize()).resolves.toBe(true);
    await expect(authorize()).resolves.toBe(true);
    expect(conversationsMembers).toHaveBeenCalledTimes(1);
  });

  it("coalesces in-flight channel member lookups", async () => {
    const members = createDeferred<MembersResponse>();
    const { authorize, conversationsMembers } = makeChannelMemberAuth(vi.fn(() => members.promise));

    const first = authorize();
    const second = authorize();
    members.resolve({ members: ["UOWNER"], response_metadata: {} });

    await expect(Promise.all([first, second])).resolves.toEqual([true, true]);
    expect(conversationsMembers).toHaveBeenCalledTimes(1);
  });

  it("denies channel bot authorization on a cursor cycle and retries cleanly", async () => {
    const cursors = ["cursor-a", "cursor-b", "cursor-a"];
    const remainingCursors = [...cursors];
    const conversationsMembers = vi.fn(async (): Promise<MembersResponse> => {
      const nextCursor = remainingCursors.shift();
      if (!nextCursor) {
        throw new Error("channel member pagination escaped the cursor guard");
      }
      return { members: ["UOWNER"], response_metadata: { next_cursor: nextCursor } };
    });
    const { authorize } = makeChannelMemberAuth(conversationsMembers);

    await expect(authorize()).resolves.toBe(false);
    expect(conversationsMembers).toHaveBeenCalledTimes(cursors.length);

    conversationsMembers.mockResolvedValueOnce({
      members: ["UOWNER"],
      response_metadata: {},
    });
    await expect(authorize()).resolves.toBe(true);
    expect(conversationsMembers).toHaveBeenCalledTimes(cursors.length + 1);
  });

  it.each([
    ["global-only stays open", owner, channelSender("U_ATTACKER"), allowedChannel],
    ["channel user need not be owner", ownerAndChannel, channelSender("U_ALLOWED"), allowedChannel],
    [
      "keeps owners behind the channel users gate despite a global wildcard",
      { allowFrom: ["U_OWNER", "*"], channelsConfig: channelUsers },
      channelSender("U_OWNER"),
      deniedChannel,
    ],
  ] satisfies AuthorizeCase[])("%s", async (_name, ctx, request, expected) => {
    await expect(authorizeSystemEvent(ctx, request)).resolves.toEqual(expected);
  });

  it("does not use pairing-store allowFrom for MPIM system events", async () => {
    readChannelIngressStoreAllowFromForDmPolicyMock.mockResolvedValue(["U_ATTACKER"]);
    const result = await authorizeSystemEvent(
      {
        allowFrom: [],
        dmPolicy: "pairing",
        resolveChannelName: async () => ({ name: "group-dm", type: "mpim" }),
      },
      { senderId: "U_ATTACKER", channelId: "G_MPIM" },
    );

    expect(result).toEqual({
      allowed: false,
      reason: "sender-not-allowlisted",
      channelType: "mpim",
      channelName: "group-dm",
    });
    expect(readChannelIngressStoreAllowFromForDmPolicyMock).not.toHaveBeenCalled();
  });
});

describe("resolveSlackCommandIngress", () => {
  it("matches an uppercase native sender against a lowercase pairing approval entry", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const actual = await vi.importActual<
        typeof import("openclaw/plugin-sdk/channel-ingress-runtime")
      >("openclaw/plugin-sdk/channel-ingress-runtime");
      readChannelIngressStoreAllowFromForDmPolicyMock.mockImplementation(
        actual.readChannelIngressStoreAllowFromForDmPolicy,
      );
      const ctx = makeAuthorizeCtx({ dmPolicy: "pairing" });
      await addChannelAllowFromStoreEntry({
        channel: "slack",
        accountId: ctx.accountId,
        entry: "u123",
      });
      const allowFrom = await resolveSlackEffectiveAllowFrom(ctx, { includePairingStore: true });
      expect(allowFrom).toEqual(["u123"]);
      for (const [senderId, authorized] of [
        ["U123", true],
        ["U999", false],
      ] as const) {
        const ingress = await commandIngress({
          ctx,
          senderId,
          senderAuthentication: "verified",
          ownerAllowFromLower: allowFrom,
          allowTextCommands: true,
          hasControlCommand: true,
        });
        expect(ingress.commandAccess).toMatchObject({
          authorized,
          shouldBlockControlCommand: !authorized,
        });
      }
    });
  });

  it("matches a slugged allowlist entry against a spaced sender name", async () => {
    const result = await commandIngress({
      ctx: makeAuthorizeCtx({ allowNameMatching: true }),
      senderName: "Alice Smith",
      ownerAllowFromLower: ["alice-smith"],
      allowTextCommands: true,
      hasControlCommand: true,
    });

    expect(result.commandAccess.authorized).toBe(true);
  });

  it("does not authorize commands when sender denial stops before the command gate", async () => {
    const result = await commandIngress({
      senderId: "U_DENIED",
      channelType: "channel",
      channelId: "C1",
      ownerAllowFromLower: ["u_owner"],
      channelUsers: ["U_ALLOWED"],
      hasControlCommand: true,
      eventKind: "button",
      modeWhenAccessGroupsOff: "configured",
    });

    expect(result).toMatchObject({
      ingress: { decision: "block" },
      commandAccess: { authorized: false, shouldBlockControlCommand: false },
    });
  });
});

describe("authorizeSlackSystemEventSender interactiveEvent", () => {
  const interactiveChannel = (senderId: string) =>
    interactiveRequest(senderId, { channelId: "C1" });
  const mystery = (type?: "group"): AuthorizeContextOptions => ({
    ...owner,
    resolveChannelName: async () => ({ name: "mystery", type }),
  });
  it.each([
    [
      "rejects missing expectedSenderId",
      owner,
      { senderId: "U_OWNER", channelId: "C1", interactiveEvent: true },
      { allowed: false, reason: "missing-expected-sender" },
    ],
    [
      "reports denial by both global and channel allowlists",
      ownerAndChannel,
      interactiveChannel("U_ATTACKER"),
      { ...deniedChannel, reason: "sender-not-authorized" },
    ],
    [
      "preserves explicit owner access alongside a wildcard",
      { allowFrom: ["U_OWNER", "*"], channelsConfig: channelUsers },
      interactiveChannel("U_OWNER"),
      allowedChannel,
    ],
    [
      "keeps no-channel events open without allowFrom",
      {},
      interactiveRequest("U_ANYONE"),
      { allowed: true, channelType: "channel", channelName: undefined },
    ],
    [
      "denies no-channel senders outside allowFrom",
      owner,
      interactiveRequest("U_ATTACKER"),
      { allowed: false, reason: "sender-not-allowlisted" },
    ],
    [
      "rejects ambiguous channel type",
      mystery(),
      interactiveRequest("U_OWNER", { channelId: "X1" }),
      { ...deniedChannel, reason: "ambiguous-channel-type", channelName: "mystery" },
    ],
    [
      "accepts explicit channel type",
      mystery("group"),
      interactiveRequest("U_OWNER", { channelId: "X1", channelType: "group" }),
      { allowed: true, channelType: "group", channelName: "mystery" },
    ],
  ] satisfies AuthorizeCase[])("%s", async (_name, ctx, request, expected) => {
    await expect(authorizeSystemEvent(ctx, request)).resolves.toEqual(expected);
  });
});

it.each([
  ["team:t001:user:u123", { domain: "t001", idKind: "user-id", id: "u123" }],
  ["team:t001:user:b123", { domain: "t001", idKind: "bot-id", id: "b123" }],
  ["team:t_invalid:user:u123", undefined],
  [undefined, undefined],
] as const)(
  "qualifies Slack participant identity from workspace evidence %s",
  (workspaceSenderId, expected) => {
    expect(
      slackIngressIdentity.resolveParticipant?.({
        stableId: "u123",
        aliases: { workspaceSenderId },
      }),
    ).toEqual(expected);
  },
);

function makeDmParams(
  dmPolicy: SlackMonitorContext["dmPolicy"],
): Parameters<typeof authorizeSlackDirectMessage>[0] {
  return {
    ctx: makeAuthorizeCtx({ dmPolicy }),
    accountId: "workspace",
    senderId: "U123",
    allowFromLower: [],
    resolveSenderName: vi.fn(async () => ({ name: "Alice" })),
    sendPairingReply: vi.fn(),
    onDisabled: vi.fn(),
    onUnauthorized: vi.fn(),
    log: vi.fn(),
  };
}

describe("authorizeSlackDirectMessage", () => {
  beforeEach(() => {
    upsertChannelPairingRequestMock.mockReset().mockResolvedValue({
      code: "ABCDEFGH",
      created: true,
    });
  });

  it("allows open DM policy when effective allowFrom includes wildcard", async () => {
    const params = makeDmParams("open");
    params.allowFromLower = ["*"];
    params.resolveSenderName = vi.fn(async () => {
      throw new Error("users.info failed");
    });

    await expect(authorizeSlackDirectMessage(params)).resolves.toBe(true);

    expect(params.onUnauthorized).not.toHaveBeenCalled();
    expect(params.resolveSenderName).not.toHaveBeenCalled();
  });

  it("rejects open DM policy when effective allowFrom lacks wildcard", async () => {
    const params = makeDmParams("open");

    await expect(authorizeSlackDirectMessage(params)).resolves.toBe(false);

    expect(params.onUnauthorized).toHaveBeenCalledWith({
      allowMatchMeta: "matchKey=none matchSource=none",
      senderName: "Alice",
    });
  });

  it("allows bare user ids for workspace-install DMs", async () => {
    const params = makeDmParams("allowlist");
    params.ctx.installationIdentity = { kind: "workspace", teamId: "T11111111" };
    params.eventScope = { teamId: "T11111111", client: {} as never };
    params.allowFromLower = ["u123"];

    await expect(authorizeSlackDirectMessage(params)).resolves.toBe(true);

    expect(params.onUnauthorized).not.toHaveBeenCalled();
  });

  it("creates independent pairing requests for the same user in two Grid workspaces", async () => {
    const teams = ["T11111111", "T22222222"];
    const requests = teams.map((teamId) => ({
      ...makeDmParams("pairing"),
      eventScope: { teamId, client: {} as never },
    }));
    await expect(Promise.all(requests.map(authorizeSlackDirectMessage))).resolves.toEqual([
      false,
      false,
    ]);
    requests.forEach((params, index) => {
      const teamId = teams[index];
      expect(upsertChannelPairingRequestMock).toHaveBeenNthCalledWith(index + 1, {
        channel: "slack",
        id: `team:${teamId}:user:U123`,
        accountId: "workspace",
        meta: { name: "Alice", teamId, senderId: "U123" },
      });
      expect(params.sendPairingReply).toHaveBeenCalledTimes(1);
    });
  });
});
