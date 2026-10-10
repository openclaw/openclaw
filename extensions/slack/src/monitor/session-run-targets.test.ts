import "openclaw/plugin-sdk/compiled-subprocess-testing";
import {
  registerSessionBindingAdapter,
  unregisterSessionBindingAdapter,
  type SessionBindingRecord,
} from "openclaw/plugin-sdk/conversation-runtime";
import { upsertSessionEntry } from "openclaw/plugin-sdk/session-store-runtime";
import {
  closeOpenClawAgentDatabasesAsync,
  observeHostDataSql,
  openIncognitoTestActor,
  withIncognitoSessionBinding,
} from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { afterAll, expect, it } from "vitest";
import { resolveSlackSessionEventRoutingContext } from "./message-handler/prepare-routing.js";
import {
  createInboundSlackTestContext,
  createSlackTestAccount,
} from "./message-handler/prepare.test-helpers.js";

const tempDirs = useAutoCleanupTempDirTracker(afterAll);
afterAll(() => closeOpenClawAgentDatabasesAsync());

it("targets Stop at the live bound actor and revokes it on rebind or generation change", async () => {
  const env = { OPENCLAW_STATE_DIR: tempDirs.make("slack-bound-stop-") };
  const authority = { assertCurrent() {} };
  const actor = await openIncognitoTestActor(env, authority);
  const sessionKey = "agent:main:dashboard:incognito-slack";
  const binding: SessionBindingRecord = {
    bindingId: "slack-private",
    targetSessionKey: sessionKey,
    targetKind: "session",
    status: "active",
    boundAt: 1,
    metadata: {},
    conversation: {
      channel: "slack",
      accountId: "default",
      conversationId: "1.000",
      parentConversationId: "user:U1",
    },
  };
  let active: SessionBindingRecord | null = binding;
  const adapter = {
    channel: "slack",
    accountId: "default",
    listBySession: () => [],
    resolveByConversation: (ref: SessionBindingRecord["conversation"]) =>
      ref.conversationId === binding.conversation.conversationId &&
      ref.parentConversationId === binding.conversation.parentConversationId
        ? active
        : null,
  };
  registerSessionBindingAdapter(adapter);
  try {
    await actor.sessions.create(authority, {
      sessionKey,
      entry: { sessionId: "original", updatedAt: 1, incognito: true },
    });
    const ctx = createInboundSlackTestContext({
      cfg: { session: { store: actor.path }, channels: { slack: { enabled: true } } },
    });
    const input = {
      ctx,
      account: createSlackTestAccount(),
      chatType: "direct" as const,
      intent: "stop" as const,
      message: {
        type: "message" as const,
        channel: "D1",
        channel_type: "im",
        user: "U1",
        text: "stop",
        ts: "2.000",
        thread_ts: "1.000",
      },
    };
    await withIncognitoSessionBinding({ actor }, async () => {
      const sql = observeHostDataSql();
      try {
        const selected = await resolveSlackSessionEventRoutingContext(input);
        expect(selected.sessionKey).toBe(sessionKey);
        expect(selected.isCurrentSession()).toBe(true);
        active = null;
        expect(selected.isCurrentSession()).toBe(false);
        active = binding;
        const recaptured = await resolveSlackSessionEventRoutingContext(input);
        await upsertSessionEntry({
          agentId: "main",
          storePath: actor.path,
          sessionKey,
          entry: { sessionId: "replacement", updatedAt: 2, incognito: true },
        });
        expect(recaptured.isCurrentSession()).toBe(false);
        expect(sql.queries).toEqual([]);
      } finally {
        sql.restore();
      }
    });
  } finally {
    unregisterSessionBindingAdapter({ channel: "slack", accountId: "default", adapter });
    await actor.close();
  }
});
