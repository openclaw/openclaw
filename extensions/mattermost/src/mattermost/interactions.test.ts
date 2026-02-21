import { type IncomingMessage } from "node:http";
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import {
  buildButtonAttachments,
  generateInteractionToken,
  getInteractionCallbackUrl,
  getInteractionSecret,
  isLocalhostRequest,
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
    setInteractionCallbackUrl("resolve-test", "");
  });

  it("prefers cached URL from registry", () => {
    setInteractionCallbackUrl("cached", "http://cached:1234/path");
    expect(resolveInteractionCallbackUrl("cached")).toBe("http://cached:1234/path");
  });

  it("falls back to computed URL from gateway port config", () => {
    const url = resolveInteractionCallbackUrl("default", { gateway: { port: 9999 } });
    expect(url).toBe("http://localhost:9999/mattermost/interactions/default");
  });

  it("uses default port 18789 when no config provided", () => {
    const url = resolveInteractionCallbackUrl("myaccount");
    expect(url).toBe("http://localhost:18789/mattermost/interactions/myaccount");
  });

  it("uses default port when gateway config has no port", () => {
    const url = resolveInteractionCallbackUrl("acct", { gateway: {} });
    expect(url).toBe("http://localhost:18789/mattermost/interactions/acct");
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

// ── isLocalhostRequest ───────────────────────────────────────────────

describe("isLocalhostRequest", () => {
  function fakeReq(remoteAddress?: string): IncomingMessage {
    return {
      socket: { remoteAddress },
    } as unknown as IncomingMessage;
  }

  it("accepts 127.0.0.1", () => {
    expect(isLocalhostRequest(fakeReq("127.0.0.1"))).toBe(true);
  });

  it("accepts ::1", () => {
    expect(isLocalhostRequest(fakeReq("::1"))).toBe(true);
  });

  it("accepts ::ffff:127.0.0.1", () => {
    expect(isLocalhostRequest(fakeReq("::ffff:127.0.0.1"))).toBe(true);
  });

  it("rejects external addresses", () => {
    expect(isLocalhostRequest(fakeReq("10.0.0.1"))).toBe(false);
    expect(isLocalhostRequest(fakeReq("192.168.1.1"))).toBe(false);
  });

  it("rejects when socket has no remote address", () => {
    expect(isLocalhostRequest(fakeReq(undefined))).toBe(false);
  });

  it("rejects when socket is missing", () => {
    expect(isLocalhostRequest({} as IncomingMessage)).toBe(false);
  });
});
