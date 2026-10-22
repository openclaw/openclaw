import type { HttpInstance, HttpRequestOptions } from "@larksuiteoapi/node-sdk";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ClawdbotConfig } from "../runtime-api.js";
import { buildFeishuAgentBody } from "./bot-agent-body.js";
import { FeishuConfigSchema } from "./config-schema.js";
import {
  editMessageFeishu,
  getMessageFeishu,
  listFeishuThreadMessages,
  sendMessageFeishu,
  sendStructuredCardFeishu,
} from "./send.js";

const {
  mockConvertMarkdownTables,
  mockClientGet,
  mockClientCreate,
  mockClientList,
  mockClientPatch,
  mockClientUpdate,
  mockCreateFeishuClient,
  mockLogVerbose,
  mockResolveMarkdownTableMode,
  mockResolveFeishuAccount,
  mockRuntimeConvertMarkdownTables,
  mockRuntimeResolveMarkdownTableMode,
} = vi.hoisted(() => ({
  mockConvertMarkdownTables: vi.fn((text: string) => text),
  mockClientGet: vi.fn(),
  mockClientCreate:
    vi.fn<
      (params: {
        data: { receive_id: string; content: string; msg_type: string };
      }) => Promise<{ code: number; data: { message_id: string } }>
    >(),
  mockClientList: vi.fn(),
  mockClientPatch: vi.fn(),
  mockClientUpdate: vi.fn(),
  mockCreateFeishuClient: vi.fn(),
  mockLogVerbose: vi.fn(),
  mockResolveMarkdownTableMode: vi.fn(() => "preserve"),
  mockResolveFeishuAccount: vi.fn(),
  mockRuntimeConvertMarkdownTables: vi.fn((text: string) => text),
  mockRuntimeResolveMarkdownTableMode: vi.fn(() => "preserve"),
}));

vi.mock("openclaw/plugin-sdk/markdown-table-runtime", () => ({
  resolveMarkdownTableMode: mockResolveMarkdownTableMode,
}));

vi.mock("openclaw/plugin-sdk/runtime-env", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/runtime-env")>();
  return {
    ...actual,
    logVerbose: mockLogVerbose,
  };
});

vi.mock("openclaw/plugin-sdk/text-chunking", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/text-chunking")>();
  return {
    ...actual,
    convertMarkdownTables: mockConvertMarkdownTables,
  };
});

vi.mock("./client.js", () => ({
  createFeishuClient: mockCreateFeishuClient,
}));

vi.mock("./accounts.js", () => ({
  resolveFeishuAccount: mockResolveFeishuAccount,
  resolveFeishuRuntimeAccount: mockResolveFeishuAccount,
}));

vi.mock("./runtime.js", () => ({
  getFeishuRuntime: () => ({
    channel: {
      text: {
        resolveMarkdownTableMode: mockRuntimeResolveMarkdownTableMode,
        convertMarkdownTables: mockRuntimeConvertMarkdownTables,
      },
    },
  }),
}));

afterAll(() => {
  vi.doUnmock("openclaw/plugin-sdk/markdown-table-runtime");
  vi.doUnmock("openclaw/plugin-sdk/runtime-env");
  vi.doUnmock("openclaw/plugin-sdk/text-chunking");
  vi.doUnmock("./client.js");
  vi.doUnmock("./accounts.js");
  vi.doUnmock("./runtime.js");
  vi.resetModules();
});

beforeEach(() => {
  vi.clearAllMocks();
  mockClientCreate.mockReset();
  mockResolveMarkdownTableMode.mockReturnValue("preserve");
  mockConvertMarkdownTables.mockImplementation((text: string) => text);
  mockRuntimeResolveMarkdownTableMode.mockImplementation(() => {
    throw new Error("Feishu runtime not initialized");
  });
  mockRuntimeConvertMarkdownTables.mockImplementation(() => {
    throw new Error("Feishu runtime not initialized");
  });
  mockResolveFeishuAccount.mockReturnValue({
    accountId: "default",
    configured: true,
    config: FeishuConfigSchema.parse({}),
  });
  mockCreateFeishuClient.mockReturnValue({
    im: {
      message: {
        create: mockClientCreate,
        get: mockClientGet,
        list: mockClientList,
        patch: mockClientPatch,
      },
    },
  });
});

