import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import {
  registerSessionBindingAdapter,
  testing as sessionBindingTesting,
} from "openclaw/plugin-sdk/conversation-runtime";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
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
type BindingAdapter = Parameters<typeof registerSessionBindingAdapter>[0];
type Conversation = Parameters<NonNullable<BindingAdapter["resolveByConversation"]>>[0];
function binding(conversation: Conversation, id: string) {
  return {
    bindingId: `binding-${id}`,
    targetSessionKey: "agent:finance:bound",
    targetKind: "session" as const,
    conversation,
    status: "active" as const,
    boundAt: 1,
  };
}
function registerBindingAdapter(
  resolveByConversation: BindingAdapter["resolveByConversation"],
  touch?: BindingAdapter["touch"],
) {
  registerSessionBindingAdapter({
    channel: "slack",
    accountId: "default",
    listBySession: () => [],
    resolveByConversation,
    touch,
  });
}

let releaseInstallation: (() => void) | undefined;
function release() {
  releaseInstallation?.();
  releaseInstallation = undefined;
}

beforeEach(() => {
  for (const key of ["SLACK_BOT_TOKEN", "SLACK_APP_TOKEN", "SLACK_USER_TOKEN"]) {
    vi.stubEnv(key, undefined);
  }
  sessionBindingTesting.resetSessionBindingAdaptersForTests();
  releaseInstallation = registerSlackInstallationState("default", "workspace").release;
});

afterEach(() => {
  release();
  sessionBindingTesting.resetSessionBindingAdaptersForTests();
  vi.unstubAllEnvs();
});

it("prefers the thread over its parent without touching liveness", async () => {
  const touch = vi.fn();
  const resolveByConversation = vi.fn((conversation) =>
    conversation.conversationId === "thread-1" ? binding(conversation, "thread") : null,
  );
  registerBindingAdapter(resolveByConversation, touch);

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
  release();
  const installation = registerSlackInstallationState("default", "degraded");
  releaseInstallation = installation.release;

  expect(await inspect()).toEqual({ kind: "unavailable" });
  installation.update("workspace");
  expect(await inspect("team:T123:channel:C456")).toBeNull();
});

it("fails closed when workspace identity is released during binding inspection", async () => {
  registerBindingAdapter((conversation) => binding(conversation, "channel"));
  expect(await inspect()).toEqual({
    kind: "agent",
    agentId: "finance",
  });
  release();
  expect(await inspect()).toEqual({ kind: "unavailable" });
});
it.each([
  ["removed account", "retired", { accounts: { default: {} } }],
  ["removed default account", "default", { accounts: {} }],
  ["disabled account", "default", { accounts: { default: { enabled: false } } }],
  ["disabled channel", "default", { enabled: false, accounts: { default: { enabled: true } } }],
] as const)("rejects inactive %s without identity", async (_name, accountId, slack) => {
  release();

  expect(await inspect("C456", slack, accountId)).toBeNull();
});

it("preserves a configured default while its token and installation are unavailable", async () => {
  vi.stubEnv("OPENCLAW_TEST_MISSING_SLACK_BOT_TOKEN", undefined);
  release();
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
