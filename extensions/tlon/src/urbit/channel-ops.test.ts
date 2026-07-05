// Tlon tests cover channel ops plugin behavior.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { scryUrbitPath } from "./channel-ops.js";
import { urbitFetch } from "./fetch.js";

vi.mock("./fetch.js", () => ({
  urbitFetch: vi.fn(),
}));

const scryDeps = {
  baseUrl: "https://example.com",
  cookie: "urbauth-~zod=123",
} as const;

const scryParams = {
  path: "/chat/inbox.json",
  auditContext: "test",
} as const;

function oversizedScryJsonResponse(): {
  response: Response;
  getReadCount: () => number;
  totalChunkCount: number;
} {
  const bodyChunk = Buffer.alloc(64 * 1024, 0x61);
  const chunkCount = (18 * 1024 * 1024) / bodyChunk.length;
  let readCount = 0;
  const response = new Response(
    new ReadableStream({
      pull(controller) {
        if (readCount >= chunkCount) {
          controller.close();
          return;
        }
        readCount += 1;
        controller.enqueue(bodyChunk);
      },
    }),
    {
      status: 200,
      headers: { "content-type": "application/json" },
    },
  );
  return { response, getReadCount: () => readCount, totalChunkCount: chunkCount };
}

describe("Urbit channel operations", () => {
  beforeEach(() => {
    vi.mocked(urbitFetch).mockReset();
  });

  it("parses successful scry JSON responses", async () => {
    const release = vi.fn().mockResolvedValue(undefined);
    vi.mocked(urbitFetch).mockResolvedValue({
      response: Response.json({ inbox: [] }),
      finalUrl: "https://example.com/~/scry/chat/inbox.json",
      release,
    });

    await expect(scryUrbitPath(scryDeps, scryParams)).resolves.toEqual({ inbox: [] });
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("rejects malformed scry response JSON", async () => {
    const release = vi.fn().mockResolvedValue(undefined);
    vi.mocked(urbitFetch).mockResolvedValue({
      response: new Response("{not json", {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
      finalUrl: "https://example.com/~/scry/chat/inbox.json",
      release,
    });

    await expect(scryUrbitPath(scryDeps, scryParams)).rejects.toThrow(
      "Tlon scry response for path /chat/inbox.json: malformed JSON response",
    );
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("bounds oversized scry JSON responses", async () => {
    const release = vi.fn().mockResolvedValue(undefined);
    const streamed = oversizedScryJsonResponse();
    vi.mocked(urbitFetch).mockResolvedValue({
      response: streamed.response,
      finalUrl: "https://example.com/~/scry/chat/inbox.json",
      release,
    });

    await expect(scryUrbitPath(scryDeps, scryParams)).rejects.toThrow(
      "Tlon scry response for path /chat/inbox.json: JSON response exceeds 16777216 bytes",
    );
    expect(streamed.getReadCount()).toBeLessThan(streamed.totalChunkCount);
    expect(release).toHaveBeenCalledTimes(1);
  });
});
