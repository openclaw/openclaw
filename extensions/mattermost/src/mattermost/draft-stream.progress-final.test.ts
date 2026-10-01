import { describe, expect, it, vi } from "vitest";
import type { MattermostClient } from "./client.js";
import { createMattermostDraftStream, MATTERMOST_PROGRESS_POST_TYPE } from "./draft-stream.js";

type RequestRecord = { path: string; init?: RequestInit };

function createFixture(
  options: {
    rootId?: string;
    postType?: string;
    throttleMs?: number;
    postResponses?: unknown[];
  } = {},
) {
  const calls: RequestRecord[] = [];
  let nextId = 1;
  const postResponses = [...(options.postResponses ?? [])];
  const { postResponses: _postResponses, ...streamOptions } = options;
  const request: MattermostClient["request"] = async <T>(
    path: string,
    init?: RequestInit,
  ): Promise<T> => {
    calls.push({ path, init });
    if (path === "/posts") {
      if (postResponses.length > 0) {
        const response = postResponses.shift();
        if (response instanceof Error) {
          throw response;
        }
        return response as T;
      }
      return { id: `post-${nextId++}` } as T;
    }
    return { id: "post-1" } as T;
  };
  const client: MattermostClient = {
    baseUrl: "https://chat.example.com",
    apiBaseUrl: "https://chat.example.com/api/v4",
    token: "token",
    request: vi.fn(request) as MattermostClient["request"],
    fetchImpl: vi.fn() as MattermostClient["fetchImpl"],
  };
  const stream = createMattermostDraftStream({
    client,
    channelId: "channel-1",
    throttleMs: 0,
    ...streamOptions,
  });
  return { calls, stream };
}

function parseRequestJson(init: RequestInit | undefined): Record<string, unknown> {
  if (typeof init?.body !== "string") {
    throw new Error("expected JSON request body");
  }
  return JSON.parse(init.body) as Record<string, unknown>;
}

describe("Mattermost typed progress draft stream", () => {
  it("creates typed progress posts atomically and edits them normally", async () => {
    const { calls, stream } = createFixture({
      rootId: "root-1",
      postType: MATTERMOST_PROGRESS_POST_TYPE,
    });

    stream.update("Working");
    await stream.flush();
    stream.update("Still working");
    await stream.flush();

    expect(parseRequestJson(calls[0]?.init)).toMatchObject({
      channel_id: "channel-1",
      root_id: "root-1",
      message: "Working",
      type: MATTERMOST_PROGRESS_POST_TYPE,
    });
    expect(calls[1]?.path).toBe("/posts/post-1/patch");
    expect(parseRequestJson(calls[1]?.init)).not.toHaveProperty("type");
  });

  it("replaces a throttled stale update with terminal failure text", async () => {
    const { calls, stream } = createFixture({ throttleMs: 1000 });

    stream.update("Working");
    await stream.flush();
    stream.update("Stale partial");
    await expect(stream.retainTerminalText("Failed.")).resolves.toBe(true);

    expect(calls.map((call) => [call.path, call.init?.method])).toEqual([
      ["/posts", "POST"],
      ["/posts/post-1/patch", "PUT"],
    ]);
    expect(parseRequestJson(calls[1]?.init)).toEqual({
      id: "post-1",
      message: "Failed.",
    });
  });

  it("creates a typed terminal post when no progress post exists yet", async () => {
    const { calls, stream } = createFixture({ postType: MATTERMOST_PROGRESS_POST_TYPE });

    await expect(stream.retainTerminalText("Failed.")).resolves.toBe(true);

    expect(parseRequestJson(calls[0]?.init)).toMatchObject({
      channel_id: "channel-1",
      message: "Failed.",
      type: MATTERMOST_PROGRESS_POST_TYPE,
    });
    expect(stream.postId()).toBe("post-1");
  });

  it("does not duplicate an accepted terminal post whose receipt has no usable id", async () => {
    const { calls, stream } = createFixture({
      postType: MATTERMOST_PROGRESS_POST_TYPE,
      postResponses: [{}, { id: "duplicate-post" }],
    });

    await expect(stream.retainTerminalText("Failed.")).rejects.toMatchObject({
      code: "CHANNEL_PARTIAL_DELIVERY",
    });
    await expect(stream.retainTerminalText("Failed.")).rejects.toMatchObject({
      code: "CHANNEL_PARTIAL_DELIVERY",
    });

    expect(calls.filter((call) => call.path === "/posts")).toHaveLength(1);
  });

  it("allows a terminal post retry after a definite provider rejection", async () => {
    const { calls, stream } = createFixture({
      postType: MATTERMOST_PROGRESS_POST_TYPE,
      postResponses: [new Error("provider rejected post"), { id: "retry-post" }],
    });

    await expect(stream.retainTerminalText("Failed.")).rejects.toThrow("provider rejected post");
    await expect(stream.retainTerminalText("Failed.")).resolves.toBe(true);

    expect(calls.filter((call) => call.path === "/posts")).toHaveLength(2);
    expect(stream.postId()).toBe("retry-post");
  });
});
