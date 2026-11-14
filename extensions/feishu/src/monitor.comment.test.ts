import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { createNonExitingRuntimeEnv } from "openclaw/plugin-sdk/plugin-test-runtime";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ClawdbotConfig } from "../runtime-api.js";
import type { FeishuDriveCommentReply as Reply } from "./comment-shared.js";
import type { FeishuIngressLifecycle } from "./feishu-ingress.js";
import { createFeishuDriveCommentNoticeHandler } from "./monitor.comment-notice-handler.js";
import {
  resolveDriveCommentEventTurn,
  type FeishuDriveCommentNoticeEvent,
} from "./monitor.comment.js";

type CommentHandler = typeof import("./comment-handler.js").handleFeishuCommentEvent;
const handleComment = vi.hoisted(() => vi.fn<CommentHandler>(async () => {}));
const createFeishuClientMock = vi.hoisted(() => vi.fn());
vi.mock("./client.js", () => ({ createFeishuClient: createFeishuClientMock }));
vi.mock("./comment-handler.js", () => ({ handleFeishuCommentEvent: handleComment }));

afterAll(() => {
  vi.doUnmock("./client.js");
  vi.doUnmock("./comment-handler.js");
  vi.resetModules();
});
afterEach(() => {
  vi.useRealTimers();
});

const TEST_DOC_TOKEN = "ZsJfdxrBFo0RwuxteOLc1Ekvneb";
const TEST_WIKI_TOKEN = "OtYpd5pKOoMeQzxrzkocv9KIn4H";
const docUrl = `https://www.larksuite.com/docx/${TEST_DOC_TOKEN}`;
const wikiUrl = `https://www.larksuite.com/wiki/${TEST_WIKI_TOKEN}`;
const COMMENT_ID = "7623358762119646411";
const ROOT_REPLY_ID = "7623358762136374451";
const USER_ID = "ou_509d4d7ace4a9addec2312676ffcba9b";
const ROOT_TEXT = "Also send it to the agent after receiving the comment event";
const cfg: ClawdbotConfig = { channels: { feishu: { enabled: true } } };

function makeDriveCommentEvent(
  overrides: Partial<FeishuDriveCommentNoticeEvent> = {},
): FeishuDriveCommentNoticeEvent {
  return {
    comment_id: COMMENT_ID,
    event_id: "10d9d60b990db39f96a4c2fd357fb877",
    is_mentioned: true,
    reply_id: ROOT_REPLY_ID,
    timestamp: "1774951528000",
    type: "drive.notice.comment_add_v1",
    ...overrides,
    notice_meta: {
      file_token: TEST_DOC_TOKEN,
      file_type: "docx",
      from_user_id: { open_id: USER_ID, user_id: "on_comment_user_1" },
      notice_type: "add_comment",
      to_user_id: { open_id: "ou_bot" },
      ...overrides.notice_meta,
    },
  };
}

