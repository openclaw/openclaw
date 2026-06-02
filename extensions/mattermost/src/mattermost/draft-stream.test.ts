import { describe, expect, it, vi } from "vitest";
import type { MattermostClient } from "./client.js";
import {
  buildMattermostToolStatusText,
  createMattermostDraftPreviewBoundaryController,
  createMattermostDraftStream,
} from "./draft-stream.js";

type RequestRecord = {
  path: string;
  init?: RequestInit;
};

function createMockClient(): {
  client: MattermostClient;
  calls: RequestRecord[];
  requestMock: ReturnType<typeof vi.fn>;
} {
  const calls: RequestRecord[] = [];
  let nextId = 1;
  const requestImpl: MattermostClient["request"] = async <T>(
    path: string,
    init?: RequestInit,
  ): Promise<T> => {
    calls.push({ path, init });
    if (path === "/posts") {
      return { id: `post-${nextId++}` } as T;
    }
    if (path.startsWith("/posts/")) {
      return { id: "patched" } as T;
    }
    return {} as T;
  };
  const requestMock = vi.fn(requestImpl);
  const client: MattermostClient = {
    baseUrl: "https://chat.example.com",
    apiBaseUrl: "https://chat.example.com/api/v4",
    token: "token",
    request: requestMock as MattermostClient["request"],
    fetchImpl: vi.fn() as MattermostClient["fetchImpl"],
  };
  return { client, calls, requestMock };
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

    expect(parseRequestJson(calls[0]?.init)).toEqual({
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

  it("clears the preview post when no final reply is delivered", async () => {
    const { client, calls } = createMockClient();
    const stream = createMattermostDraftStream({
      client,
      channelId: "channel-1",
      rootId: "root-1",
      throttleMs: 0,
    });

    stream.update("Working...");
    await stream.flush();
    await stream.clear();

    expect(calls).toHaveLength(2);
    expect(calls[1]?.path).toBe("/posts/post-1");
    expect(calls[1]?.init?.method).toBe("DELETE");
    expect(stream.postId()).toBeUndefined();
  });

  it("discardPending keeps the preview post but ignores later updates", async () => {
    const { client, calls } = createMockClient();
    const stream = createMattermostDraftStream({
      client,
      channelId: "channel-1",
      rootId: "root-1",
      throttleMs: 0,
    });

    stream.update("Working...");
    await stream.flush();
    await stream.discardPending();
    stream.update("Late update");
    await stream.flush();

    expect(calls).toHaveLength(1);
    expect(calls[0]?.path).toBe("/posts");
    expect(stream.postId()).toBe("post-1");
  });

  it("seal keeps the preview post and cancels pending final overwrites", async () => {
    const { client, calls } = createMockClient();
    const stream = createMattermostDraftStream({
      client,
      channelId: "channel-1",
      rootId: "root-1",
      throttleMs: 0,
    });

    stream.update("Working...");
    await stream.flush();
    stream.update("Stale final draft");
    await stream.seal();

    expect(calls).toHaveLength(1);
    expect(calls[0]?.path).toBe("/posts");
    expect(stream.postId()).toBe("post-1");
  });

  it("stop flushes the last pending update and ignores later ones", async () => {
    const { client, calls } = createMockClient();
    const stream = createMattermostDraftStream({
      client,
      channelId: "channel-1",
      rootId: "root-1",
      throttleMs: 1000,
    });

    stream.update("Working...");
    await stream.flush();
    stream.update("Stale partial");
    await stream.stop();
    stream.update("Late partial");
    await stream.flush();

    expect(calls).toHaveLength(2);
    expect(calls[0]?.path).toBe("/posts");
    expect(calls[1]?.path).toBe("/posts/post-1");
    expect(parseRequestJson(calls[1]?.init)).toEqual({
      id: "post-1",
      message: "Stale partial",
    });
  });

  it("warns and stops when preview creation fails", async () => {
    const warn = vi.fn();
    const requestImpl: MattermostClient["request"] = async () => {
      throw new Error("boom");
    };
    const requestMock = vi.fn(requestImpl);
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
      throttleMs: 0,
      warn,
    });

    stream.update("Working...");
    await stream.flush();
    stream.update("Still working...");
    await stream.flush();

    expect(warn).toHaveBeenCalled();
    expect(requestMock).toHaveBeenCalledTimes(1);
    expect(stream.postId()).toBeUndefined();
  });

  it("does not resend after an update failure followed by stop", async () => {
    const warn = vi.fn();
    const calls: RequestRecord[] = [];
    let failNextPatch = true;
    const requestImpl: MattermostClient["request"] = async <T>(
      path: string,
      init?: RequestInit,
    ): Promise<T> => {
      calls.push({ path, init });
      if (path === "/posts") {
        return { id: "post-1" } as T;
      }
      if (path === "/posts/post-1") {
        if (failNextPatch) {
          failNextPatch = false;
          throw new Error("patch failed");
        }
        return { id: "patched" } as T;
      }
      return {} as T;
    };
    const requestMock = vi.fn(requestImpl);
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
      throttleMs: 1000,
      warn,
    });

    stream.update("Working...");
    await stream.flush();
    stream.update("Will fail");
    await stream.flush();
    await stream.stop();

    expect(warn).toHaveBeenCalledWith("mattermost stream preview failed: patch failed");
    expect(calls).toHaveLength(2);
    expect(calls[0]?.path).toBe("/posts");
    expect(calls[1]?.path).toBe("/posts/post-1");
  });
});

