import { createReplyDispatcher } from "openclaw/plugin-sdk/reply-runtime";
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import { createFeishuReplyDispatcher } from "./reply-dispatcher.js";
import { installReplyRuntime } from "./reply-dispatcher.test-support.js";
import { getFeishuRuntime } from "./runtime.js";

const { createMessage, uploadImage } = vi.hoisted(() => ({
  createMessage:
    vi.fn<(request: { data: { msg_type: string; content: string } }) => Promise<unknown>>(),
  uploadImage: vi.fn(),
}));
vi.mock("./client.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./client.js")>()),
  createFeishuClient: () => ({
    im: { message: { create: createMessage }, image: { create: uploadImage } },
  }),
}));

let restoreRuntime: () => void;
beforeAll(() => {
  restoreRuntime = installReplyRuntime();
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
});
afterAll(() => {
  restoreRuntime();
  vi.doUnmock("./client.js");
  vi.resetModules();
});

it.each(["off", "partial"] as const)(
  "delivers caption and image with block streaming disabled and previews %s",
  async (mode) => {
    createMessage.mockImplementation(async ({ data }) => ({
      code: 0,
      data: { message_id: `om_${data.msg_type}` },
    }));
    uploadImage.mockResolvedValue({ code: 0, data: { image_key: "img_chart" } });
    vi.spyOn(getFeishuRuntime().media, "loadWebMedia").mockResolvedValue({
      kind: "image",
      buffer: Buffer.from(
        "89504e470d0a1a0a0000000d4948445200000001000000010802000000907753de",
        "hex",
      ),
      fileName: "chart.png",
      contentType: "image/png",
    });
    const plan = createFeishuReplyDispatcher({
      cfg: {
        channels: {
          feishu: {
            appId: "test-app",
            appSecret: "test-secret",
            renderMode: "auto",
            streaming: { mode, block: { enabled: false } },
          },
        },
      },
      agentId: "agent",
      chatId: "oc_chat",
      sendTarget: "oc_chat",
      runtime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() },
    });
    const dispatcher = createReplyDispatcher({ ...plan.dispatcherOptions, ...plan.delivery });
    dispatcher.sendBlockReply({ text: "Chart ready", mediaUrl: "https://example.com/chart.png" });
    dispatcher.markComplete();
    const receipt = await dispatcher.waitForIdle();

    expect(createMessage.mock.calls.map(([request]) => request.data.msg_type)).toEqual([
      "post",
      "image",
    ]);
    expect(JSON.parse(createMessage.mock.calls[0]![0].data.content)).toEqual({
      zh_cn: { content: [[{ tag: "md", text: "Chart ready" }]] },
    });
    expect(JSON.parse(createMessage.mock.calls[1]![0].data.content)).toEqual({
      image_key: "img_chart",
    });
    expect(uploadImage).toHaveBeenCalledOnce();
    expect(receipt).toMatchObject({
      anyVisibleDelivered: true,
      counts: { block: { delivered: 1 } },
    });
    await expect(plan.ensureNoVisibleReplyFallback("completed")).resolves.toBe(false);
    expect(createMessage).toHaveBeenCalledTimes(2);
  },
);
