import assert from "node:assert/strict";
import { PlatformMessageNotDispatchedError } from "openclaw/plugin-sdk/error-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { createXApiClient } from "./api.js";
import { createXTestApi, type XFetch } from "./test-support/api-client.js";

type Media = Parameters<ReturnType<typeof createXApiClient>["uploadMedia"]>[0];
function client(fetch: XFetch) {
  return createXTestApi({
    clientSecret: "test-secret",
    refreshToken: "test-refresh",
    fetch: (url, init) =>
      url.endsWith("/oauth2/token")
        ? Promise.resolve(Response.json({ access_token: "test-access" }))
        : fetch(url, init),
  });
}

const mediaResponse = (data: object = { id: "101" }) => Response.json({ data });
const processing = (state: string, check_after_secs?: number, id = "101") => ({
  id,
  processing_info: { state, check_after_secs },
});
const revoked = new PlatformMessageNotDispatchedError("Revoked", {
  cause: undefined,
  retryable: false,
});
const uploadPaths = [
  "/2/media/upload/initialize",
  "/2/media/upload/101/append",
  "/2/media/upload/101/finalize",
];
const uploadThenReply = (
  api: ReturnType<typeof client>,
  media: Media = image,
  text = "Never text-only",
) => api.uploadMedia(media).then((id) => api.reply({ text, inReplyToId: "20", mediaIds: [id] }));

const image = {
  buffer: Buffer.from("synthetic-image-bytes"),
  contentType: "image/png",
  fileName: "image.png",
  mediaCategory: "tweet_image" as const,
};
async function readMedia(request: Request) {
  const form = await request.formData();
  const file = form.get("media");
  assert(file instanceof File, "Expected binary media");
  return { file, index: form.get("segment_index") };
}

function processingFixture(options: {
  media?: Media;
  finalize: object;
  append?: () => Response;
  statuses?: object[];
}) {
  const id = "101",
    media = options.media ?? image;
  const finalized = Promise.withResolvers<void>();
  const calls: string[] = [],
    polls: number[] = [];
  const chunks: { index: FormDataEntryValue | null; bytes: Buffer }[] = [];
  let post: unknown;
  const api = client(async (url, init) => {
    const request = new Request(url, init),
      parsed = new URL(url);
    calls.push(parsed.pathname);
    expect(request.method).toBe(parsed.pathname === "/2/media/upload" ? "GET" : "POST");
    expect(request.headers.get("authorization")).toBe("Bearer test-access");
    if (parsed.pathname.endsWith("/initialize")) {
      expect(await request.json()).toEqual({
        media_type: media.contentType,
        total_bytes: media.buffer.length,
        media_category: media.mediaCategory,
      });
      return mediaResponse({ id });
    }
    if (parsed.pathname.endsWith("/append")) {
      expect(request.headers.get("content-type")).toContain("multipart/form-data; boundary=");
      const { file, index } = await readMedia(request);
      expect(file).toMatchObject({ name: media.fileName, type: media.contentType });
      chunks.push({ index, bytes: Buffer.from(await file.arrayBuffer()) });
      return options.append?.() ?? mediaResponse({ id });
    }
    if (parsed.pathname.endsWith("/finalize")) {
      expect(await request.text()).toBe("");
      finalized.resolve();
      return mediaResponse(options.finalize);
    }
    if (parsed.pathname === "/2/media/upload") {
      expect(Object.fromEntries(parsed.searchParams)).toEqual({ command: "STATUS", media_id: id });
      polls.push(Date.now());
      const states = options.statuses;
      return mediaResponse(
        states?.[Math.min(polls.length - 1, states.length - 1)] ?? options.finalize,
      );
    }
    post = await request.json();
    return mediaResponse({ id: "900" });
  });
  return { api, calls, chunks, polls, finalized: finalized.promise, post: () => post };
}

afterEach(() => vi.useRealTimers());

