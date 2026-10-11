import { isChannelPartialDeliveryError } from "openclaw/plugin-sdk/channel-inbound";
import { createDeferred } from "openclaw/plugin-sdk/concurrency-runtime";
import { PlatformMessageNotDispatchedError } from "openclaw/plugin-sdk/error-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const effectGate = vi.hoisted(() => ({ prepare: undefined as (() => Promise<void>) | undefined }));
vi.mock("openclaw/plugin-sdk/fetch-runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/fetch-runtime")>();
  return {
    ...actual,
    captureEffectAuthority: () => {
      const authority = actual.captureEffectAuthority();
      const prepare = effectGate.prepare;
      return prepare
        ? {
            ...authority,
            initiate: async <T>(effect: () => T | Promise<T>) => {
              await prepare();
              return authority.initiate(effect);
            },
          }
        : authority;
    },
  };
});

const fetchWithSsrFGuardMock = vi.hoisted(() => vi.fn());
vi.mock("openclaw/plugin-sdk/ssrf-runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/ssrf-runtime")>();
  return { ...actual, fetchWithSsrFGuard: (...args: unknown[]) => fetchWithSsrFGuardMock(...args) };
});

import { cancelTrackedTextResponse } from "../../../test-support/streaming-error-response.js";
import {
  createMattermostClient,
  createMattermostDirectChannelWithRetry,
  createMattermostPost,
  deleteMattermostPost,
  fetchMattermostChannelPosts,
  sendMattermostTyping,
  uploadMattermostFile,
} from "./client.js";

const botToken = "abcdefghijklmnopqrstuvwxyz";
const clientParams = { baseUrl: "https://chat.example.com/api/v4/", botToken };
const jsonHeaders = { "content-type": "application/json" };
const postParams = { channelId: "ch1", message: "hello" };

function customClient(response: Response) {
  const fetchImpl = vi.fn<typeof fetch>().mockResolvedValueOnce(response);
  return { client: createMattermostClient({ ...clientParams, fetchImpl }), fetchImpl };
}

function guardedClient(response: Response) {
  const release = vi.fn(async () => {});
  fetchWithSsrFGuardMock.mockResolvedValueOnce({ response, release });
  return { client: createMattermostClient(clientParams), release };
}

function requestBody(fetchImpl: ReturnType<typeof vi.fn<typeof fetch>>): unknown {
  const body = fetchImpl.mock.calls[0]?.[1]?.body;
  if (typeof body !== "string") {
    throw new Error("expected JSON request body");
  }
  return JSON.parse(body);
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => {
      throw new Error("expected request rejection");
    },
    (error: unknown) => error,
  );
}

async function expectAccepted(promise: Promise<unknown>) {
  const error = await rejection(promise);
  expect(isChannelPartialDeliveryError(error)).toBe(true);
  if (!isChannelPartialDeliveryError(error)) {
    throw new Error("expected an accepted Mattermost delivery without a receipt");
  }
  expect(error.deliveryResult).toEqual({ messageIds: [], visibleReplySent: true });
}

