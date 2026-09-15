import { createPluginRuntimeMock } from "openclaw/plugin-sdk/channel-test-helpers";
import type { PluginRuntime } from "openclaw/plugin-sdk/core";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import type { PluginStateSyncKeyedStore } from "openclaw/plugin-sdk/plugin-state-runtime";
import { buildAgentSessionKey, resolveAgentRoute } from "openclaw/plugin-sdk/routing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { handleClickClackInbound } from "./inbound.js";
import { setClickClackRuntime } from "./runtime.js";
import type { ClickClackMessage, ResolvedClickClackAccount } from "./types.js";

const saveResponseMediaMock = vi.hoisted(() => vi.fn());

vi.mock("openclaw/plugin-sdk/media-runtime", () => ({
  MediaFetchError: class MediaFetchError extends Error {},
  saveResponseMedia: saveResponseMediaMock,
}));

function configureDiscussionStore(runtime: PluginRuntime): void {
  const createStore = <T>(): PluginStateSyncKeyedStore<T> => {
    const values = new Map<string, { value: T; createdAt: number }>();
    return {
      register(key, value) {
        values.set(key, { value, createdAt: Date.now() });
      },
      registerIfAbsent(key, value) {
        if (values.has(key)) {
          return false;
        }
        values.set(key, { value, createdAt: Date.now() });
        return true;
      },
      lookup: (key) => values.get(key)?.value,
      consume(key) {
        const value = values.get(key)?.value;
        values.delete(key);
        return value;
      },
      delete: (key) => values.delete(key),
      entries: () =>
        Array.from(values, ([key, entry]) => ({
          key,
          value: entry.value,
          createdAt: entry.createdAt,
        })),
      clear: () => values.clear(),
    };
  };
  const stores = new Map<string, PluginStateSyncKeyedStore<unknown>>();
  runtime.state.openSyncKeyedStore = vi.fn((options: { namespace: string }) => {
    const existing = stores.get(options.namespace);
    if (existing) {
      return existing;
    }
    const created = createStore<unknown>();
    stores.set(options.namespace, created);
    return created;
  }) as unknown as PluginRuntime["state"]["openSyncKeyedStore"];
}

function createRuntime(): PluginRuntime {
  const runtime = createPluginRuntimeMock({
    agent: {
      runEmbeddedAgent: vi.fn().mockResolvedValue({ payloads: [{ text: "ok" }], meta: {} }),
      session: { getSessionEntry: vi.fn(() => ({ sessionId: "session-id", updatedAt: 1 })) },
    },
    channel: {
      routing: {
        resolveAgentRoute: vi.fn(
          (params: Parameters<PluginRuntime["channel"]["routing"]["resolveAgentRoute"]>[0]) =>
            resolveAgentRoute(params),
        ),
        buildAgentSessionKey: vi.fn(
          (params: Parameters<PluginRuntime["channel"]["routing"]["buildAgentSessionKey"]>[0]) =>
            buildAgentSessionKey(params),
        ),
      },
    },
  } as unknown as PluginRuntime);
  configureDiscussionStore(runtime);
  return runtime;
}

function createAccount(): ResolvedClickClackAccount {
  return {
    accountId: "default",
    enabled: true,
    configured: true,
    baseUrl: "http://127.0.0.1:8080",
    apiEndpoint: "http://127.0.0.1:8080",
    token: "test-token-placeholder",
    workspace: "wsp_1",
    replyMode: "agent",
    toolsAllow: [],
    defaultTo: "channel:general",
    allowFrom: ["*"],
    allowBots: false,
    reconnectMs: 1_500,
    agentActivity: false,
    nativeProgress: false,
    commandMenu: true,
    discussions: { enabled: false, workspace: "wsp_1", section: "Sessions" },
    requireMention: false,
    mentionPatterns: [],
    groups: {},
    config: { allowFrom: ["*"] },
  };
}

function createMessage(body: string): ClickClackMessage {
  return {
    id: "msg_1",
    workspace_id: "wsp_1",
    channel_id: "chn_1",
    author_id: "usr_owner",
    thread_root_id: "msg_1",
    body,
    body_format: "markdown",
    created_at: "2026-05-09T12:00:00.000Z",
    author: {
      id: "usr_owner",
      kind: "human",
      display_name: "Peter",
      handle: "steipete",
      avatar_url: "",
      created_at: "2026-05-09T12:00:00.000Z",
    },
    attachments: [
      {
        id: "upl_image",
        workspace_id: "wsp_1",
        owner_id: "usr_owner",
        filename: "diagram.png",
        content_type: "image/png",
        byte_size: 4,
        width: 640,
        height: 480,
        duration_ms: 0,
        created_at: "2026-05-09T12:00:00.000Z",
      },
    ],
  };
}