describe("X native media request boundary", () => {
  it("uploads authenticated video chunks and waits for processing before posting", async () => {
    vi.useFakeTimers();
    const media: Media = {
      buffer: Buffer.concat([Buffer.alloc(4 * 1024 * 1024, 0x41), Buffer.alloc(7, 0x42)]),
      contentType: "video/mp4",
      fileName: "clip.mp4",
      mediaCategory: "tweet_video",
    };
    const test = processingFixture({
      media,
      finalize: processing("pending", 2),
      append: () => new Response(null, { status: 204 }),
      statuses: [processing("in_progress", 3), processing("succeeded")],
    });
    const started = Date.now();
    const pending = uploadThenReply(test.api, media, "Video");
    await test.finalized;
    await vi.advanceTimersByTimeAsync(1999);
    expect(test.polls).toEqual([]);
    expect(test.post()).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    expect(test.polls).toEqual([started + 2000]);
    await vi.advanceTimersByTimeAsync(2999);
    expect(test.post()).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    await expect(pending).resolves.toBe("900");
    expect(test.polls).toEqual([started + 2000, started + 5000]);
    expect(test.chunks.map(({ index, bytes }) => [index, bytes.length])).toEqual([
      ["0", 4194304],
      ["1", 7],
    ]);
    expect(Buffer.concat(test.chunks.map(({ bytes }) => bytes))).toEqual(media.buffer);
    expect(test.post()).toEqual({
      text: "Video",
      reply: { in_reply_to_tweet_id: "20" },
      media: { media_ids: ["101"] },
    });
    expect(await test.api.spend.status()).toMatchObject({ dayUsd: 0.02 });
  });

  it.each([
    [
      "media.write",
      Response.json({ detail: "Denied test-access test-refresh test-secret" }, { status: 403 }),
      false,
      false,
    ],
    ["429", new Response(null, { status: 429, headers: { "Retry-After": "60" } }), true, false],
    ["503", new Response(null, { status: 503 }), true, false],
    ["network request failed", new Error("socket reset"), true, false],
    ["media ID", mediaResponse({}), false, false],
    ["invalid processing state", mediaResponse(processing("unknown")), false, true],
    ["invalid media result", mediaResponse({ id: "102" }), false, true],
    ["timed out", mediaResponse(processing("pending", 3600)), true, true],
  ] as const)(
    "classifies %s as no Post dispatched without retrying the upload",
    async (message, response, retryable, finalize) => {
      const calls: string[] = [];
      const api = client(async (url) => {
        calls.push(new URL(url).pathname);
        if (finalize && !url.endsWith("/finalize")) {
          return mediaResponse();
        }
        if (response instanceof Error) {
          throw response;
        }
        return response.clone();
      });
      const error: unknown = await uploadThenReply(api).catch((cause: unknown) => cause);
      expect(error).toBeInstanceOf(PlatformMessageNotDispatchedError);
      expect(error).toMatchObject({ retryable, message: expect.stringContaining(message) });
      expect(String(error)).not.toMatch(/test-access|test-refresh|test-secret/);
      expect(calls).toEqual(finalize ? uploadPaths : ["/2/media/upload/initialize"]);
      expect(await api.spend.status()).toMatchObject({ dayUsd: 0 });
    },
  );

  it("bounds repeated pending processing responses without shortening X polling delays", async () => {
    vi.useFakeTimers();
    const test = processingFixture({ finalize: processing("pending", 60) });
    const started = Date.now();
    const result = test.api.uploadMedia(image).catch((cause: unknown) => cause);
    await test.finalized;
    await vi.advanceTimersByTimeAsync(300_000);
    expect(await result).toMatchObject({
      code: "OPENCLAW_PLATFORM_MESSAGE_NOT_DISPATCHED",
      retryable: true,
      message: expect.stringContaining("processing timed out"),
    });
    expect(test.polls.map((time) => time - started)).toEqual([60_000, 120_000, 180_000, 240_000]);
  });

  it.each(["caller abort", "revoked authority", "missing processing status"])(
    "stops after %s during the processing wait without posting",
    async (failure) => {
      vi.useFakeTimers();
      const controller = new AbortController();
      let active = true;
      const test = processingFixture({
        finalize: processing("pending", 2),
        statuses: [{ id: "101" }],
      });
      const result = uploadThenReply(test.api, {
        ...image,
        signal: failure === "caller abort" ? controller.signal : undefined,
        assertActive: () => () => {
          if (!active) {
            throw revoked;
          }
        },
      }).catch((cause: unknown) => cause);
      await test.finalized;
      await vi.advanceTimersByTimeAsync(0);
      if (failure.includes("abort")) {
        controller.abort();
      } else if (failure === "revoked authority") {
        active = false;
      }
      await vi.advanceTimersByTimeAsync(2000);
      const error = await result;
      expect(error).toBeInstanceOf(PlatformMessageNotDispatchedError);
      expect(error).toMatchObject({ retryable: false });
      if (failure === "revoked authority") {
        expect(error).toBe(revoked);
      }
      expect(test.calls).toEqual([
        ...uploadPaths,
        ...(failure === "missing processing status" ? ["/2/media/upload"] : []),
      ]);
    },
  );

  it("refreshes a rejected upload once and replays binary multipart with the persisted user token", async () => {
    let refreshes = 0;
    let persisted = "";
    const paths: string[] = [];
    const chunks: { token: string | null; content: string }[] = [];
    const api = createXTestApi({
      fetch: async (url, init) => {
        if (url.endsWith("/oauth2/token")) {
          refreshes++;
          return Response.json({
            access_token: "access-" + refreshes,
            refresh_token: "refresh-" + refreshes,
          });
        }
        paths.push(new URL(url).pathname);
        expect(persisted).toBe("refresh-" + refreshes);
        if (url.endsWith("/initialize")) {
          expect(await new Request(url, init).json()).toEqual({
            media_type: image.contentType,
            total_bytes: image.buffer.length,
            media_category: image.mediaCategory,
          });
        }
        if (url.endsWith("/append")) {
          const request = new Request(url, init);
          const { file, index } = await readMedia(request);
          expect(index).toBe("0");
          expect(file).toMatchObject({ name: image.fileName, type: image.contentType });
          chunks.push({ token: request.headers.get("authorization"), content: await file.text() });
          if (chunks.length === 1) {
            return new Response(null, { status: 401 });
          }
        }
        return mediaResponse();
      },
      saveRefreshToken: async (token) => {
        persisted = token;
      },
    });
    await expect(api.uploadMedia(image)).resolves.toBe("101");
    expect(refreshes).toBe(2);
    expect(paths).toEqual([uploadPaths[0], uploadPaths[1], uploadPaths[1], uploadPaths[2]]);
    expect(chunks).toEqual([
      { token: "Bearer access-1", content: "synthetic-image-bytes" },
      { token: "Bearer access-2", content: "synthetic-image-bytes" },
    ]);
  });

  it.each(["token refresh", "between chunks"])("revalidates authority after %s", async (stage) => {
    let active = true;
    const calls: string[] = [];
    const api = createXTestApi({
      fetch: async (url) => {
        const path = new URL(url).pathname;
        calls.push(path);
        if (path.endsWith("/oauth2/token")) {
          if (stage === "token refresh") {
            active = false;
          }
          return Response.json({ access_token: "access" });
        }
        if (path.endsWith("/append")) {
          active = false;
        }
        return mediaResponse();
      },
    });
    await expect(
      api.uploadMedia({
        ...image,
        buffer: stage === "between chunks" ? Buffer.alloc(5 * 1024 * 1024) : image.buffer,
        assertActive: async () => () => {
          if (!active) {
            throw revoked;
          }
        },
      }),
    ).rejects.toBe(revoked);
    expect(calls).toEqual(
      stage === "token refresh"
        ? ["/2/oauth2/token"]
        : ["/2/oauth2/token", "/2/media/upload/initialize", "/2/media/upload/101/append"],
    );
  });
});
