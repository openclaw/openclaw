import { hasControlCommand } from "openclaw/plugin-sdk/command-auth";
import {
  createInboundDebouncer,
  resolveInboundDebounceMs,
} from "openclaw/plugin-sdk/reply-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPluginRuntimeMock } from "../../../test/helpers/plugins/plugin-runtime-mock.js";
import { createNonExitingTypedRuntimeEnv } from "../../../test/helpers/plugins/runtime-env.js";
import type { ClawdbotConfig, RuntimeEnv } from "../runtime-api.js";
import * as dedup from "./dedup.js";
import { monitorSingleAccount } from "./monitor.account.js";
import {
  resolveDriveCommentEventTurn,
  type FeishuDriveCommentNoticeEvent,
} from "./monitor.comment.js";
import { setFeishuRuntime } from "./runtime.js";
import type { ResolvedFeishuAccount } from "./types.js";

const handleFeishuCommentEventMock = vi.hoisted(() => vi.fn(async () => {}));
const createEventDispatcherMock = vi.hoisted(() => vi.fn());
const createFeishuClientMock = vi.hoisted(() => vi.fn());
const monitorWebSocketMock = vi.hoisted(() => vi.fn(async () => {}));
const monitorWebhookMock = vi.hoisted(() => vi.fn(async () => {}));
const createFeishuThreadBindingManagerMock = vi.hoisted(() => vi.fn(() => ({ stop: vi.fn() })));

let handlers: Record<string, (data: unknown) => Promise<void>> = {};
const TEST_DOC_TOKEN = "doxxxxxxx";

vi.mock("./client.js", () => ({
  createEventDispatcher: createEventDispatcherMock,
  createFeishuClient: createFeishuClientMock,
}));

vi.mock("./comment-handler.js", () => ({
  handleFeishuCommentEvent: handleFeishuCommentEventMock,
}));

vi.mock("./monitor.transport.js", () => ({
  monitorWebSocket: monitorWebSocketMock,
  monitorWebhook: monitorWebhookMock,
}));

vi.mock("./thread-bindings.js", () => ({
  createFeishuThreadBindingManager: createFeishuThreadBindingManagerMock,
}));

function buildMonitorConfig(): ClawdbotConfig {
  return {
    channels: {
      feishu: {
        enabled: true,
      },
    },
  } as ClawdbotConfig;
}

function buildMonitorAccount(): ResolvedFeishuAccount {
  return {
    accountId: "default",
    enabled: true,
    configured: true,
    appId: "cli_test",
    appSecret: "secret_test", // pragma: allowlist secret
    domain: "feishu",
    config: {
      enabled: true,
      connectionMode: "websocket",
    },
  } as ResolvedFeishuAccount;
}

function makeDriveCommentEvent(
  overrides: Partial<FeishuDriveCommentNoticeEvent> = {},
): FeishuDriveCommentNoticeEvent {
  return {
    comment_id: "7623358762119646411",
    event_id: "10d9d60b990db39f96a4c2fd357fb877",
    is_mentioned: true,
    notice_meta: {
      file_token: TEST_DOC_TOKEN,
      file_type: "docx",
      from_user_id: {
        open_id: "ou_509d4d7ace4a9addec2312676ffcba9b",
      },
      notice_type: "add_comment",
      to_user_id: {
        open_id: "ou_bot",
      },
    },
    reply_id: "7623358762136374451",
    timestamp: "1774951528000",
    type: "drive.notice.comment_add_v1",
    ...overrides,
  };
}

