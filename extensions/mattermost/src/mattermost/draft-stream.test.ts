import { isChannelPartialDeliveryError } from "openclaw/plugin-sdk/channel-inbound";
import {
  createChannelProgressDraftCompositor,
  createLivePreviewLifecycle,
} from "openclaw/plugin-sdk/channel-outbound";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import type { ReplyPayload } from "openclaw/plugin-sdk/reply-runtime";
import { describe, expect, it, vi } from "vitest";
import type { MattermostClient } from "./client.js";
import { createMattermostDraftStream } from "./draft-stream.js";
import { deliverMattermostReplyWithDraftPreview } from "./monitor-draft-delivery.js";

type RequestRecord = {
  path: string;
  init?: RequestInit;
};

type DraftStreamOptions = Omit<
  Parameters<typeof createMattermostDraftStream>[0],
  "client" | "channelId"
> & {
  request?: MattermostClient["request"];
  beforeRequest?: (path: string) => Promise<void>;
};

function createDraftStreamFixture(options: DraftStreamOptions = {}) {
  const { request, beforeRequest, ...streamOptions } = options;
  const calls: RequestRecord[] = [];
  let nextId = 1;
  const requestImpl: MattermostClient["request"] = async <T>(
    path: string,
    init?: RequestInit,
  ): Promise<T> => {
    calls.push({ path, init });
    await beforeRequest?.(path);
    if (path === "/posts") {
      return { id: `post-${nextId++}` } as T;
    }
    if (path.startsWith("/posts/")) {
      return { id: "patched" } as T;
    }
    return {} as T;
  };
  const requestMock = vi.fn(request ?? requestImpl);
  const client: MattermostClient = {
    baseUrl: "https://chat.example.com",
    apiBaseUrl: "https://chat.example.com/api/v4",
    token: "token",
    request: requestMock as MattermostClient["request"],
    fetchImpl: vi.fn() as MattermostClient["fetchImpl"],
  };
  const stream = createMattermostDraftStream({
    client,
    channelId: "channel-1",
    ...streamOptions,
  });
  const publish = async (text: string, assistant = false) => {
    (assistant ? stream.updateAssistantText : stream.update)(text);
    await stream.flush();
  };
  return { client, calls, requestMock, stream, publish };
}

function expectResolution(
  stream: ReturnType<typeof createMattermostDraftStream>,
  input: string,
  kind: "full" | "remaining" | "already-delivered",
  text?: string,
  publishedParts = [{ messageId: "post-1", content: "First block" }],
) {
  expect(stream.resolveFinalText(input)).toEqual({
    kind,
    ...(kind === "already-delivered" ? {} : { text }),
    publishedParts,
  });
}

function parseRequestJson(init: RequestInit | undefined): Record<string, unknown> {
  if (typeof init?.body !== "string") {
    throw new Error("expected JSON request body");
  }
  const parsed: unknown = JSON.parse(init.body);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("expected JSON object request body");
  }
  return parsed as Record<string, unknown>;
}

function createProviderPostFixture(
  options: {
    beforeDelete?: (id: string) => Promise<void>;
    warn?: (message: string) => void;
  } = {},
) {
  const posts = new Map<string, string>();
  let nextId = 1;
  const request: MattermostClient["request"] = async <T>(
    path: string,
    init?: RequestInit,
  ): Promise<T> => {
    if (path === "/posts" && init?.method === "POST") {
      const id = `post-${nextId++}`;
      const message = String(parseRequestJson(init).message);
      posts.set(id, message);
      return { id, message } as T;
    }
    const id = path.slice("/posts/".length).replace(/\/patch$/, "");
    if (init?.method === "DELETE") {
      await options.beforeDelete?.(id);
      posts.delete(id);
      return undefined as T;
    }
    if (init?.method === "PUT") {
      if (!posts.has(id)) {
        throw new Error("Mattermost API 404 Not Found");
      }
      const message = String(parseRequestJson(init).message);
      posts.set(id, message);
      return { id, message } as T;
    }
    throw new Error(`Unexpected Mattermost request: ${init?.method} ${path}`);
  };
  return { ...createDraftStreamFixture({ request, warn: options.warn }), posts };
}