function textElement(text: string, encoding: "content" | "text" = "text") {
  return { type: "text_run", text_run: { [encoding]: text } };
}
function reply(
  id: string,
  text: string | unknown[],
  fields: Pick<Reply, "user_id" | "create_time"> = {},
  encoding: "content" | "text" = "content",
): Reply {
  return {
    reply_id: id,
    ...fields,
    content: { elements: typeof text === "string" ? [textElement(text, encoding)] : text },
  };
}
const rootReply = reply(ROOT_REPLY_ID, ROOT_TEXT);
const targetReply = reply("7623359125036043462", "Please follow up on this comment");
function timedReply(id: string, text: string, create_time: number, user_id?: string) {
  return reply(id, text, { create_time, user_id }, "text");
}
function wholeComment(id: string, entry: Reply) {
  return {
    comment_id: id,
    user_id: entry.user_id,
    create_time: entry.create_time,
    is_whole: true,
    reply_list: { replies: [entry] },
  };
}
function makeOpenApiClient(
  params: {
    isWholeComment?: boolean;
    batchCommentId?: string;
    repliesSequence?: Reply[][];
    batchReplies?: Reply[];
    wholeComments?: ReturnType<typeof wholeComment>[];
  } = {},
) {
  const remaining = [...(params.repliesSequence ?? [])];
  return {
    request: vi.fn(async (request: { method: "GET" | "POST"; url: string; data: unknown }) => {
      let data: unknown;
      if (request.url === "/open-apis/drive/v1/metas/batch_query") {
        data = {
          metas: [
            { doc_token: TEST_DOC_TOKEN, title: "Comment event handling request", url: docUrl },
          ],
        };
      } else if (request.url.includes("/comments/batch_query")) {
        data = {
          items: [
            {
              comment_id: params.batchCommentId ?? COMMENT_ID,
              is_whole: params.isWholeComment,
              quote: "im.message.receive_v1 message trigger implementation",
              reply_list: { replies: params.batchReplies ?? [rootReply] },
            },
          ],
        };
      } else if (request.url.includes("/comments?file_type=docx&is_whole=true")) {
        data = { has_more: false, items: params.wholeComments ?? [] };
      } else if (request.url.includes("/replies")) {
        data = { has_more: false, items: remaining.shift() ?? [rootReply, targetReply] };
      } else {
        throw new Error(`unexpected request: ${request.method} ${request.url}`);
      }
      return { code: 0, data };
    }),
    wiki: { space: { getNode: vi.fn(async () => ({ code: 0, data: { node: {} } })) } },
  };
}
function resolveCommentTurn(params: {
  client?: ReturnType<typeof makeOpenApiClient>;
  event?: FeishuDriveCommentNoticeEvent;
  botOpenId?: string | null;
  abortSignal?: AbortSignal;
}) {
  createFeishuClientMock.mockReturnValue(params.client ?? makeOpenApiClient());
  return resolveDriveCommentEventTurn({
    cfg,
    accountId: "default",
    event: params.event ?? makeDriveCommentEvent(),
    botOpenId: params.botOpenId === null ? undefined : (params.botOpenId ?? "ou_bot"),
    abortSignal: params.abortSignal,
  });
}
function commentHandler(
  params: Partial<Parameters<typeof createFeishuDriveCommentNoticeHandler>[0]> = {},
) {
  return createFeishuDriveCommentNoticeHandler({
    cfg,
    accountId: "default",
    runtime: createNonExitingRuntimeEnv(),
    fireAndForget: true,
    getBotOpenId: () => "ou_bot",
    ...params,
  });
}
type CommentTurn = Awaited<ReturnType<typeof resolveCommentTurn>>;
function expectPrompt(turn: CommentTurn, ...fragments: string[]) {
  for (const fragment of fragments) {
    expect(turn?.prompt).toContain(fragment);
  }
}
function timeline(turn: CommentTurn, kind: "reply" | "comment") {
  const prefix = kind === "reply" ? /^- \[\d+\] author=/ : /^- \[\d+\] create_time=/;
  return turn?.prompt.split("\n").filter((line) => prefix.test(line));
}
function replyRequests(client: ReturnType<typeof makeOpenApiClient>) {
  return client.request.mock.calls.filter(
    ([request]) => request.method === "GET" && request.url.includes("/replies"),
  );
}
function blockFirstComment() {
  const started = createDeferred<void>();
  const finish = createDeferred<void>();
  handleComment.mockImplementationOnce(async () => {
    started.resolve();
    await finish.promise;
  });
  return { started: started.promise, release: finish.resolve };
}

