import { PlatformMessageNotDispatchedError } from "openclaw/plugin-sdk/error-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createXApiClient, type XFetch } from "./api.js";
import { createXTestSpend } from "./test-support/spend.js";

type ClientOptions = Parameters<typeof createXApiClient>[0];
function rawClient(fetch: XFetch, options: Partial<ClientOptions> = {}) {
  return createXApiClient({
    spend: createXTestSpend(),
    clientId: "client",
    clientSecret: "test-secret",
    refreshToken: "test-refresh",
    saveRefreshToken: async () => {},
    ...options,
    fetch,
  });
}
function client(fetch: XFetch, options: Partial<ClientOptions> = {}) {
  return rawClient(
    (url, init) =>
      url.endsWith("/oauth2/token")
        ? Promise.resolve(Response.json({ access_token: "test-access" }))
        : fetch(url, init),
    options,
  );
}

const mediaResponse = (data: object = { id: "101" }) => Response.json({ data });
const uploadPaths = [
  "/2/media/upload/initialize",
  "/2/media/upload/101/append",
  "/2/media/upload/101/finalize",
];
const uploadThenReply = (
  api: ReturnType<typeof client>,
  media: Parameters<ReturnType<typeof client>["uploadMedia"]>[0] = image,
) =>
  api
    .uploadMedia(media)
    .then((id) => api.reply({ text: "Never text-only", inReplyToId: "20", mediaIds: [id] }));

const image = {
  buffer: Buffer.from("synthetic-image-bytes"),
  contentType: "image/png",
  fileName: "image.png",
  mediaCategory: "tweet_image" as const,
};
async function readMedia(request: Request) {
  const form = await request.formData();
  const file = form.get("media");
  expect(file).toBeInstanceOf(File);
  if (!(file instanceof File)) {
    throw new Error("Expected binary media");
  }
  return { file, index: form.get("segment_index") };
}

afterEach(() => vi.useRealTimers());

