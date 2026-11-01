import "./outbound.tables.test-support.js";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { ClawdbotConfig } from "../runtime-api.js";
import { feishuOutbound } from "./outbound.js";

const {
  deliverCommentThreadTextMock,
  installOutboundHarness,
  sendCardFeishuMock,
  sendMediaFeishuMock,
  sendMessageFeishuMock,
} = await import("./outbound.tables.test-support.js");

installOutboundHarness();

describe("feishu outbound cancellation", () => {
  const longText = Array.from(
    { length: 400 },
    (_entry, index) => `Line ${index} of a long outbound reply.`,
  ).join("\n");

  function abortingDelivery() {
    const controller = new AbortController();
    const delivered: string[] = [];
    return {
      controller,
      delivered,
      onDeliveryResult: (result: { messageId?: string }) => {
        delivered.push(result.messageId ?? "");
      },
      abortOnFirst: (mock: ReturnType<typeof vi.fn>, result: Record<string, unknown>) => {
        mock.mockImplementation(() => {
          controller.abort();
          return result;
        });
      },
    };
  }

  function abortName(outcome: unknown): string {
    return outcome instanceof Error ? outcome.name : String(outcome);
  }

  it.each([
    { fanout: "text", to: "chat_1", id: "text_msg" },
    { fanout: "comment thread", to: "comment:docx:doc_token_1:comment_1", id: "reply_1" },
  ])("stops the formatted $fanout fanout at the first abort", async ({ to, id }) => {
    const run = abortingDelivery();
    if (to === "chat_1") {
      run.abortOnFirst(sendMessageFeishuMock, { messageId: id });
    } else {
      run.abortOnFirst(deliverCommentThreadTextMock, {
        delivery_mode: "reply_comment",
        reply_id: id,
      });
    }
    expect(longText.length).toBeGreaterThan(4000);
    const outcome = await feishuOutbound
      .sendFormattedText?.({
        cfg: {} as ClawdbotConfig,
        to,
        text: longText,
        accountId: "main",
        signal: run.controller.signal,
        onDeliveryResult: run.onDeliveryResult,
      } as never)
      .catch((error: unknown) => error);
    expect(
      to === "chat_1" ? sendMessageFeishuMock : deliverCommentThreadTextMock,
    ).toHaveBeenCalledTimes(1);
    expect(abortName(outcome)).toBe("AbortError");
    expect(run.delivered).toEqual([id]);
  });

  it("sends nothing from the early formatted branches once the turn is cancelled", async () => {
    const controller = new AbortController();
    controller.abort();
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-feishu-cancelled-"));
    const imagePath = path.join(dir, "sample.png");
    await fs.writeFile(imagePath, "image-data");
    const nativeCardText = JSON.stringify({
      schema: "2.0",
      body: { elements: [{ tag: "markdown", content: "hello" }] },
    });
    try {
      for (const text of [imagePath, nativeCardText]) {
        const outcome = await feishuOutbound
          .sendFormattedText?.({
            cfg: {} as ClawdbotConfig,
            to: "chat_1",
            text,
            accountId: "main",
            signal: controller.signal,
          } as never)
          .catch((error: unknown) => error);
        expect(abortName(outcome)).toBe("AbortError");
      }
      expect(sendMediaFeishuMock).not.toHaveBeenCalled();
      expect(sendCardFeishuMock).not.toHaveBeenCalled();
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("stops before the attachment when the caption send is aborted", async () => {
    const run = abortingDelivery();
    run.abortOnFirst(sendMessageFeishuMock, { messageId: "text_msg" });
    const outcome = await feishuOutbound
      .sendMedia?.({
        cfg: {} as ClawdbotConfig,
        to: "chat_1",
        text: "Here is the chart.",
        mediaUrl: "https://example.test/chart.png",
        accountId: "main",
        signal: run.controller.signal,
        onDeliveryResult: run.onDeliveryResult,
      } as never)
      .catch((error: unknown) => error);
    expect(sendMessageFeishuMock).toHaveBeenCalledTimes(1);
    expect(sendMediaFeishuMock).not.toHaveBeenCalled();
    expect(abortName(outcome)).toBe("AbortError");
  });
});

describe("feishu outbound delivery formatting", () => {
  const body = Array.from(
    { length: 60 },
    (_entry, index) => `Line ${index} of the answer ${"y".repeat(30)}`,
  ).join("\n");

  it.each([
    { cut: "chat fanout to the delivery limit", to: "chat_1", account: undefined, limit: 1000 },
    {
      cut: "chat fanout to the delivery limit over the account",
      to: "chat_1",
      account: 2000,
      limit: 1000,
    },
    { cut: "chat fanout to the account limit", to: "chat_1", account: 2000, limit: undefined },
    {
      cut: "comment replies to the delivery limit",
      to: "comment:docx:doc_token_1:comment_1",
      account: undefined,
      limit: 1000,
    },
  ])("cuts the $cut", async ({ to, account, limit }) => {
    expect(body.length).toBeGreaterThan(2000);
    expect(body.length).toBeLessThan(4000);
    await feishuOutbound.sendFormattedText?.({
      cfg: (account ? { channels: { feishu: { textChunkLimit: account } } } : {}) as ClawdbotConfig,
      to,
      text: body,
      accountId: "main",
      ...(limit ? { formatting: { textLimit: limit } } : {}),
    } as never);
    const lengths =
      to === "chat_1"
        ? sendMessageFeishuMock.mock.calls.map((call) => String(call[0]?.text ?? "").length)
        : deliverCommentThreadTextMock.mock.calls.map(
            (call) => String(call[1]?.content ?? "").length,
          );
    expect(lengths).toHaveLength(limit ? 4 : 2);
    expect(Math.max(...lengths)).toBeLessThanOrEqual(limit ?? account ?? 4000);
  });
});
