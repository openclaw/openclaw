import { afterEach, describe, expect, it, vi } from "vitest";
import { sendCampfireReply, sendCampfireText } from "./send.js";

describe("sendCampfireReply", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("sends a plain text POST request with bot authorization", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(null, {
        status: 200,
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await sendCampfireReply(
      "https://campfire.example.com/rooms/7/key/messages",
      "Hello world",
      "42-AbCdEf",
    );

    expect(fetchMock).toHaveBeenCalledWith(
      "https://campfire.example.com/rooms/7/key/messages",
      expect.objectContaining({
        method: "POST",
        headers: {
          Authorization: "Bearer 42-AbCdEf",
          "Content-Type": "text/plain; charset=utf-8",
        },
        body: "Hello world",
      }),
    );
  });

  it("throws when Campfire rejects the message", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response("no", {
        status: 403,
        statusText: "Forbidden",
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      sendCampfireReply("https://campfire.example.com/rooms/7/key/messages", "Hello world"),
    ).rejects.toThrow("Campfire reply failed: 403 Forbidden");
  });
});

describe("sendCampfireText", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("sends long replies in deterministic chunks", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(null, {
        status: 200,
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await sendCampfireText(
      "https://campfire.example.com/rooms/7/key/messages",
      "abcdefghij",
      "42-AbCdEf",
      4,
    );

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock.mock.calls[0]?.[1]).toEqual(
      expect.objectContaining({
        body: "abcd",
      }),
    );
    expect(fetchMock.mock.calls[1]?.[1]).toEqual(
      expect.objectContaining({
        body: "efgh",
      }),
    );
    expect(fetchMock.mock.calls[2]?.[1]).toEqual(
      expect.objectContaining({
        body: "ij",
      }),
    );
  });
});