describe("ClickClack inbound media", () => {
  beforeEach(() => {
    saveResponseMediaMock.mockReset();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it.each([
    ["already-attached image", "inspect this image"],
    ["attachment-only message", ""],
  ])("materializes an %s for the agent turn", async (_label, messageBody) => {
    const runtime = createRuntime();
    setClickClackRuntime(runtime);
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer test-token-placeholder");
      return new Response(Uint8Array.from([137, 80, 78, 71]), {
        headers: { "content-type": "image/png" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    saveResponseMediaMock.mockResolvedValue({
      id: "diagram.png---saved.png",
      path: "/tmp/openclaw-media/inbound/diagram.png---saved.png",
      size: 4,
      contentType: "image/png",
    });

    await handleClickClackInbound({
      account: createAccount(),
      config: {},
      message: createMessage(messageBody),
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "http://127.0.0.1:8080/api/uploads/upl_image",
      expect.objectContaining({ headers: expect.any(Headers) }),
    );
    expect(saveResponseMediaMock).toHaveBeenCalledWith(
      expect.any(Response),
      expect.objectContaining({
        fallbackContentType: "image/png",
        filePathHint: "diagram.png",
        maxBytes: 64 * 1024 * 1024,
        originalFilename: "diagram.png",
      }),
    );
    const ctxPayload = vi.mocked(runtime.channel.inbound.dispatch).mock.calls[0]?.[0].ctxPayload;
    if (!ctxPayload) {
      throw new Error("expected inbound dispatch context");
    }
    expect(ctxPayload.BodyForAgent).toBe(messageBody);
    expect(ctxPayload.media).toEqual([
      expect.objectContaining({
        path: "/tmp/openclaw-media/inbound/diagram.png---saved.png",
        contentType: "image/png",
        kind: "image",
        fileName: "diagram.png",
        messageId: "msg_1",
        width: 640,
        height: 480,
      }),
    ]);
  });

  it("keeps permanent upload failures local to the attachment", async () => {
    const runtime = createRuntime();
    setClickClackRuntime(runtime);
    const message = createMessage("inspect what is available");
    const firstAttachment = message.attachments?.[0];
    if (!firstAttachment) {
      throw new Error("expected attachment fixture");
    }
    message.attachments?.push({
      ...firstAttachment,
      id: "upl_available",
      filename: "available.png",
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) =>
        (typeof input === "string"
          ? input
          : input instanceof URL
            ? input.href
            : input.url
        ).endsWith("/upl_image")
          ? new Response("gone", { status: 404 })
          : new Response(Uint8Array.from([137, 80, 78, 71])),
      ),
    );
    saveResponseMediaMock.mockResolvedValue({
      path: "/tmp/openclaw-media/inbound/available.png",
      size: 4,
      contentType: "image/png",
    });

    await handleClickClackInbound({ account: createAccount(), config: {}, message });

    expect(saveResponseMediaMock).toHaveBeenCalledOnce();
    const ctxPayload = vi.mocked(runtime.channel.inbound.dispatch).mock.calls[0]?.[0].ctxPayload;
    expect(ctxPayload?.BodyForAgent).toContain(
      "[ClickClack attachment unavailable: diagram.png could not be retrieved]",
    );
    expect(ctxPayload?.media).toEqual([
      expect.objectContaining({ fileName: "available.png", kind: "image" }),
    ]);
  });

  it("keeps transient upload failures retryable", async () => {
    const runtime = createRuntime();
    setClickClackRuntime(runtime);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("retry", { status: 503 })),
    );

    await expect(
      handleClickClackInbound({
        account: createAccount(),
        config: {},
        message: createMessage("inspect this"),
      }),
    ).rejects.toMatchObject({ status: 503 });
    expect(runtime.channel.inbound.dispatch).not.toHaveBeenCalled();
  });

  it("does not publish progress or dispatch after shutdown during staging", async () => {
    const runtime = createRuntime();
    setClickClackRuntime(runtime);
    const staged = createDeferred<{
      path: string;
      size: number;
      contentType: string;
    }>();
    saveResponseMediaMock.mockReturnValue(staged.promise);
    const fetchMock = vi.fn(async () => new Response(Uint8Array.from([137, 80, 78, 71])));
    vi.stubGlobal("fetch", fetchMock);
    const abort = new AbortController();
    const account = { ...createAccount(), nativeProgress: true };

    const pending = handleClickClackInbound({
      account,
      config: {},
      message: createMessage("inspect this"),
      abortSignal: abort.signal,
    });
    await vi.waitFor(() => expect(saveResponseMediaMock).toHaveBeenCalledOnce());
    abort.abort();
    staged.resolve({ path: "/tmp/staged.png", size: 4, contentType: "image/png" });
    await pending;

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(runtime.channel.inbound.dispatch).not.toHaveBeenCalled();
  });
});
