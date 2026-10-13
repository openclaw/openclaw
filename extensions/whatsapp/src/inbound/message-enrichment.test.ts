import { Readable } from "node:stream";
import type { WAMessage } from "baileys";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { enrichWhatsAppInboundMessage } from "./message-enrichment.js";

const downloadMediaMessage = vi.hoisted(() => vi.fn());

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
    logVerbose: () => {},
  });
}

describe("enrichWhatsAppInboundMessage document media kind", () => {
  beforeEach(() => {
    downloadMediaMessage.mockReset();
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
});
