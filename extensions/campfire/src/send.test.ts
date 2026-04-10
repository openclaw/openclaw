import { afterEach, describe, expect, it, vi } from "vitest";
import {
  _setFetchGuardForTesting,
  chunkCampfireText,
  sendCampfireReply,
  sendCampfireText,
} from "./send.js";

describe("sendCampfireReply", () => {
  afterEach(() => {
    _setFetchGuardForTesting(null);
  });

  it("sends a plain text POST request with bot authorization", async () => {
    const release = vi.fn().mockResolvedValue(undefined);
    const fetchGuardMock = vi.fn().mockResolvedValue({
      response: new Response(null, {
        status: 200,
      }),
      finalUrl: "https://campfire.example.com/rooms/7/key/messages",
      release,
    });
    _setFetchGuardForTesting(fetchGuardMock);

    await sendCampfireReply(
      "https://campfire.example.com/rooms/7/key/messages",
      "Hello world",
      "42-AbCdEf",
    );

    expect(fetchGuardMock).toHaveBeenCalledWith(
      expect.objectContaining({
        url: "https://campfire.example.com/rooms/7/key/messages",
        timeoutMs: 10_000,
        policy: { allowPrivateNetwork: true },
        auditContext: "campfire-reply",
        init: expect.objectContaining({
          method: "POST",
          headers: {
            Authorization: "Bearer 42-AbCdEf",
            "Content-Type": "text/plain; charset=utf-8",
          },
          body: "Hello world",
        }),
      }),
    );
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("omits Authorization header when botKey is empty", async () => {
    const fetchGuardMock = vi.fn().mockResolvedValue({
      response: new Response(null, { status: 200 }),
      finalUrl: "https://campfire.example.com/rooms/7/key/messages",
      release: vi.fn().mockResolvedValue(undefined),
    });
    _setFetchGuardForTesting(fetchGuardMock);

    await sendCampfireReply("https://campfire.example.com/rooms/7/key/messages", "Hello world");

    const headers = fetchGuardMock.mock.calls[0]?.[0]?.init?.headers as Record<string, string>;
    expect(headers.Authorization).toBeUndefined();
    expect(headers["Content-Type"]).toBe("text/plain; charset=utf-8");
  });

  it("throws when Campfire rejects the message", async () => {
    const release = vi.fn().mockResolvedValue(undefined);
    const fetchGuardMock = vi.fn().mockResolvedValue({
      response: new Response("no", {
        status: 403,
        statusText: "Forbidden",
      }),
      finalUrl: "https://campfire.example.com/rooms/7/key/messages",
      release,
    });
    _setFetchGuardForTesting(fetchGuardMock);

    await expect(
      sendCampfireReply("https://campfire.example.com/rooms/7/key/messages", "Hello world"),
    ).rejects.toThrow("Campfire reply failed: 403 Forbidden");

    expect(release).toHaveBeenCalledTimes(1);
  });
});

describe("chunkCampfireText", () => {
  it("returns a single chunk for text within the limit", () => {
    expect(chunkCampfireText("hello", 10)).toEqual(["hello"]);
  });

  it("returns an empty-string chunk for empty input", () => {
    expect(chunkCampfireText("")).toEqual([""]);
  });

  it("falls back to chunk size 1 for non-positive limits", () => {
    expect(chunkCampfireText("abc", 0)).toEqual(["a", "b", "c"]);
    expect(chunkCampfireText("ab", -5)).toEqual(["a", "b"]);
  });

  it("falls back to chunk size 1 for non-finite limits", () => {
    expect(chunkCampfireText("ab", Number.NaN)).toEqual(["a", "b"]);
    expect(chunkCampfireText("ab", Number.POSITIVE_INFINITY)).toEqual(["a", "b"]);
  });

  it("floors fractional chunk limits", () => {
    expect(chunkCampfireText("abcde", 2.9)).toEqual(["ab", "cd", "e"]);
  });
});

describe("sendCampfireText", () => {
  afterEach(() => {
    _setFetchGuardForTesting(null);
  });

  it("sends long replies in deterministic chunks", async () => {
    const fetchGuardMock = vi.fn().mockResolvedValue({
      response: new Response(null, {
        status: 200,
      }),
      finalUrl: "https://campfire.example.com/rooms/7/key/messages",
      release: vi.fn().mockResolvedValue(undefined),
    });
    _setFetchGuardForTesting(fetchGuardMock);

    await sendCampfireText(
      "https://campfire.example.com/rooms/7/key/messages",
      "abcdefghij",
      "42-AbCdEf",
      4,
    );

    expect(fetchGuardMock).toHaveBeenCalledTimes(3);
    expect(fetchGuardMock.mock.calls[0]?.[0]?.init).toEqual(
      expect.objectContaining({
        body: "abcd",
      }),
    );
    expect(fetchGuardMock.mock.calls[1]?.[0]?.init).toEqual(
      expect.objectContaining({
        body: "efgh",
      }),
    );
    expect(fetchGuardMock.mock.calls[2]?.[0]?.init).toEqual(
      expect.objectContaining({
        body: "ij",
      }),
    );
  });
});
