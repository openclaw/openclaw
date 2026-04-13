import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { SlackMonitorContext } from "./context.js";

const readStoreAllowFromForDmPolicyMock = vi.hoisted(() => vi.fn());
let authorizeSlackSystemEventSender: typeof import("./auth.js").authorizeSlackSystemEventSender;
let clearSlackAllowFromCacheForTest: typeof import("./auth.js").clearSlackAllowFromCacheForTest;
let resolveSlackEffectiveAllowFrom: typeof import("./auth.js").resolveSlackEffectiveAllowFrom;

vi.mock("openclaw/plugin-sdk/security-runtime", async () => {
  const actual = await vi.importActual<typeof import("openclaw/plugin-sdk/security-runtime")>(
    "openclaw/plugin-sdk/security-runtime",
  );
  return {
    ...actual,
    readStoreAllowFromForDmPolicy: (...args: unknown[]) =>
      readStoreAllowFromForDmPolicyMock(...args),
  };
});

function makeSlackCtx(allowFrom: string[]): SlackMonitorContext {
  return {
    allowFrom,
    accountId: "main",
    dmPolicy: "pairing",
  } as unknown as SlackMonitorContext;
}

function makeAuthorizeCtx(params?: {
  allowFrom?: string[];
  channelsConfig?: Record<string, { users?: string[] }>;
  resolveUserName?: (userId: string) => Promise<{ name?: string }>;
  resolveChannelName?: (
    channelId: string,
  ) => Promise<{ name?: string; type?: "im" | "mpim" | "channel" | "group" }>;
}) {
  return {
    allowFrom: params?.allowFrom ?? [],
    accountId: "main",
    dmPolicy: "open",
    dmEnabled: true,
    allowNameMatching: false,
    channelsConfig: params?.channelsConfig ?? {},
    channelsConfigKeys: Object.keys(params?.channelsConfig ?? {}),
    defaultRequireMention: true,
    isChannelAllowed: vi.fn(() => true),
    resolveUserName: vi.fn(
      params?.resolveUserName ?? ((_) => Promise.resolve({ name: undefined })),
    ),
    resolveChannelName: vi.fn(
      params?.resolveChannelName ?? ((_) => Promise.resolve({ name: "general", type: "channel" })),
    ),
  } as unknown as SlackMonitorContext;
}

describe("resolveSlackEffectiveAllowFrom", () => {
  const prevTtl = process.env.OPENCLAW_SLACK_PAIRING_ALLOWFROM_CACHE_TTL_MS;

  beforeAll(async () => {
    ({
      authorizeSlackSystemEventSender,
      clearSlackAllowFromCacheForTest,
      resolveSlackEffectiveAllowFrom,
    } = await import("./auth.js"));
  });

  beforeEach(() => {
    readStoreAllowFromForDmPolicyMock.mockReset();
    clearSlackAllowFromCacheForTest();
    if (prevTtl === undefined) {
      delete process.env.OPENCLAW_SLACK_PAIRING_ALLOWFROM_CACHE_TTL_MS;
    } else {
      process.env.OPENCLAW_SLACK_PAIRING_ALLOWFROM_CACHE_TTL_MS = prevTtl;
    }
  });

  it("falls back to channel config allowFrom when pairing store throws", async () => {
    readStoreAllowFromForDmPolicyMock.mockRejectedValueOnce(new Error("boom"));

    const effective = await resolveSlackEffectiveAllowFrom(makeSlackCtx(["u1"]));

    expect(effective.allowFrom).toEqual(["u1"]);
    expect(effective.allowFromLower).toEqual(["u1"]);
  });

  it("treats malformed non-array pairing-store responses as empty", async () => {
    readStoreAllowFromForDmPolicyMock.mockReturnValueOnce(undefined);

    const effective = await resolveSlackEffectiveAllowFrom(makeSlackCtx(["u1"]));

    expect(effective.allowFrom).toEqual(["u1"]);
    expect(effective.allowFromLower).toEqual(["u1"]);
  });

  it("memoizes pairing-store allowFrom reads within TTL", async () => {
    readStoreAllowFromForDmPolicyMock.mockResolvedValue(["u2"]);
    const ctx = makeSlackCtx(["u1"]);

    const first = await resolveSlackEffectiveAllowFrom(ctx, { includePairingStore: true });
    const second = await resolveSlackEffectiveAllowFrom(ctx, { includePairingStore: true });

    expect(first.allowFrom).toEqual(["u1", "u2"]);
    expect(second.allowFrom).toEqual(["u1", "u2"]);
    expect(readStoreAllowFromForDmPolicyMock).toHaveBeenCalledTimes(1);
  });

  it("refreshes pairing-store allowFrom when cache TTL is zero", async () => {
    process.env.OPENCLAW_SLACK_PAIRING_ALLOWFROM_CACHE_TTL_MS = "0";
    readStoreAllowFromForDmPolicyMock.mockResolvedValue(["u2"]);
    const ctx = makeSlackCtx(["u1"]);

    await resolveSlackEffectiveAllowFrom(ctx, { includePairingStore: true });
    await resolveSlackEffectiveAllowFrom(ctx, { includePairingStore: true });

    expect(readStoreAllowFromForDmPolicyMock).toHaveBeenCalledTimes(2);
  });
});

