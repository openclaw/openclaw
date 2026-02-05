/**
 * Tests for media upload and download API.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { uploadMedia, downloadMedia } from "./media.js";
import { clearAllTokens } from "./token-manager.js";
import { BASIC_ACCOUNT } from "../../test/fixtures/configs.js";

describe("uploadMedia", () => {
  beforeEach(() => {
    clearAllTokens();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("uploads file and returns mediaId", async () => {
    const mockFetch = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ accessToken: "test-token", expireIn: 7200 }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ mediaId: "uploaded-media-123" }),
      });
    vi.stubGlobal("fetch", mockFetch);

    const result = await uploadMedia({
      account: BASIC_ACCOUNT,
      file: Buffer.from("test file content"),
      fileName: "test.pdf",
    });

    expect(result.ok).toBe(true);
    expect(result.mediaId).toBe("uploaded-media-123");

    const uploadCall = mockFetch.mock.calls[1];
    expect(uploadCall[0]).toContain("/robot/messageFiles/upload");
  });

  it("returns error when token fetch fails", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      text: () => Promise.resolve("Invalid credentials"),
    });
    vi.stubGlobal("fetch", mockFetch);

    const result = await uploadMedia({
      account: BASIC_ACCOUNT,
      file: Buffer.from("test"),
      fileName: "test.pdf",
    });

    expect(result.ok).toBe(false);
    expect(result.error).toBeDefined();
  });

  it("returns error when upload fails", async () => {
    const mockFetch = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ accessToken: "test-token", expireIn: 7200 }),
      })
      .mockResolvedValueOnce({
        ok: false,
        status: 400,
        text: () => Promise.resolve("Invalid file"),
      });
    vi.stubGlobal("fetch", mockFetch);

    const result = await uploadMedia({
      account: BASIC_ACCOUNT,
      file: Buffer.from("test"),
      fileName: "test.pdf",
    });

    expect(result.ok).toBe(false);
    expect(result.error?.message).toContain("400");
  });

  it("handles fetch exception", async () => {
    const mockFetch = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ accessToken: "test-token", expireIn: 7200 }),
      })
      .mockRejectedValueOnce(new Error("Network error"));
    vi.stubGlobal("fetch", mockFetch);

    const result = await uploadMedia({
      account: BASIC_ACCOUNT,
      file: Buffer.from("test"),
      fileName: "test.pdf",
    });

    expect(result.ok).toBe(false);
    expect(result.error?.message).toBe("Network error");
  });
});

describe("downloadMedia", () => {
  beforeEach(() => {
    clearAllTokens();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("downloads file and returns URL", async () => {
    const mockFetch = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ accessToken: "test-token", expireIn: 7200 }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ downloadUrl: "https://cdn.dingtalk.com/file/xyz" }),
      });
    vi.stubGlobal("fetch", mockFetch);

    const result = await downloadMedia({
      account: BASIC_ACCOUNT,
      downloadCode: "abc123code",
    });

    expect(result.ok).toBe(true);
    expect(result.url).toBe("https://cdn.dingtalk.com/file/xyz");

    const downloadCall = mockFetch.mock.calls[1];
    expect(downloadCall[0]).toContain("/robot/messageFiles/download");
    const body = JSON.parse(downloadCall[1].body);
    expect(body.downloadCode).toBe("abc123code");
    expect(body.robotCode).toBe(BASIC_ACCOUNT.clientId);
  });

  it("returns error when token fetch fails", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      text: () => Promise.resolve("Invalid credentials"),
    });
    vi.stubGlobal("fetch", mockFetch);

    const result = await downloadMedia({
      account: BASIC_ACCOUNT,
      downloadCode: "abc123",
    });

    expect(result.ok).toBe(false);
    expect(result.error).toBeDefined();
  });

  it("returns error when download fails", async () => {
    const mockFetch = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ accessToken: "test-token", expireIn: 7200 }),
      })
      .mockResolvedValueOnce({
        ok: false,
        status: 404,
        text: () => Promise.resolve("File not found"),
      });
    vi.stubGlobal("fetch", mockFetch);

    const result = await downloadMedia({
      account: BASIC_ACCOUNT,
      downloadCode: "invalid-code",
    });

    expect(result.ok).toBe(false);
    expect(result.error?.message).toContain("404");
  });

  it("handles fetch exception", async () => {
    const mockFetch = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ accessToken: "test-token", expireIn: 7200 }),
      })
      .mockRejectedValueOnce(new Error("Connection timeout"));
    vi.stubGlobal("fetch", mockFetch);

    const result = await downloadMedia({
      account: BASIC_ACCOUNT,
      downloadCode: "abc123",
    });

    expect(result.ok).toBe(false);
    expect(result.error?.message).toBe("Connection timeout");
  });
});
