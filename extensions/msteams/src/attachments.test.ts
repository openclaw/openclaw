import { createRequire } from "node:module";
import {
  CONTENT_TYPE_APPLICATION_JSON,
  CONTENT_TYPE_APPLICATION_PDF,
} from "openclaw/plugin-sdk/provider-http";
import {
  downloadAttachmentsWithFetch,
  isGraphShareUrl,
  resolveGraphShareUrlFromAttachment,
} from "./attachments.js";
import {
  createMockAttachment,
  createOkFetchMock,
  expectAttachmentMediaLength,
  GRAPH_SHARES_URL_PREFIX,
} from "./test-helpers.js";

const nodeRequire = createRequire(import.meta.url);
const PDF_BUFFER = Buffer.from("fake-pdf-content");
const SAVED_PDF_PATH = "/tmp/saved.pdf";

const detectMimeMock = vi.fn();
const saveMediaBufferMock = vi.fn();

vi.mock("openclaw/plugin-sdk/media-understanding", () => ({
  detectMimeFromBuffer: detectMimeMock,
}));

vi.mock("./attachments.js", async (importOriginal) => {
  const actual = (await importOriginal()) as any;
  return {
    ...actual,
    saveMediaBuffer: saveMediaBufferMock,
  };
});

function createPdfAttachments(url: string) {
  return [
    createMockAttachment({
      contentType: CONTENT_TYPE_APPLICATION_PDF,
      contentUrl: url,
      name: "test.pdf",
    }),
  ];
}

describe("msteams attachments", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("isGraphShareUrl", () => {
    it("identifies graph share URLs", () => {
      expect(isGraphShareUrl(`${GRAPH_SHARES_URL_PREFIX}/123`)).toBe(true);
      expect(isGraphShareUrl("https://example.com/123")).toBe(false);
    });
  });

  describe("resolveGraphShareUrlFromAttachment", () => {
    it("resolves graph share URL from attachment with downloadUrl", () => {
      const downloadUrl = `${GRAPH_SHARES_URL_PREFIX}/abc`;
      const attachment = createMockAttachment({
        content: { downloadUrl },
      });
      expect(resolveGraphShareUrlFromAttachment(attachment)).toBe(downloadUrl);
    });

    it("returns null if no graph share URL is found", () => {
      const attachment = createMockAttachment({
        contentUrl: "https://example.com/123",
      });
      expect(resolveGraphShareUrlFromAttachment(attachment)).toBeNull();
    });
  });

  describe("downloadAttachmentsWithFetch", () => {
    describe("when contentUrl is a graph share URL", () => {
      it("fetches the share URL directly", async () => {
        const shareUrl = `${GRAPH_SHARES_URL_PREFIX}/xyz`;
        const fetchMock = createOkFetchMock(CONTENT_TYPE_APPLICATION_PDF, "pdf");
        detectMimeMock.mockResolvedValueOnce(CONTENT_TYPE_APPLICATION_PDF);
        saveMediaBufferMock.mockResolvedValueOnce({
          id: "saved.pdf",
          path: SAVED_PDF_PATH,
          size: Buffer.byteLength(PDF_BUFFER),
          contentType: CONTENT_TYPE_APPLICATION_PDF,
        });

        const media = await downloadAttachmentsWithFetch(
          createPdfAttachments(shareUrl),
          fetchMock,
        );

        expectAttachmentMediaLength(media, 1);
        expect(media[0]?.path).toBe(SAVED_PDF_PATH);
        // The only host that should be fetched is graph.microsoft.com.
        const calledUrls = (fetchMock.mock.calls as Array<[RequestInfo | URL, RequestInit?]>).map(
          ([input]) => (typeof input === "string" ? input : String(input)),
        );
        expect(calledUrls.length).toBeGreaterThan(0);
        for (const url of calledUrls) {
          expect(url.startsWith(GRAPH_SHARES_URL_PREFIX)).toBe(true);
        }
      });
    });

    describe("when contentUrl is NOT a graph share URL", () => {
      it("fetches the contentUrl directly", async () => {
        const directUrl = "https://example.com/files/test.pdf";
        const fetchMock = createOkFetchMock(CONTENT_TYPE_APPLICATION_PDF, "pdf");
        detectMimeMock.mockResolvedValueOnce(CONTENT_TYPE_APPLICATION_PDF);
        saveMediaBufferMock.mockResolvedValueOnce({
          id: "saved.pdf",
          path: SAVED_PDF_PATH,
          size: Buffer.byteLength(PDF_BUFFER),
          contentType: CONTENT_TYPE_APPLICATION_PDF,
        });

        const media = await downloadAttachmentsWithFetch(
          createPdfAttachments(directUrl),
          fetchMock,
        );

        expectAttachmentMediaLength(media, 1);
        const calledUrls = (fetchMock.mock.calls as unknown[]).map((call) => {
          const input = (call as [RequestInfo | URL])[0];
          return typeof input === "string" ? input : String(input);
        });
        // Should have hit the original host, NOT graph shares.
        expect(calledUrls.some((url) => url === directUrl)).toBe(true);
        expect(calledUrls.some((url) => url.startsWith(GRAPH_SHARES_URL_PREFIX))).toBe(false);
      });
    });
  });
});
