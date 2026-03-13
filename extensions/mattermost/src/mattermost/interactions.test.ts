import { type IncomingMessage, type ServerResponse } from "node:http";
import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { setMattermostRuntime } from "../runtime.js";
import { resolveMattermostAccount } from "./accounts.js";
import type { MattermostClient, MattermostPost } from "./client.js";
import {
  buildButtonAttachments,
  computeInteractionCallbackUrl,
  createMattermostInteractionHandler,
  generateInteractionToken,
  getInteractionCallbackUrl,
  getInteractionSecret,
  resolveInteractionCallbackPath,
  resolveInteractionCallbackUrl,
  setInteractionCallbackUrl,
  setInteractionSecret,
  verifyInteractionToken,
} from "./interactions.js";

// ── HMAC token management ────────────────────────────────────────────

describe("setInteractionSecret / getInteractionSecret", () => {
  beforeEach(() => {
    setInteractionSecret("test-bot-token");
  });

  it("derives a deterministic secret from the bot token", () => {
    setInteractionSecret("token-a");
    const secretA = getInteractionSecret();
    setInteractionSecret("token-a");
    const secretA2 = getInteractionSecret();
    expect(secretA).toBe(secretA2);
  });

  it("produces different secrets for different tokens", () => {
    setInteractionSecret("token-a");
    const secretA = getInteractionSecret();
    setInteractionSecret("token-b");
    const secretB = getInteractionSecret();
    expect(secretA).not.toBe(secretB);
  });

  it("returns a hex string", () => {
    expect(getInteractionSecret()).toMatch(/^[0-9a-f]+$/);
  });
});

// ── Token generation / verification ──────────────────────────────────