function makeOpenApiClient(params: {
  documentTitle?: string;
  documentUrl?: string;
  quoteText?: string;
  rootReplyText?: string;
  targetReplyText?: string;
  includeTargetReplyInBatch?: boolean;
}) {
  return {
    request: vi.fn(async (request: { method: "GET" | "POST"; url: string; data: unknown }) => {
      if (request.url === "/open-apis/drive/v1/metas/batch_query") {
        return {
          code: 0,
          data: {
            metas: [
              {
                doc_token: TEST_DOC_TOKEN,
                title: params.documentTitle ?? "Comment event handling request",
                url: params.documentUrl ?? `https://www.larksuite.com/docx/${TEST_DOC_TOKEN}`,
              },
            ],
          },
        };
      }
      if (request.url.includes("/comments/batch_query")) {
        return {
          code: 0,
          data: {
            items: [
              {
                comment_id: "7623358762119646411",
                quote: params.quoteText ?? "im.message.receive_v1 message trigger implementation",
                reply_list: {
                  replies: [
                    {
                      reply_id: "7623358762136374451",
                      content: {
                        elements: [
                          {
                            type: "text_run",
                            text_run: {
                              content:
                                params.rootReplyText ??
                                "Also send it to the agent after receiving the comment event",
                            },
                          },
                        ],
                      },
                    },
                    ...(params.includeTargetReplyInBatch
                      ? [
                          {
                            reply_id: "7623359125036043462",
                            content: {
                              elements: [
                                {
                                  type: "text_run",
                                  text_run: {
                                    content:
                                      params.targetReplyText ?? "Please follow up on this comment",
                                  },
                                },
                              ],
                            },
                          },
                        ]
                      : []),
                  ],
                },
              },
            ],
          },
        };
      }
      if (request.url.includes("/replies")) {
        return {
          code: 0,
          data: {
            has_more: false,
            items: [
              {
                reply_id: "7623358762136374451",
                content: {
                  elements: [
                    {
                      type: "text_run",
                      text_run: {
                        content:
                          params.rootReplyText ??
                          "Also send it to the agent after receiving the comment event",
                      },
                    },
                  ],
                },
              },
              {
                reply_id: "7623359125036043462",
                content: {
                  elements: [
                    {
                      type: "text_run",
                      text_run: {
                        content: params.targetReplyText ?? "Please follow up on this comment",
                      },
                    },
                  ],
                },
              },
            ],
          },
        };
      }
      throw new Error(`unexpected request: ${request.method} ${request.url}`);
    }),
  };
}

async function setupCommentMonitorHandler(): Promise<(data: unknown) => Promise<void>> {
  const register = vi.fn((registered: Record<string, (data: unknown) => Promise<void>>) => {
    handlers = registered;
  });
  createEventDispatcherMock.mockReturnValue({ register });

  await monitorSingleAccount({
    cfg: buildMonitorConfig(),
    account: buildMonitorAccount(),
    runtime: createNonExitingTypedRuntimeEnv<RuntimeEnv>(),
    botOpenIdSource: {
      kind: "prefetched",
      botOpenId: "ou_bot",
    },
  });

  const handler = handlers["drive.notice.comment_add_v1"];
  if (!handler) {
    throw new Error("missing drive.notice.comment_add_v1 handler");
  }
  return handler;
}

