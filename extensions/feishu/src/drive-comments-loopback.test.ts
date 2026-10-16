import { createServer } from "node:http";
import * as Lark from "@larksuiteoapi/node-sdk";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { afterAll, afterEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { createCommentTypingReactionLifecycle } from "./comment-reaction.js";
import { registerFeishuDriveTools } from "./drive.js";
import { createToolFactoryHarness } from "./tool-factory-test-harness.js";

const config = {
  channels: {
    feishu: {
      enabled: true,
      appId: "loopback-test-app",
      appSecret: "loopback-test-placeholder", // pragma: allowlist secret
      tools: { drive: true },
    },
  },
};

type DeliveryContext = { channel?: string; to?: string; threadId?: string | number };
type WireRequest = { method: string; url: string; body: string };
type ApiReply = { body: unknown; status?: number; wait?: Promise<void>; received?: () => void };

const rawTarget = { token: " raw/+ ", file: "%20raw%2F%2B%20" };
const ambientTarget = { token: " ", file: "ambient_file" };
const explicitTarget = { token: " explicit/+ ", file: "explicit%2F%2B" };
const thread = (type: string) => `comment:${type}:ambient_file:ambient_comment`;
function target(
  action: string,
  ambient: string | undefined,
  source: typeof rawTarget,
  type: string,
  defaulted: boolean,
  extra: { channel?: string; explicitType?: string } = {},
) {
  return { action, ambient, ...source, type, defaulted, ...extra };
}
function get(url: string): WireRequest {
  return { method: "GET", url, body: "" };
}
function post(url: string, body: unknown): WireRequest {
  return { method: "POST", url, body: JSON.stringify(body) };
}
function emptyPage(replies: boolean) {
  return {
    has_more: false,
    page_token: undefined,
    ...(replies ? { replies: [] } : { comments: [] }),
  };
}
function writeRequest(reply: boolean, file: string, type: string, comment: string, text: string) {
  return post(
    `/open-apis/drive/v1/files/${file}/${reply ? `comments/${comment}/replies?file_type=${type}` : "new_comments"}`,
    reply
      ? { content: { elements: [{ type: "text_run", text_run: { text } }] } }
      : { file_type: type, reply_elements: [{ type: "text", text }] },
  );
}
function metadataRequest(file: string, type: string, comment: string) {
  return post(
    `/open-apis/drive/v1/files/${file}/comments/batch_query?file_type=${type}&user_id_type=open_id`,
    { comment_ids: [comment] },
  );
}

async function createDriveLoopback(replies: ApiReply[], deliveryContext?: DeliveryContext) {
  const requests: WireRequest[] = [];
  const logs: Array<{ level: string; message: string }> = [];
  for (const level of ["info", "warn"] as const) {
    vi.spyOn(console, level).mockImplementation((message) => {
      logs.push({ level, message: String(message) });
    });
  }
  const server = createServer((request, response) => {
    void (async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      }
      requests.push({
        method: request.method ?? "",
        url: request.url ?? "",
        body: Buffer.concat(chunks).toString("utf8"),
      });
      const reply = replies[requests.length - 1];
      if (!reply) {
        response.writeHead(500).end("Unexpected request");
        return;
      }
      reply.received?.();
      await reply.wait;
      response.writeHead(reply.status ?? 200, { "content-type": "application/json" });
      response.end(JSON.stringify(reply.body));
    })().catch((error: unknown) => {
      response.writeHead(500).end(String(error));
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  onTestFinished(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Missing loopback server address");
  }
  const origin = `http://127.0.0.1:${address.port}`;
  const client = new Lark.Client({
    appId: config.channels.feishu.appId,
    appSecret: config.channels.feishu.appSecret,
    domain: origin,
    disableTokenCache: true,
    loggerLevel: Lark.LoggerLevel.error,
  });
  const sdkErrors = vi.spyOn(client.logger, "error").mockImplementation(() => {});
  vi.spyOn(await import("./client.js"), "createFeishuClient").mockReturnValue(client);
  const harness = createToolFactoryHarness(config);
  registerFeishuDriveTools(harness.api);
  const context = { agentAccountId: undefined, deliveryContext };
  return {
    requests,
    logs,
    sdkErrors,
    tool: harness.resolveTool("feishu_drive", context),
  };
}

function expectDriveOutcome(
  fixture: Awaited<ReturnType<typeof createDriveLoopback>>,
  result: { details: Record<string, unknown> },
  requests: WireRequest[],
  details: Record<string, unknown>,
) {
  expect(fixture.requests).toEqual(requests);
  expect(result.details).toStrictEqual(details);
  expect(result).toMatchObject({
    content: [{ type: "text", text: expect.stringContaining("EXTERNAL_UNTRUSTED_CONTENT") }],
  });
}

describe("feishu_drive comments through the installed Lark SDK", () => {
  afterEach(() => vi.restoreAllMocks());
  afterAll(() => vi.resetModules());

  it.each(["list_comments", "list_comment_replies"] as const)(
    "encodes %s pagination and retains its normalized result shape",
    async (action) => {
      const reply = {
        reply_id: "r1",
        user_id: "u1",
        create_time: 10,
        content: { elements: [{ type: "text_run", text_run: { text: "Reply text" } }] },
      };
      const normalizedReply = {
        reply_id: "r1",
        user_id: "u1",
        create_time: 10,
        update_time: undefined,
        text: "Reply text",
      };
      const isReplies = action === "list_comment_replies";
      const fixture = await createDriveLoopback([
        {
          body: {
            code: 0,
            data: {
              has_more: true,
              page_token: "next + cursor",
              items: isReplies
                ? [reply]
                : [{ comment_id: "c1", reply_list: { replies: [reply, reply] } }],
            },
          },
        },
        { body: { code: 0 } },
      ]);
      const params = {
        action,
        file_token: " doc/+ ",
        file_type: "sheet",
        comment_id: " comment/+ ",
        page_size: 201,
        page_token: " cursor +/ ",
      };
      const result = await fixture.tool.execute("page", params);
      const path =
        "/open-apis/drive/v1/files/%20doc%2F%2B%20/comments" +
        (isReplies ? "/%20comment%2F%2B%20/replies" : "");
      const request = get(
        `${path}?file_type=sheet&page_size=100&page_token=cursor+%2B%2F&user_id_type=open_id`,
      );
      const items = isReplies
        ? { replies: [normalizedReply] }
        : {
            comments: [
              {
                comment_id: "c1",
                user_id: undefined,
                create_time: undefined,
                update_time: undefined,
                is_solved: undefined,
                is_whole: undefined,
                quote: undefined,
                text: "Reply text",
                has_more_replies: undefined,
                replies_page_token: undefined,
                replies: [normalizedReply],
              },
            ],
          };
      expectDriveOutcome(fixture, result, [request], {
        has_more: true,
        page_token: "next + cursor",
        ...items,
      });
      expect(Object.keys(result.details)).toEqual([
        "has_more",
        "page_token",
        isReplies ? "replies" : "comments",
      ]);
      const empty = await fixture.tool.execute("empty-page", {
        ...params,
        page_size: 0,
        page_token: " ",
      });
      expectDriveOutcome(
        fixture,
        empty,
        [request, get(`${path}?file_type=sheet&page_size=1&user_id_type=open_id`)],
        emptyPage(isReplies),
      );
      expect(fixture.logs).toEqual([]);
    },
  );

  it.each([
    target("list_comments", undefined, rawTarget, "docx", true),
    target("list_comments", thread("sheet"), ambientTarget, "sheet", false),
    target("list_comment_replies", thread("file"), ambientTarget, "file", false),
    target("list_comment_replies", thread("sheet"), rawTarget, "docx", true, { channel: "slack" }),
    target("add_comment", thread("doc"), ambientTarget, "doc", false),
    target("add_comment", thread("slides"), rawTarget, "docx", true),
    target("reply_comment", thread("slides"), ambientTarget, "slides", false),
    target("reply_comment", thread("doc"), explicitTarget, "docx", false, { explicitType: "docx" }),
  ])("resolves $action targets over HTTP ($type, $file)", async (testCase) => {
    const isReply = testCase.action === "reply_comment";
    const fixture = await createDriveLoopback(
      [
        ...(isReply ? [{ body: { code: 0, data: { items: [] } } }] : []),
        { body: { code: 0, data: {} } },
      ],
      testCase.ambient
        ? { channel: testCase.channel ?? "feishu", to: testCase.ambient }
        : undefined,
    );
    const result = await fixture.tool.execute("target", {
      action: testCase.action,
      file_token: testCase.token,
      ...(testCase.explicitType ? { file_type: testCase.explicitType } : {}),
      comment_id: " ",
      content: "Hello + 世界",
    });
    const filePath = `/open-apis/drive/v1/files/${testCase.file}`;
    const commentId = testCase.defaulted ? "%20" : "ambient_comment";
    let requests: WireRequest[];
    let details: Record<string, unknown>;
    if (testCase.action === "add_comment") {
      requests = [writeRequest(false, testCase.file, testCase.type, commentId, "Hello + 世界")];
      details = { success: true };
    } else if (isReply) {
      requests = [
        metadataRequest(testCase.file, testCase.type, "ambient_comment"),
        writeRequest(true, testCase.file, testCase.type, commentId, "Hello + 世界"),
      ];
      details = { delivery_mode: "reply_comment", success: true };
    } else {
      const replies = testCase.action === "list_comment_replies";
      requests = [
        get(
          `${filePath}/comments${replies ? `/${commentId}/replies` : ""}?file_type=${testCase.type}&user_id_type=open_id`,
        ),
      ];
      details = emptyPage(replies);
    }
    expectDriveOutcome(fixture, result, requests, details);
    expect(fixture.logs).toEqual(
      testCase.defaulted
        ? [
            {
              level: "info",
              message: `[feishu_drive] ${testCase.action} missing file_type; defaulting to docx file_token=${testCase.token}`,
            },
          ]
        : [],
    );
  });

  it.each(["list_comments", "list_comment_replies"])(
    "surfaces fulfilled API failures and HTTP failures for %s",
    async (action) => {
      const fixture = await createDriveLoopback([
        { body: { code: 9999, msg: "Denied by Drive" } },
        { status: 403, body: { code: 9999, msg: "Denied by Drive" } },
      ]);
      const params = { action, file_token: "file", file_type: "docx", comment_id: "comment" };
      const request = get(
        `/open-apis/drive/v1/files/file/comments${action === "list_comment_replies" ? "/comment/replies" : ""}?file_type=docx&user_id_type=open_id`,
      );
      expectDriveOutcome(fixture, await fixture.tool.execute("api-error", params), [request], {
        error: "Denied by Drive",
      });
      expect(fixture.sdkErrors).not.toHaveBeenCalled();
      expectDriveOutcome(
        fixture,
        await fixture.tool.execute("http-error", params),
        [request, request],
        {
          error: JSON.stringify({
            message: "Request failed with status code 403",
            http_status: 403,
            feishu_code: 9999,
            feishu_msg: "Denied by Drive",
          }),
        },
      );
      expect(fixture.sdkErrors).toHaveBeenCalledTimes(1);
    },
  );

  it.each([
    { action: "add_comment", failure: false },
    { action: "reply_comment", failure: false },
    { action: "add_comment", failure: true },
    { action: "reply_comment", failure: true },
  ])(
    "returns $action (failure=$failure) before its typing delete completes",
    async ({ action, failure }) => {
      const deletionStarted = createDeferred<void>();
      const releaseDeletion = createDeferred<void>();
      const isReply = action === "reply_comment";
      const fixture = await createDriveLoopback(
        [
          { body: { code: 0 } },
          ...(isReply ? [{ body: { code: 0, data: { items: [] } } }] : []),
          {
            body: failure
              ? { code: 9999, msg: "Write denied" }
              : { code: 0, data: { id: "written" } },
          },
          { body: { code: 0 }, wait: releaseDeletion.promise, received: deletionStarted.resolve },
        ],
        { channel: "feishu", to: "comment:docx:file:comment", threadId: "typing_reply" },
      );
      const lifecycle = createCommentTypingReactionLifecycle({
        cfg: config,
        fileType: "docx",
        fileToken: "file",
        replyId: "typing_reply",
      });
      await lifecycle.start();
      const output = fixture.tool.execute("write", { action, content: "Write text" });
      let returned = false;
      void Promise.resolve(output).then(() => {
        returned = true;
      });
      try {
        await deletionStarted.promise;
        expect(returned).toBe(true);
        const reaction = (reactionAction: string) =>
          post("/open-apis/drive/v2/files/file/comments/reaction?file_type=docx", {
            action: reactionAction,
            reply_id: "typing_reply",
            reaction_type: "Typing",
          });
        expectDriveOutcome(
          fixture,
          await output,
          [
            reaction("add"),
            ...(isReply ? [metadataRequest("file", "docx", "comment")] : []),
            writeRequest(isReply, "file", "docx", "comment", "Write text"),
            reaction("delete"),
          ],
          failure
            ? { error: "Write denied" }
            : {
                ...(isReply ? { delivery_mode: "reply_comment" } : {}),
                success: true,
                id: "written",
              },
        );
      } finally {
        releaseDeletion.resolve();
        await lifecycle.cleanup();
        await output;
      }
      expect(
        fixture.requests.filter((request) => request.body.includes('"action":"delete"')),
      ).toHaveLength(1);
    },
  );
});
