import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import {
  registerSessionBindingAdapter,
  testing as sessionBindingTesting,
} from "openclaw/plugin-sdk/conversation-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { inspectSlackConversationRouteOwner } from "./conversation-route-owner.test-support.js";
import { registerSlackInstallationState } from "./installation-identity-state.js";

const defaultSlack = { accounts: { default: {} } };
function inspect(
  peerId = "C456",
  slack: NonNullable<OpenClawConfig["channels"]>["slack"] = defaultSlack,
  accountId = "default",
  threadId?: string,
) {
  return inspectSlackConversationRouteOwner({
    cfg: { channels: { slack } },
    accountId,
    conversation: { kind: "channel", peerId, threadId },
  });
}
function binding(
  conversation: { channel: string; accountId: string; conversationId: string },
  id: string,
) {
  return {
    bindingId: `binding-${id}`,
    targetSessionKey: "agent:finance:bound",
    targetKind: "session" as const,
    conversation,
    status: "active" as const,
    boundAt: 1,
  };
}

describe("inspectSlackConversationRouteOwner", () => {
  let releaseInstallation: (() => void) | undefined;

  beforeEach(() => {
    for (const key of ["SLACK_BOT_TOKEN", "SLACK_APP_TOKEN", "SLACK_USER_TOKEN"]) {
      vi.stubEnv(key, undefined);
    }
    sessionBindingTesting.resetSessionBindingAdaptersForTests();
    releaseInstallation = registerSlackInstallationState("default", "workspace").release;
  });

  afterEach(() => {
    releaseInstallation?.();
    sessionBindingTesting.resetSessionBindingAdaptersForTests();
    vi.unstubAllEnvs();
  });

  it("prefers the thread over its parent without touching liveness", async () => {
    const touch = vi.fn();
    const resolveByConversation = vi.fn((conversation) =>
      conversation.conversationId === "thread-1" ? binding(conversation, "thread") : null,
    );
    registerSessionBindingAdapter({
      channel: "slack",
      accountId: "default",
      listBySession: () => [],
      resolveByConversation,
      touch,
    });

    expect(await inspect("channel-1", defaultSlack, "default", "thread-1")).toEqual({
      kind: "agent",
      agentId: "finance",
    });
    expect(resolveByConversation).toHaveBeenCalledWith({
      channel: "slack",
      accountId: "default",
      conversationId: "thread-1",
      parentConversationId: "channel-1",
    });
    expect(touch).not.toHaveBeenCalled();
  });

  it("distinguishes degraded identity from a qualified target conflict", async () => {
    releaseInstallation?.();
    const installation = registerSlackInstallationState("default", "degraded");
    releaseInstallation = installation.release;

    expect(await inspect()).toEqual({ kind: "unavailable" });
    installation.update("workspace");
    expect(await inspect("team:T123:channel:C456")).toBeNull();
  });

  it("fails closed when workspace identity is released during binding inspection", async () => {
    registerSessionBindingAdapter({
      channel: "slack",
      accountId: "default",
      listBySession: () => [],
      resolveByConversation: (conversation) => binding(conversation, "channel"),
    });
    expect(await inspect()).toEqual({
      kind: "agent",
      agentId: "finance",
    });
    releaseInstallation?.();
    releaseInstallation = undefined;
    expect(await inspect()).toEqual({ kind: "unavailable" });
  });
  const inactiveAccounts: Array<{
    name: string;
    accountId: string;
    slack: NonNullable<OpenClawConfig["channels"]>["slack"];
  }> = [
    { name: "removed account", accountId: "retired", slack: { accounts: { default: {} } } },
    { name: "removed default account", accountId: "default", slack: { accounts: {} } },
    {
      name: "disabled account",
      accountId: "default",
      slack: { accounts: { default: { enabled: false } } },
    },
    {
      name: "disabled channel",
      accountId: "default",
      slack: { enabled: false, accounts: { default: { enabled: true } } },
    },
  ];
  it.each(inactiveAccounts)(
    "rejects a $name without requiring installation identity",
    async ({ accountId, slack }) => {
      releaseInstallation?.();
      releaseInstallation = undefined;

      expect(await inspect("C456", slack, accountId)).toBeNull();
    },
  );

  it("preserves a configured default while its token and installation are unavailable", async () => {
    vi.stubEnv("OPENCLAW_TEST_MISSING_SLACK_BOT_TOKEN", undefined);
    releaseInstallation?.();
    releaseInstallation = undefined;
    expect(
      await inspect("C456", {
        botToken: {
          source: "env",
          provider: "default",
          id: "OPENCLAW_TEST_MISSING_SLACK_BOT_TOKEN",
        },
        appToken: "synthetic-app-token",
        accounts: { secondary: {} },
      }),
    ).toEqual({
      kind: "unavailable",
    });
  });
});