describe("getMessageFeishu", () => {
  function expectTextReceipt(
    result: Awaited<ReturnType<typeof sendMessageFeishu>>,
    messageId: string,
  ) {
    const chatId = "oc_send";
    const raw = { channel: "feishu", messageId, chatId, conversationId: chatId };
    expect(typeof result.receipt.sentAt).toBe("number");
    expect(result).toEqual({
      messageId,
      chatId,
      receipt: {
        primaryPlatformMessageId: messageId,
        platformMessageIds: [messageId],
        parts: [{ platformMessageId: messageId, kind: "text", index: 0, raw }],
        sentAt: result.receipt.sentAt,
        raw: [raw],
        sourceResults: [{ channel: "feishu", messageId }],
      },
    });
  }

  function expectParsedMessage(result: unknown, expected: Record<string, unknown>) {
    expect(result).toEqual({
      chatType: undefined,
      senderId: undefined,
      senderOpenId: undefined,
      senderType: undefined,
      createTime: undefined,
      threadId: undefined,
      ...expected,
    });
  }

  it("sends native mentions while preserving body mentions, prose breaks, and code fences", async () => {
    mockClientCreate.mockResolvedValue({ code: 0, data: { message_id: "om_mentions" } });

    const result = await sendMessageFeishu({
      cfg: {} as ClawdbotConfig,
      to: "oc_send",
      text: 'body <at user_id="ou_body">Body User</at>\nsecond line\n\n```ts\nconst value = 1\n```',
      mentions: [{ openId: "ou_target", name: "Target User", key: "@_user_1" }],
    });

    expect(mockConvertMarkdownTables).toHaveBeenCalledWith(
      'body <at user_id="ou_body">Body User</at>\nsecond line\n\n```ts\nconst value = 1\n```',
      "preserve",
    );
    expect(mockClientCreate).toHaveBeenCalledWith({
      params: { receive_id_type: "chat_id" },
      data: {
        receive_id: "oc_send",
        msg_type: "post",
        content: JSON.stringify({
          zh_cn: {
            content: [
              [
                { tag: "at", user_id: "ou_target", user_name: "Target User" },
                {
                  tag: "md",
                  text: 'body <at user_id="ou_body">Body User</at>  \nsecond line\n\n```ts\nconst value = 1\n```',
                },
              ],
            ],
          },
        }),
      },
    });
    expectTextReceipt(result, "om_mentions");
  });

  it("sends structured cards with schema-2.0 width config and intact newlines", async () => {
    mockClientCreate.mockResolvedValue({ code: 0, data: { message_id: "om_card" } });

    await sendStructuredCardFeishu({
      cfg: {} as ClawdbotConfig,
      to: "oc_card",
      text: "line one\nline two\n\nparagraph",
      header: { title: "Agent", template: "space lobster" },
    });

    const request = mockClientCreate.mock.calls[0]?.[0];
    expect(JSON.parse(request?.data?.content ?? "null")).toEqual({
      schema: "2.0",
      config: { width_mode: "fill" },
      body: { elements: [{ tag: "markdown", content: "line one\nline two\n\nparagraph" }] },
      header: { title: { tag: "plain_text", content: "Agent" }, template: "blue" },
    });
  });

  it("preserves the canonical root and thread returned by the Feishu message API", async () => {
    mockClientGet.mockResolvedValueOnce(
      page([
        {
          ...textMessage("om_topic_child", "topic reply"),
          root_id: "om_topic_root",
          thread_id: "omt_topic",
          chat_id: "oc_topic_group",
          msg_type: "text",
        },
      ]),
    );
    const result = await getMessageFeishu({ cfg: {}, messageId: "om_topic_child" });

    expect(result).toEqual(
      expect.objectContaining({
        messageId: "om_topic_child",
        rootId: "om_topic_root",
        threadId: "omt_topic",
      }),
    );
  });

  it.each([
    {
      name: "i18n",
      card: {
        elements: [],
        body: { elements: [] },
        i18n_elements: {
          zh_cn: [],
          en_us: [{ tag: "markdown", content: "hello ${count} {{label}} {{metadata}}" }],
        },
        template_variable: { count: 2, label: "tasks", metadata: { ignored: true } },
      },
      content: "hello 2 tasks {{metadata}}",
    },
    {
      name: "post",
      card: {
        elements: [],
        post: {
          zh_cn: { title: "Card summary", content: [[{ tag: "md", text: "**fallback** body" }]] },
        },
      },
      content: "Card summary\n\n**fallback** body",
    },
  ])("falls through empty card elements to $name content", async ({ name, card, content }) => {
    const messageId = `om_${name}_card`;
    const chatId = `oc_${name}_card`;
    mockClientGet.mockResolvedValueOnce(
      page([
        {
          message_id: messageId,
          chat_id: chatId,
          msg_type: "interactive",
          body: body(card),
        },
      ]),
    );
    const result = await getMessageFeishu({ cfg: {}, messageId });
    expectParsedMessage(result, { messageId, chatId, content, contentType: "interactive" });
  });

  it("logs a safe diagnostic (not raw content) when message content is not valid JSON", async () => {
    mockClientGet.mockResolvedValueOnce({
      code: 0,
      data: {
        message_id: "om_bad_json",
        chat_id: "oc_test",
        chat_type: "group",
        msg_type: "text",
        body: { content: "{bad json}" },
        sender: { id: "ou_1", sender_type: "user" },
      },
    });
    const result = await getMessageFeishu({ cfg: {}, messageId: "om_bad_json" });

    expect(mockLogVerbose).toHaveBeenCalledWith(
      expect.stringContaining("feishu message content parse failed for text message"),
    );
    expect(mockLogVerbose.mock.calls.flat().map(String).join("\n")).not.toContain("{bad json}");
    expect(result).toMatchObject({
      messageId: "om_bad_json",
      contentType: "text",
      content: "{bad json}",
    });
  });

  it("looks up senders only for the first 50 chronological forwarded children", async () => {
    const children = Array.from({ length: 51 }, (_, index) => ({
      upper_message_id: "om_lookup_limit",
      msg_type: "text",
      create_time: String(index),
      sender: { id: `ou_lookup_limit_${index}` },
      body: body({ text: `child ${index}` }),
    })).toReversed();
    const getUser = vi.fn(async (_request: { path: { user_id: string } }) => ({
      data: { user: { name: "Sender" } },
    }));
    mockCreateFeishuClient.mockReturnValue({
      im: { message: { get: mockClientGet } },
      contact: { user: { get: getUser } },
    });
    mockClientGet.mockResolvedValueOnce(
      page([{ message_id: "om_lookup_limit", msg_type: "merge_forward" }, ...children]),
    );

    const result = await getMessageFeishu({ cfg: {}, messageId: "om_lookup_limit" });
    expect(getUser.mock.calls.map(([request]) => request.path.user_id)).toEqual(
      Array.from({ length: 50 }, (_, index) => `ou_lookup_limit_${index}`),
    );
    expect(result?.content).toContain("... and 1 more messages");
    expect(result?.content).not.toContain("child 50");
  });
});

