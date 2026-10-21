import { WebAPIPlatformError, WebAPIRequestError } from "@slack/web-api";
import { createPluginRuntimeMock } from "openclaw/plugin-sdk/channel-test-helpers";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { addChannelAllowFromStoreEntry } from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { withOpenClawTestState } from "openclaw/plugin-sdk/test-state";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { setSlackRuntime } from "../runtime.js";
import type { SlackMonitorContext } from "./context.js";

const participantDescriptors = vi.hoisted(
  () =>
    [] as Array<
      import("openclaw/plugin-sdk/channel-ingress-runtime").ChannelIngressIdentityDescriptor
    >,
);
const readChannelIngressStoreAllowFromForDmPolicyMock = vi.hoisted(() => vi.fn());
let authorizeSlackBotRoomMessage: typeof import("./auth.js").authorizeSlackBotRoomMessage;
let authorizeSlackSystemEventSender: typeof import("./auth.js").authorizeSlackSystemEventSender;
let resolveSlackEffectiveAllowFrom: typeof import("./auth.js").resolveSlackEffectiveAllowFrom;
let resolveSlackCommandIngress: typeof import("./auth.js").resolveSlackCommandIngress;
let SlackSystemEventAuthRetryError: typeof import("./auth.js").SlackSystemEventAuthRetryError;

beforeAll(async () => {
  ({
    authorizeSlackBotRoomMessage,
    authorizeSlackSystemEventSender,
    resolveSlackCommandIngress,
    resolveSlackEffectiveAllowFrom,
    SlackSystemEventAuthRetryError,
  } = await import("./auth.js"));
});

beforeEach(() => {
  setSlackRuntime(createPluginRuntimeMock());
  readChannelIngressStoreAllowFromForDmPolicyMock.mockReset().mockResolvedValue([]);
});

