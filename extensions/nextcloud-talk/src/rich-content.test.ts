/**
 * Self-contained tests for rich content parsing logic.
 * These don't import monitor.ts (which depends on openclaw/plugin-sdk).
 * Instead we inline the pure functions to validate the logic.
 */
import { describe, expect, it } from "vitest";

// --- Inline the pure functions under test ---

type RichObjectParam = {
  type: string; id: string; name: string;
  size?: number; path?: string; link?: string;
  mimetype?: string; "preview-available"?: string;
};
type RichContent = { message: string; parameters?: Record<string, RichObjectParam> };

function parseRichContent(content: string): RichContent | null {
  try {
    const parsed = JSON.parse(content);
    if (typeof parsed !== "object" || parsed === null || typeof parsed.message !== "string") return null;
    return parsed as RichContent;
  } catch { return null; }
}

function resolveRichMessageText(message: string, parameters: Record<string, RichObjectParam> | undefined): string {
  if (!parameters) return message;
  return message.replace(/\{([\w-]+)\}/g, (match, key: string) => {
    const param = parameters[key];
    return param?.name ?? match;
  });
}

function extractFileParameters(parameters: Record<string, RichObjectParam> | undefined): RichObjectParam[] {
  if (!parameters) return [];
  return Object.values(parameters).filter((p) => p.type === "file");
}

function processContent(rawContent: string, objectName: string) {
  const richContent = parseRichContent(rawContent);
  let text: string;
  let fileParameters: RichObjectParam[] = [];
  if (richContent) {
    text = resolveRichMessageText(richContent.message, richContent.parameters);
    fileParameters = extractFileParameters(richContent.parameters);
  } else {
    text = rawContent || objectName || "";
  }
  return { text, fileParameters: fileParameters.length > 0 ? fileParameters : undefined };
}

function buildFileDownloadUrl(file: RichObjectParam, baseUrl: string, apiUser: string | undefined): string | undefined {
  if (baseUrl && apiUser && file.path) {
    return `${baseUrl}/remote.php/dav/files/${encodeURIComponent(apiUser)}/${file.path}`;
  }
  return file.link || undefined;
}

// --- Tests ---

describe("parseRichContent", () => {
  it("parses valid rich content JSON", () => {
    const result = parseRichContent(JSON.stringify({ message: "Hello", parameters: {} }));
    expect(result).toEqual({ message: "Hello", parameters: {} });
  });
  it("returns null for non-JSON", () => { expect(parseRichContent("plain text")).toBeNull(); });
  it("returns null for JSON without message", () => { expect(parseRichContent(JSON.stringify({ foo: "bar" }))).toBeNull(); });
  it("returns null for empty string", () => { expect(parseRichContent("")).toBeNull(); });
});

