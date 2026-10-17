import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { createNonExitingRuntimeEnv } from "openclaw/plugin-sdk/plugin-test-runtime";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ClawdbotConfig } from "../runtime-api.js";
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

type Reply = {
  reply_id: string;
  user_id?: string;
  create_time?: number;
  content: {
    elements: Array<{
      type: string;
      text_run?: { text?: string; content?: string };
      person?: { user_id: string };
      docs_link?: { url: string };
    }>;
  };
};
function reply(
  id: string,
  text: string,
  fields: Pick<Reply, "user_id" | "create_time"> = {},
  encoding: "content" | "text" = "content",
): Reply {
  return {
    reply_id: id,
    ...fields,
    content: { elements: [{ type: "text_run", text_run: { [encoding]: text } }] },
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
    includeTargetReplyInBatch?: boolean;
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
            {
              doc_token: TEST_DOC_TOKEN,
              title: "Comment event handling request",
              url: docUrl,
            },
          ],
        };
      } else if (request.url.includes("/comments/batch_query")) {
        const replies = params.batchReplies ?? [
          rootReply,
          ...(params.includeTargetReplyInBatch ? [targetReply] : []),
        ];
        data = {
          items: [
            {
              comment_id: params.batchCommentId ?? COMMENT_ID,
              is_whole: params.isWholeComment,
              quote: "im.message.receive_v1 message trigger implementation",
              reply_list: { replies },
            },
          ],
        };
      } else if (request.url.includes("/comments?file_type=docx&is_whole=true")) {
        data = {
          has_more: false,
          items: params.wholeComments ?? [],
        };
      } else if (request.url.includes("/replies")) {
        data = {
          has_more: false,
          items: remaining.shift() ?? [rootReply, targetReply],
        };
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
  return resolveDriveCommentEventTurn({
    cfg,
    accountId: "default",
    event: params.event ?? makeDriveCommentEvent(),
    botOpenId: params.botOpenId === null ? undefined : (params.botOpenId ?? "ou_bot"),
    createClient: () => (params.client ?? makeOpenApiClient()) as never,
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
function expectPrompt(
  turn: Awaited<ReturnType<typeof resolveCommentTurn>>,
  ...fragments: string[]
) {
  for (const fragment of fragments) {
    expect(turn?.prompt).toContain(fragment);
  }
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
        {
          ...reply(ROOT_REPLY_ID, "", { user_id: USER_ID }),
          content: {
            elements: [
              { type: "text_run", text_run: { text: "请 " } },
              { type: "person", person: { user_id: "ou_bot" } },
              { type: "text_run", text_run: { text: " 总结下 " } },
              {
                type: "docs_link",
                docs_link: { url: docUrl },
              },
              { type: "text_run", text_run: { text: " 和 " } },
              {
                type: "docs_link",
                docs_link: { url: wikiUrl },
              },
            ],
          },
        },
      ],
    });
    const wikiGetNode = client.wiki.space.getNode;
    wikiGetNode.mockResolvedValue({
      code: 0,
      data: { node: { obj_type: "docx", obj_token: "doc_ref_1" } },
    });
    const turn = await resolveCommentTurn({ client, botOpenId: null });
    expect(turn?.senderId).toBe(USER_ID);
    expect(turn?.senderUserId).toBe("on_comment_user_1");
    expect(turn?.messageId).toBe("drive-comment:10d9d60b990db39f96a4c2fd357fb877");
    expect(turn?.targetReplyText).toBe(`请 总结下 ${docUrl} 和 ${wikiUrl}`);
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

  it("does not trust whole-comment metadata from a mismatched batch_query item", async () => {
    const turn = await resolveCommentTurn({
      client: makeOpenApiClient({
        includeTargetReplyInBatch: true,
        isWholeComment: true,
        batchCommentId: "different_comment_id",
      }),
    });
    expect(turn?.isWholeComment).toBeUndefined();
    expect(turn?.prompt).not.toContain("This is a whole-document comment.");
  });

  it("retries comment reply lookup when the requested reply is not immediately visible", async () => {
    vi.useFakeTimers();
    const missing = [rootReply, reply("7623358762999999999", "Earlier assistant summary")];
    const client = makeOpenApiClient({
      repliesSequence: [
        missing,
        missing,
        [rootReply, reply("7623359125999999999", "Insert a sentence below this paragraph")],
      ],
    });
    const turnPromise = resolveCommentTurn({
      client,
      event: makeDriveCommentEvent({
        notice_meta: { notice_type: "add_reply" },
        reply_id: "7623359125999999999",
      }),
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(2_000);
    const turn = await turnPromise;
    expect(turn?.targetReplyText).toBe("Insert a sentence below this paragraph");
    expectPrompt(
      turn,
      'The user added a reply in "Comment event handling request".',
      'Original comment text: "Also send it to the agent after receiving the comment event"',
      "Insert a sentence below this paragraph",
    );
    expect(vi.getTimerCount()).toBe(0);
    expect(replyRequests(client)).toHaveLength(3);
  });

  it("stops the comment reply retry loop when the owning abortSignal fires", async () => {
    vi.useFakeTimers();
    const abortController = new AbortController();
    const client = makeOpenApiClient({
      repliesSequence: [[reply(ROOT_REPLY_ID, "Earlier assistant summary")]],
    });
    const turnPromise = resolveCommentTurn({
      client,
      event: makeDriveCommentEvent({ reply_id: "7623358762999999999" }),
      abortSignal: abortController.signal,
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(vi.getTimerCount()).toBe(1);
    abortController.abort();
    const turn = await turnPromise;
    expect(turn).not.toBeNull();
    expect(vi.getTimerCount()).toBe(0);
    expect(replyRequests(client)).toHaveLength(1);
    expect(turn?.targetReplyText).toBeUndefined();
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

  it("serializes same-document comment notices before invoking handleFeishuCommentEvent", async () => {
    const controller = new AbortController();
    const onComment = commentHandler({ abortSignal: controller.signal });
    const first = blockFirstComment();
    const second = createDeferred<void>();
    handleComment.mockImplementationOnce(async () => {
      second.resolve();
    });
    await onComment(makeDriveCommentEvent({ event_id: "evt_1", reply_id: "reply_1" }));
    await first.started;
    expect(handleComment).toHaveBeenCalledTimes(1);
    await onComment(makeDriveCommentEvent({ event_id: "evt_2", reply_id: "reply_2" }));
    expect(handleComment).toHaveBeenCalledTimes(1);
    first.release();
    await second.promise;
    expect(handleComment).toHaveBeenCalledTimes(2);
    expect(handleComment).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        accountId: "default",
        botOpenId: "ou_bot",
        abortSignal: controller.signal,
        event: expect.objectContaining({ event_id: "evt_1", comment_id: COMMENT_ID }),
      }),
    );
    expect(handleComment).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        event: expect.objectContaining({ event_id: "evt_2" }),
      }),
    );
  });

  it("does not execute a queued durable comment after its claim aborts", async () => {
    const first = blockFirstComment();
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
      resolveIngressLifecycle: (data) =>
        (data as { event_id?: string }).event_id === "evt_queued" ? lifecycle : undefined,
    });
    await onComment(makeDriveCommentEvent({ event_id: "evt_blocking" }));
    await first.started;
    expect(handleComment).toHaveBeenCalledTimes(1);
    const queued = onComment(makeDriveCommentEvent({ event_id: "evt_queued" }));
    controller.abort(new Error("adoption timeout"));
    first.release();
    await queued;
    expect(handleComment).toHaveBeenCalledTimes(1);
    expect(abandoned).toHaveBeenCalledTimes(1);
  });

  it("cancels a queued durable comment after its claim aborts without spending retry budget", async () => {
    const first = blockFirstComment();
    const controller = new AbortController();
    const cancelled = vi.fn(async () => {});
    const abandoned = vi.fn(async () => {});
    const lifecycle: FeishuIngressLifecycle = {
      abortSignal: controller.signal,
      onAdopted: vi.fn(async () => {}),
      onDeferred: vi.fn(),
      onAdoptionFinalizing: vi.fn(),
      onCancelled: cancelled,
      onAbandoned: abandoned,
    };
    const onComment = commentHandler({
      resolveIngressLifecycle: (data) =>
        (data as { event_id?: string }).event_id === "evt_queued_cancel" ? lifecycle : undefined,
    });
    await onComment(makeDriveCommentEvent({ event_id: "evt_blocking_cancel" }));
    await first.started;
    const queued = onComment(makeDriveCommentEvent({ event_id: "evt_queued_cancel" }));
    controller.abort(new Error("adoption timeout"));
    first.release();
    await queued;
    expect(handleComment).toHaveBeenCalledTimes(1);
    expect(cancelled).toHaveBeenCalledTimes(1);
    expect(abandoned).not.toHaveBeenCalled();
  });
});
