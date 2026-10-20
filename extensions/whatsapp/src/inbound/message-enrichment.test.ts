import { Readable } from "node:stream";
import type { WAMessage } from "baileys";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { enrichWhatsAppInboundMessage } from "./message-enrichment.js";

const downloadMediaMessage = vi.hoisted(() => vi.fn());
const warn = vi.hoisted(() => vi.fn());

vi.mock("openclaw/plugin-sdk/logging-core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/logging-core")>()),
  createSubsystemLogger: () => ({ child: () => ({ warn }) }),
}));

vi.mock("./runtime-api.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./runtime-api.js")>()),
  downloadMediaMessage,
}));

const PNG_BYTES = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);
const PDF_BYTES = Buffer.from("%PDF-1.4\n1 0 obj\n<<>>\nendobj\ntrailer\n<<>>\n%%EOF\n");

function documentMessage(params: { mimetype: string; fileName: string }): WAMessage {
  return {
    key: { id: "doc-1", remoteJid: "15550001111@s.whatsapp.net", fromMe: false },
    message: { documentMessage: { ...params, caption: "what is this?" } },
  } as WAMessage;
}

async function enrich(message: WAMessage) {
  return await enrichWhatsAppInboundMessage({
    msg: message,
    sock: { updateMediaMessage: vi.fn(), logger: {} } as never,
  });
}

describe("enrichWhatsAppInboundMessage document media kind", () => {
  beforeEach(() => {
    downloadMediaMessage.mockReset();
    warn.mockReset();
  });

  it.each([
    { name: "PNG bytes", bytes: PNG_BYTES, mimetype: "image/png", expectedKind: "image" },
    {
      name: "PNG bytes without a declared image type",
      bytes: PNG_BYTES,
      mimetype: "application/octet-stream",
      expectedKind: "image",
    },
    { name: "PDF bytes", bytes: PDF_BYTES, mimetype: "application/pdf", expectedKind: "document" },
    {
      name: "PDF bytes declared as an image",
      bytes: PDF_BYTES,
      mimetype: "image/png",
      expectedKind: "document",
    },
  ])("classifies a document carrying $name as $expectedKind", async (params) => {
    downloadMediaMessage.mockImplementation(() => Readable.from([params.bytes]));

    const enriched = await enrich(
      documentMessage({ mimetype: params.mimetype, fileName: "upload.bin" }),
    );

    expect(downloadMediaMessage).toHaveBeenCalledOnce();
    expect(enriched?.mediaPath).toBeTruthy();
    expect(enriched?.mediaKind).toBe(params.expectedKind);
    expect(enriched?.nativeMedia?.kind).toBe("document");
  });

  it.each([
    { name: "TypeError", errorClass: "TypeError" },
    { name: "private-media-download-content", errorClass: "Error" },
  ])(
    "keeps attachment failure category $errorClass without logging download content",
    async ({ name, errorClass }) => {
      const marker = "private-media-download-content";
      downloadMediaMessage.mockRejectedValueOnce(Object.assign(new Error(marker), { name }));

      const enriched = await enrich(
        documentMessage({ mimetype: "application/pdf", fileName: "upload.pdf" }),
      );

      expect(enriched?.body).toContain("what is this?");
      expect(enriched?.body).toContain("[whatsapp attachment unavailable]");
      expect(enriched?.commandBody).toBe("what is this?");
      expect(enriched?.mediaPath).toBeUndefined();
      expect(warn).toHaveBeenCalledExactlyOnceWith(
        "WhatsApp inbound media materialization failed",
        expect.objectContaining({
          failureStage: "direct",
          errorClass,
          mediaKind: "document",
          messageId: "doc-1",
        }),
      );
      expect(JSON.stringify(warn.mock.calls)).not.toContain(marker);
    },
  );
});
