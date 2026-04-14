import { describe, expect, it, vi } from "vitest";
import type { MattermostClient } from "./client.js";
import { buildMattermostToolStatusText, createMattermostDraftStream } from "./draft-stream.js";

type RequestRecord = {
  path: string;
  init?: RequestInit;
};

function createMockClient(): {
  client: MattermostClient;
  calls: RequestRecord[];
  request: ReturnType<typeof vi.fn>;
} {
  const calls: RequestRecord[] = [];
  let nextId = 1;
  const request = vi.fn(async <T>(path: string, init?: RequestInit): Promise<T> => {
    calls.push({ path, init });
    if (path === "/posts") {
      return { id: `post-${nextId++}` } as T;
    }
    if (path.startsWith("/posts/")) {
      return { id: "patched" } as T;
    }
    return {} as T;
  });
  const client: MattermostClient = {
    baseUrl: "https://chat.example.com",
    apiBaseUrl: "https://chat.example.com/api/v4",
    token: "token",
    request: request as MattermostClient["request"],
    fetchImpl: vi.fn(async () => new Response(null, { status: 204 })),
  };
  return { client, calls, request };
}

describe("createMattermostDraftStream", () => {
  it("creates a preview post and updates it on later changes", async () => {
    const { client, calls } = createMockClient();
    const stream = createMattermostDraftStream({
      client,
      channelId: "channel-1",
      rootId: "root-1",
      throttleMs: 0,
    });

    stream.update("Running `read`…");
    await stream.flush();
    stream.update("Running `read`…");
    await stream.flush();

    expect(calls).toHaveLength(1);
    expect(calls[0]?.path).toBe("/posts");

    const createBody = JSON.parse(calls[0]?.init?.body as string);
    expect(createBody).toMatchObject({
      channel_id: "channel-1",
      root_id: "root-1",
      message: "Running `read`…",
    });
    expect(stream.postId()).toBe("post-1");
  });

  it("does not resend identical updates", async () => {
    const { client, calls } = createMockClient();
    const stream = createMattermostDraftStream({
      client,
      channelId: "channel-1",
      throttleMs: 0,
    });

    stream.update("Working...");
    await stream.flush();
    stream.update("Working...");
    await stream.flush();

    expect(calls).toHaveLength(1);
  });

  it("warns and stops when preview creation fails", async () => {
    const warn = vi.fn();
    const request = vi.fn(async () => {
      throw new Error("boom");
    });
    const client: MattermostClient = {
      baseUrl: "https://chat.example.com",
      apiBaseUrl: "https://chat.example.com/api/v4",
      token: "token",
      request: request as MattermostClient["request"],
      fetchImpl: vi.fn(async () => new Response(null, { status: 204 })),
    };
    const stream = createMattermostDraftStream({
      client,
      channelId: "channel-1",
      throttleMs: 0,
      warn,
    });

    stream.update("Working...");
    await stream.flush();
    stream.update("Still working...");
    await stream.flush();

    expect(warn).toHaveBeenCalled();
    expect(request).toHaveBeenCalledTimes(1);
    expect(stream.postId()).toBeUndefined();
  });
});

describe("buildMattermostToolStatusText", () => {
  it("renders a start status when phase is absent", () => {
    expect(buildMattermostToolStatusText({ name: "read" })).toBe("Running `read`…");
  });

  it("renders an update status when phase is update", () => {
    expect(buildMattermostToolStatusText({ name: "exec", phase: "update" })).toBe(
      "Running `exec`…",
    );
  });
});