describe("editMessageFeishu", () => {
  beforeEach(() => {
    mockClientPatch.mockReset();
    mockClientUpdate.mockReset();
    mockCreateFeishuClient.mockReturnValue({
      im: {
        message: {
          patch: mockClientPatch,
          update: mockClientUpdate,
        },
      },
    });
  });

  it("routes card and rich-post edits through their distinct Feishu SDK HTTP methods", async () => {
    const Lark = await import("@larksuiteoapi/node-sdk");
    const requests: Array<{ method: string; url: string; data: unknown }> = [];
    const tokenRequest = vi.fn(async (): Promise<never> => {
      throw new Error("Unexpected Feishu HTTP request");
    });
    const transport: HttpInstance = {
      request: tokenRequest,
      get: tokenRequest,
      delete: tokenRequest,
      head: tokenRequest,
      options: tokenRequest,
      post: tokenRequest,
      put: tokenRequest,
      patch: tokenRequest,
    };
    Object.defineProperty(transport, "request", {
      value: async (options: HttpRequestOptions<{ content?: string; msg_type?: string }>) => {
        const method = options.method ?? "GET";
        const data = options.data ?? {};
        requests.push({ method, url: options.url ?? "", data });
        const content = JSON.parse(data.content ?? "{}") as { schema?: string };
        const valid = content.schema
          ? method === "PATCH"
          : method === "PUT" && data.msg_type === "post";
        return Response.json({ code: valid ? 0 : 230020, msg: "edit contract" }).json();
      },
    });
    mockCreateFeishuClient.mockReturnValue(
      new Lark.Client({
        appId: "cli_edit_contract",
        appSecret: "local-test-placeholder", // pragma: allowlist secret
        domain: Lark.Domain.Feishu,
        loggerLevel: Lark.LoggerLevel.error,
        disableTokenCache: true,
        httpInstance: transport,
      }),
    );

    await expect(
      editMessageFeishu({
        cfg: {} as ClawdbotConfig,
        messageId: "om_card_contract",
        card: { schema: "2.0" },
      }),
    ).resolves.toEqual({ messageId: "om_card_contract", contentType: "interactive" });
    const text = `${"a".repeat(4_500)}\nsecond line`;
    await expect(
      editMessageFeishu({
        cfg: {} as ClawdbotConfig,
        messageId: "om_post_contract",
        text,
      }),
    ).resolves.toEqual({ messageId: "om_post_contract", contentType: "post" });

    expect(requests).toEqual([
      {
        method: "PATCH",
        url: "https://open.feishu.cn/open-apis/im/v1/messages/om_card_contract",
        data: { content: JSON.stringify({ schema: "2.0" }) },
      },
      {
        method: "PUT",
        url: "https://open.feishu.cn/open-apis/im/v1/messages/om_post_contract",
        data: {
          msg_type: "post",
          content: JSON.stringify({
            zh_cn: { content: [[{ tag: "md", text: `${"a".repeat(4_500)}  \nsecond line` }]] },
          }),
        },
      },
    ]);
    expect(tokenRequest).not.toHaveBeenCalled();
  });

  it("rejects edits that exceed the rich-post byte envelope", async () => {
    await expect(
      editMessageFeishu({
        cfg: {} as ClawdbotConfig,
        messageId: "om_edit",
        text: "界".repeat(11_000),
      }),
    ).rejects.toThrow("Feishu message edit exceeds the 30 KB rich-post API limit");
    expect(mockClientPatch).not.toHaveBeenCalled();
    expect(mockClientUpdate).not.toHaveBeenCalled();
  });
});

