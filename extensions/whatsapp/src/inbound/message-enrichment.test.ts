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

function enrich(mimetype: string, fileName = "upload.bin") {
  return enrichWhatsAppInboundMessage({
    msg: {
      key: { id: "doc-1", remoteJid: "15550001111@s.whatsapp.net", fromMe: false },
      message: { documentMessage: { mimetype, fileName, caption: "what is this?" } },
    } as WAMessage,
    sock: { updateMediaMessage: vi.fn(), logger: {} } as never,
  });
}

describe("enrichWhatsAppInboundMessage document media kind", () => {
  beforeEach(() => {
    downloadMediaMessage.mockReset();
    warn.mockReset();
  });

  it.each([
    [PNG_BYTES, "image/png", "image"],
    [PNG_BYTES, "application/octet-stream", "image"],
    [PDF_BYTES, "application/pdf", "document"],
    [PDF_BYTES, "image/png", "document"],
  ] as const)("classifies %s declared as %s as %s", async (bytes, mimetype, expectedKind) => {
    downloadMediaMessage.mockImplementation(() => Readable.from([bytes]));
    const enriched = await enrich(mimetype);
    expect(downloadMediaMessage).toHaveBeenCalledOnce();
    expect(enriched?.mediaPath).toBeTruthy();
    expect(enriched).toMatchObject({ mediaKind: expectedKind, nativeMedia: { kind: "document" } });
  });

  it.each([
    { name: "TypeError", errorClass: "TypeError" },
    { name: "private-media-download-content", errorClass: "Error" },
  ])("redacts download failure content ($errorClass)", async ({ name, errorClass }) => {
    const marker = "private-media-download-content";
    downloadMediaMessage.mockRejectedValueOnce(Object.assign(new Error(marker), { name }));

    const enriched = await enrich("application/pdf", "upload.pdf");
    expect(enriched?.body).toContain("what is this?");
    expect(enriched?.body).toContain("[whatsapp attachment unavailable]");
    expect(enriched).toMatchObject({ commandBody: "what is this?", mediaPath: undefined });
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
  });
});
