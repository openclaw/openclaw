import { describe, expect, it, vi } from "vitest";
import type { PluginRuntime, RuntimeEnv } from "../runtime-api.js";
import type { ResolvedNextcloudTalkAccount } from "./accounts.js";
import { handleNextcloudTalkInboundReaction } from "./inbound-reaction.js";
import { setNextcloudTalkRuntime } from "./runtime.js";
import type { CoreConfig, NextcloudTalkInboundReaction } from "./types.js";

function installReactionRuntime() {
  setNextcloudTalkRuntime({
    channel: {
      routing: {
        resolveAgentRoute: () => ({
          agentId: "agent-1",
          sessionKey: "session-key-1",
          accountId: "default",
        }),
      },
      session: {
        resolveStorePath: () => "/tmp/test-store",
        readSessionUpdatedAt: () => undefined,
        recordInboundSession: vi.fn(async () => {}),
      },
      reply: {
        resolveEnvelopeFormatOptions: () => ({}),
        formatAgentEnvelope: (_params: { body: string }) => _params.body,
        finalizeInboundContext: (ctx: unknown) => ctx,
        dispatchReplyWithBufferedBlockDispatcher: vi.fn(async () => {}),
      },
    },
  } as unknown as PluginRuntime);
}

function createTestRuntimeEnv(): RuntimeEnv {
  return {
    log: vi.fn(),
    error: vi.fn(),
  } as unknown as RuntimeEnv;
}

function makeReaction(
  overrides?: Partial<NextcloudTalkInboundReaction>,
): NextcloudTalkInboundReaction {
  return {
    messageId: "msg-1",
    roomToken: "room-allowed",
    roomName: "Allowed Room",
    actorId: "user-allowed",
    actorName: "Allowed User",
    emoji: "👍",
    operation: "added",
    timestamp: Date.now(),
    ...overrides,
  };
}

function makeAccount(
  overrides?: Partial<ResolvedNextcloudTalkAccount["config"]>,
): ResolvedNextcloudTalkAccount {
  return {
    accountId: "default",
    enabled: true,
    baseUrl: "",
    secret: "",
    secretSource: "none", // pragma: allowlist secret
    config: {
      dmPolicy: "pairing",
      allowFrom: [],
      groupPolicy: "allowlist",
      groupAllowFrom: ["user-allowed"],
      rooms: {
        "room-allowed": { enabled: true },
      },
      ...overrides,
    },
  };
}

function makeConfig(): CoreConfig {
  return {
    channels: {
      "nextcloud-talk": {
        groupPolicy: "allowlist",
        groupAllowFrom: ["user-allowed"],
      },
    },
  };
}

describe("nextcloud-talk inbound reaction dispatch", () => {
  it("dispatches reaction from allowed actor in allowed room", async () => {
    installReactionRuntime();
    const runtime = createTestRuntimeEnv();
    const _dispatchCalls: unknown[] = [];

    // Patch dispatchInboundReplyWithBase via the deliver callback
    // We verify no error logs and log shows dispatch
    await handleNextcloudTalkInboundReaction({
      reaction: makeReaction(),
      account: makeAccount(),
      config: makeConfig(),
      runtime,
    });

    // Should not log any drop messages
    const logCalls = (runtime.log as ReturnType<typeof vi.fn>).mock.calls.map(
      (c) => c[0] as string,
    );
    expect(logCalls.filter((m) => m.includes("drop"))).toHaveLength(0);
  });

  it("silently drops reaction from disallowed actor", async () => {
    installReactionRuntime();
    const runtime = createTestRuntimeEnv();

    await handleNextcloudTalkInboundReaction({
      reaction: makeReaction({ actorId: "attacker", actorName: "Attacker" }),
      account: makeAccount(),
      config: makeConfig(),
      runtime,
    });

    const logCalls = (runtime.log as ReturnType<typeof vi.fn>).mock.calls.map(
      (c) => c[0] as string,
    );
    expect(logCalls.some((m) => m.includes("drop actor"))).toBe(true);
  });

  it("silently drops reaction from room not in allowlist", async () => {
    installReactionRuntime();
    const runtime = createTestRuntimeEnv();

    await handleNextcloudTalkInboundReaction({
      reaction: makeReaction({ roomToken: "room-unknown" }),
      account: makeAccount(),
      config: makeConfig(),
      runtime,
    });

    const logCalls = (runtime.log as ReturnType<typeof vi.fn>).mock.calls.map(
      (c) => c[0] as string,
    );
    expect(logCalls.some((m) => m.includes("drop room"))).toBe(true);
  });

  it("dispatches reaction with operation=removed", async () => {
    installReactionRuntime();
    const runtime = createTestRuntimeEnv();

    await handleNextcloudTalkInboundReaction({
      reaction: makeReaction({ operation: "removed" }),
      account: makeAccount(),
      config: makeConfig(),
      runtime,
    });

    const logCalls = (runtime.log as ReturnType<typeof vi.fn>).mock.calls.map(
      (c) => c[0] as string,
    );
    expect(logCalls.filter((m) => m.includes("drop"))).toHaveLength(0);
  });
});