const thread = { cfg: {}, threadId: "omt_1" };

function page<T>(items: T[], paging: { has_more?: boolean; page_token?: string } = {}) {
  return { code: 0, data: { items, ...paging } };
}

function body(content: unknown) {
  return { content: JSON.stringify(content) };
}

function textMessage(message_id: string, text: string) {
  return { message_id, body: body({ text }) };
}

function historyMessage(
  messageId: string,
  senderId: string,
  contentType: string,
  content: string,
  createTime?: number,
  senderType = "user",
) {
  return { messageId, senderId, senderType, contentType, content, createTime };
}

describe("fetched text mentions", () => {
  it.each(["get", "thread", "forward"] as const)(
    "resolves %s placeholders once using each message's flat metadata",
    async (surface) => {
      const text = "Meet @_user_1 then @_user_10 and @_user_1";
      const normalized =
        'Meet <at user_id="ou_alice">Alice @_user_10</at> then <at user_id="ou_bob">Bob &lt;Ops&gt;</at> and <at user_id="ou_alice">Alice @_user_10</at>';
      const message = {
        ...textMessage("om_mentions", text),
        msg_type: "text",
        mentions: [
          { key: "@_user_1", id: "ou_alice", id_type: "open_id", name: "Alice @_user_10" },
          { key: "@_user_10", id: "ou_bob", id_type: "open_id", name: "Bob <Ops>" },
        ],
      };
      const items =
        surface === "forward"
          ? [
              { message_id: "om_forward", msg_type: "merge_forward" },
              { ...message, upper_message_id: "om_forward", create_time: "1000" },
              {
                ...textMessage("om_other", "@_user_1"),
                msg_type: "text",
                upper_message_id: "om_forward",
                create_time: "2000",
                mentions: [{ key: "@_user_1", id: "ou_other", id_type: "open_id", name: "Other" }],
              },
            ]
          : [message];
      const response = page(items);
      const before = structuredClone(response);
      let content: string | undefined;
      if (surface === "thread") {
        mockClientList.mockResolvedValueOnce(response);
        content = (await listFeishuThreadMessages(thread))[0]?.content;
      } else {
        mockClientGet.mockResolvedValueOnce(response);
        content = (
          await getMessageFeishu({
            cfg: {},
            messageId: surface === "forward" ? "om_forward" : "om_mentions",
          })
        )?.content;
      }
      expect(content).toBe(
        surface === "forward"
          ? `[Merged and Forwarded Messages]\n- [1970-01-01T00:00:01.000Z] ${normalized}\n- [1970-01-01T00:00:02.000Z] <at user_id="ou_other">Other</at>`
          : normalized,
      );
      expect(response).toEqual(before);
      if (surface === "get") {
        expect(
          buildFeishuAgentBody({
            ctx: { content: "reply", senderOpenId: "ou_sender", messageId: "om_reply" },
            quotedContent: content,
          }),
        ).toBe(`[message_id: om_reply]\nou_sender: [Replying to: "${normalized}"]\n\nreply`);
      }
    },
  );
});

