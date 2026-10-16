import { createHmac } from "node:crypto";
import type { ServerResponse } from "node:http";
import {
  createMockIncomingRequest,
  createMockServerResponse,
  postRawWebhook,
  withServer,
} from "openclaw/plugin-sdk/test-env";
import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import type { PluginRuntime } from "../../runtime-api.js";
import { setMattermostRuntime } from "../runtime.js";
import { resolveMattermostAccount } from "./accounts.js";
import type { MattermostClient, MattermostPost } from "./client.js";
import {
  buildButtonAttachments,
  buildButtonProps,
  computeInteractionCallbackUrl,
  createMattermostInteractionHandler,
  resolveInteractionCallbackUrl,
  setInteractionCallbackUrl,
  setInteractionSecret,
} from "./interactions.js";

type ButtonAttachments = ReturnType<typeof buildButtonAttachments>;
type ButtonPropsInput = Parameters<typeof buildButtonAttachments>[0];

function buildButtonAttachmentsForTest(params: ButtonPropsInput): ButtonAttachments {
  const signedChannelId = params.buttons[0]?.context?.["__openclaw_channel_id"];
  const props = buildButtonProps({
    ...params,
    accountId: params.accountId ?? "default",
    channelId: typeof signedChannelId === "string" ? signedChannelId : "test-channel",
  });
  const attachments = props?.attachments;
  if (!Array.isArray(attachments)) {
    throw new Error("Expected button attachments");
  }
  return attachments as ButtonAttachments;
}

function requireAction(attachments: ButtonAttachments) {
  const action = attachments[0]?.actions[0];
  if (!action) {
    throw new Error("Expected button attachment action");
  }
  return action;
}

function generateInteractionToken(context: Record<string, unknown>, accountId?: string): string {
  const actionId = typeof context.action_id === "string" ? context.action_id : "test";
  const attachments = buildButtonAttachmentsForTest({
    callbackUrl: "https://gateway.example.com/mattermost/interactions/test",
    accountId,
    buttons: [{ id: actionId, name: "Test", context }],
  });
  return String(requireAction(attachments).integration.context["_token"]);
}

function verifyInteractionToken(
  context: Record<string, unknown>,
  token: string,
  accountId?: string,
): boolean {
  return generateInteractionToken(context, accountId) === token;
}

describe("setInteractionSecret / getInteractionSecret", () => {
  beforeEach(() => {
    setInteractionSecret("default", "test-bot-token");
  });

  it("signs public account-free attachments with the sole registered account", () => {
    const attachments = buildButtonAttachments({
      callbackUrl: "https://gateway.example.com/mattermost/interactions/default",
      buttons: [{ id: "probe", name: "Probe" }],
    });
    const secret = createHmac("sha256", "openclaw-mattermost-interactions")
      .update("test-bot-token")
      .digest("hex");
    expect(attachments[0]?.actions?.[0]?.integration.context["_token"]).toBe(
      createHmac("sha256", secret).update('{"action_id":"probe"}').digest("hex"),
    );
  });
});

describe("generateInteractionToken / verifyInteractionToken", () => {
  beforeEach(() => {
    setInteractionSecret("default", "test-bot-token");
  });

  it("rejects nested context tampering", () => {
    const originalContext = {
      action_id: "nested",
      payload: { provider: "openai", model: "gpt-5" },
    };
    const token = generateInteractionToken(originalContext);
    const tamperedContext = {
      action_id: "nested",
      payload: { ...originalContext.payload, provider: "anthropic" },
    };

    expect(verifyInteractionToken(tamperedContext, token)).toBe(false);
  });

  it("scopes tokens per account when account secrets differ", () => {
    setInteractionSecret("acct-a", "bot-token-a");
    setInteractionSecret("acct-b", "bot-token-b");
    const context = { action_id: "do_now", item_id: "123" };
    const tokenA = generateInteractionToken(context, "acct-a");

    expect(verifyInteractionToken(context, tokenA, "acct-a")).toBe(true);
    expect(verifyInteractionToken(context, tokenA, "acct-b")).toBe(false);
  });
});