describe("resolveDriveCommentEventTurn", () => {
  it("builds a real comment-turn prompt for add_comment notices", async () => {
    const client = makeOpenApiClient({ includeTargetReplyInBatch: true });

    const turn = await resolveDriveCommentEventTurn({
      cfg: buildMonitorConfig(),
      accountId: "default",
      event: makeDriveCommentEvent(),
      botOpenId: "ou_bot",
      createClient: () => client as never,
    });

    expect(turn).not.toBeNull();
    expect(turn?.senderId).toBe("ou_509d4d7ace4a9addec2312676ffcba9b");
    expect(turn?.messageId).toBe("drive-comment:10d9d60b990db39f96a4c2fd357fb877");
    expect(turn?.fileType).toBe("docx");
    expect(turn?.fileToken).toBe(TEST_DOC_TOKEN);
    expect(turn?.prompt).toContain(
      'The user added a comment in "Comment event handling request": Also send it to the agent after receiving the comment event',
    );
    expect(turn?.prompt).toContain(
      "This is a Feishu document comment-thread event, not a Feishu IM conversation.",
    );
    expect(turn?.prompt).toContain("comment_id: 7623358762119646411");
    expect(turn?.prompt).toContain("reply_id: 7623358762136374451");
    expect(turn?.prompt).toContain("The system will automatically reply with your final answer");
  });

  it("preserves sender user_id for downstream allowlist checks", async () => {
    const client = makeOpenApiClient({ includeTargetReplyInBatch: true });

    const turn = await resolveDriveCommentEventTurn({
      cfg: buildMonitorConfig(),
      accountId: "default",
      event: makeDriveCommentEvent({
        notice_meta: {
          ...makeDriveCommentEvent().notice_meta,
          from_user_id: {
            open_id: "ou_509d4d7ace4a9addec2312676ffcba9b",
            user_id: "on_comment_user_1",
          },
        },
      }),
      botOpenId: "ou_bot",
      createClient: () => client as never,
    });

    expect(turn?.senderId).toBe("ou_509d4d7ace4a9addec2312676ffcba9b");
    expect(turn?.senderUserId).toBe("on_comment_user_1");
  });

  it("falls back to the replies API to resolve add_reply text", async () => {
    const client = makeOpenApiClient({
      includeTargetReplyInBatch: false,
      targetReplyText: "Please follow up on this comment",
    });

    const turn = await resolveDriveCommentEventTurn({
      cfg: buildMonitorConfig(),
      accountId: "default",
      event: makeDriveCommentEvent({
        notice_meta: {
          ...makeDriveCommentEvent().notice_meta,
          notice_type: "add_reply",
        },
        reply_id: "7623359125036043462",
      }),
      botOpenId: "ou_bot",
      createClient: () => client as never,
    });

    expect(turn?.prompt).toContain(
      'The user added a reply in "Comment event handling request": Please follow up on this comment',
    );
    expect(turn?.prompt).toContain(
      "Original comment: Also send it to the agent after receiving the comment event",
    );
    expect(turn?.prompt).toContain(`file_token: ${TEST_DOC_TOKEN}`);
    expect(turn?.prompt).toContain("Event type: add_reply");
  });

  it("ignores self-authored comment notices", async () => {
    const turn = await resolveDriveCommentEventTurn({
      cfg: buildMonitorConfig(),
      accountId: "default",
      event: makeDriveCommentEvent({
        notice_meta: {
          ...makeDriveCommentEvent().notice_meta,
          from_user_id: { open_id: "ou_bot" },
        },
      }),
      botOpenId: "ou_bot",
      createClient: () => makeOpenApiClient({}) as never,
    });

    expect(turn).toBeNull();
  });

  it("skips comment notices when bot open_id is unavailable", async () => {
    const turn = await resolveDriveCommentEventTurn({
      cfg: buildMonitorConfig(),
      accountId: "default",
      event: makeDriveCommentEvent(),
      botOpenId: undefined,
      createClient: () => makeOpenApiClient({}) as never,
    });

    expect(turn).toBeNull();
  });
});

describe("drive.notice.comment_add_v1 monitor handler", () => {
  beforeEach(() => {
    handlers = {};
    handleFeishuCommentEventMock.mockClear();
    createEventDispatcherMock.mockReset();
    createFeishuClientMock.mockReset().mockReturnValue(makeOpenApiClient({}) as never);
    createFeishuThreadBindingManagerMock.mockReset().mockImplementation(() => ({
      stop: vi.fn(),
    }));
    vi.spyOn(dedup, "tryBeginFeishuMessageProcessing").mockReturnValue(true);
    vi.spyOn(dedup, "recordProcessedFeishuMessage").mockResolvedValue(true);
    vi.spyOn(dedup, "hasProcessedFeishuMessage").mockResolvedValue(false);
    setFeishuRuntime(
      createPluginRuntimeMock({
        channel: {
          debounce: {
            resolveInboundDebounceMs,
            createInboundDebouncer,
          },
          text: {
            hasControlCommand,
          },
        },
      }),
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("dispatches comment notices through handleFeishuCommentEvent", async () => {
    const onComment = await setupCommentMonitorHandler();

    await onComment(makeDriveCommentEvent());

    expect(handleFeishuCommentEventMock).toHaveBeenCalledTimes(1);
    expect(handleFeishuCommentEventMock).toHaveBeenCalledWith(
      expect.objectContaining({
        accountId: "default",
        botOpenId: "ou_bot",
        event: expect.objectContaining({
          event_id: "10d9d60b990db39f96a4c2fd357fb877",
          comment_id: "7623358762119646411",
        }),
      }),
    );
  });

  it("drops duplicate comment events before dispatch", async () => {
    vi.spyOn(dedup, "hasProcessedFeishuMessage").mockResolvedValue(true);
    const onComment = await setupCommentMonitorHandler();

    await onComment(makeDriveCommentEvent());

    expect(handleFeishuCommentEventMock).not.toHaveBeenCalled();
  });
});