describe("processContent (simulates payloadToInboundMessage)", () => {
  it("normal text message — backward compatible", () => {
    const r = processContent(JSON.stringify({ message: "Hello world", parameters: {} }), "message");
    expect(r.text).toBe("Hello world");
    expect(r.fileParameters).toBeUndefined();
  });

  it("single file share", () => {
    const r = processContent(JSON.stringify({
      message: "{file}",
      parameters: { file: { type: "file", id: "117924", name: "IMG_123.jpg", size: 3145728, path: "Talk/IMG_123.jpg", link: "https://cloud.example.com/f/117924", mimetype: "image/jpeg", "preview-available": "yes" } }
    }), "");
    expect(r.text).toBe("IMG_123.jpg");
    expect(r.fileParameters).toHaveLength(1);
    expect(r.fileParameters![0].mimetype).toBe("image/jpeg");
  });

  it("image share (mimetype image/*)", () => {
    const r = processContent(JSON.stringify({
      message: "{file}",
      parameters: { file: { type: "file", id: "200", name: "screenshot.png", size: 500000, path: "Talk/screenshot.png", link: "https://cloud.example.com/f/200", mimetype: "image/png", "preview-available": "yes" } }
    }), "");
    expect(r.fileParameters![0].mimetype).toBe("image/png");
  });

  it("text AND file attachment", () => {
    const r = processContent(JSON.stringify({
      message: "Check this out {file}",
      parameters: { file: { type: "file", id: "125", name: "document.pdf", size: 524288, path: "Talk/document.pdf", link: "https://cloud.example.com/f/125", mimetype: "application/pdf", "preview-available": "no" } }
    }), "");
    expect(r.text).toBe("Check this out document.pdf");
    expect(r.fileParameters).toHaveLength(1);
  });

  it("malformed JSON — graceful fallback", () => {
    const r = processContent("this is not json", "fallback-name");
    expect(r.text).toBe("this is not json");
    expect(r.fileParameters).toBeUndefined();
  });

  it("empty content falls back to object.name", () => {
    const r = processContent("", "fallback-name");
    expect(r.text).toBe("fallback-name");
  });

  it("multiple file parameters", () => {
    const r = processContent(JSON.stringify({
      message: "{file0} and {file1}",
      parameters: {
        file0: { type: "file", id: "301", name: "photo1.jpg", size: 1000, path: "Talk/photo1.jpg", link: "https://cloud.example.com/f/301", mimetype: "image/jpeg" },
        file1: { type: "file", id: "302", name: "photo2.jpg", size: 2000, path: "Talk/photo2.jpg", link: "https://cloud.example.com/f/302", mimetype: "image/jpeg" }
      }
    }), "");
    expect(r.text).toBe("photo1.jpg and photo2.jpg");
    expect(r.fileParameters).toHaveLength(2);
  });

  it("empty parameters — normal text", () => {
    const r = processContent(JSON.stringify({ message: "Just text", parameters: {} }), "");
    expect(r.text).toBe("Just text");
    expect(r.fileParameters).toBeUndefined();
  });

  it("non-file parameter types (mentions) — no fileParameters", () => {
    const r = processContent(JSON.stringify({
      message: "Hello {mention-user1}",
      parameters: { "mention-user1": { type: "user", id: "alice", name: "Alice" } }
    }), "");
    expect(r.text).toBe("Hello Alice");
    expect(r.fileParameters).toBeUndefined();
  });
});

describe("real-world NC Talk payloads", () => {
  it("handles actual file+mention message from our NC Talk (msg 5862)", () => {
    // Real-world style payload with file + mention parameters
    const r = processContent(JSON.stringify({
      message: "{mention-user1} check out this shared file.",
      parameters: {
        actor: { type: "user", id: "alice", name: "Alice", "mention-id": "alice" },
        file: { type: "file", id: "12345", name: "shared-photo.jpg", size: "2000000", path: "Talk/shared-photo.jpg", link: "https://cloud.example.com/index.php/f/122459", mimetype: "image/jpeg", "preview-available": "yes", width: "3024", height: "4032" },
        "mention-user1": { type: "user", id: "bot-user", name: "Bot", "mention-id": "bot-user" }
      }
    }), "");
    expect(r.text).toBe("Bot check out this shared file.");
    expect(r.fileParameters).toHaveLength(1);
    expect(r.fileParameters![0].name).toBe("shared-photo.jpg");
    expect(r.fileParameters![0].mimetype).toBe("image/jpeg");
    expect(r.fileParameters![0].path).toBe("Talk/shared-photo.jpg");
  });

  it("constructs correct WebDAV URL for real file", () => {
    const url = buildFileDownloadUrl(
      { type: "file", id: "12345", name: "shared-photo.jpg", path: "Talk/shared-photo.jpg", link: "https://cloud.example.com/index.php/f/122459", mimetype: "image/jpeg" },
      "https://cloud.example.com",
      "bot-user"
    );
    expect(url).toBe("https://cloud.example.com/remote.php/dav/files/bot-user/Talk/shared-photo.jpg");
  });
});

describe("buildFileDownloadUrl", () => {
  it("constructs WebDAV URL when baseUrl + apiUser + path available", () => {
    const url = buildFileDownloadUrl({ type: "file", id: "1", name: "test.jpg", path: "Talk/test.jpg" }, "https://cloud.example.com", "bot-user");
    expect(url).toBe("https://cloud.example.com/remote.php/dav/files/bot-user/Talk/test.jpg");
  });

  it("falls back to link when apiUser missing", () => {
    const url = buildFileDownloadUrl({ type: "file", id: "1", name: "test.jpg", path: "Talk/test.jpg", link: "https://cloud.example.com/f/1" }, "https://cloud.example.com", undefined);
    expect(url).toBe("https://cloud.example.com/f/1");
  });

  it("returns undefined when no path, no link", () => {
    const url = buildFileDownloadUrl({ type: "file", id: "1", name: "test.jpg" }, "", undefined);
    expect(url).toBeUndefined();
  });
});