describe("resolveInteractionCallbackUrl", () => {
  afterEach(() => {
    for (const accountId of ["cached", "default", "acct", "myaccount"]) {
      setInteractionCallbackUrl(accountId, "");
    }
  });

  it("prefers cached URL from registry", () => {
    setInteractionCallbackUrl("cached", "http://cached:1234/path");
    expect(resolveInteractionCallbackUrl("cached")).toBe("http://cached:1234/path");
  });

  it("recomputes from config when bypassing the cache explicitly", () => {
    setInteractionCallbackUrl("acct", "http://cached:1234/path");
    const url = computeInteractionCallbackUrl("acct", {
      gateway: { port: 9999, customBindHost: "gateway.internal" },
    });
    expect(url).toBe("http://gateway.internal:9999/mattermost/interactions/acct");
  });

  it("trims trailing slashes from callbackBaseUrl", () => {
    const url = resolveInteractionCallbackUrl("acct", {
      channels: {
        mattermost: {
          interactions: {
            callbackBaseUrl: "https://gateway.example.com/root///",
          },
        },
      },
    });
    expect(url).toBe("https://gateway.example.com/root/mattermost/interactions/acct");
  });

  it("uses merged per-account interactions.callbackBaseUrl", () => {
    const cfg = {
      gateway: { port: 9999 },
      channels: {
        mattermost: {
          accounts: {
            acct: {
              botToken: "bot-token",
              baseUrl: "https://chat.example.com",
              interactions: {
                callbackBaseUrl: "https://gateway.example.com/root",
              },
            },
          },
        },
      },
    };
    const account = resolveMattermostAccount({
      cfg,
      accountId: "acct",
    });
    const url = resolveInteractionCallbackUrl(account.accountId, {
      gateway: cfg.gateway,
      interactions: account.config.interactions,
    });
    expect(url).toBe("https://gateway.example.com/root/mattermost/interactions/acct");
  });

  it("falls back to localhost when customBindHost is a wildcard bind address", () => {
    const url = resolveInteractionCallbackUrl("default", {
      gateway: { port: 9999, customBindHost: "0.0.0.0" },
    });
    expect(url).toBe("http://localhost:9999/mattermost/interactions/default");
  });

  it("brackets IPv6 custom bind hosts", () => {
    const url = resolveInteractionCallbackUrl("acct", {
      gateway: { port: 9999, customBindHost: "::1" },
    });
    expect(url).toBe("http://[::1]:9999/mattermost/interactions/acct");
  });
});

describe("buildButtonProps attachments", () => {
  beforeEach(() => {
    setInteractionSecret("default", "test-bot-token");
  });

  it("sets type to 'button' on every action", () => {
    const result = buildButtonAttachmentsForTest({
      callbackUrl: "http://localhost:18789/cb",
      buttons: [{ id: "my_action", name: "A" }],
    });

    const action = requireAction(result);
    expect(action).toMatchObject({
      type: "button",
      id: "myaction",
      integration: { context: { action_id: "myaction" } },
    });
  });
});