describe("X native media request boundary", () => {
  it.each([
    image,
    {
      ...image,
      contentType: "image/gif",
      fileName: "animation.gif",
      mediaCategory: "tweet_gif" as const,
    },
  ])(
    "uploads $mediaCategory as authenticated binary multipart before attaching it",
    async (media) => {
      const requests: string[] = [];
      const api = client(async (url, init) => {
        const request = new Request(url, init);
        const path = new URL(url).pathname;
        requests.push(`${request.method} ${path}`);
        expect(request.headers.get("authorization")).toBe("Bearer test-access");
        if (path.endsWith("/initialize")) {
          expect(await request.json()).toEqual({
            media_type: media.contentType,
            total_bytes: media.buffer.length,
            media_category: media.mediaCategory,
          });
          return mediaResponse();
        }
        if (path.endsWith("/append")) {
          expect(request.headers.get("content-type")).toContain("multipart/form-data; boundary=");
          const { file, index } = await readMedia(request);
          expect(index).toBe("0");
          expect(file).toMatchObject({ name: media.fileName, type: media.contentType });
          expect(Buffer.from(await file.arrayBuffer())).toEqual(media.buffer);
          return mediaResponse({ expires_at: 86400 });
        }
        if (path.endsWith("/finalize")) {
          expect(await request.text()).toBe("");
          return mediaResponse();
        }
        expect(await request.json()).toEqual({
          text: "Ready",
          reply: { in_reply_to_tweet_id: "20" },
          media: { media_ids: ["101"] },
        });
        return Response.json({ data: { id: "900" } });
      });
      const mediaId = await api.uploadMedia(media);
      await expect(
        api.reply({ text: "Ready", inReplyToId: "20", mediaIds: [mediaId] }),
      ).resolves.toBe("900");
      expect(requests).toEqual([
        "POST /2/media/upload/initialize",
        "POST /2/media/upload/101/append",
        "POST /2/media/upload/101/finalize",
        "POST /2/tweets",
      ]);
      expect(await api.spend.status()).toMatchObject({ dayUsd: 0.02 });
    },
  );

  it("appends ordered video chunks and waits for X processing before posting", async () => {
    vi.useFakeTimers();
    const buffer = Buffer.alloc(4 * 1024 * 1024 + 7, 0x41);
    buffer.fill(0x42, 4 * 1024 * 1024);
    const chunks: { index: string | null; bytes: Buffer }[] = [];
    const finalized = Promise.withResolvers<void>();
    const polls: number[] = [];
    let post: unknown;
    const api = client(async (url, init) => {
      const request = new Request(url, init);
      const parsed = new URL(url);
      if (parsed.pathname.endsWith("/initialize")) {
        expect(await request.json()).toEqual({
          media_type: "video/mp4",
          total_bytes: buffer.length,
          media_category: "tweet_video",
        });
        return Response.json({ data: { id: "201" } });
      }
      if (parsed.pathname.endsWith("/append")) {
        const { file, index } = await readMedia(request);
        if (typeof index !== "string") {
          throw new Error("Expected a multipart segment index");
        }
        chunks.push({ index, bytes: Buffer.from(await file.arrayBuffer()) });
        return new Response(null, { status: 204 });
      }
      if (parsed.pathname.endsWith("/finalize")) {
        finalized.resolve();
        return mediaResponse({
          id: "201",
          processing_info: { state: "pending", check_after_secs: 2 },
        });
      }
      if (parsed.pathname === "/2/media/upload") {
        expect(request.method).toBe("GET");
        expect(parsed.searchParams.get("command")).toBe("STATUS");
        expect(parsed.searchParams.get("media_id")).toBe("201");
        polls.push(Date.now());
        return mediaResponse({
          id: "201",
          processing_info:
            polls.length === 1
              ? { state: "in_progress", check_after_secs: 3 }
              : { state: "succeeded" },
        });
      }
      post = await request.json();
      return Response.json({ data: { id: "900" } });
    });
    const started = Date.now();
    const pending = api
      .uploadMedia({
        buffer,
        contentType: "video/mp4",
        fileName: "clip.mp4",
        mediaCategory: "tweet_video",
      })
      .then((id) => api.reply({ text: "Video", inReplyToId: "20", mediaIds: [id] }));
    await finalized.promise;
    await vi.advanceTimersByTimeAsync(1999);
    expect(polls).toEqual([]);
    expect(post).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    expect(polls).toEqual([started + 2000]);
    await vi.advanceTimersByTimeAsync(2999);
    expect(post).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    await expect(pending).resolves.toBe("900");
    expect(polls).toEqual([started + 2000, started + 5000]);
    expect(chunks.map(({ index, bytes }) => [index, bytes.length])).toEqual([
      ["0", 4194304],
      ["1", 7],
    ]);
    expect(Buffer.concat(chunks.map(({ bytes }) => bytes)).equals(buffer)).toBe(true);
    expect(post).toEqual({
      text: "Video",
      reply: { in_reply_to_tweet_id: "20" },
      media: { media_ids: ["201"] },
    });
  });

  it.each([
    [
      "forbidden",
      () =>
        Response.json({ detail: "Denied test-access test-refresh test-secret" }, { status: 403 }),
      false,
      "media.write",
    ],
    [
      "rate limited",
      () => new Response(null, { status: 429, headers: { "Retry-After": "60" } }),
      true,
      "429",
    ],
    ["server failure", () => new Response(null, { status: 503 }), true, "503"],
    [
      "lost upload response",
      () => {
        throw new Error("socket reset");
      },
      true,
      "network request failed",
    ],
    ["missing media ID", () => mediaResponse({}), false, "media ID"],
  ] as const)(
    "classifies %s as no Post dispatched without retrying the upload",
    async (_label, response, retryable, message) => {
      const calls: string[] = [];
      const api = client(async (url) => {
        calls.push(new URL(url).pathname);
        return response();
      });
      const error: unknown = await uploadThenReply(api).catch((cause: unknown) => cause);
      expect(error).toBeInstanceOf(PlatformMessageNotDispatchedError);
      expect(error).toMatchObject({ retryable, message: expect.stringContaining(message) });
      expect(String(error)).not.toMatch(/test-access|test-refresh|test-secret/);
      expect(calls).toEqual(["/2/media/upload/initialize"]);
      expect(await api.spend.status()).toMatchObject({ dayUsd: 0 });
    },
  );

  it.each([
    ["failed processing", { id: "101", processing_info: { state: "failed" } }, "processing failed"],
    [
      "unknown processing",
      { id: "101", processing_info: { state: "unknown" } },
      "invalid processing state",
    ],
    ["wrong media ID", { id: "102" }, "invalid media result"],
    [
      "unbounded processing delay",
      { id: "101", processing_info: { state: "pending", check_after_secs: 3600 } },
      "timed out",
    ],
  ] as const)("refuses %s before the caller can post", async (_label, data, message) => {
    const calls: string[] = [];
    const api = client(async (url) => {
      calls.push(new URL(url).pathname);
      return mediaResponse(url.endsWith("/finalize") ? data : undefined);
    });
    await expect(uploadThenReply(api)).rejects.toThrow(message);
    expect(calls).toEqual(uploadPaths);
  });

  it("bounds repeated pending processing responses without shortening X polling delays", async () => {
    vi.useFakeTimers();
    const finalized = Promise.withResolvers<void>();
    const polls: number[] = [];
    const api = client(async (url) => {
      const path = new URL(url).pathname;
      if (path.endsWith("/finalize") || path === "/2/media/upload") {
        if (path.endsWith("/finalize")) {
          finalized.resolve();
        } else {
          polls.push(Date.now());
        }
        return mediaResponse({
          id: "101",
          processing_info: { state: "pending", check_after_secs: 60 },
        });
      }
      return mediaResponse();
    });
    const started = Date.now();
    const result = api.uploadMedia(image).catch((cause: unknown) => cause);
    await finalized.promise;
    await vi.advanceTimersByTimeAsync(300_000);
    expect(await result).toMatchObject({
      code: "OPENCLAW_PLATFORM_MESSAGE_NOT_DISPATCHED",
      retryable: true,
      message: expect.stringContaining("processing timed out"),
    });
    expect(polls.map((time) => time - started)).toEqual([60_000, 120_000, 180_000, 240_000]);
  });

  it.each(["caller abort", "account abort", "revoked authority", "missing processing status"])(
    "stops after %s during the processing wait without posting",
    async (failure) => {
      vi.useFakeTimers();
      const controller = new AbortController();
      const finalized = Promise.withResolvers<void>();
      const calls: string[] = [];
      let active = true;
      const rejected = new PlatformMessageNotDispatchedError("X account authority revoked", {
        cause: undefined,
        retryable: false,
      });
      const api = client(
        async (url) => {
          const path = new URL(url).pathname;
          calls.push(path);
          if (path.endsWith("/finalize")) {
            finalized.resolve();
            return mediaResponse({
              id: "101",
              processing_info: { state: "pending", check_after_secs: 2 },
            });
          }
          return mediaResponse();
        },
        { signal: failure === "account abort" ? controller.signal : undefined },
      );
      const result = uploadThenReply(api, {
        ...image,
        signal: failure === "caller abort" ? controller.signal : undefined,
        assertActive: () => () => {
          if (!active) {
            throw rejected;
          }
        },
      }).catch((cause: unknown) => cause);
      await finalized.promise;
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
        expect(error).toBe(rejected);
      }
      expect(calls).toEqual([
        ...uploadPaths,
        ...(failure === "missing processing status" ? ["/2/media/upload"] : []),
      ]);
    },
  );

  it("refreshes a rejected upload once and replays binary multipart with the persisted user token", async () => {
    let refreshes = 0;
    let persisted = "";
    const chunks: { token: string | null; content: string }[] = [];
    const api = rawClient(
      async (url, init) => {
        if (url.endsWith("/oauth2/token")) {
          refreshes++;
          return Response.json({
            access_token: "access-" + refreshes,
            refresh_token: "refresh-" + refreshes,
          });
        }
        expect(persisted).toBe("refresh-" + refreshes);
        if (url.endsWith("/append")) {
          const request = new Request(url, init);
          const { file } = await readMedia(request);
          chunks.push({ token: request.headers.get("authorization"), content: await file.text() });
          if (chunks.length === 1) {
            return new Response(null, { status: 401 });
          }
        }
        return mediaResponse();
      },
      {
        clientSecret: "secret",
        refreshToken: "seed",
        saveRefreshToken: async (token) => {
          persisted = token;
        },
      },
    );
    await expect(api.uploadMedia(image)).resolves.toBe("101");
    expect(refreshes).toBe(2);
    expect(chunks).toEqual([
      { token: "Bearer access-1", content: "synthetic-image-bytes" },
      { token: "Bearer access-2", content: "synthetic-image-bytes" },
    ]);
  });

  it.each(["token refresh", "between chunks"])("revalidates authority after %s", async (stage) => {
    let active = true;
    const calls: string[] = [];
    const rejected = new PlatformMessageNotDispatchedError("Revoked", {
      cause: undefined,
      retryable: false,
    });
    const api = rawClient(
      async (url) => {
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
      { clientSecret: "secret", refreshToken: "seed" },
    );
    await expect(
      api.uploadMedia({
        ...image,
        buffer: stage === "between chunks" ? Buffer.alloc(5 * 1024 * 1024) : image.buffer,
        assertActive: async () => () => {
          if (!active) {
            throw rejected;
          }
        },
      }),
    ).rejects.toBe(rejected);
    expect(calls).toEqual(
      stage === "token refresh"
        ? ["/2/oauth2/token"]
        : ["/2/oauth2/token", "/2/media/upload/initialize", "/2/media/upload/101/append"],
    );
  });
});
