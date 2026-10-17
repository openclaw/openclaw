import { PlatformMessageNotDispatchedError } from "openclaw/plugin-sdk/error-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createXApiClient, type XFetch } from "./api.js";
import { createXTestSpend } from "./test-support/spend.js";

function client(fetch: XFetch, signal?: AbortSignal) {
  return createXApiClient({
    spend: createXTestSpend(),
    clientId: "client",
    clientSecret: "test-secret",
    refreshToken: "test-refresh",
    saveRefreshToken: async () => {},
    signal,
    fetch: (url, init) =>
      url.endsWith("/oauth2/token")
        ? Promise.resolve(Response.json({ access_token: "test-access" }))
        : fetch(url, init),
  });
}

const image = {
  buffer: Buffer.from("synthetic-image-bytes"),
  contentType: "image/png",
  fileName: "image.png",
  mediaCategory: "tweet_image" as const,
};

afterEach(() => vi.useRealTimers());

describe("X native media request boundary", () => {
  it("attaches native media IDs without changing reply routing or link-free pricing", async () => {
    let body: unknown;
    const api = client(async (_url, init) => {
      body = await new Response(init?.body).json();
      return Response.json({ data: { id: "900" } });
    });
    await expect(
      api.reply({
        text: "Native image",
        inReplyToId: "20",
        mediaIds: ["101", "102"],
      }),
    ).resolves.toBe("900");
    expect(body).toEqual({
      text: "Native image",
      reply: { in_reply_to_tweet_id: "20" },
      media: { media_ids: ["101", "102"] },
    });
    expect(await api.spend.status()).toMatchObject({ dayUsd: 0.02 });
  });

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
          return Response.json({ data: { id: "101" } });
        }
        if (path.endsWith("/append")) {
          expect(request.headers.get("content-type")).toContain("multipart/form-data; boundary=");
          const form = await request.formData();
          expect(form.get("segment_index")).toBe("0");
          const file = form.get("media");
          expect(file).toBeInstanceOf(File);
          if (!(file instanceof File)) {
            throw new Error("Expected binary media");
          }
          expect(file.name).toBe(media.fileName);
          expect(file.type).toBe(media.contentType);
          expect(Buffer.from(await file.arrayBuffer())).toEqual(media.buffer);
          return Response.json({ data: { expires_at: 86400 } });
        }
        if (path.endsWith("/finalize")) {
          expect(await request.text()).toBe("");
          return Response.json({ data: { id: "101" } });
        }
        expect(await request.json()).toMatchObject({ media: { media_ids: ["101"] } });
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
        const form = await request.formData();
        const media = form.get("media");
        if (!(media instanceof File)) {
          throw new Error("Expected binary media");
        }
        const index = form.get("segment_index");
        if (typeof index !== "string") {
          throw new Error("Expected a multipart segment index");
        }
        chunks.push({
          index,
          bytes: Buffer.from(await media.arrayBuffer()),
        });
        return new Response(null, { status: 204 });
      }
      if (parsed.pathname.endsWith("/finalize")) {
        finalized.resolve();
        return Response.json({
          data: { id: "201", processing_info: { state: "pending", check_after_secs: 2 } },
        });
      }
      if (parsed.pathname === "/2/media/upload") {
        expect(request.method).toBe("GET");
        expect(parsed.searchParams.get("command")).toBe("STATUS");
        expect(parsed.searchParams.get("media_id")).toBe("201");
        polls.push(Date.now());
        return Response.json({
          data: {
            id: "201",
            processing_info:
              polls.length === 1
                ? { state: "in_progress", check_after_secs: 3 }
                : { state: "succeeded" },
          },
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
    {
      label: "forbidden",
      response: () =>
        Response.json({ detail: "Denied test-access test-refresh test-secret" }, { status: 403 }),
      retryable: false,
      message: "media.write",
    },
    {
      label: "rate limited",
      response: () => new Response(null, { status: 429, headers: { "Retry-After": "60" } }),
      retryable: true,
      message: "429",
    },
    {
      label: "server failure",
      response: () => new Response(null, { status: 503 }),
      retryable: true,
      message: "503",
    },
    {
      label: "lost upload response",
      response: () => {
        throw new Error("socket reset");
      },
      retryable: true,
      message: "network request failed",
    },
    {
      label: "missing media ID",
      response: () => Response.json({ data: {} }),
      retryable: false,
      message: "media ID",
    },
  ])(
    "classifies $label as no Post dispatched without retrying the upload",
    async ({ response, retryable, message }) => {
      const calls: string[] = [];
      const api = client(async (url) => {
        calls.push(new URL(url).pathname);
        return response();
      });
      const error: unknown = await api
        .uploadMedia(image)
        .then((id) => api.reply({ text: "Never text-only", inReplyToId: "20", mediaIds: [id] }))
        .catch((cause: unknown) => cause);
      expect(error).toBeInstanceOf(PlatformMessageNotDispatchedError);
      expect(error).toMatchObject({ retryable, message: expect.stringContaining(message) });
      expect(String(error)).not.toMatch(/test-access|test-refresh|test-secret/);
      expect(calls).toEqual(["/2/media/upload/initialize"]);
      expect(await api.spend.status()).toMatchObject({ dayUsd: 0 });
    },
  );

  it.each([
    {
      label: "failed processing",
      data: { id: "101", processing_info: { state: "failed" } },
      message: "processing failed",
    },
    {
      label: "unknown processing",
      data: { id: "101", processing_info: { state: "unknown" } },
      message: "invalid processing state",
    },
    { label: "wrong media ID", data: { id: "102" }, message: "invalid media result" },
    {
      label: "unbounded processing delay",
      data: { id: "101", processing_info: { state: "pending", check_after_secs: 3600 } },
      message: "timed out",
    },
  ])("refuses $label before the caller can post", async ({ data, message }) => {
    const calls: string[] = [];
    const api = client(async (url) => {
      calls.push(new URL(url).pathname);
      return url.endsWith("/finalize")
        ? Response.json({ data })
        : Response.json({ data: { id: "101" } });
    });
    await expect(
      api
        .uploadMedia(image)
        .then((id) => api.reply({ text: "Never text-only", inReplyToId: "20", mediaIds: [id] })),
    ).rejects.toThrow(message);
    expect(calls).toEqual([
      "/2/media/upload/initialize",
      "/2/media/upload/101/append",
      "/2/media/upload/101/finalize",
    ]);
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
        return Response.json({
          data: { id: "101", processing_info: { state: "pending", check_after_secs: 60 } },
        });
      }
      return Response.json({ data: { id: "101" } });
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
            return Response.json({
              data: { id: "101", processing_info: { state: "pending", check_after_secs: 2 } },
            });
          }
          return Response.json({ data: { id: "101" } });
        },
        failure === "account abort" ? controller.signal : undefined,
      );
      const result = api
        .uploadMedia({
          ...image,
          signal: failure === "caller abort" ? controller.signal : undefined,
          assertActive: () => () => {
            if (!active) {
              throw rejected;
            }
          },
        })
        .then((id) => api.reply({ text: "Never text-only", inReplyToId: "20", mediaIds: [id] }))
        .catch((cause: unknown) => cause);
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
        "/2/media/upload/initialize",
        "/2/media/upload/101/append",
        "/2/media/upload/101/finalize",
        ...(failure === "missing processing status" ? ["/2/media/upload"] : []),
      ]);
    },
  );

  it("refreshes a rejected upload once and replays binary multipart with the persisted user token", async () => {
    let refreshes = 0;
    let persisted = "";
    const chunks: { token: string | null; content: string }[] = [];
    const api = createXApiClient({
      spend: createXTestSpend(),
      clientId: "client",
      clientSecret: "secret",
      refreshToken: "seed",
      saveRefreshToken: async (token) => {
        persisted = token;
      },
      fetch: async (url, init) => {
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
          const form = await request.formData();
          const file = form.get("media");
          if (!(file instanceof File)) {
            throw new Error("Expected media");
          }
          chunks.push({ token: request.headers.get("authorization"), content: await file.text() });
          if (chunks.length === 1) {
            return new Response(null, { status: 401 });
          }
        }
        return Response.json({ data: { id: "101" } });
      },
    });
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
    const api = createXApiClient({
      spend: createXTestSpend(),
      clientId: "client",
      clientSecret: "secret",
      refreshToken: "seed",
      saveRefreshToken: async () => {},
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
        return Response.json({ data: { id: "101" } });
      },
    });
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
