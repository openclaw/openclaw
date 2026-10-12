import fs from "node:fs/promises";
import type { webhook } from "@line/bot-sdk";
import { withOpenClawTestState } from "openclaw/plugin-sdk/test-state";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildLineMessageContext } from "./bot-message-context.js";
import { downloadLineMedia } from "./download.js";
import type { ResolvedLineAccount } from "./types.js";

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);
const PDF = Buffer.from("%PDF-1.4\n1 0 obj\n<<>>\nendobj\ntrailer\n<<>>\n%%EOF\n");

const account: ResolvedLineAccount = {
  accountId: "default",
  enabled: true,
  channelAccessToken: "token",
  channelSecret: "secret",
  tokenSource: "config",
  config: {},
};

function fileMessageEvent(fileName: string, size: number): webhook.MessageEvent {
  return {
    type: "message",
    message: { id: "file-1", type: "file", fileName, fileSize: size },
    replyToken: "reply-token",
    timestamp: Date.now(),
    source: { type: "user", userId: "user-1" },
    mode: "active",
    webhookEventId: "evt-file-1",
    deliveryContext: { isRedelivery: false },
  } as webhook.MessageEvent;
}

describe("LINE file message media kind", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it.each([
    {
      label: "a PNG file",
      bytes: PNG,
      fileName: "diagram.png",
      header: "image/png",
      contentType: "image/png",
      kind: "image",
    },
    {
      label: "a PNG file served as octet-stream",
      bytes: PNG,
      fileName: "upload.bin",
      header: "application/octet-stream",
      contentType: "image/png",
      kind: "image",
    },
    {
      label: "a PDF file",
      bytes: PDF,
      fileName: "report.pdf",
      header: "application/pdf",
      contentType: "application/pdf",
      kind: "document",
    },
    {
      label: "PDF bytes mislabeled as an image",
      bytes: PDF,
      fileName: "report.png",
      header: "image/png",
      contentType: "application/pdf",
      kind: "document",
    },
  ])("hands the agent $label as $kind", async (fixture) => {
    await withOpenClawTestState({ label: "line-file-media-kind" }, async (state) => {
      const fetchMock = vi.fn(async (input: RequestInfo | URL) =>
        String(input instanceof Request ? input.url : input).endsWith("/message/file-1/content")
          ? new Response(fixture.bytes, { headers: { "content-type": fixture.header } })
          : new Response("{}", { status: 404 }),
      );
      vi.stubGlobal("fetch", fetchMock);

      const media = await downloadLineMedia("file-1", account.channelAccessToken, 1024, {
        originalFilename: fixture.fileName,
      });
      const context = await buildLineMessageContext({
        event: fileMessageEvent(fixture.fileName, fixture.bytes.length),
        allMedia: [
          { path: media.path, contentType: media.contentType, fileName: fixture.fileName },
        ],
        cfg: { session: { store: state.path("sessions.json") } },
        account,
        commandAuthorized: true,
      });

      expect(await fs.readFile(media.path)).toEqual(fixture.bytes);
      expect(context?.ctxPayload.media).toEqual([
        expect.objectContaining({
          path: media.path,
          contentType: fixture.contentType,
          kind: fixture.kind,
        }),
      ]);
    });
  });
});
