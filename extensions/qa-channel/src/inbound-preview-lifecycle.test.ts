import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { beforeEach, expect, it, vi } from "vitest";
import * as bus from "./bus-client.js";
import { createQaInboundParams, runQaInbound } from "./inbound.test-harness.js";

vi.mock("./bus-client.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./bus-client.js")>()),
  deleteQaBusMessage: vi.fn(),
  editQaBusMessage: vi.fn(),
  sendQaBusMessage: vi.fn(),
}));

vi.mock("openclaw/plugin-sdk/outbound-media", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/outbound-media")>()),
  loadOutboundMediaFromUrl: vi.fn(async () => ({
    buffer: Buffer.from("attachment"),
    kind: "file",
    contentType: "text/plain",
    fileName: "answer.txt",
  })),
}));

beforeEach(() => vi.clearAllMocks());

it.each(["preview", "expanded preview"])("serializes %s and final", async (partialText) => {
  const messages = new Map<string, bus.QaBusMessage>();
  const deleted = new Set<string>();
  const deleteStarted = createDeferred<void>();
  const deleteAcknowledged = createDeferred<void>();
  const liveMessage = (id: string) => {
    const message = messages.get(id);
    if (!message || deleted.has(id)) {
      throw new Error(`message was deleted: ${id}`);
    }
    return message;
  };
  vi.mocked(bus.sendQaBusMessage).mockImplementation(async (params) => {
    const message: bus.QaBusMessage = {
      ...createQaInboundParams().message,
      id: `outbound-${messages.size + 1}`,
      direction: "outbound",
      text: params.text,
      attachments: params.attachments,
      toolCalls: params.toolCalls,
    };
    messages.set(message.id, message);
    return { message };
  });
  vi.mocked(bus.editQaBusMessage).mockImplementation(async ({ messageId, text }) => ({
    message: Object.assign(liveMessage(messageId), { text }),
  }));
  vi.mocked(bus.deleteQaBusMessage).mockImplementation(async ({ messageId }) => {
    const message = liveMessage(messageId);
    deleted.add(messageId);
    deleteStarted.resolve();
    await deleteAcknowledged.promise;
    return { message };
  });

  await runQaInbound(async (assembled) => {
    await assembled.replyOptions?.onPartialReply?.({ text: "preview" });
    await assembled.replyOptions?.onToolStart?.({ phase: "start", name: "read" });
    const media = assembled.delivery.deliver({ mediaUrl: "/tmp/answer.txt" }, { kind: "block" });
    await deleteStarted.promise;
    const partial = assembled.replyOptions?.onPartialReply?.({ text: partialText });
    const final = assembled.delivery.deliver({ text: "final caption" }, { kind: "final" });
    const settled = Promise.allSettled([media, partial, final]);
    try {
      await Promise.resolve(); // Advance callbacks before deletion is acknowledged.
      await Promise.resolve();
      expect(bus.editQaBusMessage).not.toHaveBeenCalled();
    } finally {
      deleteAcknowledged.resolve();
      await settled;
    }
    expect((await settled).map((result) => result.status)).toEqual(Array(3).fill("fulfilled"));
    expect([...messages.values()].filter((message) => !deleted.has(message.id))).toMatchObject([
      {
        text: "",
        attachments: [{ contentBase64: Buffer.from("attachment").toString("base64") }],
      },
      { text: "final caption", toolCalls: [{ name: "read" }] },
    ]);
  });
});