describe("createMattermostDraftStream", () => {
  it.each([{ timing: "immediately after retraction" }, { timing: "while deletion is pending" }])(
    "keeps the identical plan replacement $timing",
    async ({ timing }) => {
      const deleteStarted = createDeferred<void>();
      const releaseDelete = createDeferred<void>();
      const { stream, posts } = createProviderPostFixture({
        beforeDelete: async () => {
          deleteStarted.resolve();
          await releaseDelete.promise;
        },
      });
      const progress = createChannelProgressDraftCompositor({
        entry: { streaming: { mode: "progress", progress: { label: false } } },
        mode: "progress",
        active: true,
        seed: "plan-retraction",
        update: async (text, options) => {
          stream.update(text);
          if (options?.flush) {
            await stream.flush();
          }
        },
        deleteCurrent: () => stream.deleteCurrentMessage(),
      });
      let firstPublication: Promise<boolean> | undefined;
      let retraction: Promise<boolean> | undefined;
      let replacementPublication: Promise<boolean> | undefined;
      try {
        firstPublication = progress.pushPlanProgress([{ step: "Inspect", status: "in_progress" }]);
        await firstPublication;
        expect([...posts.values()]).toEqual([expect.stringContaining("Inspect")]);

        retraction = progress.pushPlanProgress([]);
        if (timing !== "immediately after retraction") {
          await deleteStarted.promise;
        }
        replacementPublication = progress.pushPlanProgress([
          { step: "Inspect", status: "in_progress" },
        ]);
        await deleteStarted.promise;
        releaseDelete.resolve();
        await Promise.all([retraction, replacementPublication]);
        await stream.flush();

        expect([...posts.values()]).toEqual([expect.stringContaining("Inspect")]);
        expect(posts.has(stream.postId() ?? "")).toBe(true);
      } finally {
        releaseDelete.resolve();
        await Promise.allSettled([firstPublication, retraction, replacementPublication]);
        progress.cancel();
        await stream.clear();
      }
    },
  );

  it.each([false, true])(
    "retries retired preview cleanup at stop while preserving the final (retry fails: %s)",
    async (retryFails) => {
      const warn = vi.fn();
      const deleteAttempts: string[] = [];
      const { client, stream, posts, publish } = createProviderPostFixture({
        warn,
        beforeDelete: async (id) => {
          deleteAttempts.push(id);
          if (deleteAttempts.length === 1 || retryFails) {
            throw new Error("temporary delete failure");
          }
        },
      });
      const deliverPayload = vi.fn(async () => {
        throw new Error("the final should edit its preview in place");
      });
      try {
        await publish("Retired plan");
        const retiredId = stream.postId();
        await stream.deleteCurrentMessage();
        await publish("Replacement plan");
        const finalId = stream.postId();
        const result = await deliverMattermostReplyWithDraftPreview({
          payload: { text: "Final answer" },
          info: { kind: "final" },
          kind: "direct",
          client,
          previewLifecycle: createLivePreviewLifecycle<ReplyPayload, string>({
            draft: { ...stream, id: stream.postId },
          }),
          resolvePreviewFinalText: (text) => ({ editText: text, alreadyDelivered: false }),
          logVerboseMessage: vi.fn(),
          deliverPayload,
        });
        expect(result.visibleReplySent).toBe(true);
        expect(result.messageIds).toEqual([finalId]);
        expect(posts.get(finalId ?? "")).toBe("Final answer");
        expect(deliverPayload).not.toHaveBeenCalled();

        await stream.stop();

        expect(posts.get(finalId ?? "")).toBe("Final answer");
        expect(deleteAttempts).not.toContain(finalId);
        expect(deleteAttempts).toEqual([retiredId, retiredId]);
        expect(warn).toHaveBeenCalledTimes(retryFails ? 2 : 1);
        expect(warn).toHaveBeenCalledWith(
          "mattermost stream preview cleanup failed: temporary delete failure",
        );
        expect([...posts.values()]).toEqual(
          retryFails ? ["Retired plan", "Final answer"] : ["Final answer"],
        );
      } finally {
        await stream.seal();
      }
    },
  );

  it("retains a failed current-post deletion across stop until another clear", async () => {
    const warn = vi.fn();
    const deleteAttempts: string[] = [];
    const { stream, posts, publish } = createProviderPostFixture({
      warn,
      beforeDelete: async (id) => {
        deleteAttempts.push(id);
        if (deleteAttempts.length === 1) {
          throw new Error("temporary delete failure");
        }
      },
    });
    try {
      await publish("Current preview");
      const currentId = stream.postId();
      await stream.clear();
      await stream.stop();
      expect(stream.postId()).toBe(currentId);
      expect([...posts.values()]).toEqual(["Current preview"]);
      expect(deleteAttempts).toEqual([currentId]);
      expect(warn).toHaveBeenCalledTimes(1);

      await stream.clear();
      expect(posts.size).toBe(0);
      expect(deleteAttempts).toEqual([currentId, currentId]);
    } finally {
      await stream.seal();
    }
  });

  it.each(["seal", "stop"] as const)(
    "%s preserves the preview and ignores later updates",
    async (finish) => {
      const { calls, stream, publish } = createDraftStreamFixture({ rootId: "root-1" });
      await publish("Working...");
      stream.update("Stale partial");
      await stream[finish]();
      await stream.forceNewMessage();
      stream.update("Late partial");
      await stream.flush();
      expect(stream.postId()).toBe("post-1");
      expect(calls).toHaveLength(finish === "seal" ? 1 : 2);
      expect(calls[0]?.path).toBe("/posts");
      if (finish === "stop") {
        expect(calls[1]?.path).toBe("/posts/post-1/patch");
        expect(parseRequestJson(calls[1]?.init)).toEqual({
          id: "post-1",
          message: "Stale partial",
        });
      }
    },
  );

  it("retains an accepted preview failure after its background flush has settled", async () => {
    const warn = vi.fn();
    const { requestMock, stream } = createDraftStreamFixture({ warn });
    requestMock.mockResolvedValueOnce({ message: "already visible" });

    stream.update("Already delivered");
    await vi.waitFor(() => expect(warn).toHaveBeenCalledOnce());

    const caught: unknown = await stream.flush().catch((error: unknown) => error);
    expect(isChannelPartialDeliveryError(caught)).toBe(true);
    expect(requestMock.mock.calls[0]?.[0]).toBe("/posts");
    stream.update("Must not create another accepted post");
    await expect(stream.flush()).rejects.toThrow("did not include a post id");
    for (const finish of [
      "discardPending",
      "clear",
      "seal",
      "stop",
      "forceNewMessage",
      "settleBoundaries",
    ] as const) {
      await expect(stream[finish]()).rejects.toThrow("did not include a post id");
    }
    expect(requestMock).toHaveBeenCalledOnce();
  });

  it("does not resend after an update failure followed by stop", async () => {
    const warn = vi.fn();
    const { requestMock, stream, publish } = createDraftStreamFixture({ warn });
    await publish("Working...");
    requestMock.mockRejectedValueOnce(new Error("patch failed"));
    await publish("Will fail");
    await stream.stop();

    expect(warn).toHaveBeenCalledWith("mattermost stream preview failed: patch failed");
    expect(requestMock.mock.calls.map(([path]) => path)).toEqual(["/posts", "/posts/post-1/patch"]);
  });

  it("waits a throttle window after a slow preview send before the next edit", async () => {
    vi.useFakeTimers();
    const releaseCreate = createDeferred<void>();
    const { calls, stream } = createDraftStreamFixture({
      beforeRequest: (path) => (path === "/posts" ? releaseCreate.promise : Promise.resolve()),
    });
    try {
      stream.update("Working");
      await vi.advanceTimersByTimeAsync(0);
      stream.update("Working on it");
      await vi.advanceTimersByTimeAsync(2500);
      releaseCreate.resolve();
      await vi.advanceTimersByTimeAsync(1199);
      expect(calls.map(({ path }) => path)).toEqual(["/posts"]);

      await vi.advanceTimersByTimeAsync(1);
      expect(calls.map(({ path }) => path)).toEqual(["/posts", "/posts/post-1/patch"]);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("Mattermost preview final placement", () => {
  type TimelinePost = { id: string; message: string; root_id: string; type?: string };

  it.each([
    { case: "a message-tool post in its thread", rootId: "root-1", newer: {}, inPlace: false },
    {
      case: "a reply in another thread",
      rootId: "root-1",
      newer: { root_id: "root-2" },
      inPlace: true,
    },
    {
      case: "a system post",
      rootId: "root-1",
      newer: { type: "system_add_to_channel" },
      inPlace: true,
    },
    {
      case: "a thread reply after a root-level preview",
      rootId: undefined,
      newer: { root_id: "root-2" },
      inPlace: false,
    },
    { case: "a failed order check", rootId: "root-1", newer: "error", inPlace: true },
  ] as const)("places the final correctly after $case", async ({ rootId, newer, inPlace }) => {
    const timeline: TimelinePost[] = [];
    const channelReads: string[] = [];
    let nextId = 1;
    const request: MattermostClient["request"] = async <T>(
      path: string,
      init?: RequestInit,
    ): Promise<T> => {
      if (path.startsWith("/channels/channel-1/posts?")) {
        channelReads.push(path);
        if (newer === "error") {
          throw new Error("Mattermost API 403 Forbidden");
        }
        const after = new URLSearchParams(path.split("?")[1]).get("after");
        const later = timeline.slice(timeline.findIndex((post) => post.id === after) + 1);
        return {
          order: later.map((post) => post.id).toReversed(),
          posts: Object.fromEntries(later.map((post) => [post.id, post])),
        } as T;
      }
      const body = typeof init?.body === "string" ? parseRequestJson(init) : {};
      if (path === "/posts") {
        const post = {
          id: `post-${nextId++}`,
          message: String(body.message),
          root_id: typeof body.root_id === "string" ? body.root_id : "",
        };
        timeline.push(post);
        return post as T;
      }
      const id = path.slice("/posts/".length).replace(/\/patch$/, "");
      const post = timeline.find((entry) => entry.id === id);
      if (!post) {
        throw new Error(`Unexpected Mattermost request: ${init?.method} ${path}`);
      }
      if (init?.method === "DELETE") {
        timeline.splice(timeline.indexOf(post), 1);
        return undefined as T;
      }
      post.message = String(body.message);
      return post as T;
    };
    const { client, stream, publish } = createDraftStreamFixture({ request, rootId });
    const logVerboseMessage = vi.fn();
    const deliverPayload = vi.fn(async (payload: ReplyPayload) => {
      timeline.push({ id: "final-post", message: payload.text ?? "", root_id: rootId ?? "" });
      return {
        outcome: "text" as const,
        messageIds: ["final-post"],
        visibleReplySent: true,
        content: payload.text,
      };
    });

    await publish("Running tools…");
    if (newer !== "error") {
      timeline.push({ id: "newer-post", message: "Progress note", root_id: "root-1", ...newer });
    }
    await deliverMattermostReplyWithDraftPreview({
      payload: { text: "Final answer" },
      info: { kind: "final" },
      kind: "channel",
      client,
      previewLifecycle: createLivePreviewLifecycle<ReplyPayload, string>({
        draft: { ...stream, id: stream.postId },
      }),
      effectiveReplyToId: rootId,
      resolvePreviewFinalText: (text) => ({ editText: text, alreadyDelivered: false }),
      logVerboseMessage,
      deliverPayload,
      findPostAfterPreview: stream.findPostAfter,
    });

    const messages = timeline.map((post) => post.message);
    if (inPlace) {
      expect(messages[0]).toBe("Final answer");
      expect(timeline[0]?.id).toBe("post-1");
      expect(deliverPayload).not.toHaveBeenCalled();
    } else {
      // The preview is deleted and the answer lands below the newer post.
      expect(messages).toEqual(["Progress note", "Final answer"]);
      expect(logVerboseMessage).toHaveBeenCalledWith(
        "mattermost preview post-1 is above newer post newer-post; sending the final as a new post",
      );
    }
    expect(channelReads).toEqual([
      "/channels/channel-1/posts?per_page=200&after=post-1&skipFetchThreads=true",
    ]);
    if (newer === "error") {
      expect(logVerboseMessage).toHaveBeenCalledWith(
        "mattermost preview order check failed; finalizing in place (Error: Mattermost API 403 Forbidden)",
      );
    }
  });
});

describe("createMattermostDraftStream forceNewMessage", () => {
  it("propagates an accepted background failure that settles during boundary rotation", async () => {
    const { requestMock, stream } = createDraftStreamFixture();
    const createReady = createDeferred<void>();
    requestMock.mockImplementationOnce(async () => {
      await createReady.promise;
      return { message: "already visible" };
    });

    stream.update("Accepted background preview");
    await vi.waitFor(() => expect(requestMock).toHaveBeenCalledOnce());
    const boundary = stream.forceNewMessage();
    createReady.resolve();

    await expect(boundary).rejects.toThrow("did not include a post id");
    await expect(stream.flush()).rejects.toThrow("did not include a post id");
    expect(requestMock).toHaveBeenCalledOnce();
  });

  it("deduplicates Unicode-safe previews and restores lossless chunks before rotating", async () => {
    // Preview index 3997 straddles the emoji; rotation must restore it intact.
    const firstChunk = `${"a".repeat(3996)}\u{1F600}aa`;
    const secondChunk = "b".repeat(4000);
    const chunkText = vi.fn(() => [firstChunk, secondChunk]);
    const { calls, stream, publish } = createDraftStreamFixture({ chunkText, rootId: "root-1" });
    await publish(`${firstChunk}${secondChunk}`);
    await publish(`${firstChunk}${secondChunk}`);
    expect(calls).toHaveLength(1);
    expect(stream.postId()).toBe("post-1");
    expect(parseRequestJson(calls[0]?.init)).toEqual({
      channel_id: "channel-1",
      root_id: "root-1",
      message: `${"a".repeat(3996)}...`,
    });
    await stream.forceNewMessage();
    expect(stream.postId()).toBeUndefined();
    await publish("tool");

    const finalizedChunks = [
      parseRequestJson(calls[1]?.init)?.message,
      parseRequestJson(calls[2]?.init)?.message,
    ];
    expect(chunkText).toHaveBeenCalledWith(`${firstChunk}${secondChunk}`);
    expect(finalizedChunks).toEqual([firstChunk, secondChunk]);
    expect(parseRequestJson(calls[3]?.init)?.message).toBe("tool");
    expect(stream.postId()).toBe("post-3");
  });

  it("publishes overlapping fire-and-forget boundaries in generation order", async () => {
    const firstCreate = createDeferred<void>();
    const boundaryPatch = createDeferred<void>();
    const secondCreate = createDeferred<void>();
    let createdCount = 0;
    const { calls, stream } = createDraftStreamFixture({
      beforeRequest: async (path) => {
        if (path === "/posts") {
          const gate = [firstCreate, secondCreate][createdCount++];
          await gate?.promise;
        } else if (path.startsWith("/posts/")) {
          await boundaryPatch.promise;
        }
      },
    });

    stream.update("tool start");
    stream.update("tool complete");
    const firstBoundary = stream.forceNewMessage();
    stream.update("assistant progress");
    const secondBoundary = stream.forceNewMessage();
    stream.update("final answer");
    const flush = stream.flush();
    firstCreate.resolve();

    await vi.waitFor(() => {
      expect(calls.map((c) => c.path)).toEqual(["/posts", "/posts/post-1/patch"]);
    });
    boundaryPatch.resolve();
    await vi.waitFor(() => {
      expect(calls.map((c) => c.path)).toEqual(["/posts", "/posts/post-1/patch", "/posts"]);
    });
    secondCreate.resolve();
    await Promise.all([firstBoundary, secondBoundary, flush]);

    expect(calls.map((c) => c.path)).toEqual(["/posts", "/posts/post-1/patch", "/posts", "/posts"]);
    expect(calls.map(({ init }) => parseRequestJson(init).message)).toEqual([
      "tool start",
      "tool complete",
      "assistant progress",
      "final answer",
    ]);
    expect(stream.postId()).toBe("post-3");
  });

  it("resolves a cumulative terminal reply to the current confirmed generation", async () => {
    const { stream, publish } = createDraftStreamFixture();
    await publish("First block", true);
    await stream.forceNewMessage();
    await publish("Second block", true);
    expectResolution(
      stream,
      "First block\n\nSecond block complete",
      "remaining",
      "Second block complete",
    );
    expectResolution(stream, "Second block complete", "full", "Second block complete");
    expectResolution(stream, "First block extended", "full", "First block extended");
  });

  it("strips confirmed assistant blocks but not transient progress generations", async () => {
    const { stream, publish } = createDraftStreamFixture();
    await publish("First block", true);
    await stream.forceNewMessage();
    await publish("Running tool…");
    await stream.forceNewMessage();
    await stream.settleBoundaries();

    expectResolution(stream, "First block\n\nFinal after tool", "remaining", "Final after tool");
    expectResolution(stream, "First block extended", "full", "First block extended");
    expectResolution(stream, "First block", "already-delivered");
    expectResolution(stream, "", "full", "");
  });

  it("keeps the canonical final when an assistant boundary fails to publish", async () => {
    const { requestMock, stream, publish } = createDraftStreamFixture();
    await publish("First block", true);
    requestMock.mockRejectedValueOnce(new Error("boundary failed"));
    stream.updateAssistantText("First block complete");
    await stream.forceNewMessage();

    const finalText = "First block complete\n\nFinal after failure";
    expectResolution(stream, finalText, "remaining", "complete\n\nFinal after failure");
  });

  it("does not strip a requested prefix rewritten by the provider", async () => {
    const { requestMock, stream, publish } = createDraftStreamFixture({
      chunkText: () => ["First half", "Second half"],
    });
    await publish("First half Second half", true);
    requestMock
      .mockResolvedValueOnce({ id: "post-1", message: "Provider rewrite" })
      .mockRejectedValueOnce(new Error("second chunk failed"));
    await stream.forceNewMessage();

    const finalText = "First half Second half\n\nFinal after failure";
    expectResolution(stream, finalText, "full", finalText, [
      { messageId: "post-1", content: "Provider rewrite" },
    ]);
  });

  it("publishes the known prefix before an IDless failure warning re-enters", async () => {
    const finalText = "First Second Third\n\nFinal after failure";
    let resolutionAtWarning: unknown;
    let reenteredBoundary: Promise<void> | undefined;
    const warn = vi.fn(() => {
      resolutionAtWarning = stream.resolveFinalText(finalText);
      stream.update("must not publish twice");
      reenteredBoundary = stream.forceNewMessage();
      void reenteredBoundary.catch(() => {});
    });
    const { requestMock, stream, publish } = createDraftStreamFixture({
      chunkText: () => ["First", "Second", "Third"],
      warn,
    });
    await publish("First Second Third", true);
    requestMock
      .mockResolvedValueOnce({ id: "post-1", message: "First" })
      .mockResolvedValueOnce({ id: "post-2", message: "Second" })
      .mockResolvedValueOnce({ message: "Third" });

    await expect(stream.forceNewMessage()).rejects.toThrow("did not include a post id");
    await expect(reenteredBoundary).rejects.toThrow("did not include a post id");

    const expectedResolution = {
      kind: "remaining",
      text: "Third\n\nFinal after failure",
      publishedParts: [
        { messageId: "post-1", content: "First" },
        { messageId: "post-2", content: "Second" },
      ],
    };
    expect(warn).toHaveBeenCalledOnce();
    expect(resolutionAtWarning).toEqual(expectedResolution);
    expect(stream.resolveFinalText(finalText)).toEqual(expectedResolution);
    expect(requestMock.mock.calls.map(([, init]) => parseRequestJson(init).message)).toEqual([
      "First Second Third",
      "First",
      "Second",
      "Third",
    ]);
  });
});