describe("listFeishuThreadMessages", () => {
  it("reuses the same content parsing for thread history messages", async () => {
    const response = page([
      { ...textMessage("om_root", "root starter"), msg_type: "text" },
      {
        message_id: "om_card",
        msg_type: "interactive",
        body: body({
          body: {
            elements: [{ tag: "markdown", content: "hello from card 2.0" }],
          },
        }),
        sender: {
          id: "app_1",
          sender_type: "app",
        },
        create_time: "1710000000000",
      },
      {
        message_id: "om_post",
        msg_type: "post",
        body: body({
          zh_cn: {
            title: "Summary",
            content: [[{ tag: "text", text: "Ready", style: ["bold"] }]],
          },
        }),
        sender: { id: "ou_post", sender_type: "user" },
        create_time: "1710000000500",
      },
      {
        message_id: "om_file",
        msg_type: "file",
        body: body({ file_key: "file_v3_123" }),
        sender: {
          id: "ou_1",
          sender_type: "user",
        },
        create_time: "1710000001000",
      },
    ]);
    const before = structuredClone(response);
    mockClientList.mockResolvedValueOnce(response);

    const result = await listFeishuThreadMessages({
      ...thread,
      rootMessageId: "om_root",
    });

    expect(mockClientList).toHaveBeenCalledWith({
      params: {
        container_id_type: "thread",
        container_id: "omt_1",
        sort_type: "ByCreateTimeDesc",
        page_size: 21,
        card_msg_content_type: "user_card_content",
      },
    });
    expect(response).toEqual(before);
    expect(result).toEqual([
      historyMessage("om_file", "ou_1", "file", "[file message]", 1710000001000),
      historyMessage("om_post", "ou_post", "post", "Summary\n\n**Ready**", 1710000000500),
      historyMessage(
        "om_card",
        "app_1",
        "interactive",
        "hello from card 2.0",
        1710000000000,
        "app",
      ),
    ]);
  });

  it("does not partially parse malformed thread history create_time values", async () => {
    mockClientList.mockResolvedValueOnce(
      page([
        {
          ...textMessage("om_text", "partial time"),
          msg_type: "text",
          sender: {
            id: "ou_1",
            sender_type: "user",
          },
          create_time: "1710000000000ms",
        },
      ]),
    );

    const result = await listFeishuThreadMessages({
      ...thread,
      rootMessageId: "om_root",
    });

    expect(result).toEqual([historyMessage("om_text", "ou_1", "text", "partial time")]);
  });

  it("fills thread history from continuation pages after excluding the current and root messages", async () => {
    mockClientList
      .mockResolvedValueOnce(
        page(
          [
            textMessage("om_current", "current"),
            textMessage("om_root", "root"),
            textMessage("om_newer", "newer"),
          ],
          {
            has_more: true,
            page_token: "older-history",
          },
        ),
      )
      .mockResolvedValueOnce(page([textMessage("om_older", "older")], { has_more: false }));

    const result = await listFeishuThreadMessages({
      ...thread,
      currentMessageId: "om_current",
      rootMessageId: "om_root",
      limit: 2,
    });

    expect(result.map((message) => message.messageId)).toEqual(["om_older", "om_newer"]);
    expect(mockClientList).toHaveBeenNthCalledWith(2, {
      params: {
        container_id_type: "thread",
        container_id: "omt_1",
        sort_type: "ByCreateTimeDesc",
        page_size: 3,
        page_token: "older-history",
        card_msg_content_type: "user_card_content",
      },
    });
  });

  it("reads thread history beyond the SDK's maximum single-page size", async () => {
    const pageOne = Array.from({ length: 50 }, (_value, index) =>
      textMessage(`om_${String(51 - index)}`, String(51 - index)),
    );
    mockClientList
      .mockResolvedValueOnce(page(pageOne, { has_more: true, page_token: "last-message" }))
      .mockResolvedValueOnce(page([textMessage("om_1", "1")], { has_more: false }));

    const result = await listFeishuThreadMessages({
      ...thread,
      limit: 51,
    });

    expect(result).toHaveLength(51);
    expect(result[0]?.messageId).toBe("om_1");
    expect(result.at(-1)?.messageId).toBe("om_51");
  });

  it("deduplicates overlapping continuation pages without consuming the history limit", async () => {
    mockClientList
      .mockResolvedValueOnce(
        page([textMessage("om_newer", "newer")], {
          has_more: true,
          page_token: "overlapping-page",
        }),
      )
      .mockResolvedValueOnce(
        page([textMessage("om_newer", "duplicate"), textMessage("om_older", "older")]),
      );

    const result = await listFeishuThreadMessages({
      ...thread,
      limit: 2,
    });

    expect(result.map((message) => message.messageId)).toEqual(["om_older", "om_newer"]);
  });

  it.each([
    { name: "missing", firstToken: undefined, secondToken: undefined },
    { name: "repeated", firstToken: "same-page", secondToken: "same-page" },
  ])("rejects $name thread history continuation tokens", async ({ firstToken, secondToken }) => {
    mockClientList.mockResolvedValueOnce(
      page([], {
        has_more: true,
        ...(firstToken ? { page_token: firstToken } : {}),
      }),
    );
    if (firstToken) {
      mockClientList.mockResolvedValueOnce(
        page([], {
          has_more: true,
          ...(secondToken ? { page_token: secondToken } : {}),
        }),
      );
    }

    await expect(listFeishuThreadMessages(thread)).rejects.toThrow(
      `Feishu thread history pagination returned a ${firstToken ? "repeated" : "missing"} page token`,
    );
  });
});