describe("createMattermostDraftStream forceNewMessage", () => {
  it("creates a new post on the next update after forceNewMessage", async () => {
    const { client, calls } = createMockClient();
    const stream = createMattermostDraftStream({
      client,
      channelId: "channel-1",
      rootId: "root-1",
      throttleMs: 0,
    });

    stream.update("Running `read`…");
    await stream.flush();
    expect(stream.postId()).toBe("post-1");

    await stream.forceNewMessage();

    stream.update("Here are the contents.");
    await stream.flush();

    expect(calls).toHaveLength(2);
    expect(calls[0]?.path).toBe("/posts");
    expect(calls[1]?.path).toBe("/posts");
    expect(parseRequestJson(calls[0]?.init)).toEqual({
      channel_id: "channel-1",
      root_id: "root-1",
      message: "Running `read`…",
    });
    expect(parseRequestJson(calls[1]?.init)).toEqual({
      channel_id: "channel-1",
      root_id: "root-1",
      message: "Here are the contents.",
    });
    expect(stream.postId()).toBe("post-2");
  });

  it("flushes a pending in-flight create before forcing a new post", async () => {
    const calls: RequestRecord[] = [];
    let nextId = 1;
    let releaseFirstCreate: (() => void) | undefined;
    const firstCreateInFlight = new Promise<void>((resolve) => {
      releaseFirstCreate = resolve;
    });
    let createdCount = 0;
    const requestImpl: MattermostClient["request"] = async <T>(
      path: string,
      init?: RequestInit,
    ): Promise<T> => {
      calls.push({ path, init });
      if (path === "/posts") {
        createdCount += 1;
        if (createdCount === 1) {
          await firstCreateInFlight;
        }
        return { id: `post-${nextId++}` } as T;
      }
      if (path.startsWith("/posts/")) {
        return { id: "patched" } as T;
      }
      return {} as T;
    };
    const requestMock = vi.fn(requestImpl);
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
      throttleMs: 0,
    });

    stream.update("block A");
    const boundary = stream.forceNewMessage();
    releaseFirstCreate?.();
    await boundary;

    stream.update("block B");
    await stream.flush();

    expect(calls.map((c) => c.path)).toEqual(["/posts", "/posts"]);
    expect(parseRequestJson(calls[0]?.init)?.message).toBe("block A");
    expect(parseRequestJson(calls[1]?.init)?.message).toBe("block B");
    expect(stream.postId()).toBe("post-2");
  });
});

describe("createMattermostDraftPreviewBoundaryController", () => {
  it("calls forceNewMessage on boundary when enabled and content was streamed", async () => {
    const forceNewMessage = vi.fn();
    const controller = createMattermostDraftPreviewBoundaryController({
      enabled: true,
      forceNewMessage,
    });

    controller.noteUpdate();
    await controller.noteBoundary();

    expect(forceNewMessage).toHaveBeenCalledTimes(1);
  });

  it("skips forceNewMessage when no content was streamed since the last boundary", async () => {
    const forceNewMessage = vi.fn();
    const controller = createMattermostDraftPreviewBoundaryController({
      enabled: true,
      forceNewMessage,
    });

    await controller.noteBoundary();
    await controller.noteBoundary();
    controller.noteUpdate();
    await controller.noteBoundary();
    await controller.noteBoundary();

    expect(forceNewMessage).toHaveBeenCalledTimes(1);
  });

  it("never calls forceNewMessage when disabled", async () => {
    const forceNewMessage = vi.fn();
    const controller = createMattermostDraftPreviewBoundaryController({
      enabled: false,
      forceNewMessage,
    });

    controller.noteUpdate();
    await controller.noteBoundary();
    controller.noteUpdate();
    await controller.noteBoundary();

    expect(forceNewMessage).not.toHaveBeenCalled();
  });

  it("awaits the forceNewMessage promise before resolving the boundary", async () => {
    let releaseForce: (() => void) | undefined;
    const forcePending = new Promise<void>((resolve) => {
      releaseForce = resolve;
    });
    const forceNewMessage = vi.fn(async () => {
      await forcePending;
    });
    const controller = createMattermostDraftPreviewBoundaryController({
      enabled: true,
      forceNewMessage,
    });

    controller.noteUpdate();
    let resolved = false;
    const boundary = controller.noteBoundary().then(() => {
      resolved = true;
    });

    await Promise.resolve();
    await Promise.resolve();
    expect(resolved).toBe(false);

    releaseForce?.();
    await boundary;
    expect(resolved).toBe(true);
    expect(forceNewMessage).toHaveBeenCalledTimes(1);
  });
});

describe("buildMattermostToolStatusText", () => {
  it("renders a status with the shared tool label", () => {
    expect(buildMattermostToolStatusText({ name: "read" })).toBe("📖 Read");
  });

  it("honors raw exec detail mode", () => {
    expect(
      buildMattermostToolStatusText({
        name: "exec",
        args: { command: "pnpm test -- --watch=false" },
        detailMode: "raw",
      }),
    ).toBe("🛠️ run tests, `pnpm test -- --watch=false`");
  });

  it("can hide raw exec detail from status text", () => {
    expect(
      buildMattermostToolStatusText({
        name: "exec",
        args: { command: "pnpm test -- --watch=false" },
        detailMode: "raw",
        config: { streaming: { preview: { commandText: "status" } } },
      }),
    ).toBe("🛠️ Exec");
  });
});