beforeEach(() => {
  fetchWithSsrFGuardMock.mockReset();
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("Mattermost request boundary", () => {
  it.each([false, true])(
    "rechecks custom message transports after effect preparation (retired=%s)",
    async (retired) => {
      const preparing = createDeferred();
      const prepared = createDeferred();
      const dispatched = createDeferred();
      const response = createDeferred<Response>();
      const caller = new AbortController();
      const failure = new Error("Mattermost caller retired");
      effectGate.prepare = async () => {
        preparing.resolve();
        await prepared.promise;
      };
      const fetchImpl = vi.fn<typeof fetch>(() => {
        dispatched.resolve();
        return response.promise;
      });
      const client = createMattermostClient({
        ...clientParams,
        fetchImpl,
        assertRequestCurrent: () => caller.signal.throwIfAborted(),
      });
      const sending = createMattermostPost(client, postParams).then(
        (value) => ({ value }),
        (error: unknown) => ({ error }),
      );
      try {
        await Promise.race([
          preparing.promise,
          dispatched.promise.then(() => {
            throw new Error("dispatched before preparation");
          }),
        ]);
        expect(fetchImpl).not.toHaveBeenCalled();
        if (retired) {
          caller.abort(failure);
        }
        prepared.resolve();
        if (!retired) {
          await dispatched.promise;
          caller.abort(failure);
        }
        response.resolve(Response.json({ id: "post-1" }));
        const outcome = await sending;
        if (retired) {
          expect(outcome).toMatchObject({ error: { cause: failure } });
          expect("error" in outcome && outcome.error).toBeInstanceOf(
            PlatformMessageNotDispatchedError,
          );
        } else {
          expect(outcome).toEqual({ value: { id: "post-1" } });
        }
        expect(fetchImpl).toHaveBeenCalledTimes(retired ? 0 : 1);
      } finally {
        prepared.resolve();
        response.resolve(Response.json({ id: "post-1" }));
        await sending;
        effectGate.prepare = undefined;
      }
    },
  );

  it("rejects an empty base URL", () => {
    expect(() => createMattermostClient({ baseUrl: "", botToken })).toThrow("baseUrl is required");
  });

  it("releases null-body errors without unbounded response readers", async () => {
    const response = new Response(null, {
      status: 503,
      statusText: "Service Unavailable",
      headers: jsonHeaders,
    });
    const json = vi.spyOn(response, "json");
    const text = vi.spyOn(response, "text");
    const { client, release } = guardedClient(response);
    await expect(client.request("/users/me")).rejects.toThrow(
      "Mattermost API 503 Service Unavailable: unknown error",
    );
    expect(json).not.toHaveBeenCalled();
    expect(text).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledOnce();
  });

  it("rejects raw, encoded, and URL-normalized traversal before fetch", async () => {
    const { client, fetchImpl } = customClient(Response.json({}));
    for (const path of [
      "/posts/../users/me",
      "/posts/%2e%2e/users/me",
      "/posts/..?x=1",
      "/posts/%2e%2e?x=1",
      "/posts\\..\\users/me",
      "/posts/.\n./users/me",
      "/posts/.%0a./users/me",
      "/posts/%2e%2e%2fusers%80%2f..%2fme",
    ]) {
      await expect(client.request(path)).rejects.toThrow(
        "Mattermost API path must not contain unsafe path segments",
      );
    }
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("bounds and cancels a streaming JSON response flood", async () => {
    let canceled = false;
    let pulled = 0;
    const chunk = new Uint8Array(2 * 1024 * 1024).fill(0x7b);
    const { client, release } = guardedClient(
      new Response(
        new ReadableStream<Uint8Array>({
          pull(controller) {
            pulled++;
            controller.enqueue(chunk);
          },
          cancel() {
            canceled = true;
          },
        }),
        { headers: jsonHeaders },
      ),
    );
    await expect(client.request("/users/me")).rejects.toThrow(
      "JSON response exceeds 16777216 bytes",
    );
    expect(canceled).toBe(true);
    expect(pulled).toBeLessThanOrEqual(12);
    expect(release).toHaveBeenCalledOnce();
  });

  it("rejects oversized success text instead of truncating it", async () => {
    const tracked = cancelTrackedTextResponse(`${"plain success ".repeat(7000)}tail`);
    const { client, release } = guardedClient(tracked.response);
    await expect(client.request("/users/me")).rejects.toThrow("text response exceeds 65536 bytes");
    expect(tracked.wasCanceled()).toBe(true);
    expect(release).toHaveBeenCalledOnce();
  });

  it("reports accepted typing as sent despite an unreadable body", async () => {
    const { client, fetchImpl } = customClient(
      new Response(
        new ReadableStream({
          pull() {
            throw new TypeError("terminated");
          },
        }),
        { headers: jsonHeaders },
      ),
    );
    await expect(
      sendMattermostTyping(client, { channelId: "ch1", parentId: "root1" }),
    ).resolves.toBeUndefined();
    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(fetchImpl.mock.calls[0]?.[1]?.method).toBe("POST");
    expect(requestBody(fetchImpl)).toEqual({ channel_id: "ch1", parent_id: "root1" });
  });

  it("reports accepted deletion as done even when releasing its body fails", async () => {
    const { client, release } = guardedClient(
      new Response(
        new ReadableStream({
          cancel() {
            return Promise.reject(new Error("release failed"));
          },
        }),
        { headers: jsonHeaders },
      ),
    );
    release.mockRejectedValueOnce(new Error("release failed"));
    await expect(deleteMattermostPost(client, "post1")).resolves.toBeUndefined();
    expect(fetchWithSsrFGuardMock).toHaveBeenCalledOnce();
    expect(fetchWithSsrFGuardMock).toHaveBeenCalledWith(
      expect.objectContaining({
        url: "https://chat.example.com/api/v4/posts/post1",
        init: expect.objectContaining({ method: "DELETE" }),
      }),
    );
    expect(release).toHaveBeenCalledOnce();
  });
});

describe("Mattermost credential diagnostics", () => {
  it("decodes JSON escapes before redacting the request credential", async () => {
    const response = new Response(
      String.raw`{"message":"Bearer\u0020\u0061bcdefghijklmnopqrstuvwxyz"}`,
      {
        status: 401,
        headers: jsonHeaders,
      },
    );
    const json = vi.spyOn(response, "json");
    const text = vi.spyOn(response, "text");
    const { client, fetchImpl } = customClient(response);
    await expect(client.request("/users/me")).rejects.toThrow("Mattermost API 401 : ***");
    expect(new Headers(fetchImpl.mock.calls[0]?.[1]?.headers).get("Authorization")).toBe(
      `Bearer ${botToken}`,
    );
    expect(json).not.toHaveBeenCalled();
    expect(text).not.toHaveBeenCalled();
  });

  it("redacts malformed JSON served with a JSON content type", async () => {
    const { client } = customClient(
      new Response(`upstream error: Bearer ${botToken}`, {
        status: 502,
        headers: jsonHeaders,
      }),
    );
    await expect(client.request("/users/me")).rejects.toThrow(
      "Mattermost API 502 : upstream error: ***",
    );
  });

  it("redacts a bare upload credential in an object-valued error message", async () => {
    const { client, fetchImpl } = customClient(
      Response.json({ message: { context: "retry later", echoed: botToken } }, { status: 503 }),
    );
    await expect(
      uploadMattermostFile(client, {
        channelId: "ch1",
        buffer: Buffer.from("fixture upload"),
        fileName: "proof.txt",
        contentType: "text/plain",
      }),
    ).rejects.toThrow('Mattermost API 503 : {"message":{"context":"retry later","echoed":"***"}}');
    expect(new Headers(fetchImpl.mock.calls[0]?.[1]?.headers).get("Authorization")).toBe(
      `Bearer ${botToken}`,
    );
  });

  it("redacts a credential clipped by the error limit and releases unread data", async () => {
    const prefix = "upstream diagnostic " + ".".repeat(8192 - 20 - 12);
    const tracked = cancelTrackedTextResponse(prefix + botToken + " unread suffix", {
      status: 503,
    });
    const { client, release } = guardedClient(tracked.response);
    const error = await rejection(client.request("/users/me"));
    expect(error).toMatchObject({ message: "Mattermost API 503 : " + prefix + "***" });
    expect(tracked.wasCanceled()).toBe(true);
    expect(release).toHaveBeenCalledOnce();
  });
});

describe("Mattermost post receipts", () => {
  it("preserves accepted visibility when a post receipt cannot be decoded", async () => {
    const { client, fetchImpl } = customClient(new Response("{", { headers: jsonHeaders }));
    await expectAccepted(createMattermostPost(client, postParams));
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it("preserves accepted visibility for a no-content post identity", async () => {
    const { client } = customClient(new Response(null, { status: 204 }));
    await expectAccepted(createMattermostPost(client, postParams));
  });

  it("sends post attachments and trims the provider identity", async () => {
    const { client, fetchImpl } = customClient(Response.json({ id: "  post1  " }));
    const props = {
      attachments: [{ text: "Choose:", actions: [{ id: "btn1", type: "button", name: "Click" }] }],
    };
    await expect(
      createMattermostPost(client, { ...postParams, fileIds: ["file1", "file2"], props }),
    ).resolves.toEqual({ id: "post1" });
    expect(requestBody(fetchImpl)).toEqual({
      channel_id: "ch1",
      message: "hello",
      file_ids: ["file1", "file2"],
      props,
    });
    expect(new Headers(fetchImpl.mock.calls[0]?.[1]?.headers).get("Content-Type")).toBe(
      "application/json",
    );
  });
});

describe("Mattermost post reads and edits", () => {
  it.each(["before", "after"] as const)(
    "reads ordered %s pages until the requested-direction cursor is exhausted",
    async (direction) => {
      const posts = [
        { id: "post-2", message: "newer" },
        { id: "post-1", message: "older" },
      ];
      const cursorKey = direction === "before" ? "prev_post_id" : "next_post_id";
      const oppositeKey = direction === "before" ? "next_post_id" : "prev_post_id";
      const response = Response.json({
        order: ["post-2", "post-1"],
        posts: { "post-1": posts[1], "post-2": posts[0] },
        [cursorKey]: "next-page",
      });
      const arrayBuffer = vi
        .spyOn(response, "arrayBuffer")
        .mockRejectedValue(new Error("responses must stay streaming"));
      const { client, release } = guardedClient(response);
      fetchWithSsrFGuardMock.mockResolvedValueOnce({
        response: Response.json({
          order: [],
          posts: {},
          [cursorKey]: "",
          [oppositeKey]: "opposite-boundary",
        }),
        release,
      });
      const options =
        direction === "before" ? { before: "cursor", limit: 500 } : { after: "cursor" };
      await expect(fetchMattermostChannelPosts(client, "channel/unsafe", options)).resolves.toEqual(
        { messages: posts, hasMore: true },
      );
      await expect(
        fetchMattermostChannelPosts(client, "channel/unsafe", { [direction]: "next-page" }),
      ).resolves.toEqual({ messages: [], hasMore: false });
      expect(fetchWithSsrFGuardMock).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({
          url: `https://chat.example.com/api/v4/channels/channel%2Funsafe/posts?per_page=${direction === "before" ? 200 : 60}&${direction}=cursor`,
        }),
      );
      expect(arrayBuffer).not.toHaveBeenCalled();
      expect(release).toHaveBeenCalledTimes(2);
    },
  );

  it("rejects invalid limits before provider access", async () => {
    const { client, fetchImpl } = customClient(Response.json({}));
    for (const limit of [0, 1.5]) {
      await expect(fetchMattermostChannelPosts(client, "ch1", { limit })).rejects.toThrow(
        "Mattermost read limit must be a positive integer",
      );
    }
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("rejects mutually exclusive cursors before provider access", async () => {
    const { client, fetchImpl } = customClient(Response.json({}));
    await expect(
      fetchMattermostChannelPosts(client, "ch1", { before: "older", after: "newer" }),
    ).rejects.toThrow("Mattermost read accepts either before or after, not both");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("rejects a post list referencing a missing post", async () => {
    const { client } = customClient(Response.json({ order: ["missing-post"], posts: {} }));
    await expect(fetchMattermostChannelPosts(client, "ch1")).rejects.toThrow(
      "Unexpected Mattermost channel posts response",
    );
  });
});

describe("Mattermost DM retries", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(async () => {
    try {
      await vi.runOnlyPendingTimersAsync();
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([
    {
      name: "nested transport code",
      failure: new TypeError("fetch failed", {
        cause: Object.assign(new Error("connect failed"), { code: "ECONNREFUSED" }),
      }),
    },
    {
      name: "port 443 connection error",
      failure: new Error("connect ECONNRESET 104.18.32.10:443"),
    },
  ])("retries $name with capped exponential jitter", async ({ failure }) => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockRejectedValueOnce(failure)
      .mockRejectedValueOnce(failure)
      .mockResolvedValueOnce(Response.json({ id: "dm1" }));
    const client = createMattermostClient({ ...clientParams, fetchImpl });
    const onRetry = vi.fn();
    const run = createMattermostDirectChannelWithRetry(client, ["u1", "u2"], {
      initialDelayMs: 100,
      maxDelayMs: 250,
      onRetry,
    });
    await vi.runAllTimersAsync();
    await expect(run).resolves.toMatchObject({ id: "dm1" });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(onRetry).toHaveBeenCalledTimes(2);
    expect(onRetry).toHaveBeenNthCalledWith(1, 1, expect.any(Number), failure);
    expect(onRetry).toHaveBeenNthCalledWith(2, 2, expect.any(Number), failure);
    expect(onRetry.mock.calls[0]?.[1]).toBeGreaterThanOrEqual(100);
    expect(onRetry.mock.calls[0]?.[1]).toBeLessThanOrEqual(200);
    expect(onRetry.mock.calls[1]?.[1]).toBeGreaterThanOrEqual(200);
    expect(onRetry.mock.calls[1]?.[1]).toBeLessThanOrEqual(250);
  });

  it.each([
    { status: 400, message: "Invalid request: too many requests is diagnostic text" },
    { status: 400, message: "Invalid request; upstream Mattermost API 503 Service Unavailable" },
  ])("does not retry $status with misleading details: $message", async ({ status, message }) => {
    const fetchImpl = vi.fn<typeof fetch>(async () => Response.json({ message }, { status }));
    const client = createMattermostClient({ ...clientParams, fetchImpl });
    const outcome = expect(
      createMattermostDirectChannelWithRetry(client, ["u1", "u2"]),
    ).rejects.toThrow(`Mattermost API ${status}`);
    await vi.runAllTimersAsync();
    await outcome;
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it("does not retry a permanent dispatch rejection with a transient provider cause", async () => {
    const failure = new PlatformMessageNotDispatchedError("sender retired", {
      cause: new Error("Mattermost API 503 Service Unavailable"),
      retryable: false,
    });
    const fetchImpl = vi.fn<typeof fetch>().mockRejectedValue(failure);
    const client = createMattermostClient({ ...clientParams, fetchImpl });
    const outcome = expect(
      createMattermostDirectChannelWithRetry(client, ["u1", "u2"]),
    ).rejects.toBe(failure);
    await vi.runAllTimersAsync();
    await outcome;
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it.each([400, 429, 503])(
    "preserves HTTP %s retry policy when the error response body fails",
    async (status) => {
      const fetchImpl = vi.fn<typeof fetch>(
        async () =>
          new Response(
            new ReadableStream({
              pull() {
                throw new TypeError("network error");
              },
            }),
            { status, headers: jsonHeaders },
          ),
      );
      const client = createMattermostClient({ ...clientParams, fetchImpl });
      const outcome = rejection(createMattermostDirectChannelWithRetry(client, ["u1", "u2"]));
      await vi.runAllTimersAsync();
      expect(fetchImpl).toHaveBeenCalledTimes(status === 429 || status >= 500 ? 4 : 1);
      expect(await outcome).toMatchObject({
        message: expect.stringContaining(`Mattermost API ${status}`),
      });
    },
  );
});
