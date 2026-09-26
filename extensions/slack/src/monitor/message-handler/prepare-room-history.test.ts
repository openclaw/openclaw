import fs from "node:fs/promises";
import type { App } from "@slack/bolt";
import type { ContextVisibilityMode, OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { upsertSessionEntry } from "openclaw/plugin-sdk/session-store-runtime";
import type * as SystemEventRuntime from "openclaw/plugin-sdk/system-event-runtime";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { SlackMessageEvent } from "../../types.js";
import type * as SlackMediaRuntime from "../media.runtime.js";
import { prepareSlackMessage } from "./prepare.js";
import {
  createInboundSlackTestContext,
  createSlackSessionStoreFixture,
  createSlackTestAccount,
} from "./prepare.test-helpers.js";

vi.mock("openclaw/plugin-sdk/system-event-runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof SystemEventRuntime>()),
  enqueueRoutedSystemEvent: vi.fn(),
}));

const mediaFetchMock = vi.hoisted(() =>
  vi.fn<typeof SlackMediaRuntime.fetchWithRuntimeDispatcher>(),
);
vi.mock("../media.runtime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof SlackMediaRuntime>()),
  fetchWithRuntimeDispatcher: mediaFetchMock,
}));

describe("Slack platform-authoritative automatic room history", () => {
  const storeFixture = createSlackSessionStoreFixture("openclaw-slack-room-history-");
  beforeAll(() => storeFixture.setup());
  afterAll(() => storeFixture.cleanup());
  beforeEach(() => mediaFetchMock.mockReset());
  afterEach(() => vi.restoreAllMocks());

  function fixture(limit = 3, contextVisibility: ContextVisibilityMode = "allowlist") {
    const { storePath } = storeFixture.makeTmpStorePath();
    const history = vi.fn().mockResolvedValue({ messages: [] });
    const replies = vi.fn().mockResolvedValue({ messages: [] });
    const cfg: OpenClawConfig = {
      session: { store: storePath },
      channels: {
        slack: { enabled: true, groupPolicy: "open", contextVisibility },
      },
    };
    const createContext = () => {
      const ctx = createInboundSlackTestContext({
        cfg,
        appClient: { conversations: { history, replies } } as unknown as App["client"],
        defaultRequireMention: true,
        channelsConfig: { C1: { requireMention: true, users: ["U1"] } },
      });
      ctx.historyLimit = limit;
      ctx.resolveUserName = async (id) => ({ name: id });
      ctx.resolveChannelName = async () => ({ name: "room", type: "channel" });
      return ctx;
    };
    const message: SlackMessageEvent = {
      type: "message",
      channel: "C1",
      channel_type: "channel",
      user: "U1",
      text: "<@B1> current request",
      ts: "20.000",
    };
    return {
      storePath,
      history,
      replies,
      createContext,
      ctx: createContext(),
      message,
      account: createSlackTestAccount(),
    };
  }

  it("recovers a capped current platform snapshot across monitor replacement and edits", async () => {
    const f = fixture(2);
    f.history.mockResolvedValue({
      messages: [
        { ts: "19.000", user: "U1", text: "edited platform value" },
        { ts: "18.000", user: "U1", text: "offline discussion" },
        { ts: "17.000", user: "U1", text: "outside cap" },
      ],
    });
    for (const ctx of [f.ctx, f.createContext()]) {
      const prepared = await prepareSlackMessage({
        ctx,
        account: f.account,
        message: f.message,
        opts: { source: "app_mention" },
      });
      expect(prepared?.ctxPayload.InboundHistory?.map((entry) => entry.body)).toEqual([
        "offline discussion",
        "edited platform value",
      ]);
      expect(prepared?.ctxPayload.Body).toContain("offline discussion");
      expect(prepared?.ctxPayload.Body).toContain("edited platform value");
      expect(prepared?.ctxPayload.Body).not.toContain("outside cap");
      expect(prepared?.ctxPayload.RawBody).toContain("current request");
    }
    f.history.mockResolvedValue({
      messages: [{ ts: "19.000", user: "U1", text: "latest platform edit" }],
    });
    const refreshed = await prepareSlackMessage({
      ctx: f.ctx,
      account: f.account,
      message: f.message,
      opts: { source: "app_mention" },
    });
    expect(refreshed?.ctxPayload.InboundHistory?.map((entry) => entry.body)).toEqual([
      "latest platform edit",
    ]);
    expect(refreshed?.ctxPayload.Body).not.toContain("offline discussion");
  });

  it("hydrates recent room images and table text from the fresh platform snapshot", async () => {
    const f = fixture(5);
    mediaFetchMock.mockResolvedValue(
      new Response(Buffer.from("fresh image data"), {
        headers: { "content-type": "image/png" },
      }),
    );
    f.history.mockResolvedValue({
      messages: [
        {
          user: "U1",
          ts: "500.000",
          text: "Updated diagram",
          files: [
            {
              id: "FNEW",
              name: "fresh.png",
              mimetype: "image/png",
              url_private: "https://files.slack.com/fresh.png",
            },
          ],
          blocks: [
            {
              type: "table",
              rows: [[{ type: "raw_text", text: "Status" }], [{ type: "raw_text", text: "ready" }]],
            },
          ],
        },
      ],
    });
    const prepared = await prepareSlackMessage({
      ctx: f.ctx,
      account: f.account,
      message: { ...f.message, text: "<@B1> inspect the recent diagram", ts: "501.000" },
      opts: { source: "app_mention" },
    });
    const image = prepared?.ctxPayload.InboundHistory?.[0]?.media?.[0];
    try {
      expect(prepared?.ctxPayload.Body).toContain("Updated diagram");
      expect(prepared?.ctxPayload.Body).toContain("ready");
      expect(prepared?.ctxPayload.InboundHistory?.[0]?.body).toContain("ready");
      expect(image).toMatchObject({
        kind: "image",
        contentType: "image/png",
        messageId: "500.000",
        path: expect.any(String),
      });
      expect(mediaFetchMock).toHaveBeenCalledOnce();
    } finally {
      if (image?.path) {
        await fs.rm(image.path, { force: true });
      }
    }
  });

  it.each([false, true])(
    "applies the history attachment budget before I/O (failures: %s)",
    async (fail) => {
      const f = fixture(4);
      mediaFetchMock.mockImplementation(
        async () =>
          new Response(Buffer.from("image data"), {
            status: fail ? 500 : 200,
            headers: { "content-type": "image/png" },
          }),
      );
      const attachmentCounts = fail ? [4, 4, 4, 4] : [4, 1];
      f.history.mockResolvedValue({
        messages: attachmentCounts.map((count, index) => ({
          ts: `${18 - index}.000`,
          user: "U1",
          text: `history image ${index}`,
          files: Array.from({ length: count }, (_, image) => ({
            id: `F${index}-${image}`,
            name: `image-${index}-${image}.png`,
            mimetype: "image/png",
            url_private: `https://files.slack.com/image-${index}-${image}.png`,
          })),
        })),
      });
      const prepared = await prepareSlackMessage({
        ctx: f.ctx,
        account: f.account,
        message: f.message,
        opts: { source: "app_mention" },
      });
      const media =
        prepared?.ctxPayload.InboundHistory?.flatMap((entry) => entry.media ?? []) ?? [];
      try {
        expect(mediaFetchMock).toHaveBeenCalledTimes(4);
        expect(media).toHaveLength(fail ? 0 : 4);
        expect(prepared?.ctxPayload.RawBody).toContain("current request");
      } finally {
        await Promise.all(
          media.map(async (entry) => {
            if (entry.path) {
              await fs.rm(entry.path, { force: true });
            }
          }),
        );
      }
    },
  );

  it("excludes denied senders, the current bot, future messages and every debounced source ID", async () => {
    const f = fixture(10);
    f.history.mockResolvedValue({
      messages: [
        { ts: "21.000", user: "U1", text: "future" },
        { ts: "20.000", user: "U1", text: "current request" },
        { ts: "19.000", user: "U1", text: "first source in batch" },
        { ts: "18.000", user: "U_DENIED", text: "denied history" },
        { ts: "17.000", user: "B1", bot_id: "B1", text: "assistant output" },
        { ts: "16.000", user: "U1", text: "permitted discussion" },
      ],
    });
    const prepared = await prepareSlackMessage({
      ctx: f.ctx,
      account: f.account,
      message: f.message,
      opts: { source: "app_mention", sourceMessageIds: ["19.000", "20.000"] },
    });
    expect(prepared?.ctxPayload.InboundHistory?.map((entry) => entry.body)).toEqual([
      "permitted discussion",
    ]);
    expect(prepared?.ctxPayload.Body).not.toMatch(
      /future|first source|denied history|assistant output/,
    );
  });

  it.each([
    { mode: "allowlist", allowed: false },
    { mode: "allowlist", allowed: true },
    { mode: "allowlist_quote", allowed: false },
    { mode: "all", allowed: false },
  ] as const)(
    "keeps bot thread context independent of allowBots false ($mode, allowed: $allowed)",
    async ({ mode, allowed }) => {
      const f = fixture(5, mode);
      f.account.config.allowBots = false;
      const root = {
        ts: "10.000",
        user: allowed ? "U1" : "UDENIED",
        bot_id: "BOTHER",
        text: "bot root decision",
        files: [
          {
            id: "FROOT",
            name: "root.png",
            mimetype: "image/png",
            url_private: "https://files.slack.com/root.png",
          },
        ],
      };
      f.replies.mockImplementation(async ({ limit }: { limit: number }) => ({
        messages:
          limit === 1
            ? [root]
            : [
                root,
                { ts: "11.000", user: "UDENIED", bot_id: "BOTHER", text: "denied bot follow-up" },
                { ts: "12.000", user: "U1", bot_id: "BOTHER", text: "allowed bot follow-up" },
              ],
      }));
      mediaFetchMock.mockImplementation(
        async () =>
          new Response(Buffer.from("root image"), {
            headers: { "content-type": "image/png" },
          }),
      );
      const prepared = await prepareSlackMessage({
        ctx: f.ctx,
        account: f.account,
        message: { ...f.message, thread_ts: "10.000" },
        opts: { source: "app_mention" },
      });
      try {
        const includeRoot = allowed || mode === "all";
        expect(prepared?.ctxPayload.RawBody).toContain("current request");
        expect(prepared?.ctxPayload.ThreadHistoryBody).toContain("allowed bot follow-up");
        expect(prepared?.ctxPayload.ThreadStarterBody).toBe(includeRoot ? root.text : undefined);
        expect(prepared?.ctxPayload.ThreadHistoryBody?.includes(root.text)).toBe(includeRoot);
        expect(prepared?.ctxPayload.ThreadHistoryBody?.includes("denied bot follow-up")).toBe(
          mode === "all",
        );
        expect(mediaFetchMock).toHaveBeenCalledTimes(includeRoot ? 1 : 0);
        expect(prepared?.ctxPayload.media ?? []).toHaveLength(includeRoot ? 1 : 0);
      } finally {
        for (const media of prepared?.ctxPayload.media ?? []) {
          if (media.path) {
            await fs.rm(media.path, { force: true });
          }
        }
      }
    },
  );

  it("uses only the event workspace client for a recovered channel window", async () => {
    const f = fixture();
    const scopedHistory = vi.fn().mockResolvedValue({
      messages: [{ ts: "19.000", user: "U1", text: "workspace two only" }],
    });
    f.history.mockResolvedValue({
      messages: [{ ts: "19.000", user: "U1", text: "workspace one secret" }],
    });
    const prepared = await prepareSlackMessage({
      ctx: f.ctx,
      account: f.account,
      message: f.message,
      opts: {
        source: "app_mention",
        eventScope: {
          teamId: "T2",
          client: { conversations: { history: scopedHistory } } as unknown as App["client"],
        },
      },
    });
    expect(prepared?.ctxPayload.Body).toContain("workspace two only");
    expect(prepared?.ctxPayload.Body).not.toContain("workspace one secret");
    expect(f.history).not.toHaveBeenCalled();
    expect(scopedHistory).toHaveBeenCalledWith(expect.objectContaining({ channel: "C1" }));
  });

  it("does no automatic room history transport for quiet ingress or historyLimit zero", async () => {
    const f = fixture();
    const quiet = await prepareSlackMessage({
      ctx: f.ctx,
      account: f.account,
      message: { ...f.message, text: "quiet discussion" },
      opts: { source: "message" },
    });
    expect(quiet).toBeNull();
    f.ctx.historyLimit = 0;
    const active = await prepareSlackMessage({
      ctx: f.ctx,
      account: f.account,
      message: f.message,
      opts: { source: "app_mention" },
    });
    expect(active?.ctxPayload.RawBody).toContain("current request");
    expect(active?.ctxPayload.InboundHistory).toBeUndefined();
    expect(f.history).not.toHaveBeenCalled();
    expect(f.replies).not.toHaveBeenCalled();
  });

  it("respects the canonical session start and reset tombstone without inspecting command text", async () => {
    const f = fixture();
    const sessionKey = "agent:main:slack:channel:c1";
    await upsertSessionEntry({
      storePath: f.storePath,
      sessionKey,
      entry: { sessionId: "new-generation", updatedAt: 15_000, sessionStartedAt: 15_000 },
    });
    f.history.mockResolvedValue({
      messages: [
        { ts: "19.000", user: "U1", text: "after reset" },
        { ts: "14.000", user: "U1", text: "discarded generation" },
      ],
    });
    const prepare = () =>
      prepareSlackMessage({
        ctx: f.ctx,
        account: f.account,
        message: f.message,
        opts: { source: "app_mention" },
      });
    const first = await prepare();
    expect(first?.ctxPayload.InboundHistory?.map((entry) => entry.body)).toEqual(["after reset"]);
    expect(first?.ctxPayload.Body).not.toContain("discarded generation");
    await upsertSessionEntry({
      storePath: f.storePath,
      sessionKey,
      entry: { sessionId: "reset-tombstone", updatedAt: 0 },
    });
    f.history.mockClear();
    const reset = await prepare();
    expect(reset?.ctxPayload.InboundHistory).toEqual([]);
    expect(reset?.ctxPayload.RawBody).toContain("current request");
    expect(f.history).not.toHaveBeenCalled();
  });

  it("logs native fetch failure without losing the addressed current turn", async () => {
    const f = fixture();
    f.history.mockRejectedValue(new Error("missing_scope"));
    const warn = vi.spyOn(f.ctx.logger, "warn").mockImplementation(() => undefined);
    const prepared = await prepareSlackMessage({
      ctx: f.ctx,
      account: f.account,
      message: f.message,
      opts: { source: "app_mention" },
    });
    expect(prepared?.ctxPayload.RawBody).toContain("current request");
    expect(prepared?.ctxPayload.InboundHistory).toEqual([]);
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ reason: expect.stringContaining("missing_scope") }),
      "Slack automatic history omitted",
    );
  });

  it("discards a recovered window if the session generation changes during the fetch", async () => {
    const f = fixture();
    await upsertSessionEntry({
      storePath: f.storePath,
      sessionKey: "agent:main:slack:channel:c1",
      entry: {
        sessionId: "same-session",
        lifecycleRevision: "before-reset",
        updatedAt: 10_000,
        sessionStartedAt: 10_000,
      },
    });
    f.history.mockImplementation(async () => {
      await upsertSessionEntry({
        storePath: f.storePath,
        sessionKey: "agent:main:slack:channel:c1",
        entry: {
          sessionId: "same-session",
          lifecycleRevision: "after-reset",
          updatedAt: 10_000,
          sessionStartedAt: 10_000,
        },
      });
      return { messages: [{ ts: "19.000", user: "U1", text: "raced context" }] };
    });
    const prepared = await prepareSlackMessage({
      ctx: f.ctx,
      account: f.account,
      message: f.message,
      opts: { source: "app_mention" },
    });
    expect(prepared?.ctxPayload.InboundHistory).toEqual([]);
    expect(prepared?.ctxPayload.Body).not.toContain("raced context");
    expect(prepared?.ctxPayload.RawBody).toContain("current request");
  });

  it("honors cancellation and live policy revocation while awaiting native history", async () => {
    const f = fixture();
    const controller = new AbortController();
    f.history.mockImplementation(async () => {
      controller.abort();
      return { messages: [{ ts: "19.000", user: "U1", text: "late context" }] };
    });
    await expect(
      prepareSlackMessage({
        ctx: f.ctx,
        account: f.account,
        message: f.message,
        opts: { source: "app_mention", abortSignal: controller.signal },
      }),
    ).rejects.toMatchObject({ name: "AbortError" });
    let policyCurrent = true;
    f.history.mockImplementation(async () => {
      policyCurrent = false;
      return { messages: [{ ts: "19.000", user: "U1", text: "revoked context" }] };
    });
    const revoked = await prepareSlackMessage({
      ctx: f.ctx,
      account: f.account,
      message: f.message,
      opts: { source: "app_mention", isRuntimePolicyCurrent: () => policyCurrent },
    });
    expect(revoked).toBeNull();
  });

  it("recovers only the exact warm thread and does not add a second initial window", async () => {
    const f = fixture(2);
    const now = Date.now();
    await upsertSessionEntry({
      storePath: f.storePath,
      sessionKey: "agent:main:slack:channel:c1:thread:10.000",
      entry: {
        sessionId: "warm-thread",
        updatedAt: now,
        lastInteractionAt: now,
        sessionStartedAt: 10_000,
      },
    });
    f.history.mockResolvedValue({
      messages: [{ ts: "19.000", user: "U1", text: "other channel discussion" }],
    });
    f.replies.mockImplementation(async ({ ts, limit }: { ts: string; limit: number }) => ({
      messages:
        limit === 1
          ? [{ ts, user: "U1", text: "thread root" }]
          : [
              { ts: "11.000", user: "U1", text: "outside thread cap" },
              { ts: "18.000", user: "U1", text: "thread history one" },
              { ts: "19.000", user: "U1", text: "thread history two" },
              { ts: "20.000", user: "U1", text: "current request" },
              { ts: "21.000", user: "U1", text: "future thread message" },
            ],
    }));
    const prepared = await prepareSlackMessage({
      ctx: f.ctx,
      account: f.account,
      message: { ...f.message, thread_ts: "10.000" },
      opts: { source: "app_mention" },
    });
    expect(prepared?.ctxPayload.InboundHistory?.map((entry) => entry.body)).toEqual([
      "thread history one",
      "thread history two",
    ]);
    expect(prepared?.ctxPayload.Body).toContain("thread history two");
    expect(prepared?.ctxPayload.Body).not.toMatch(
      /outside thread cap|other channel discussion|future thread/,
    );
    expect(prepared?.ctxPayload.ThreadHistoryBody).toBeUndefined();
    expect(f.history).not.toHaveBeenCalled();
    expect(f.replies).toHaveBeenLastCalledWith(
      expect.objectContaining({
        channel: "C1",
        ts: "10.000",
        latest: "20.000",
      }),
    );
  });

  it.each(["thread", "channel"] as const)(
    "keeps initial thread context single while honoring %s history scope",
    async (scope) => {
      const f = fixture(2);
      f.ctx.threadHistoryScope = scope;
      f.history.mockResolvedValue({
        messages: [{ ts: "19.000", user: "U1", text: "channel-wide decision" }],
      });
      f.replies.mockImplementation(async ({ limit }: { limit: number }) => ({
        messages:
          limit === 1
            ? [{ ts: "10.000", user: "U1", text: "thread root" }]
            : [
                { ts: "11.000", user: "U1", text: "initial thread note one" },
                { ts: "12.000", user: "U1", text: "initial thread note two" },
              ],
      }));
      const prepared = await prepareSlackMessage({
        ctx: f.ctx,
        account: f.account,
        message: { ...f.message, thread_ts: "10.000" },
        opts: { source: "app_mention" },
      });
      expect(prepared?.ctxPayload.ThreadHistoryBody).toContain("initial thread note one");
      expect(prepared?.ctxPayload.ThreadHistoryBody).toContain("initial thread note two");
      expect(prepared?.ctxPayload.InboundHistory?.map((entry) => entry.body)).toEqual(
        scope === "channel" ? ["channel-wide decision"] : [],
      );
    },
  );

  it("omits an incomplete oldest-first thread prefix with a warning, preserving the addressed turn", async () => {
    const f = fixture(5);
    f.replies.mockImplementation(async ({ ts, limit }: { ts: string; limit: number }) => ({
      messages: [{ ts, user: "U1", text: limit === 1 ? "explicit root" : "incomplete old prefix" }],
      response_metadata: { next_cursor: limit === 1 ? "" : "another-page" },
    }));
    const warn = vi.spyOn(f.ctx.logger, "warn").mockImplementation(() => undefined);
    const prepared = await prepareSlackMessage({
      ctx: f.ctx,
      account: f.account,
      message: { ...f.message, thread_ts: "10.000" },
      opts: { source: "app_mention" },
    });
    expect(prepared?.ctxPayload.InboundHistory).toEqual([]);
    expect(prepared?.ctxPayload.ThreadHistoryBody).toBeUndefined();
    expect(prepared?.ctxPayload.Body).not.toContain("incomplete old prefix");
    expect(prepared?.ctxPayload.RawBody).toContain("current request");
    expect(f.replies).toHaveBeenCalledTimes(4);
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ reason: expect.stringContaining("three-page") }),
      "Slack automatic thread history omitted",
    );
  });

  it("stops initial thread pagination when policy is revoked during a page read", async () => {
    const f = fixture(4);
    let policyCurrent = true;
    f.replies.mockImplementation(async ({ limit }: { limit: number }) => {
      if (limit === 1) {
        return { messages: [{ ts: "10.000", user: "U1", text: "thread root" }] };
      }
      policyCurrent = false;
      return {
        messages: [{ ts: "11.000", user: "U1", text: "revoked thread history" }],
        response_metadata: { next_cursor: "another-page" },
      };
    });
    const result = await prepareSlackMessage({
      ctx: f.ctx,
      account: f.account,
      message: { ...f.message, thread_ts: "10.000" },
      opts: { source: "app_mention", isRuntimePolicyCurrent: () => policyCurrent },
    }).catch((error: unknown) => {
      expect(error).toBeInstanceOf(Error);
      return null;
    });
    expect(result).toBeNull();
    expect(f.replies).toHaveBeenNthCalledWith(2, expect.objectContaining({ limit: 200 }));
    expect(f.replies).toHaveBeenCalledTimes(2);
  });

  it("honors channel history overrides larger than the chronological thread scan budget", async () => {
    const f = fixture(601);
    f.history.mockImplementation(async ({ cursor, limit }: { cursor?: string; limit: number }) => {
      const offset = Number(cursor ?? 0);
      const count = Math.min(limit, 601 - offset);
      return {
        messages: Array.from({ length: count }, (_, index) => ({
          ts: `${999 - offset - index}.000`,
          user: "U1",
          text: `prior discussion ${999 - offset - index}`,
        })),
        response_metadata: { next_cursor: offset + count < 601 ? String(offset + count) : "" },
      };
    });
    const prepared = await prepareSlackMessage({
      ctx: f.ctx,
      account: f.account,
      message: { ...f.message, ts: "1000.000" },
      opts: { source: "app_mention" },
    });
    expect(prepared?.ctxPayload.InboundHistory).toHaveLength(601);
    expect(prepared?.ctxPayload.InboundHistory?.[0]?.messageId).toBe("399.000");
    expect(prepared?.ctxPayload.InboundHistory?.at(-1)?.messageId).toBe("999.000");
    expect(f.history).toHaveBeenCalledTimes(4);
  });
});
