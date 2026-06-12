// Telegram tests cover the pin-from-here mirror admission path: a mirror skips the
// synthetic-sender gate but still honors destination revocation (group disabled).
import { getRuntimeConfig } from "openclaw/plugin-sdk/runtime-config-snapshot";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { defaultRouteConfig } = vi.hoisted(() => ({
  defaultRouteConfig: {
    agents: {
      list: [{ id: "main", default: true }],
    },
    channels: { telegram: {} },
    messages: { groupChat: { mentionPatterns: [] } },
  },
}));

vi.mock("openclaw/plugin-sdk/runtime-config-snapshot", async () => {
  const actual = await vi.importActual<
    typeof import("openclaw/plugin-sdk/runtime-config-snapshot")
  >("openclaw/plugin-sdk/runtime-config-snapshot");
  return {
    ...actual,
    getRuntimeConfig: vi.fn(() => defaultRouteConfig),
  };
});

const { buildTelegramMessageContextForTest } =
  await import("./bot-message-context.test-harness.js");

describe("buildTelegramMessageContext mirror revocation", () => {
  // A synthetic mirror inbound (message_id 0, from id 0), mirroring bot-message's
  // dispatchMirror.
  function mirrorForumMessage(threadId = 7) {
    return {
      message_id: 0,
      chat: {
        id: -1001234567890,
        type: "supergroup" as const,
        title: "Forum",
        is_forum: true,
      },
      date: 1_700_000_000,
      text: "·",
      message_thread_id: threadId,
      from: { id: 0, is_bot: false, first_name: "mirror" },
    };
  }

  beforeEach(() => {
    vi.mocked(getRuntimeConfig).mockReturnValue(defaultRouteConfig as never);
  });

  it("blocks a mirror to a now-disabled group (pin revoked) and fires onMirrorAdmissionBlocked", async () => {
    const onMirrorAdmissionBlocked = vi.fn();
    const ctx = await buildTelegramMessageContextForTest({
      message: mirrorForumMessage(),
      options: { mirror: true, forceWasMentioned: true, onMirrorAdmissionBlocked },
      resolveGroupActivation: () => false,
      resolveGroupRequireMention: () => false,
      resolveTelegramGroupConfig: () => ({
        groupConfig: { enabled: false },
        topicConfig: undefined,
      }),
    });

    // Destination revoked: context dropped AND signaled so dispatchMirror keeps the
    // target suppressed (the post-hoc echo must not deliver the revoked content).
    expect(ctx).toBeNull();
    expect(onMirrorAdmissionBlocked).toHaveBeenCalledTimes(1);
  });

  it("builds a mirror context for an enabled group without firing the revocation signal", async () => {
    const onMirrorAdmissionBlocked = vi.fn();
    const ctx = await buildTelegramMessageContextForTest({
      message: mirrorForumMessage(),
      options: { mirror: true, forceWasMentioned: true, onMirrorAdmissionBlocked },
      resolveGroupActivation: () => true,
      resolveGroupRequireMention: () => false,
      resolveTelegramGroupConfig: () => ({
        groupConfig: { enabled: true },
        topicConfig: undefined,
      }),
    });

    expect(ctx).not.toBeNull();
    expect(onMirrorAdmissionBlocked).not.toHaveBeenCalled();
  });
});
