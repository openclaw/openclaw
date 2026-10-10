import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { getSessionBindingService } from "openclaw/plugin-sdk/conversation-runtime";
import {
  observeHostDataSql,
  openIncognitoTestActor,
  useSessionStoreTempDirs,
  withIncognitoSessionActor,
} from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { afterAll, expect, it } from "vitest";
import type { TelegramBotDeps } from "./bot-deps.js";
import { createTelegramMessageSessionRuntime } from "./bot-handlers.message-context.js";
import {
  createFreshTelegramSessionEntryLoader,
  resolveTelegramReasoningLevel,
} from "./bot-message-dispatch-session.js";
import {
  TELEGRAM_THREAD_BINDINGS_TEST_CFG,
  useTelegramThreadBindingsFixture,
} from "./thread-bindings.test-support.js";

const fixture = useTelegramThreadBindingsFixture();
const dirs = useSessionStoreTempDirs(afterAll, "telegram-bound-session-");
const authority = { assertCurrent() {} };

it("routes a bound topic to the actor for model and reasoning facts without host SQL", async () => {
  const env = { OPENCLAW_STATE_DIR: dirs.make() };
  const actor = await openIncognitoTestActor(env, authority);
  const sessionKey = "agent:main:dashboard:incognito-telegram";
  const cfg: OpenClawConfig = {
    ...TELEGRAM_THREAD_BINDINGS_TEST_CFG,
    session: { store: actor.path },
  };
  await fixture.createManager({ accountId: "default", persist: true, enableSweeper: false });
  await getSessionBindingService().bind({
    conversation: { channel: "telegram", accountId: "default", conversationId: "-100:topic:42" },
    targetKind: "subagent",
    targetSessionKey: sessionKey,
  });
  try {
    await actor.sessions.create(authority, {
      sessionKey,
      entry: {
        sessionId: "telegram",
        updatedAt: 1,
        incognito: true,
        providerOverride: "openai",
        modelOverride: "selected",
        reasoningLevel: "stream",
      },
    });
    const telegramDeps = { resolveStorePath: () => actor.path } as TelegramBotDeps;
    const runtime = createTelegramMessageSessionRuntime({
      accountId: "default",
      resolveTelegramGroupConfig: () => ({}),
      telegramDeps,
    });
    const sql = observeHostDataSql();
    try {
      await withIncognitoSessionActor(actor, async () => {
        const selected = await runtime.resolveTelegramSessionState({
          chatId: -100,
          isGroup: true,
          threadSpec: { scope: "forum", id: 42 },
          runtimeCfg: cfg,
        });
        expect(selected).toMatchObject({ sessionKey, model: "openai/selected" });
        const loadFreshSessionEntry = createFreshTelegramSessionEntryLoader({ cfg, telegramDeps });
        await expect(
          resolveTelegramReasoningLevel({
            cfg,
            sessionKey,
            agentId: "main",
            loadFreshSessionEntry,
          }),
        ).resolves.toBe("stream");
        await actor.close();
        await expect(
          resolveTelegramReasoningLevel({
            cfg,
            sessionKey,
            agentId: "main",
            loadFreshSessionEntry,
          }),
        ).rejects.toMatchObject({ code: "INCOGNITO_SESSION_ENDED" });
      });
      expect(sql.queries).toEqual([]);
    } finally {
      sql.restore();
    }
  } finally {
    await actor.close();
  }
});