describe("authorizeSlackSystemEventSender", () => {
  beforeAll(async () => {
    ({ authorizeSlackSystemEventSender, clearSlackAllowFromCacheForTest } =
      await import("./auth.js"));
  });

  beforeEach(() => {
    clearSlackAllowFromCacheForTest();
  });

  it("blocks channel senders outside a configured global allowFrom", async () => {
    const result = await authorizeSlackSystemEventSender({
      ctx: makeAuthorizeCtx({ allowFrom: ["U_OWNER"] }),
      senderId: "U_ATTACKER",
      channelId: "C1",
    });

    expect(result).toEqual({
      allowed: false,
      reason: "sender-not-allowlisted",
      channelType: "channel",
      channelName: "general",
    });
  });

  it("allows channel senders who match the global allowFrom even when channel users are configured", async () => {
    const result = await authorizeSlackSystemEventSender({
      ctx: makeAuthorizeCtx({
        allowFrom: ["U_OWNER"],
        channelsConfig: {
          C1: { users: ["U_ALLOWED"] },
        },
      }),
      senderId: "U_OWNER",
      channelId: "C1",
    });

    expect(result).toEqual({
      allowed: true,
      channelType: "channel",
      channelName: "general",
    });
  });

  it("uses a combined denial reason when sender matches neither global nor channel allowlists", async () => {
    const result = await authorizeSlackSystemEventSender({
      ctx: makeAuthorizeCtx({
        allowFrom: ["U_OWNER"],
        channelsConfig: {
          C1: { users: ["U_ALLOWED"] },
        },
      }),
      senderId: "U_ATTACKER",
      channelId: "C1",
    });

    expect(result).toEqual({
      allowed: false,
      reason: "sender-not-authorized",
      channelType: "channel",
      channelName: "general",
    });
  });

  it("allows channel senders authorized by channel users even when not in global allowFrom", async () => {
    const result = await authorizeSlackSystemEventSender({
      ctx: makeAuthorizeCtx({
        allowFrom: ["U_OWNER"],
        channelsConfig: {
          C1: { users: ["U_ALLOWED"] },
        },
      }),
      senderId: "U_ALLOWED",
      channelId: "C1",
    });

    expect(result).toEqual({
      allowed: true,
      channelType: "channel",
      channelName: "general",
    });
  });

  it("keeps channel interactions open when no global or channel allowlists are configured", async () => {
    const result = await authorizeSlackSystemEventSender({
      ctx: makeAuthorizeCtx(),
      senderId: "U_ANYONE",
      channelId: "C1",
    });

    expect(result).toEqual({
      allowed: true,
      channelType: "channel",
      channelName: "general",
    });
  });

  it("does not let a wildcard global allowFrom bypass channel users restrictions", async () => {
    const result = await authorizeSlackSystemEventSender({
      ctx: makeAuthorizeCtx({
        allowFrom: ["*"],
        channelsConfig: {
          C1: { users: ["U_ALLOWED"] },
        },
      }),
      senderId: "U_ATTACKER",
      channelId: "C1",
    });

    expect(result).toEqual({
      allowed: false,
      reason: "sender-not-authorized",
      channelType: "channel",
      channelName: "general",
    });
  });

  it("still allows a channel user when the global allowFrom is wildcard", async () => {
    const result = await authorizeSlackSystemEventSender({
      ctx: makeAuthorizeCtx({
        allowFrom: ["*"],
        channelsConfig: {
          C1: { users: ["U_ALLOWED"] },
        },
      }),
      senderId: "U_ALLOWED",
      channelId: "C1",
    });

    expect(result).toEqual({
      allowed: true,
      channelType: "channel",
      channelName: "general",
    });
  });

  it("ignores wildcard owner access when channel users are configured, even if explicit owners are also listed", async () => {
    const result = await authorizeSlackSystemEventSender({
      ctx: makeAuthorizeCtx({
        allowFrom: ["U_OWNER", "*"],
        channelsConfig: {
          C1: { users: ["U_ALLOWED"] },
        },
      }),
      senderId: "U_ATTACKER",
      channelId: "C1",
    });

    expect(result).toEqual({
      allowed: false,
      reason: "sender-not-authorized",
      channelType: "channel",
      channelName: "general",
    });
  });

  it("preserves explicit owner access when allowFrom also contains wildcard", async () => {
    const result = await authorizeSlackSystemEventSender({
      ctx: makeAuthorizeCtx({
        allowFrom: ["U_OWNER", "*"],
        channelsConfig: {
          C1: { users: ["U_ALLOWED"] },
        },
      }),
      senderId: "U_OWNER",
      channelId: "C1",
    });

    expect(result).toEqual({
      allowed: true,
      channelType: "channel",
      channelName: "general",
    });
  });

  it("allows senders without channel context when no allowFrom is configured", async () => {
    const result = await authorizeSlackSystemEventSender({
      ctx: makeAuthorizeCtx(),
      senderId: "U_ANYONE",
    });

    expect(result).toEqual({
      allowed: true,
      channelType: "channel",
      channelName: undefined,
    });
  });
});