describe("createMattermostInteractionHandler", () => {
  function setInteractionRuntime(
    enqueueSystemEvent: (
      text: string,
      options: { sessionKey?: string | null; sessionId?: string | null; userId?: string | null },
    ) => boolean = () => true,
  ) {
    setMattermostRuntime({ system: { enqueueSystemEvent } } as unknown as PluginRuntime);
  }

  function createMattermostClientMock(
    requestImpl: (path: string, init?: { method?: string }) => Promise<unknown>,
  ): MattermostClient {
    return {
      baseUrl: "https://chat.example.com",
      apiBaseUrl: "https://chat.example.com/api/v4",
      token: "bot-token",
      request: async <T>(path: string, init?: RequestInit) => (await requestImpl(path, init)) as T,
      fetchImpl: vi.fn<typeof fetch>(),
    };
  }

  beforeEach(() => {
    setInteractionRuntime();
    setInteractionSecret("acct", "bot-token");
  });

  function createActionContext(actionId = "approve", channelId = "chan-1") {
    const context = { action_id: actionId, __openclaw_channel_id: channelId };
    return { context, token: generateInteractionToken(context, "acct") };
  }

  function createHandler(
    options: Partial<Parameters<typeof createMattermostInteractionHandler>[0]> = {},
  ) {
    return createMattermostInteractionHandler({
      client: createMattermostClientMock(async () => ({ message: "unused" })),
      accountId: "acct",
      ...options,
    });
  }

  function createInteractionBody(params: {
    context: Record<string, unknown>;
    token: string;
    channelId?: string;
    postId?: string;
    userId?: string;
    userName?: string;
  }) {
    return {
      user_id: params.userId ?? "user-1",
      ...(params.userName ? { user_name: params.userName } : {}),
      channel_id: params.channelId ?? "chan-1",
      post_id: params.postId ?? "post-1",
      context: { ...params.context, _token: params.token },
    };
  }

  async function runHandler(
    handler: ReturnType<typeof createMattermostInteractionHandler>,
    params: {
      body: unknown;
      remoteAddress?: string;
      headers?: Record<string, string>;
    },
  ) {
    const body =
      typeof params.body === "string" ? params.body : (JSON.stringify(params.body) ?? "");
    const req = createMockIncomingRequest([body]);
    req.method = "POST";
    req.headers = params.headers ?? {};
    Object.defineProperty(req.socket, "remoteAddress", {
      value: params.remoteAddress ?? "203.0.113.10",
    });
    const res = createMockServerResponse();
    await handler(req, res);
    return res;
  }

  function expectForbiddenResponse(
    res: ServerResponse & { body?: string },
    expectedMessage: string,
  ) {
    expect(res.statusCode).toBe(403);
    expect(res.body).toContain(expectedMessage);
  }

  function createActionPost(params?: {
    actionId?: string;
    actionName?: string;
    channelId?: string;
    rootId?: string;
  }): MattermostPost {
    const action = { id: params?.actionId ?? "approve", name: params?.actionName ?? "Approve" };
    return {
      id: "post-1",
      channel_id: params?.channelId ?? "chan-1",
      ...(params?.rootId ? { root_id: params.rootId } : {}),
      message: "Choose",
      props: { attachments: [{ actions: [action] }] },
    };
  }

  function runSignedHandler(
    handler: ReturnType<typeof createMattermostInteractionHandler>,
    overrides: Partial<Parameters<typeof createInteractionBody>[0]> = {},
  ) {
    return runHandler(handler, {
      body: createInteractionBody({ ...createActionContext(), ...overrides }),
    });
  }

  it("rejects a null callback body with a stable parser error", async () => {
    const log = vi.fn();
    const handler = createHandler({
      client: createMattermostClientMock(async () => {
        throw new Error("unexpected client request");
      }),
      log,
    });

    const res = await runHandler(handler, { body: "null" });

    expect(res.statusCode).toBe(400);
    expect(res.body).toBe(JSON.stringify({ error: "Invalid request body" }));
    expect(log).toHaveBeenCalledWith(
      "mattermost interaction: failed to parse body: Error: Mattermost interaction body was malformed JSON",
    );
  });

  it("accepts forwarded Mattermost source IPs from a trusted proxy", async () => {
    const requestLog: Array<{ path: string; method?: string }> = [];
    const handler = createHandler({
      client: createMattermostClientMock(async (path, init) => {
        requestLog.push({ path, method: init?.method });
        return init?.method === "PUT"
          ? { id: "post-1" }
          : createActionPost({ actionName: "approve" });
      }),
      allowedSourceIps: ["198.51.100.8"],
      trustedProxies: ["127.0.0.1"],
    });
    const res = await runHandler(handler, {
      remoteAddress: "127.0.0.1",
      headers: { "x-forwarded-for": "198.51.100.8" },
      body: createInteractionBody({ ...createActionContext(), userName: "alice" }),
    });
    expect(res).toMatchObject({ statusCode: 200, body: "{}" });
    expect(requestLog).toEqual([
      { path: "/posts/post-1", method: undefined },
      { path: "/posts/post-1/patch", method: "PUT" },
    ]);
  });

  it("rejects callback requests from non-allowlisted source IPs", async () => {
    const { context, token } = createActionContext();
    const handler = createHandler({
      client: createMattermostClientMock(async () => {
        throw new Error("should not fetch post for rejected origins");
      }),
      allowedSourceIps: ["127.0.0.1"],
    });

    const res = await runHandler(handler, {
      remoteAddress: "198.51.100.8",
      body: createInteractionBody({ context, token }),
    });
    expectForbiddenResponse(res, "Forbidden origin");
  });

  it("rejects requests with an invalid interaction token", async () => {
    const res = await runSignedHandler(createHandler(), {
      context: { action_id: "approve" },
      token: "deadbeef",
    });
    expectForbiddenResponse(res, "Invalid token");
  });

  it("rejects requests when the signed channel does not match the callback payload", async () => {
    const res = await runSignedHandler(createHandler(), { channelId: "chan-2" });
    expectForbiddenResponse(res, "Channel mismatch");
  });

  it("rejects requests when the fetched post does not belong to the callback channel", async () => {
    const handler = createHandler({
      client: createMattermostClientMock(async () => createActionPost({ channelId: "chan-9" })),
    });
    const res = await runSignedHandler(handler);
    expectForbiddenResponse(res, "Post/channel mismatch");
  });

  it("rejects requests when the action is not present on the fetched post", async () => {
    const res = await runSignedHandler(
      createHandler({
        client: createMattermostClientMock(async () =>
          createActionPost({ actionId: "reject", actionName: "reject" }),
        ),
      }),
    );
    expectForbiddenResponse(res, "Unknown action");
  });

  it("blocks button dispatch when the sender is not allowed for the action", async () => {
    const dispatchButtonClick = vi.fn();
    const handleInteraction = vi.fn();
    const handler = createHandler({
      client: createMattermostClientMock(async (_path: string, init?: { method?: string }) =>
        init?.method === "PUT" ? { id: "post-1" } : createActionPost(),
      ),
      authorizeButtonClick: async () => ({ ok: false, response: { ephemeral_text: "blocked" } }),
      handleInteraction,
      dispatchButtonClick,
    });

    const res = await runSignedHandler(handler);

    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("blocked");
    expect(handleInteraction).not.toHaveBeenCalled();
    expect(dispatchButtonClick).not.toHaveBeenCalled();
  });

  it("forwards fetched post threading metadata to session and button callbacks", async () => {
    const enqueueSystemEvent = vi.fn();
    setInteractionRuntime(enqueueSystemEvent);
    const resolveSessionKey = vi.fn().mockResolvedValue("session:thread:root-9");
    const dispatchButtonClick = vi.fn();
    const fetchedPost = createActionPost({ rootId: "root-9" });
    const handler = createHandler({
      client: createMattermostClientMock(async (_path: string, init?: { method?: string }) =>
        init?.method === "PUT" ? { id: "post-1" } : fetchedPost,
      ),
      resolveSessionKey,
      dispatchButtonClick,
    });

    const res = await runSignedHandler(handler, { userName: "alice" });
    expect(res.statusCode).toBe(200);
    expect(resolveSessionKey).toHaveBeenCalledWith({
      channelId: "chan-1",
      userId: "user-1",
      post: fetchedPost,
    });
    expect(enqueueSystemEvent).toHaveBeenCalledWith(
      'Mattermost button click: action="approve" by alice in channel chan-1',
      {
        sessionKey: "session:thread:root-9",
        contextKey: "mattermost:interaction:post-1:approve",
      },
    );
    expect(dispatchButtonClick).toHaveBeenCalledWith({
      channelId: "chan-1",
      userId: "user-1",
      userName: "alice",
      actionId: "approve",
      actionName: "Approve",
      postId: "post-1",
      post: fetchedPost,
    });
  });

  it("lets a custom interaction handler short-circuit generic completion updates", async () => {
    const { context, token } = createActionContext("mdlprov");
    const requestLog: Array<{ path: string; method?: string }> = [];
    const response = {
      ephemeral_text: "Only the original requester can use this picker.",
    };
    const handleInteraction = vi.fn().mockResolvedValue(response);
    const dispatchButtonClick = vi.fn();
    const originalPost = createActionPost({
      actionId: "mdlprov",
      actionName: "Browse providers",
    });
    const handler = createHandler({
      client: createMattermostClientMock(async (path: string, init?: { method?: string }) => {
        requestLog.push({ path, method: init?.method });
        return originalPost;
      }),
      handleInteraction,
      dispatchButtonClick,
    });
    const body = createInteractionBody({
      context,
      token,
      userId: "user-2",
      userName: "alice",
    });

    const res = await runHandler(handler, { body });

    expect(res.statusCode).toBe(200);
    expect(res.body).toBe(JSON.stringify(response));
    expect(requestLog).toEqual([{ path: "/posts/post-1", method: undefined }]);
    expect(handleInteraction).toHaveBeenCalledWith({
      payload: body,
      userName: "alice",
      actionId: "mdlprov",
      actionName: "Browse providers",
      originalMessage: "Choose",
      context,
      post: originalPost,
    });
    expect(dispatchButtonClick).not.toHaveBeenCalled();
  });
});

describe("createMattermostInteractionHandler body limits", () => {
  // The 10s read deadline makes the sibling 408 case too slow to drive here; slash-http
  // and Synology Chat cover that half of the same branch.
  it("delivers 413 for an over-limit callback body and then closes the connection", async () => {
    const handleInteraction = vi.fn();
    const handler = createMattermostInteractionHandler({
      client: {} as MattermostClient,
      accountId: "acct",
      handleInteraction,
    });
    await withServer(
      (req, res) => {
        void handler(req, res);
      },
      async (baseUrl) => {
        // Declared and sent in one write: the shape whose rejection used to race the flush.
        const result = await postRawWebhook({
          url: `${baseUrl}/mattermost/interactions`,
          body: "x".repeat(64 * 1024 + 1),
          headers: { "content-type": "application/json" },
        });
        expect(result.statusLine).toBe("HTTP/1.1 413 Payload Too Large");
        expect(JSON.parse(result.body)).toEqual({ error: "Payload too large" });
        expect(result.closedByServer).toBe(true);
        expect(handleInteraction).not.toHaveBeenCalled();
      },
    );
  });
});