vi.mock("openclaw/plugin-sdk/channel-ingress-runtime", async () => {
  const actual = await vi.importActual<
    typeof import("openclaw/plugin-sdk/channel-ingress-runtime")
  >("openclaw/plugin-sdk/channel-ingress-runtime");
  return {
    ...actual,
    defineStableChannelIngressIdentity: (
      params: Parameters<typeof actual.defineStableChannelIngressIdentity>[0],
    ) => {
      const identity = actual.defineStableChannelIngressIdentity(params);
      participantDescriptors.push(identity);
      return identity;
    },
    readChannelIngressStoreAllowFromForDmPolicy: (...args: unknown[]) =>
      readChannelIngressStoreAllowFromForDmPolicyMock(...args),
  };
});

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
      authorizeSlackSystemEventSender({
        ctx: makeAuthorizeCtx({
          allowNameMatching: true,
          channelsConfig: { C1: { users: ["alice"] } },
          resolveUserName: async () => ({ error }),
        }),
        senderId: "U_PENDING",
        channelId: "C1",
        retryNameLookup: true,
      });
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
    type MembersResponse = { members: string[]; response_metadata: Record<string, never> };
    const members = createDeferred<MembersResponse>();
    const { authorize, conversationsMembers } = makeChannelMemberAuth(vi.fn(() => members.promise));

    const first = authorize();
    const second = authorize();
    members.resolve({ members: ["UOWNER"], response_metadata: {} });

    await expect(Promise.all([first, second])).resolves.toEqual([true, true]);
    expect(conversationsMembers).toHaveBeenCalledTimes(1);
  });

  it.each([["a cursor cycle", ["cursor-a", "cursor-b", "cursor-a"]]] as const)(
    "denies channel bot authorization on %s and retries cleanly",
    async (_name, cursors) => {
      type MembersResponse = {
        members: string[];
        response_metadata: { next_cursor?: string };
      };
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
    },
  );

  it.each([
    [
      "keeps non-interactive channels open with only global allowFrom",
      { allowFrom: ["U_OWNER"] },
      { senderId: "U_ATTACKER", channelId: "C1" },
      allowedChannel,
    ],
    [
      "allows channel users absent from global allowFrom",
      { allowFrom: ["U_OWNER"], channelsConfig: channelUsers },
      { senderId: "U_ALLOWED", channelId: "C1" },
      allowedChannel,
    ],
    [
      "keeps owners behind the channel users gate despite a global wildcard",
      { allowFrom: ["U_OWNER", "*"], channelsConfig: channelUsers },
      { senderId: "U_OWNER", channelId: "C1" },
      deniedChannel,
    ],
  ] satisfies AuthorizeCase[])("%s", async (_name, ctx, request, expected) => {
    await expect(
      authorizeSlackSystemEventSender({ ctx: makeAuthorizeCtx(ctx), ...request }),
    ).resolves.toEqual(expected);
  });

  it("does not use pairing-store allowFrom for MPIM system events", async () => {
    readChannelIngressStoreAllowFromForDmPolicyMock.mockResolvedValue(["U_ATTACKER"]);
    const result = await authorizeSlackSystemEventSender({
      ctx: makeAuthorizeCtx({
        allowFrom: [],
        dmPolicy: "pairing",
        resolveChannelName: async () => ({ name: "group-dm", type: "mpim" }),
      }),
      senderId: "U_ATTACKER",
      channelId: "G_MPIM",
    });

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

  it.each([
    ["allows the workspace-qualified user in its workspace", "T11111111", "allow", true],
    ["blocks the same bare user ID in another workspace", "T22222222", "block", false],
  ] as const)("%s", async (_name, teamId, decision, allowed) => {
    const result = await commandIngress({
      ctx: makeAuthorizeCtx({
        installationIdentity: { kind: "enterprise", enterpriseId: "E11111111" },
      }),
      teamId,
      senderId: "U01234567",
      channelType: "channel",
      channelId: "C01234567",
      channelUsers: ["team:T11111111:user:U01234567"],
    });

    expect(result.senderAccess).toMatchObject({ decision, gate: { allowed } });
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

  it.each([
    ["blocks MPIM senders outside the configured allowFrom", "U_ATTACKER", "block", false],
    ["allows MPIM senders in the configured allowFrom", "U_OWNER", "allow", true],
  ] as const)("%s", async (_name, senderId, decision, allowed) => {
    const result = await commandIngress({
      senderId,
      channelType: "mpim",
      channelId: "G_MPIM",
      ownerAllowFromLower: ["u_owner"],
    });

    expect(result.senderAccess).toMatchObject({ decision, gate: { allowed } });
  });
});

describe("authorizeSlackSystemEventSender interactiveEvent", () => {
  it.each([
    [
      "rejects missing expectedSenderId",
      { allowFrom: ["U_OWNER"] },
      { senderId: "U_OWNER", channelId: "C1", interactiveEvent: true },
      { allowed: false, reason: "missing-expected-sender" },
    ],
    [
      "reports denial by both global and channel allowlists",
      { allowFrom: ["U_OWNER"], channelsConfig: channelUsers },
      interactiveRequest("U_ATTACKER", { channelId: "C1" }),
      { ...deniedChannel, reason: "sender-not-authorized" },
    ],
    [
      "preserves explicit owner access alongside a wildcard",
      { allowFrom: ["U_OWNER", "*"], channelsConfig: channelUsers },
      interactiveRequest("U_OWNER", { channelId: "C1" }),
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
      { allowFrom: ["U_OWNER"] },
      interactiveRequest("U_ATTACKER"),
      { allowed: false, reason: "sender-not-allowlisted" },
    ],
    [
      "rejects ambiguous channel type",
      {
        allowFrom: ["U_OWNER"],
        resolveChannelName: async () => ({ name: "mystery" }),
      },
      interactiveRequest("U_OWNER", { channelId: "X1" }),
      { ...deniedChannel, reason: "ambiguous-channel-type", channelName: "mystery" },
    ],
    [
      "accepts explicit channel type",
      {
        allowFrom: ["U_OWNER"],
        resolveChannelName: async () => ({ name: "mystery", type: "group" as const }),
      },
      interactiveRequest("U_OWNER", { channelId: "X1", channelType: "group" }),
      { allowed: true, channelType: "group", channelName: "mystery" },
    ],
  ] satisfies AuthorizeCase[])("%s", async (_name, ctx, request, expected) => {
    await expect(
      authorizeSlackSystemEventSender({ ctx: makeAuthorizeCtx(ctx), ...request }),
    ).resolves.toEqual(expected);
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
      participantDescriptors
        .at(-1)
        ?.resolveParticipant?.({ stableId: "u123", aliases: { workspaceSenderId } }),
    ).toEqual(expected);
  },
);
