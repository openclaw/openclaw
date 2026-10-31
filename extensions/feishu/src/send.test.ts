import type { HttpInstance } from "@larksuiteoapi/node-sdk";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FeishuConfigSchema } from "./config-schema.js";
import {
  editMessageFeishu,
  getMessageFeishu,
  listFeishuThreadMessages,
  sendMessageFeishu,
  sendStructuredCardFeishu,
} from "./send.js";

const { api, mockCreateFeishuClient, mockResolveFeishuAccount } = vi.hoisted(() => ({
  api: {
    get: vi.fn(),
    create:
      vi.fn<
        (params: {
          data: { receive_id: string; content: string; msg_type: string };
        }) => Promise<{ code: number; data: { message_id: string } }>
      >(),
    list: vi.fn(),
    patch: vi.fn(),
    update: vi.fn(),
  },
  mockCreateFeishuClient: vi.fn(),
  mockResolveFeishuAccount: vi.fn(),
}));

vi.mock("./client.js", () => ({
  createFeishuClient: mockCreateFeishuClient,
}));

vi.mock("./accounts.js", () => ({
  resolveFeishuAccount: mockResolveFeishuAccount,
  resolveFeishuRuntimeAccount: mockResolveFeishuAccount,
}));

afterAll(() => {
  vi.doUnmock("./client.js");
  vi.doUnmock("./accounts.js");
  vi.resetModules();
});

beforeEach(() => {
  vi.clearAllMocks();
  api.create.mockReset();
  mockResolveFeishuAccount.mockReturnValue({
    accountId: "default",
    configured: true,
    config: FeishuConfigSchema.parse({}),
  });
  mockCreateFeishuClient.mockReturnValue({
    im: { message: api },
  });
});

const getMessage = (messageId: string) => getMessageFeishu({ cfg: {}, messageId });

describe("getMessageFeishu", () => {
  it("sends native mentions while preserving body mentions, prose breaks, and code fences", async () => {
    api.create.mockResolvedValue(okResponse("om_mentions"));
    const text =
      'body <at user_id="ou_body">Body User</at>\nsecond line\n\n```ts\nconst value = 1\n```';
    const result = await sendMessageFeishu({
      cfg: {},
      to: "oc_send",
      text,
      mentions: [{ openId: "ou_target", name: "Target User", key: "@_user_1" }],
    });
    expect(JSON.parse(api.create.mock.calls[0]?.[0].data.content ?? "null")).toEqual({
      zh_cn: {
        content: [
          [
            { tag: "at", user_id: "ou_target", user_name: "Target User" },
            { tag: "md", text: text.replace("\nsecond", "  \nsecond") },
          ],
        ],
      },
    });
    expect(result).toEqual(expectedSendResult("om_mentions", "oc_send"));
    expect(result.receipt.parts).toMatchObject([{ kind: "text" }]);
  });

  it("sends structured cards with schema-2.0 width config and intact newlines", async () => {
    api.create.mockResolvedValue(okResponse("om_card"));

    await sendStructuredCardFeishu({
      cfg: {},
      to: "oc_card",
      text: "line one\nline two\n\nparagraph",
      header: { title: "Agent", template: "space lobster" },
    });

    const request = api.create.mock.calls[0]?.[0];
    expect(JSON.parse(request?.data?.content ?? "null")).toEqual({
      schema: "2.0",
      config: { width_mode: "fill" },
      body: { elements: [{ tag: "markdown", content: "line one\nline two\n\nparagraph" }] },
      header: { title: { tag: "plain_text", content: "Agent" }, template: "blue" },
    });
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
    api.get.mockResolvedValueOnce(
      page([apiMessage(messageId, card, "interactive", { chat_id: chatId })]),
    );
    const result = await getMessage(messageId);
    expect(result).toMatchObject({ messageId, chatId, content, contentType: "interactive" });
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
      im: { message: { get: api.get } },
      contact: { user: { get: getUser } },
    });
    api.get.mockResolvedValueOnce(
      page([{ message_id: "om_lookup_limit", msg_type: "merge_forward" }, ...children]),
    );

    const result = await getMessage("om_lookup_limit");
    expect(getUser.mock.calls.map(([request]) => request.path.user_id)).toEqual(
      Array.from({ length: 50 }, (_, index) => `ou_lookup_limit_${index}`),
    );
    expect(result?.content).toContain("... and 1 more messages");
    expect(result?.content).not.toContain("child 50");
  });
});

