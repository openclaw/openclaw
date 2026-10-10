import "openclaw/plugin-sdk/compiled-subprocess-testing";
import { existsSync } from "node:fs";
import { resolveStorePath, upsertSessionEntry } from "openclaw/plugin-sdk/session-store-runtime";
import {
  closeOpenClawAgentDatabasesAsync,
  observeHostDataSql,
  openIncognitoTestActor,
  withIncognitoSessionBinding,
} from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { afterAll, expect, it } from "vitest";
import { resolveFeishuReasoningPreviewEnabled } from "./reasoning-preview.js";

const tempDirs = useAutoCleanupTempDirTracker(afterAll);
const authority = { assertCurrent() {} };
afterAll(() => closeOpenClawAgentDatabasesAsync());

it.each(["native", "bound"] as const)(
  "prepares the %s reasoning policy and revokes previews after a policy change",
  async (mode) => {
    const env = { OPENCLAW_STATE_DIR: tempDirs.make(`feishu-reasoning-${mode}-`) };
    const storePath = resolveStorePath(undefined, { agentId: "main", env });
    const sessionKey = "agent:main:dashboard:incognito-reasoning";
    const actor = mode === "bound" ? await openIncognitoTestActor(env, authority) : undefined;
    const entry = {
      sessionId: "reasoning-session",
      updatedAt: 1,
      reasoningLevel: "stream" as const,
    };
    try {
      const verify = async () => {
        if (actor) {
          await actor.sessions.create(authority, { sessionKey, entry });
        } else {
          await upsertSessionEntry({ agentId: "main", storePath, sessionKey, entry });
        }
        const sql = observeHostDataSql();
        try {
          const prepared = await resolveFeishuReasoningPreviewEnabled({
            cfg: {},
            agentId: "main",
            storePath,
            sessionKey,
          });
          expect(prepared.enabled).toBe(true);
          expect(prepared.isCurrent()).toBe(true);
          await upsertSessionEntry({
            agentId: "main",
            storePath,
            sessionKey,
            entry: { ...entry, reasoningLevel: "off" },
          });
          expect(prepared.isCurrent()).toBe(false);
          const next = await resolveFeishuReasoningPreviewEnabled({
            cfg: { agents: { defaults: { reasoningDefault: "stream" } } },
            agentId: "main",
            storePath,
            sessionKey,
          });
          expect(next.enabled).toBe(false);
          if (actor) {
            expect(sql.queries).toEqual([]);
          }
        } finally {
          sql.restore();
        }
      };
      if (actor) {
        await withIncognitoSessionBinding({ actor }, verify);
        expect(existsSync(actor.path)).toBe(false);
      } else {
        await verify();
      }
    } finally {
      await actor?.close();
    }
  },
);

it("uses configured reasoning defaults when no session is selected", async () => {
  expect(
    await resolveFeishuReasoningPreviewEnabled({
      cfg: { agents: { defaults: { reasoningDefault: "stream" } } },
      agentId: "main",
      storePath: "/unused/sessions.json",
    }),
  ).toMatchObject({ enabled: true });
});

it("refuses an ended bound actor instead of selecting configured defaults", async () => {
  const env = { OPENCLAW_STATE_DIR: tempDirs.make("feishu-reasoning-ended-") };
  const actor = await openIncognitoTestActor(env, authority);
  await withIncognitoSessionBinding({ actor }, async () => {
    await actor.close();
    await expect(
      resolveFeishuReasoningPreviewEnabled({
        cfg: { agents: { defaults: { reasoningDefault: "stream" } } },
        agentId: "main",
        storePath: actor.path,
        sessionKey: "agent:main:dashboard:incognito-ended",
      }),
    ).rejects.toThrow();
  });
});
