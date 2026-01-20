import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

import { downloadBlueBubblesAttachment } from "./attachments.js";
import type { BlueBubblesAttachment } from "./types.js";

vi.mock("./accounts.js", () => ({
  resolveBlueBubblesAccount: vi.fn(({ cfg, accountId }) => {
    const config = cfg?.channels?.bluebubbles ?? {};
    return {
      accountId: accountId ?? "default",
      enabled: config.enabled !== false,
      configured: Boolean(config.serverUrl && config.password),
      config,
    };
  }),
}));

const mockFetch = vi.fn();

describe("downloadBlueBubblesAttachment", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", mockFetch);
    mockFetch.mockReset();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("throws when guid is missing", async () => {
    const attachment: BlueBubblesAttachment = {};
    await expect(
      downloadBlueBubblesAttachment(attachment, {
        serverUrl: "http://localhost:1234",
        password: "test-password",
      }),
    ).rejects.toThrow("guid is required");
  });

  it("throws when guid is empty string", async () => {
    const attachment: BlueBubblesAttachment = { guid: "  " };
    await expect(
      downloadBlueBubblesAttachment(attachment, {
        serverUrl: "http://localhost:1234",
        password: "test-password",
      }),
    ).rejects.toThrow("guid is required");
  });

  it("throws when serverUrl is missing", async () => {
    const attachment: BlueBubblesAttachment = { guid: "att-123" };
    await expect(downloadBlueBubblesAttachment(attachment, {})).rejects.toThrow(
      "serverUrl is required",
    );
  });

  it("throws when password is missing", async () => {
    const attachment: BlueBubblesAttachment = { guid: "att-123" };
    await expect(
      downloadBlueBubblesAttachment(attachment, {
        serverUrl: "http://localhost:1234",
      }),
    ).rejects.toThrow("password is required");
  });

  it("downloads attachment successfully", async () => {
    const mockBuffer = new Uint8Array([1, 2, 3, 4]);
    mockFetch.mockResolvedValueOnce({
      ok: true,
      headers: new Headers({ "content-type": "image/png" }),
      arrayBuffer: () => Promise.resolve(mockBuffer.buffer),
    });

    const attachment: BlueBubblesAttachment = { guid: "att-123" };
    const result = await downloadBlueBubblesAttachment(attachment, {
      serverUrl: "http://localhost:1234",
      password: "test-password",
    });

    expect(result.buffer).toEqual(mockBuffer);
    expect(result.contentType).toBe("image/png");
    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining("/api/v1/attachment/att-123/download"),
      expect.objectContaining({ method: "GET" }),
    );
  });

  it("includes password in URL query", async () => {
    const mockBuffer = new Uint8Array([1, 2, 3, 4]);
    mockFetch.mockResolvedValueOnce({
      ok: true,
      headers: new Headers({ "content-type": "image/jpeg" }),
      arrayBuffer: () => Promise.resolve(mockBuffer.buffer),
    });

    const attachment: BlueBubblesAttachment = { guid: "att-456" };
    await downloadBlueBubblesAttachment(attachment, {
      serverUrl: "http://localhost:1234",
      password: "my-secret-password",
    });

    const calledUrl = mockFetch.mock.calls[0][0] as string;
    expect(calledUrl).toContain("password=my-secret-password");
  });

  it("encodes guid in URL", async () => {
    const mockBuffer = new Uint8Array([1]);
    mockFetch.mockResolvedValueOnce({
      ok: true,
      headers: new Headers(),
      arrayBuffer: () => Promise.resolve(mockBuffer.buffer),
    });

    const attachment: BlueBubblesAttachment = { guid: "att/with/special chars" };
    await downloadBlueBubblesAttachment(attachment, {
      serverUrl: "http://localhost:1234",
      password: "test",
    });

    const calledUrl = mockFetch.mock.calls[0][0] as string;
    expect(calledUrl).toContain("att%2Fwith%2Fspecial%20chars");
  });

  it("throws on non-ok response", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 404,
      text: () => Promise.resolve("Attachment not found"),
    });

    const attachment: BlueBubblesAttachment = { guid: "att-missing" };
    await expect(
      downloadBlueBubblesAttachment(attachment, {
        serverUrl: "http://localhost:1234",
        password: "test",
      }),
    ).rejects.toThrow("download failed (404): Attachment not found");
  });

  it("throws when attachment exceeds max bytes", async () => {
    const largeBuffer = new Uint8Array(10 * 1024 * 1024);
    mockFetch.mockResolvedValueOnce({
      ok: true,
      headers: new Headers(),
      arrayBuffer: () => Promise.resolve(largeBuffer.buffer),
    });

    const attachment: BlueBubblesAttachment = { guid: "att-large" };
    await expect(
      downloadBlueBubblesAttachment(attachment, {
        serverUrl: "http://localhost:1234",
        password: "test",
        maxBytes: 5 * 1024 * 1024,
      }),
    ).rejects.toThrow("too large");
  });

  it("uses default max bytes when not specified", async () => {
    const largeBuffer = new Uint8Array(9 * 1024 * 1024);
    mockFetch.mockResolvedValueOnce({
      ok: true,
      headers: new Headers(),
      arrayBuffer: () => Promise.resolve(largeBuffer.buffer),
    });

    const attachment: BlueBubblesAttachment = { guid: "att-large" };
    await expect(
      downloadBlueBubblesAttachment(attachment, {
        serverUrl: "http://localhost:1234",
        password: "test",
      }),
    ).rejects.toThrow("too large");
  });

  it("uses attachment mimeType as fallback when response has no content-type", async () => {
    const mockBuffer = new Uint8Array([1, 2, 3]);
    mockFetch.mockResolvedValueOnce({
      ok: true,
      headers: new Headers(),
      arrayBuffer: () => Promise.resolve(mockBuffer.buffer),
    });

    const attachment: BlueBubblesAttachment = {
      guid: "att-789",
      mimeType: "video/mp4",
    };
    const result = await downloadBlueBubblesAttachment(attachment, {
      serverUrl: "http://localhost:1234",
      password: "test",
    });

    expect(result.contentType).toBe("video/mp4");
  });

  it("prefers response content-type over attachment mimeType", async () => {
    const mockBuffer = new Uint8Array([1, 2, 3]);
    mockFetch.mockResolvedValueOnce({
      ok: true,
      headers: new Headers({ "content-type": "image/webp" }),
      arrayBuffer: () => Promise.resolve(mockBuffer.buffer),
    });

    const attachment: BlueBubblesAttachment = {
      guid: "att-xyz",
      mimeType: "image/png",
    };
    const result = await downloadBlueBubblesAttachment(attachment, {
      serverUrl: "http://localhost:1234",
      password: "test",
    });

    expect(result.contentType).toBe("image/webp");
  });

  it("resolves credentials from config when opts not provided", async () => {
    const mockBuffer = new Uint8Array([1]);
    mockFetch.mockResolvedValueOnce({
      ok: true,
      headers: new Headers(),
      arrayBuffer: () => Promise.resolve(mockBuffer.buffer),
    });

    const attachment: BlueBubblesAttachment = { guid: "att-config" };
    const result = await downloadBlueBubblesAttachment(attachment, {
      cfg: {
        channels: {
          bluebubbles: {
            serverUrl: "http://config-server:5678",
            password: "config-password",
          },
        },
      },
    });

    const calledUrl = mockFetch.mock.calls[0][0] as string;
    expect(calledUrl).toContain("config-server:5678");
    expect(calledUrl).toContain("password=config-password");
    expect(result.buffer).toEqual(new Uint8Array([1]));
  });
});