describe("resolveDriveCommentEventTurn", () => {
  it("parses bot mentions plus current and referenced document links from comment content", async () => {
    const client = makeOpenApiClient({
      isWholeComment: false,
      batchReplies: [
        reply(
          ROOT_REPLY_ID,
          [
            textElement("请 "),
            { type: "person", person: { user_id: "ou_bot" } },
            textElement(" 总结下 "),
            { type: "docs_link", docs_link: { url: docUrl } },
            textElement(" 和 "),
            { type: "docs_link", docs_link: { url: wikiUrl } },
          ],
          { user_id: USER_ID },
        ),
      ],
    });
    const wikiGetNode = client.wiki.space.getNode;
    wikiGetNode.mockResolvedValue({
      code: 0,
      data: { node: { obj_type: "docx", obj_token: "doc_ref_1" } },
    });
    const turn = await resolveCommentTurn({ client, botOpenId: null });
    expect(turn).toMatchObject({
      senderId: USER_ID,
      senderUserId: "on_comment_user_1",
      messageId: "drive-comment:10d9d60b990db39f96a4c2fd357fb877",
      targetReplyText: `请 总结下 ${docUrl} 和 ${wikiUrl}`,
    });
    expectPrompt(
      turn,
      "Bot routing mention detected in the current user comment.",
      "Referenced documents from current user comment:",
      `raw_url=https://www.larksuite.com/docx/${TEST_DOC_TOKEN} url_kind=docx`,
      "same_as_current_document=yes",
      `raw_url=https://www.larksuite.com/wiki/${TEST_WIKI_TOKEN} url_kind=wiki ` +
        `wiki_node_token=${TEST_WIKI_TOKEN} resolved_type=docx resolved_token=doc_ref_1 same_as_current_document=no`,
    );
    expect(wikiGetNode).toHaveBeenCalledWith({ params: { token: TEST_WIKI_TOKEN } });
  });

  it("builds a whole-comment timeline and highlights the nearest bot-authored follow-up", async () => {
    const current = timedReply(ROOT_REPLY_ID, "请帮我总结这个文档", 1775531531, USER_ID);
    const client = makeOpenApiClient({
      isWholeComment: true,
      batchReplies: [current],
      wholeComments: [
        wholeComment(COMMENT_ID, { ...current, reply_id: "reply_a" }),
        wholeComment(
          "comment_bot_followup",
          timedReply("reply_b", "这是刚才的总结结果", 1775531540, "ou_bot"),
        ),
        wholeComment(
          "comment_other_user",
          timedReply("reply_c", "另一个 whole comment", 1775531550),
        ),
      ],
    });
    const turn = await resolveCommentTurn({ client });
    expect(turn?.isWholeComment).toBe(true);
    expectPrompt(
      turn,
      "comment_id=comment_other_user author=user user_id=UNKNOWN current_comment=no",
      "This is a whole-document comment.",
      "Whole-document comments do not support direct replies.",
      "Whole-document comment timeline (primary context for whole-comment follow-ups):",
      "comment_id=7623358762119646411",
      "comment_id=comment_bot_followup",
      'Nearest bot-authored whole-comment after the current comment: comment_id=comment_bot_followup text="这是刚才的总结结果"',
      "Document-level session history is auxiliary background only.",
    );
  });

  it("caps a long comment card around the current reply while retaining its root and latest reply", async () => {
    const replies = Array.from({ length: 30 }, (_, index) =>
      timedReply(`reply-${index}`, `message ${index}`, index, USER_ID),
    );
    const turn = await resolveCommentTurn({
      client: makeOpenApiClient({ batchReplies: replies }),
      event: makeDriveCommentEvent({ reply_id: "reply-15" }),
    });
    const lines = timeline(turn, "reply");
    expect(lines?.map((line) => line.match(/reply_id=(\S+)/)?.[1])).toEqual(
      [0, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 29].map(
        (index) => `reply-${index}`,
      ),
    );
    expect(lines?.filter((line) => line.includes("current_event=yes"))).toEqual([
      expect.stringContaining("reply_id=reply-15 current_event=yes"),
    ]);
  });

  it.each([
    { currentCommentId: "comment-8", selected: [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13] },
    { currentCommentId: "missing", selected: [6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17] },
  ])("caps whole-comment context for $currentCommentId", async ({ currentCommentId, selected }) => {
    const turn = await resolveCommentTurn({
      client: makeOpenApiClient({
        isWholeComment: true,
        batchCommentId: currentCommentId,
        wholeComments: Array.from({ length: 18 }, (_, index) =>
          wholeComment(
            `comment-${index}`,
            timedReply(
              `reply-${index}`,
              `message ${index}`,
              index,
              index === 4 || index === 12 ? "ou_bot" : USER_ID,
            ),
          ),
        ),
      }),
      event: makeDriveCommentEvent({ comment_id: currentCommentId }),
    });
    const lines = timeline(turn, "comment");
    expect(lines?.map((line) => line.match(/comment_id=(\S+)/)?.[1])).toEqual(
      selected.map((index) => `comment-${index}`),
    );
    expect(lines?.filter((line) => line.includes("current_comment=yes"))).toEqual(
      currentCommentId === "missing"
        ? []
        : [expect.stringContaining("comment_id=comment-8 author=user")],
    );
  });

  it("does not trust whole-comment metadata from a mismatched batch_query item", async () => {
    const turn = await resolveCommentTurn({
      client: makeOpenApiClient({
        batchReplies: [rootReply, targetReply],
        isWholeComment: true,
        batchCommentId: "different_comment_id",
      }),
    });
    expect(turn?.isWholeComment).toBeUndefined();
    expect(turn?.prompt).not.toContain("This is a whole-document comment.");
  });

  it.each([false, true])("settles missing reply lookup (aborted=%s)", async (aborted) => {
    vi.useFakeTimers();
    const abortController = new AbortController();
    const replyId = "7623359125999999999";
    const text = "Insert a sentence below this paragraph";
    const missing = [rootReply, reply("7623358762999999999", "Earlier assistant summary")];
    const client = makeOpenApiClient({
      repliesSequence: aborted
        ? [[reply(ROOT_REPLY_ID, "Earlier assistant summary")]]
        : [missing, missing, [rootReply, reply(replyId, text)]],
    });
    const turnPromise = resolveCommentTurn({
      client,
      event: makeDriveCommentEvent({
        reply_id: replyId,
        ...(aborted ? {} : { notice_meta: { notice_type: "add_reply" } }),
      }),
      abortSignal: aborted ? abortController.signal : undefined,
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(vi.getTimerCount()).toBe(1);
    if (aborted) {
      abortController.abort();
    } else {
      await vi.advanceTimersByTimeAsync(2_000);
    }
    const turn = await turnPromise;
    if (aborted) {
      expect(turn).not.toBeNull();
      expect(turn?.targetReplyText).toBeUndefined();
    } else {
      expect(turn?.targetReplyText).toBe(text);
      expectPrompt(
        turn,
        'The user added a reply in "Comment event handling request".',
        'Original comment text: "Also send it to the agent after receiving the comment event"',
        text,
      );
    }
    expect(vi.getTimerCount()).toBe(0);
    expect(replyRequests(client)).toHaveLength(aborted ? 1 : 3);
  });

  it.each([
    {
      name: "prefers startup bot identity over a mismatched event recipient",
      botOpenId: "ou_configured_bot",
      event: {
        notice_meta: {
          from_user_id: { open_id: "ou_configured_bot" },
          to_user_id: { open_id: "ou_other_bot" },
        },
      },
    },
    {
      name: "skips a cold-start comment notice when not explicitly mentioned",
      botOpenId: null,
      event: { is_mentioned: false },
    },
  ])("$name", async ({ event, botOpenId }) => {
    expect(await resolveCommentTurn({ event: makeDriveCommentEvent(event), botOpenId })).toBeNull();
  });
});

describe("drive.notice.comment_add_v1 monitor handler", () => {
  beforeEach(() => {
    handleComment.mockClear();
    createFeishuClientMock.mockReset().mockReturnValue(makeOpenApiClient());
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each([false, true])(
    "serializes same-document notices (queued claim aborted=%s)",
    async (aborted) => {
      const controller = new AbortController();
      const abandoned = vi.fn(async () => {});
      const lifecycle: FeishuIngressLifecycle = {
        abortSignal: controller.signal,
        onAdopted: vi.fn(async () => {}),
        onDeferred: vi.fn(),
        onAdoptionFinalizing: vi.fn(),
        onAbandoned: abandoned,
      };
      const onComment = commentHandler({
        ...(aborted ? {} : { abortSignal: controller.signal }),
        resolveIngressLifecycle: (data) =>
          aborted && (data as { event_id?: string }).event_id === "evt_2" ? lifecycle : undefined,
      });
      const first = blockFirstComment();
      const second = createDeferred<void>();
      if (!aborted) {
        handleComment.mockImplementationOnce(async () => {
          second.resolve();
        });
      }
      await onComment(makeDriveCommentEvent({ event_id: "evt_1", reply_id: "reply_1" }));
      await first.started;
      expect(handleComment).toHaveBeenCalledTimes(1);
      const queued = onComment(makeDriveCommentEvent({ event_id: "evt_2", reply_id: "reply_2" }));
      expect(handleComment).toHaveBeenCalledTimes(1);
      if (aborted) {
        controller.abort(new Error("adoption timeout"));
      }
      first.release();
      await queued;
      if (!aborted) {
        await second.promise;
        expect(handleComment.mock.calls.map(([params]) => params)).toMatchObject([
          {
            accountId: "default",
            botOpenId: "ou_bot",
            abortSignal: controller.signal,
            event: { event_id: "evt_1", comment_id: COMMENT_ID },
          },
          { event: { event_id: "evt_2" } },
        ]);
      }
      expect(handleComment).toHaveBeenCalledTimes(aborted ? 1 : 2);
      expect(abandoned).toHaveBeenCalledTimes(aborted ? 1 : 0);
    },
  );
});
