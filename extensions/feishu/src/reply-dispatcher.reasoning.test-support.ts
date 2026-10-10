import { resolveStorePath, upsertSessionEntry } from "openclaw/plugin-sdk/session-store-runtime";
import {
  closeOpenClawAgentDatabasesAsync,
  observeHostDataSql,
  openIncognitoTestActor,
  withIncognitoSessionBinding,
} from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { afterAll, expect, it, type Mock, vi } from "vitest";
import { resolveFeishuReasoningPreviewEnabled } from "./reasoning-preview.js";
import type { createFeishuReplyDispatcher } from "./reply-dispatcher.js";
import type { FeishuStreamingSession } from "./streaming-card.js";

export type StreamingSessionStub = {
  active: boolean;
  credentials: unknown;
  start: ReturnType<typeof vi.fn>;
  update: ReturnType<typeof vi.fn>;
  closeWithResult: Mock<FeishuStreamingSession["closeWithResult"]>;
  discard: Mock<FeishuStreamingSession["discard"]>;
  isActive: ReturnType<typeof vi.fn>;
};
type ReplyDispatcherPlan = ReturnType<typeof createFeishuReplyDispatcher>;

export function registerFeishuReasoningPreviewTests(params: {
  createDispatcherHarness: (
    overrides?: Partial<Parameters<typeof createFeishuReplyDispatcher>[0]>,
  ) => {
    result: ReplyDispatcherPlan;
    options: ReplyDispatcherPlan["dispatcherOptions"] & ReplyDispatcherPlan["delivery"];
  };
  firstStreamingCloseText: (instanceIndex?: number) => string;
  stream: (instanceIndex: number) => StreamingSessionStub;
  streamingInstances: readonly StreamingSessionStub[];
}) {
  const { createDispatcherHarness, firstStreamingCloseText, stream, streamingInstances } = params;
  const tempDirs = useAutoCleanupTempDirTracker(afterAll);
  afterAll(() => closeOpenClawAgentDatabasesAsync());

  it.each(["native", "bound"] as const)(
    "joins %s first-turn reasoning preparation and rejects later disabled previews",
    async (mode) => {
      const env = { OPENCLAW_STATE_DIR: tempDirs.make(`feishu-first-reasoning-${mode}-`) };
      const authority = { assertCurrent() {} };
      const actor = mode === "bound" ? await openIncognitoTestActor(env, authority) : undefined;
      const storePath = actor?.path ?? resolveStorePath(undefined, { agentId: "main", env });
      const sessionKey = "agent:main:dashboard:incognito-first-reasoning";
      const cfg = { agents: { defaults: { reasoningDefault: "stream" as const } } };
      const verify = async () => {
        const prepared = await resolveFeishuReasoningPreviewEnabled({
          cfg,
          agentId: "main",
          storePath,
          sessionKey,
        });
        const { result, options } = createDispatcherHarness({
          cfg,
          agentId: "main",
          allowReasoningPreview: prepared.enabled,
          isReasoningPreviewCurrent: prepared.isCurrent,
          prepareReasoningPreviewCurrent: prepared.prepareCurrent,
        });
        const entry = { sessionId: "created-reasoning", updatedAt: 1, incognito: true };
        if (actor) {
          await actor.sessions.create(authority, { sessionKey, entry });
        } else {
          await upsertSessionEntry({ agentId: "main", storePath, sessionKey, entry });
        }
        const sql = observeHostDataSql();
        try {
          const pending = result.replyOptions.onReasoningStream?.({ text: "first-turn reasoning" });
          await options.onIdle?.();
          await pending;
          expect(firstStreamingCloseText()).toContain("first-turn reasoning");
          const writes = stream(0).update.mock.calls.length;
          await upsertSessionEntry({
            agentId: "main",
            storePath,
            sessionKey,
            entry: { ...entry, reasoningLevel: "off" },
          });
          await result.replyOptions.onReasoningStream?.({ text: "must remain private" });
          await options.onIdle?.();
          expect(streamingInstances).toHaveLength(1);
          expect(stream(0).update).toHaveBeenCalledTimes(writes);
          expect(stream(0).closeWithResult).toHaveBeenCalledOnce();
          if (actor) {
            expect(sql.queries).toEqual([]);
          }
        } finally {
          sql.restore();
        }
      };
      try {
        if (actor) {
          await withIncognitoSessionBinding({ actor }, verify);
        } else {
          await verify();
        }
      } finally {
        await actor?.close();
      }
    },
  );

  it("keeps absent-session reasoning bound to its original actor across replacement", async () => {
    const env = { OPENCLAW_STATE_DIR: tempDirs.make("feishu-reasoning-replaced-") };
    const authority = { assertCurrent() {} };
    const actor = await openIncognitoTestActor(env, authority);
    const sessionKey = "agent:main:dashboard:incognito-replaced-reasoning";
    const cfg = { agents: { defaults: { reasoningDefault: "stream" as const } } };
    const prepared = await withIncognitoSessionBinding({ actor }, () =>
      resolveFeishuReasoningPreviewEnabled({
        cfg,
        agentId: "main",
        storePath: actor.path,
        sessionKey,
      }),
    );
    const { result, options } = createDispatcherHarness({
      cfg,
      agentId: "main",
      allowReasoningPreview: prepared.enabled,
      isReasoningPreviewCurrent: prepared.isCurrent,
      prepareReasoningPreviewCurrent: prepared.prepareCurrent,
    });
    await actor.close();
    const replacement = await openIncognitoTestActor(env, authority);
    try {
      await replacement.sessions.create(authority, {
        sessionKey,
        entry: { sessionId: "replacement", updatedAt: 2, incognito: true },
      });
      await withIncognitoSessionBinding({ actor: replacement }, async () => {
        await expect(
          result.replyOptions.onReasoningStream?.({ text: "wrong generation" }),
        ).rejects.toThrow();
        await expect(options.onIdle?.()).rejects.toThrow();
      });
      expect(streamingInstances).toHaveLength(0);
    } finally {
      await replacement.close();
    }
  });
  it("omits reasoning callbacks unless reasoning previews are allowed", () => {
    const { result } = createDispatcherHarness();
    expect(result.replyOptions.onReasoningStream).toBeUndefined();
    expect(result.replyOptions.onReasoningEnd).toBeUndefined();
  });
}