function okResponse(messageId: string) {
  return { code: 0, data: { message_id: messageId } };
}

function expectedSendResult(messageId: string, chatId: string) {
  return expect.objectContaining({
    messageId,
    chatId,
    receipt: expect.objectContaining({
      primaryPlatformMessageId: messageId,
      platformMessageIds: [messageId],
    }),
  });
}

function rateLimitError() {
  return Object.assign(new Error("Request failed with status code 400"), {
    response: {
      status: 400,
      data: { code: 230020, msg: "This operation triggers the frequency limit" },
    },
  });
}

describe("concurrent Feishu sends", () => {
  const cfg = {};
  beforeEach(() => {
    mockResolveFeishuAccount.mockReturnValue({ accountId: "default", configured: true });
    mockCreateFeishuClient.mockReturnValue({ im: { message: { create: mockClientCreate } } });
  });
  afterEach(() => vi.useRealTimers());
  it.each([
    { scope: "one target", targets: ["oc_shared", "oc_shared", "oc_shared"] },
    { scope: "distinct targets", targets: ["oc_alpha", "oc_beta", "oc_gamma"] },
  ])(
    "keeps sends to $scope independent when responses arrive out of order",
    async ({ targets }) => {
      const requests = targets.map((to, index) => ({
        to,
        messageId: `om_concurrent_${index}`,
        response: createDeferred<ReturnType<typeof okResponse>>(),
        started: createDeferred<void>(),
      }));
      for (const request of requests) {
        mockClientCreate.mockImplementationOnce(() => {
          request.started.resolve();
          return request.response.promise;
        });
      }
      const completionOrder: string[] = [];
      const sends = requests.map((request, index) => ({
        ...request,
        sending: sendMessageFeishu({ cfg, to: request.to, text: `message ${index}` }).then(
          (result) => {
            completionOrder.push(result.messageId);
            return result;
          },
        ),
      }));
      const settled = Promise.allSettled(sends.map((send) => send.sending));

      try {
        await Promise.all(requests.map((request) => request.started.promise));
        expect(mockClientCreate.mock.calls.map(([params]) => params.data.receive_id)).toEqual(
          targets,
        );
        expect(completionOrder).toEqual([]);

        const expectedOrder: string[] = [];
        for (const send of sends.toReversed()) {
          send.response.resolve(okResponse(send.messageId));
          await expect(send.sending).resolves.toEqual(expectedSendResult(send.messageId, send.to));
          expectedOrder.push(send.messageId);
          expect(completionOrder).toEqual(expectedOrder);
        }
        expect(mockClientCreate).toHaveBeenCalledTimes(targets.length);
      } finally {
        for (const send of sends) {
          send.response.resolve(okResponse(send.messageId));
        }
        await settled;
      }
    },
  );

  it("keeps successful, recovering, and exhausted sends independent", async () => {
    vi.useFakeTimers();
    const attempts = new Map<string, number>();
    const started = createDeferred<void>();
    mockClientCreate.mockImplementation(async ({ data: { receive_id: to } }) => {
      const attempt = (attempts.get(to) ?? 0) + 1;
      attempts.set(to, attempt);
      if (attempts.size === 3) {
        started.resolve();
      }
      if (to === "oc_exhausted" || (to === "oc_recovering" && attempt === 1)) {
        throw rateLimitError();
      }
      return okResponse(`om_${to}`);
    });

    const exhausted = sendMessageFeishu({ cfg, to: "oc_exhausted", text: "exhausted" });
    const recovering = sendMessageFeishu({ cfg, to: "oc_recovering", text: "recovering" });
    const successful = sendMessageFeishu({ cfg, to: "oc_successful", text: "successful" });
    // Attach rejection handlers before advancing the retry clock.
    const settled = Promise.allSettled([exhausted, recovering, successful]);

    try {
      await started.promise;
      expect(attempts).toEqual(
        new Map([
          ["oc_exhausted", 1],
          ["oc_recovering", 1],
          ["oc_successful", 1],
        ]),
      );
      await expect(successful).resolves.toEqual(
        expectedSendResult("om_oc_successful", "oc_successful"),
      );

      await vi.runAllTimersAsync();
      await expect(exhausted).rejects.toThrow(/^Feishu send failed:.*"feishu_code":230020/u);
      expect(attempts).toEqual(
        new Map([
          ["oc_exhausted", 3],
          ["oc_recovering", 2],
          ["oc_successful", 1],
        ]),
      );
      expect(await settled).toEqual([
        { status: "rejected", reason: expect.any(Error) },
        { status: "fulfilled", value: expectedSendResult("om_oc_recovering", "oc_recovering") },
        { status: "fulfilled", value: expectedSendResult("om_oc_successful", "oc_successful") },
      ]);
    } finally {
      await vi.runAllTimersAsync();
      await settled;
    }
  });
});
