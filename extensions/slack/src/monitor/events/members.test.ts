import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const memberMocks = vi.hoisted(() => ({
  enqueue: vi.fn(),
  mutateConfigFile: vi.fn(),
  getOptionalSlackRuntime: vi.fn(),
}));
let registerSlackMemberEvents: typeof import("./members.js").registerSlackMemberEvents;
let initSlackHarness: typeof import("./system-event-test-harness.js").createSlackSystemEventTestHarness;
type MemberOverrides = import("./system-event-test-harness.js").SlackSystemEventTestOverrides;

vi.mock("openclaw/plugin-sdk/system-event-runtime", () => ({
  enqueueSystemEvent: (...args: unknown[]) => memberMocks.enqueue(...args),
}));
vi.mock("openclaw/plugin-sdk/system-event-runtime.js", () => ({
  enqueueSystemEvent: (...args: unknown[]) => memberMocks.enqueue(...args),
}));
vi.mock("../../runtime.js", () => ({
  getOptionalSlackRuntime: () => memberMocks.getOptionalSlackRuntime(),
}));
type MemberHandler = (args: { event: Record<string, unknown>; body: unknown }) => Promise<void>;

type MemberCaseArgs = {
  event?: Record<string, unknown>;
  body?: unknown;
  overrides?: MemberOverrides;
  handler?: "joined" | "left";
  trackEvent?: () => void;
  shouldDropMismatchedSlackEvent?: (body: unknown) => boolean;
};

function makeMemberEvent(overrides?: { channel?: string; user?: string; inviter?: string }) {
  return {
    type: "member_joined_channel",
    user: overrides?.user ?? "U1",
    ...(overrides?.inviter ? { inviter: overrides.inviter } : {}),
    channel: overrides?.channel ?? "D1",
    event_ts: "123.456",
  };
}

function getMemberHandlers(params: {
  overrides?: MemberOverrides;
  trackEvent?: () => void;
  shouldDropMismatchedSlackEvent?: (body: unknown) => boolean;
}) {
  const harness = initSlackHarness(params.overrides);
  if (params.shouldDropMismatchedSlackEvent) {
    harness.ctx.shouldDropMismatchedSlackEvent = params.shouldDropMismatchedSlackEvent;
  }
  registerSlackMemberEvents({ ctx: harness.ctx, trackEvent: params.trackEvent });
  return {
    joined: harness.getHandler("member_joined_channel") as MemberHandler | null,
    left: harness.getHandler("member_left_channel") as MemberHandler | null,
  };
}

async function runMemberCase(args: MemberCaseArgs = {}): Promise<void> {
  memberMocks.enqueue.mockClear();
  const handlers = getMemberHandlers({
    overrides: args.overrides,
    trackEvent: args.trackEvent,
    shouldDropMismatchedSlackEvent: args.shouldDropMismatchedSlackEvent,
  });
  const key = args.handler ?? "joined";
  const handler = handlers[key];
  if (!handler) {
    throw new Error(`expected Slack member ${key} handler`);
  }
  await handler({
    event: (args.event ?? makeMemberEvent()) as Record<string, unknown>,
    body: args.body ?? {},
  });
}

describe("registerSlackMemberEvents", () => {
  beforeAll(async () => {
    ({ registerSlackMemberEvents } = await import("./members.js"));
    ({ createSlackSystemEventTestHarness: initSlackHarness } =
      await import("./system-event-test-harness.js"));
  });

  beforeEach(() => {
    memberMocks.enqueue.mockClear();
    memberMocks.mutateConfigFile.mockReset();
    memberMocks.getOptionalSlackRuntime.mockReset();
    memberMocks.getOptionalSlackRuntime.mockReturnValue({
      config: {
        mutateConfigFile: memberMocks.mutateConfigFile,
      },
    });
  });

  const cases: Array<{ name: string; args: MemberCaseArgs; calls: number }> = [
    {
      name: "enqueues DM member events when dmPolicy is open",
      args: { overrides: { dmPolicy: "open" } },
      calls: 1,
    },
    {
      name: "blocks DM member events when dmPolicy is disabled",
      args: { overrides: { dmPolicy: "disabled" } },
      calls: 0,
    },
    {
      name: "blocks DM member events for unauthorized senders in allowlist mode",
      args: {
        overrides: { dmPolicy: "allowlist", allowFrom: ["U2"] },
        event: makeMemberEvent({ user: "U1" }),
      },
      calls: 0,
    },
    {
      name: "allows DM member events for authorized senders in allowlist mode",
      args: {
        handler: "left" as const,
        overrides: { dmPolicy: "allowlist", allowFrom: ["U1"] },
        event: { ...makeMemberEvent({ user: "U1" }), type: "member_left_channel" },
      },
      calls: 1,
    },
    {
      name: "blocks channel member events for users outside channel users allowlist",
      args: {
        overrides: {
          dmPolicy: "open",
          channelType: "channel",
          channelUsers: ["U_OWNER"],
        },
        event: makeMemberEvent({ channel: "C1", user: "U_ATTACKER" }),
      },
      calls: 0,
    },
  ];
  it.each(cases)("$name", async ({ args, calls }) => {
    await runMemberCase(args);
    expect(memberMocks.enqueue).toHaveBeenCalledTimes(calls);
  });

  it("does not track mismatched events", async () => {
    const trackEvent = vi.fn();
    await runMemberCase({
      trackEvent,
      shouldDropMismatchedSlackEvent: () => true,
      body: { api_app_id: "A_OTHER" },
    });

    expect(trackEvent).not.toHaveBeenCalled();
  });

  it("tracks accepted member events", async () => {
    const trackEvent = vi.fn();
    await runMemberCase({ trackEvent });

    expect(trackEvent).toHaveBeenCalledTimes(1);
  });

  it("adds a channel allowlist entry when an allowlisted user invites OpenClaw", async () => {
    await runMemberCase({
      overrides: {
        allowFrom: ["U_OWNER"],
        channelType: "channel",
        userNames: { U_OWNER: "owner" },
      },
      event: makeMemberEvent({
        channel: "CNEW",
        user: "U_BOT",
        inviter: "U_OWNER",
      }),
    });

    expect(memberMocks.mutateConfigFile).toHaveBeenCalledTimes(1);
    const call = memberMocks.mutateConfigFile.mock.calls[0]?.[0] as {
      mutate: (draft: Record<string, unknown>) => void;
    };
    const draft: Record<string, unknown> = {
      channels: {
        slack: {
          accounts: {
            default: {},
          },
        },
      },
    };
    call.mutate(draft);
    expect(draft).toMatchObject({
      channels: {
        slack: {
          accounts: {
            default: {
              channels: {
                CNEW: {
                  enabled: true,
                  requireMention: true,
                },
              },
            },
          },
        },
      },
    });
    expect(memberMocks.enqueue).toHaveBeenCalledTimes(1);
  });

  it("does not add a channel allowlist entry for a non-allowlisted inviter", async () => {
    await runMemberCase({
      overrides: {
        allowFrom: ["U_OWNER"],
        channelType: "channel",
      },
      event: makeMemberEvent({
        channel: "CNEW",
        user: "U_BOT",
        inviter: "U_ATTACKER",
      }),
    });

    expect(memberMocks.mutateConfigFile).not.toHaveBeenCalled();
  });
});