describe("generateInteractionToken / verifyInteractionToken", () => {
  beforeEach(() => {
    setInteractionSecret("test-bot-token");
  });

  it("generates a hex token", () => {
    const token = generateInteractionToken({ action_id: "click" });
    expect(token).toMatch(/^[0-9a-f]{64}$/);
  });

  it("verifies a valid token", () => {
    const context = { action_id: "do_now", item_id: "123" };
    const token = generateInteractionToken(context);
    expect(verifyInteractionToken(context, token)).toBe(true);
  });

  it("rejects a tampered token", () => {
    const context = { action_id: "do_now" };
    const token = generateInteractionToken(context);
    const tampered = token.replace(/.$/, token.endsWith("0") ? "1" : "0");
    expect(verifyInteractionToken(context, tampered)).toBe(false);
  });

  it("rejects a token generated with different context", () => {
    const token = generateInteractionToken({ action_id: "a" });
    expect(verifyInteractionToken({ action_id: "b" }, token)).toBe(false);
  });

  it("rejects tokens with wrong length", () => {
    const context = { action_id: "test" };
    expect(verifyInteractionToken(context, "short")).toBe(false);
  });

  it("is deterministic for the same context", () => {
    const context = { action_id: "test", x: 1 };
    const t1 = generateInteractionToken(context);
    const t2 = generateInteractionToken(context);
    expect(t1).toBe(t2);
  });

  it("produces the same token regardless of key order", () => {
    const contextA = { action_id: "do_now", tweet_id: "123", action: "do" };
    const contextB = { action: "do", action_id: "do_now", tweet_id: "123" };
    const contextC = { tweet_id: "123", action: "do", action_id: "do_now" };
    const tokenA = generateInteractionToken(contextA);
    const tokenB = generateInteractionToken(contextB);
    const tokenC = generateInteractionToken(contextC);
    expect(tokenA).toBe(tokenB);
    expect(tokenB).toBe(tokenC);
  });

  it("verifies a token when Mattermost reorders context keys", () => {
    // Simulate: token generated with keys in one order, verified with keys in another
    // (Mattermost reorders context keys when storing/returning interactive message payloads)
    const originalContext = { action_id: "bm_do", tweet_id: "999", action: "do" };
    const token = generateInteractionToken(originalContext);

    // Mattermost returns keys in alphabetical order (or any arbitrary order)
    const reorderedContext = { action: "do", action_id: "bm_do", tweet_id: "999" };
    expect(verifyInteractionToken(reorderedContext, token)).toBe(true);
  });

  it("verifies nested context regardless of nested key order", () => {
    const originalContext = {
      action_id: "nested",
      payload: {
        model: "gpt-5",
        meta: {
          provider: "openai",
          page: 2,
        },
      },
    };
    const token = generateInteractionToken(originalContext);

    const reorderedContext = {
      payload: {
        meta: {
          page: 2,
          provider: "openai",
        },
        model: "gpt-5",
      },
      action_id: "nested",
    };

    expect(verifyInteractionToken(reorderedContext, token)).toBe(true);
  });

  it("rejects nested context tampering", () => {
    const originalContext = {
      action_id: "nested",
      payload: {
        provider: "openai",
        model: "gpt-5",
      },
    };
    const token = generateInteractionToken(originalContext);
    const tamperedContext = {
      action_id: "nested",
      payload: {
        provider: "anthropic",
        model: "gpt-5",
      },
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

// ── Callback URL registry ────────────────────────────────────────────

describe("callback URL registry", () => {
  it("stores and retrieves callback URLs", () => {
    setInteractionCallbackUrl("acct1", "http://localhost:18789/mattermost/interactions/acct1");
    expect(getInteractionCallbackUrl("acct1")).toBe(
      "http://localhost:18789/mattermost/interactions/acct1",
    );
  });

  it("returns undefined for unknown account", () => {
    expect(getInteractionCallbackUrl("nonexistent-account-id")).toBeUndefined();
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

  it("uses interactions.callbackBaseUrl when configured", () => {
    const url = resolveInteractionCallbackUrl("default", {
      channels: {
        mattermost: {
          interactions: {
            callbackBaseUrl: "https://gateway.example.com/openclaw",
          },
        },
      },
    });
    expect(url).toBe("https://gateway.example.com/openclaw/mattermost/interactions/default");
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
      allowUnresolvedSecretRef: true,
    });
    const url = resolveInteractionCallbackUrl(account.accountId, {
      gateway: cfg.gateway,
      interactions: account.config.interactions,
    });
    expect(url).toBe("https://gateway.example.com/root/mattermost/interactions/acct");
  });

  it("falls back to gateway.customBindHost when configured", () => {
    const url = resolveInteractionCallbackUrl("default", {
      gateway: { port: 9999, customBindHost: "gateway.internal" },
    });
    expect(url).toBe("http://gateway.internal:9999/mattermost/interactions/default");
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

  it("uses default port 18789 when no config provided", () => {
    const url = resolveInteractionCallbackUrl("myaccount");
    expect(url).toBe("http://localhost:18789/mattermost/interactions/myaccount");
  });
});

describe("resolveInteractionCallbackPath", () => {
  it("builds the per-account callback path", () => {
    expect(resolveInteractionCallbackPath("acct")).toBe("/mattermost/interactions/acct");
  });
});

// ── buildButtonAttachments ───────────────────────────────────────────

describe("buildButtonAttachments", () => {
  beforeEach(() => {
    setInteractionSecret("test-bot-token");
  });

  it("returns an array with one attachment containing all buttons", () => {
    const result = buildButtonAttachments({
      callbackUrl: "http://localhost:18789/mattermost/interactions/default",
      buttons: [
        { id: "btn1", name: "Click Me" },
        { id: "btn2", name: "Skip", style: "danger" },
      ],
    });

    expect(result).toHaveLength(1);
    expect(result[0].actions).toHaveLength(2);
  });

  it("sets type to 'button' on every action", () => {
    const result = buildButtonAttachments({
      callbackUrl: "http://localhost:18789/cb",
      buttons: [{ id: "a", name: "A" }],
    });

    expect(result[0].actions![0].type).toBe("button");
  });

  it("includes HMAC _token in integration context", () => {
    const result = buildButtonAttachments({
      callbackUrl: "http://localhost:18789/cb",
      buttons: [{ id: "test", name: "Test" }],
    });

    const action = result[0].actions![0];
    expect(action.integration.context._token).toMatch(/^[0-9a-f]{64}$/);
  });

  it("includes sanitized action_id in integration context", () => {
    const result = buildButtonAttachments({
      callbackUrl: "http://localhost:18789/cb",
      buttons: [{ id: "my_action", name: "Do It" }],
    });

    const action = result[0].actions![0];
    // sanitizeActionId strips hyphens and underscores (Mattermost routing bug #25747)
    expect(action.integration.context.action_id).toBe("myaction");
    expect(action.id).toBe("myaction");
  });

  it("merges custom context into integration context", () => {
    const result = buildButtonAttachments({
      callbackUrl: "http://localhost:18789/cb",
      buttons: [{ id: "btn", name: "Go", context: { tweet_id: "123", batch: true } }],
    });

    const ctx = result[0].actions![0].integration.context;
    expect(ctx.tweet_id).toBe("123");
    expect(ctx.batch).toBe(true);
    expect(ctx.action_id).toBe("btn");
    expect(ctx._token).toBeDefined();
  });

  it("passes callback URL to each button integration", () => {
    const url = "http://localhost:18789/mattermost/interactions/default";
    const result = buildButtonAttachments({
      callbackUrl: url,
      buttons: [
        { id: "a", name: "A" },
        { id: "b", name: "B" },
      ],
    });

    for (const action of result[0].actions!) {
      expect(action.integration.url).toBe(url);
    }
  });

  it("preserves button style", () => {
    const result = buildButtonAttachments({
      callbackUrl: "http://localhost/cb",
      buttons: [
        { id: "ok", name: "OK", style: "primary" },
        { id: "no", name: "No", style: "danger" },
      ],
    });

    expect(result[0].actions![0].style).toBe("primary");
    expect(result[0].actions![1].style).toBe("danger");
  });

  it("uses provided text for the attachment", () => {
    const result = buildButtonAttachments({
      callbackUrl: "http://localhost/cb",
      buttons: [{ id: "x", name: "X" }],
      text: "Choose an action:",
    });

    expect(result[0].text).toBe("Choose an action:");
  });

  it("defaults to empty string text when not provided", () => {
    const result = buildButtonAttachments({
      callbackUrl: "http://localhost/cb",
      buttons: [{ id: "x", name: "X" }],
    });

    expect(result[0].text).toBe("");
  });

  it("generates verifiable tokens", () => {
    const result = buildButtonAttachments({
      callbackUrl: "http://localhost/cb",
      buttons: [{ id: "verify_me", name: "V", context: { extra: "data" } }],
    });

    const ctx = result[0].actions![0].integration.context;
    const token = ctx._token as string;
    const { _token, ...contextWithoutToken } = ctx;
    expect(verifyInteractionToken(contextWithoutToken, token)).toBe(true);
  });

  it("generates tokens that verify even when Mattermost reorders context keys", () => {
    const result = buildButtonAttachments({
      callbackUrl: "http://localhost/cb",
      buttons: [{ id: "do_action", name: "Do", context: { tweet_id: "42", category: "ai" } }],
    });

    const ctx = result[0].actions![0].integration.context;
    const token = ctx._token as string;

    // Simulate Mattermost returning context with keys in a different order
    const reordered: Record<string, unknown> = {};
    const keys = Object.keys(ctx).filter((k) => k !== "_token");
    // Reverse the key order to simulate reordering
    for (const key of keys.reverse()) {
      reordered[key] = ctx[key];
    }
    expect(verifyInteractionToken(reordered, token)).toBe(true);
  });
});

describe("createMattermostInteractionHandler", () => {
  beforeEach(() => {
    setMattermostRuntime({
      system: {
        enqueueSystemEvent: () => {},
      },
    } as unknown as Parameters<typeof setMattermostRuntime>[0]);
    setInteractionSecret("acct", "bot-token");
  });

  function createReq(params: {
    method?: string;
    body?: unknown;
    remoteAddress?: string;
    headers?: Record<string, string>;
  }): IncomingMessage {
    const body = params.body === undefined ? "" : JSON.stringify(params.body);
    const listeners = new Map<string, Array<(...args: unknown[]) => void>>();

    const req = {
      method: params.method ?? "POST",
      headers: params.headers ?? {},
      socket: { remoteAddress: params.remoteAddress ?? "203.0.113.10" },
      on(event: string, handler: (...args: unknown[]) => void) {
        const existing = listeners.get(event) ?? [];
        existing.push(handler);
        listeners.set(event, existing);
        return this;
      },
    } as IncomingMessage & { emitTest: (event: string, ...args: unknown[]) => void };

    req.emitTest = (event: string, ...args: unknown[]) => {
      const handlers = listeners.get(event) ?? [];
      for (const handler of handlers) {
        handler(...args);
      }
    };

    queueMicrotask(() => {
      if (body) {
        req.emitTest("data", Buffer.from(body));
      }
      req.emitTest("end");
    });

    return req;
  }

  function createRes(): ServerResponse & { headers: Record<string, string>; body: string } {
    const res = {
      statusCode: 200,
      headers: {} as Record<string, string>,
      body: "",
      setHeader(name: string, value: string) {
        res.headers[name] = value;
      },
      end(chunk?: string) {
        res.body = chunk ?? "";
      },
    };
    return res as unknown as ServerResponse & { headers: Record<string, string>; body: string };
  }

  async function runApproveInteraction(params?: {
    actionName?: string;
    allowedSourceIps?: string[];
    trustedProxies?: string[];
    remoteAddress?: string;
    headers?: Record<string, string>;
  }) {
    const context = { action_id: "approve", __openclaw_channel_id: "chan-1" };
    const token = generateInteractionToken(context, "acct");
    const requestLog: Array<{ path: string; method?: string }> = [];
    const handler = createMattermostInteractionHandler({
      client: {
        request: async (path: string, init?: { method?: string }) => {
          requestLog.push({ path, method: init?.method });
          if (init?.method === "PUT") {
            return { id: "post-1" };
          }
          return {
            channel_id: "chan-1",
            message: "Choose",
            props: {
              attachments: [
                { actions: [{ id: "approve", name: params?.actionName ?? "Approve" }] },
              ],
            },
          };
        },
      } as unknown as MattermostClient,
      botUserId: "bot",
      accountId: "acct",
      allowedSourceIps: params?.allowedSourceIps,
      trustedProxies: params?.trustedProxies,
    });

    const req = createReq({
      remoteAddress: params?.remoteAddress,
      headers: params?.headers,
      body: {
        user_id: "user-1",
        user_name: "alice",
        channel_id: "chan-1",
        post_id: "post-1",
        context: { ...context, _token: token },
      },
    });
    const res = createRes();
    await handler(req, res);
    return { res, requestLog };
  }

  async function runInvalidActionRequest(actionId: string) {
    const context = { action_id: "approve", __openclaw_channel_id: "chan-1" };
    const token = generateInteractionToken(context, "acct");
    const handler = createMattermostInteractionHandler({
      client: {
        request: async () => ({
          channel_id: "chan-1",
          message: "Choose",
          props: {
            attachments: [{ actions: [{ id: actionId, name: actionId }] }],
          },
        }),
      } as unknown as MattermostClient,
      botUserId: "bot",
      accountId: "acct",
    });

    const req = createReq({
      body: {
        user_id: "user-1",
        channel_id: "chan-1",
        post_id: "post-1",
        context: { ...context, _token: token },
      },
    });
    const res = createRes();
    await handler(req, res);
    return res;
  }

  it("accepts callback requests from an allowlisted source IP", async () => {
    const { res, requestLog } = await runApproveInteraction({
      allowedSourceIps: ["198.51.100.8"],
      remoteAddress: "198.51.100.8",
    });

    expect(res.statusCode).toBe(200);
    expect(res.body).toBe("{}");
    expect(requestLog).toEqual([
      { path: "/posts/post-1", method: undefined },
      { path: "/posts/post-1", method: "PUT" },
    ]);
  });

  it("accepts forwarded Mattermost source IPs from a trusted proxy", async () => {
    const { res } = await runApproveInteraction({
      allowedSourceIps: ["198.51.100.8"],
      trustedProxies: ["127.0.0.1"],
      remoteAddress: "127.0.0.1",
      headers: { "x-forwarded-for": "198.51.100.8" },
    });

    expect(res.statusCode).toBe(200);
    expect(res.body).toBe("{}");
  });

  it("rejects callback requests from non-allowlisted source IPs", async () => {
    const context = { action_id: "approve", __openclaw_channel_id: "chan-1" };
    const token = generateInteractionToken(context, "acct");
    const handler = createMattermostInteractionHandler({
      client: {
        request: async () => {
          throw new Error("should not fetch post for rejected origins");
        },
      } as unknown as MattermostClient,
      botUserId: "bot",
      accountId: "acct",
      allowedSourceIps: ["127.0.0.1"],
    });

    const req = createReq({
      remoteAddress: "198.51.100.8",
      body: {
        user_id: "user-1",
        channel_id: "chan-1",
        post_id: "post-1",
        context: { ...context, _token: token },
      },
    });
    const res = createRes();

    await handler(req, res);

    expect(res.statusCode).toBe(403);
    expect(res.body).toContain("Forbidden origin");
  });

  it("rejects requests with an invalid interaction token", async () => {
    const handler = createMattermostInteractionHandler({
      client: {
        request: async () => ({ message: "unused" }),
      } as unknown as MattermostClient,
      botUserId: "bot",
      accountId: "acct",
    });

    const req = createReq({
      body: {
        user_id: "user-1",
        channel_id: "chan-1",
        post_id: "post-1",
        context: { action_id: "approve", _token: "deadbeef" },
      },
    });
    const res = createRes();

    await handler(req, res);

    expect(res.statusCode).toBe(403);
    expect(res.body).toContain("Invalid token");
  });

  it("rejects requests when the signed channel does not match the callback payload", async () => {
    const context = { action_id: "approve", __openclaw_channel_id: "chan-1" };
    const token = generateInteractionToken(context, "acct");
    const handler = createMattermostInteractionHandler({
      client: {
        request: async () => ({ message: "unused" }),
      } as unknown as MattermostClient,
      botUserId: "bot",
      accountId: "acct",
    });

    const req = createReq({
      body: {
        user_id: "user-1",
        channel_id: "chan-2",
        post_id: "post-1",
        context: { ...context, _token: token },
      },
    });
    const res = createRes();

    await handler(req, res);

    expect(res.statusCode).toBe(403);
    expect(res.body).toContain("Channel mismatch");
  });

  it("rejects requests when the fetched post does not belong to the callback channel", async () => {
    const context = { action_id: "approve", __openclaw_channel_id: "chan-1" };
    const token = generateInteractionToken(context, "acct");
    const handler = createMattermostInteractionHandler({
      client: {
        request: async () => ({
          channel_id: "chan-9",
          message: "Choose",
          props: {
            attachments: [{ actions: [{ id: "approve", name: "Approve" }] }],
          },
        }),
      } as unknown as MattermostClient,
      botUserId: "bot",
      accountId: "acct",
    });

    const req = createReq({
      body: {
        user_id: "user-1",
        channel_id: "chan-1",
        post_id: "post-1",
        context: { ...context, _token: token },
      },
    });
    const res = createRes();

    await handler(req, res);

    expect(res.statusCode).toBe(403);
    expect(res.body).toContain("Post/channel mismatch");
  });

  it("rejects requests when the action is not present on the fetched post", async () => {
    const res = await runInvalidActionRequest("reject");

    expect(res.statusCode).toBe(403);
    expect(res.body).toContain("Unknown action");
  });

  it("accepts actions when the button name matches the action id", async () => {
    const { res, requestLog } = await runApproveInteraction({
      actionName: "approve",
    });

    expect(res.statusCode).toBe(200);
    expect(res.body).toBe("{}");
    expect(requestLog).toEqual([
      { path: "/posts/post-1", method: undefined },
      { path: "/posts/post-1", method: "PUT" },
    ]);
  });

  it("forwards fetched post threading metadata to session and button callbacks", async () => {
    const enqueueSystemEvent = vi.fn();
    setMattermostRuntime({
      system: {
        enqueueSystemEvent,
      },
    } as unknown as Parameters<typeof setMattermostRuntime>[0]);
    const context = { action_id: "approve", __openclaw_channel_id: "chan-1" };
    const token = generateInteractionToken(context, "acct");
    const resolveSessionKey = vi.fn().mockResolvedValue("session:thread:root-9");
    const dispatchButtonClick = vi.fn();
    const fetchedPost: MattermostPost = {
      id: "post-1",
      channel_id: "chan-1",
      root_id: "root-9",
      message: "Choose",
      props: {
        attachments: [{ actions: [{ id: "approve", name: "Approve" }] }],
      },
    };
    const handler = createMattermostInteractionHandler({
      client: {
        request: async (_path: string, init?: { method?: string }) =>
          init?.method === "PUT" ? { id: "post-1" } : fetchedPost,
      } as unknown as MattermostClient,
      botUserId: "bot",
      accountId: "acct",
      resolveSessionKey,
      dispatchButtonClick,
    });

    const req = createReq({
      body: {
        user_id: "user-1",
        user_name: "alice",
        channel_id: "chan-1",
        post_id: "post-1",
        context: { ...context, _token: token },
      },
    });
    const res = createRes();

    await handler(req, res);

    expect(res.statusCode).toBe(200);
    expect(resolveSessionKey).toHaveBeenCalledWith({
      channelId: "chan-1",
      userId: "user-1",
      post: fetchedPost,
    });
    expect(enqueueSystemEvent).toHaveBeenCalledWith(
      expect.stringContaining('Mattermost button click: action="approve"'),
      expect.objectContaining({ sessionKey: "session:thread:root-9" }),
    );
    expect(dispatchButtonClick).toHaveBeenCalledWith(
      expect.objectContaining({
        channelId: "chan-1",
        userId: "user-1",
        postId: "post-1",
        post: fetchedPost,
      }),
    );
  });

  it("lets a custom interaction handler short-circuit generic completion updates", async () => {
    const context = { action_id: "mdlprov", __openclaw_channel_id: "chan-1" };
    const token = generateInteractionToken(context, "acct");
    const requestLog: Array<{ path: string; method?: string }> = [];
    const handleInteraction = vi.fn().mockResolvedValue({
      ephemeral_text: "Only the original requester can use this picker.",
    });
    const dispatchButtonClick = vi.fn();
    const handler = createMattermostInteractionHandler({
      client: {
        request: async (path: string, init?: { method?: string }) => {
          requestLog.push({ path, method: init?.method });
          return {
            id: "post-1",
            channel_id: "chan-1",
            message: "Choose",
            props: {
              attachments: [{ actions: [{ id: "mdlprov", name: "Browse providers" }] }],
            },
          };
        },
      } as unknown as MattermostClient,
      botUserId: "bot",
      accountId: "acct",
      handleInteraction,
      dispatchButtonClick,
    });

    const req = createReq({
      body: {
        user_id: "user-2",
        user_name: "alice",
        channel_id: "chan-1",
        post_id: "post-1",
        context: { ...context, _token: token },
      },
    });
    const res = createRes();

    await handler(req, res);

    expect(res.statusCode).toBe(200);
    expect(res.body).toBe(
      JSON.stringify({
        ephemeral_text: "Only the original requester can use this picker.",
      }),
    );
    expect(requestLog).toEqual([{ path: "/posts/post-1", method: undefined }]);
    expect(handleInteraction).toHaveBeenCalledWith(
      expect.objectContaining({
        actionId: "mdlprov",
        actionName: "Browse providers",
        originalMessage: "Choose",
        post: expect.objectContaining({ id: "post-1" }),
        userName: "alice",
      }),
    );
    expect(dispatchButtonClick).not.toHaveBeenCalled();
  });
});