describe("editMessageFeishu", () => {
  beforeEach(() => {
    api.patch.mockReset();
    api.update.mockReset();
  });

  it("routes card and rich-post edits through their distinct Feishu SDK HTTP methods", async () => {
    const Lark = await import("@larksuiteoapi/node-sdk");
    const requests: Array<{ method: string; url: string; data: unknown }> = [];
    const tokenRequest = vi.fn(async (): Promise<never> => {
      throw new Error("Unexpected Feishu HTTP request");
    });
    const transport: HttpInstance = {
      request: async (options) => {
        const method = options.method ?? "GET";
        const data = options.data ?? {};
        requests.push({ method, url: options.url ?? "", data });
        const valid = method === "PATCH" || method === "PUT";
        return Response.json({ code: valid ? 0 : 230020, msg: "edit contract" }).json();
      },
      get: tokenRequest,
      delete: tokenRequest,
      head: tokenRequest,
      options: tokenRequest,
      post: tokenRequest,
      put: tokenRequest,
      patch: tokenRequest,
    };
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
        cfg: {},
        messageId: "om_card_contract",
        card: { schema: "2.0" },
      }),
    ).resolves.toEqual({ messageId: "om_card_contract", contentType: "interactive" });
    const text = `${"a".repeat(4_500)}\nsecond line`;
    await expect(
      editMessageFeishu({
        cfg: {},
        messageId: "om_post_contract",
        text,
      }),
    ).resolves.toEqual({ messageId: "om_post_contract", contentType: "post" });

    const request = (method: string, id: string, data: unknown) => ({
      method,
      url: `https://open.feishu.cn/open-apis/im/v1/messages/${id}`,
      data,
    });
    expect(requests).toEqual([
      request("PATCH", "om_card_contract", { content: JSON.stringify({ schema: "2.0" }) }),
      request("PUT", "om_post_contract", {
        msg_type: "post",
        content: JSON.stringify({
          zh_cn: { content: [[{ tag: "md", text: `${"a".repeat(4_500)}  \nsecond line` }]] },
        }),
      }),
    ]);
    expect(tokenRequest).not.toHaveBeenCalled();
  });

  it("rejects edits that exceed the rich-post byte envelope", async () => {
    await expect(
      editMessageFeishu({
        cfg: {},
        messageId: "om_edit",
        text: "界".repeat(11_000),
      }),
    ).rejects.toThrow("Feishu message edit exceeds the 30 KB rich-post API limit");
    expect(api.patch).not.toHaveBeenCalled();
    expect(api.update).not.toHaveBeenCalled();
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

function apiMessage(
  message_id: string,
  content: unknown,
  msg_type: string,
  metadata: Record<string, unknown> = {},
) {
  return { message_id, body: body(content), msg_type, ...metadata };
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
        root_id: "om_topic_root",
        thread_id: "omt_topic",
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
        api.list.mockResolvedValueOnce(response);
        content = (await listFeishuThreadMessages(thread))[0]?.content;
      } else {
        api.get.mockResolvedValueOnce(response);
        const result = await getMessage(surface === "forward" ? "om_forward" : "om_mentions");
        content = result?.content;
        if (surface === "get") {
          expect(result).toMatchObject({ rootId: "om_topic_root", threadId: "omt_topic" });
        }
      }
      expect(content).toBe(
        surface === "forward"
          ? `[Merged and Forwarded Messages]\n- [1970-01-01T00:00:01.000Z] ${normalized}\n- [1970-01-01T00:00:02.000Z] <at user_id="ou_other">Other</at>`
          : normalized,
      );
      expect(response).toEqual(before);
    },
  );
});

describe("listFeishuThreadMessages", () => {
  it("parses thread history content and rejects partially numeric timestamps", async () => {
    const historyItem = (
      id: string,
      content: unknown,
      type: string,
      time: number | string,
      sender = "ou_1",
      senderType = "user",
    ) =>
      apiMessage(id, content, type, {
        sender: { id: sender, sender_type: senderType },
        create_time: String(time),
      });
    const response = page([
      { ...textMessage("om_root", "root starter"), msg_type: "text" },
      historyItem(
        "om_card",
        { body: { elements: [{ tag: "markdown", content: "card" }] } },
        "interactive",
        1000,
        "app_1",
        "app",
      ),
      historyItem(
        "om_post",
        {
          zh_cn: { title: "Summary", content: [[{ tag: "text", text: "Ready", style: ["bold"] }]] },
        },
        "post",
        1500,
        "ou_post",
      ),
      historyItem("om_file", { file_key: "file_v3_123" }, "file", 2000),
      historyItem("om_text", { text: "partial time" }, "text", "1000ms"),
    ]);
    const before = structuredClone(response);
    api.list.mockResolvedValueOnce(response);

    const result = await listFeishuThreadMessages({ ...thread, rootMessageId: "om_root" });

    expect(response).toEqual(before);
    expect(result).toEqual([
      historyMessage("om_text", "ou_1", "text", "partial time"),
      historyMessage("om_file", "ou_1", "file", "[file message]", 2000),
      historyMessage("om_post", "ou_post", "post", "Summary\n\n**Ready**", 1500),
      historyMessage("om_card", "app_1", "interactive", "card", 1000, "app"),
    ]);
  });

  it("fills large histories across overlapping pages, excluding root and current messages", async () => {
    const numbered = (n: number) => textMessage(`om_${n}`, String(n));
    api.list
      .mockResolvedValueOnce(
        page(
          [
            textMessage("om_current", "current"),
            textMessage("om_root", "root"),
            ...Array.from({ length: 48 }, (_, index) => numbered(51 - index)),
          ],
          { has_more: true, page_token: "older-history" },
        ),
      )
      .mockResolvedValueOnce(
        page([textMessage("om_51", "duplicate"), numbered(3), numbered(2), numbered(1)]),
      );
    const result = await listFeishuThreadMessages({
      ...thread,
      currentMessageId: "om_current",
      rootMessageId: "om_root",
      limit: 51,
    });
    expect(result.map(({ messageId, content }) => [messageId, content])).toEqual(
      Array.from({ length: 51 }, (_, index) => [`om_${index + 1}`, String(index + 1)]),
    );
    expect(api.list).toHaveBeenNthCalledWith(2, {
      params: {
        container_id_type: "thread",
        container_id: "omt_1",
        sort_type: "ByCreateTimeDesc",
        page_size: 50,
        page_token: "older-history",
        card_msg_content_type: "user_card_content",
      },
    });
  });
  it.each([
    { name: "missing", firstToken: undefined, secondToken: undefined },
    { name: "repeated", firstToken: "same-page", secondToken: "same-page" },
  ])("rejects $name thread history continuation tokens", async ({ firstToken, secondToken }) => {
    for (const token of firstToken ? [firstToken, secondToken] : [firstToken]) {
      api.list.mockResolvedValueOnce(
        page([], { has_more: true, ...(token ? { page_token: token } : {}) }),
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
  afterEach(() => vi.useRealTimers());
  it.each([
    { scope: "one target", targets: ["oc_shared", "oc_shared", "oc_shared"] },
    { scope: "distinct targets", targets: ["oc_alpha", "oc_beta", "oc_gamma"] },
  ])(
    "keeps sends to $scope independent when responses arrive out of order",
    async ({ targets }) => {
      const completionOrder: string[] = [];
      const sends = targets.map((to, index) => {
        const response = createDeferred<ReturnType<typeof okResponse>>();
        const started = createDeferred<void>();
        api.create.mockImplementationOnce(() => {
          started.resolve();
          return response.promise;
        });
        return {
          to,
          response,
          started,
          messageId: `om_concurrent_${index}`,
          sending: sendMessageFeishu({ cfg, to, text: `message ${index}` }).then((result) => {
            completionOrder.push(result.messageId);
            return result;
          }),
        };
      });
      const settled = Promise.allSettled(sends.map((send) => send.sending));

      try {
        await Promise.all(sends.map((send) => send.started.promise));
        expect(completionOrder).toEqual([]);

        for (const send of sends.toReversed()) {
          send.response.resolve(okResponse(send.messageId));
          await expect(send.sending).resolves.toEqual(expectedSendResult(send.messageId, send.to));
        }
        expect(completionOrder).toEqual(sends.toReversed().map((send) => send.messageId));
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
    api.create.mockImplementation(async ({ data: { receive_id: to } }) => {
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
      expect(Object.fromEntries(attempts)).toEqual({
        oc_exhausted: 1,
        oc_recovering: 1,
        oc_successful: 1,
      });
      await expect(successful).resolves.toEqual(
        expectedSendResult("om_oc_successful", "oc_successful"),
      );

      await vi.runAllTimersAsync();
      await expect(exhausted).rejects.toThrow(/^Feishu send failed:.*"feishu_code":230020/u);
      expect(Object.fromEntries(attempts)).toEqual({
        oc_exhausted: 3,
        oc_recovering: 2,
        oc_successful: 1,
      });
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
