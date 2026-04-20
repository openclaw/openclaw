import type { App } from "@slack/bolt";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import { describe, expect, it } from "vitest";
import type { SlackMessageEvent } from "../../types.js";

const [{ prepareSlackMessage }, helpers] = await Promise.all([
  import("./prepare.js"),
  import("./prepare.test-helpers.js"),
]);
const { createInboundSlackTestContext, createSlackTestAccount } = helpers;

function buildCtx(overrides?: { replyToMode?: "all" | "first" | "off" }) {
  const replyToMode = overrides?.replyToMode ?? "all";
  return createInboundSlackTestContext({
    cfg: {
      channels: {
        slack: { enabled: true, replyToMode },
      },
    } as OpenClawConfig,
    appClient: {} as App["client"],
    defaultRequireMention: false,
    replyToMode,
  });
}

function buildChannelMessage(overrides?: Partial<SlackMessageEvent>): SlackMessageEvent {
  return {
    channel: "C123",
    channel_type: "channel",
    user: "U1",
    text: "hello",
    ts: "1770408518.451689",
    ...overrides,
  } as SlackMessageEvent;
}

describe("thread-level session keys", () => {
  it("keeps top-level channel turns in one session when replyToMode=off", async () => {
    const ctx = buildCtx({ replyToMode: "off" });
    ctx.resolveUserName = async () => ({ name: "Alice" });
    const account = createSlackTestAccount({ replyToMode: "off" });

    const first = await prepareSlackMessage({
      ctx,
      account,
      message: buildChannelMessage({ ts: "1770408518.451689" }),
      opts: { source: "message" },
    });
    const second = await prepareSlackMessage({
      ctx,
      account,
      message: buildChannelMessage({ ts: "1770408520.000001" }),
      opts: { source: "message" },
    });

    expect(first).toBeTruthy();
    expect(second).toBeTruthy();
    const firstSessionKey = first!.ctxPayload.SessionKey as string;
    const secondSessionKey = second!.ctxPayload.SessionKey as string;
    expect(firstSessionKey).toBe(secondSessionKey);
    expect(firstSessionKey).not.toContain(":thread:");
  });

  it("uses parent thread_ts for thread replies even when replyToMode=off", async () => {
    const ctx = buildCtx({ replyToMode: "off" });
    ctx.resolveUserName = async () => ({ name: "Bob" });
    const account = createSlackTestAccount({ replyToMode: "off" });

    const message = buildChannelMessage({
      user: "U2",
      text: "reply",
      ts: "1770408522.168859",
      thread_ts: "1770408518.451689",
    });

    const prepared = await prepareSlackMessage({
      ctx,
      account,
      message,
      opts: { source: "message" },
    });

    expect(prepared).toBeTruthy();
    // Thread replies should use the parent thread_ts, not the reply ts
    const sessionKey = prepared!.ctxPayload.SessionKey as string;
    expect(sessionKey).toContain(":thread:1770408518.451689");
    expect(sessionKey).not.toContain("1770408522.168859");
  });

  it("keeps top-level channel messages on the per-channel session when replyToMode is off or first", async () => {
    for (const mode of ["first", "off"] as const) {
      const ctx = buildCtx({ replyToMode: mode });
      ctx.resolveUserName = async () => ({ name: "Carol" });
      const account = createSlackTestAccount({ replyToMode: mode });

      const first = await prepareSlackMessage({
        ctx,
        account,
        message: buildChannelMessage({ ts: "1770408530.000000" }),
        opts: { source: "message" },
      });
      const second = await prepareSlackMessage({
        ctx,
        account,
        message: buildChannelMessage({ ts: "1770408531.000000" }),
        opts: { source: "message" },
      });

      expect(first).toBeTruthy();
      expect(second).toBeTruthy();
      const firstKey = first!.ctxPayload.SessionKey as string;
      const secondKey = second!.ctxPayload.SessionKey as string;
      expect(firstKey).toBe(secondKey);
      expect(firstKey).not.toContain(":thread:");
    }
  });

  it("gives each top-level channel message its own thread session when replyToMode=all", async () => {
    const ctx = buildCtx({ replyToMode: "all" });
    ctx.resolveUserName = async () => ({ name: "Carol" });
    const account = createSlackTestAccount({ replyToMode: "all" });

    const first = await prepareSlackMessage({
      ctx,
      account,
      message: buildChannelMessage({ ts: "1770408530.000000" }),
      opts: { source: "message" },
    });
    const second = await prepareSlackMessage({
      ctx,
      account,
      message: buildChannelMessage({ ts: "1770408531.000000" }),
      opts: { source: "message" },
    });

    expect(first).toBeTruthy();
    expect(second).toBeTruthy();
    const firstKey = first!.ctxPayload.SessionKey as string;
    const secondKey = second!.ctxPayload.SessionKey as string;
    // Each top-level message should get its own thread-scoped session
    expect(firstKey).not.toBe(secondKey);
    expect(firstKey).toContain(":thread:1770408530.000000");
    expect(secondKey).toContain(":thread:1770408531.000000");
  });

  it("aligns SessionKey and MessageThreadId for top-level channel messages with replyToMode=all", async () => {
    const ctx = buildCtx({ replyToMode: "all" });
    ctx.resolveUserName = async () => ({ name: "Carol" });
    const account = createSlackTestAccount({ replyToMode: "all" });

    const prepared = await prepareSlackMessage({
      ctx,
      account,
      message: buildChannelMessage({ ts: "1770408530.000000" }),
      opts: { source: "message" },
    });

    expect(prepared).toBeTruthy();
    const sessionKey = prepared!.ctxPayload.SessionKey as string;
    const messageThreadId = prepared!.ctxPayload.MessageThreadId as string;
    // Session routing and reply delivery must point to the same conversation
    expect(sessionKey).toContain(`:thread:${messageThreadId}`);
  });

  it("routes thread replies into the parent thread session with replyToMode=all", async () => {
    const ctx = buildCtx({ replyToMode: "all" });
    ctx.resolveUserName = async () => ({ name: "Carol" });
    const account = createSlackTestAccount({ replyToMode: "all" });

    const reply = await prepareSlackMessage({
      ctx,
      account,
      message: buildChannelMessage({
        user: "U2",
        text: "thread reply",
        ts: "1770408535.000000",
        thread_ts: "1770408530.000000",
      }),
      opts: { source: "message" },
    });

    expect(reply).toBeTruthy();
    const sessionKey = reply!.ctxPayload.SessionKey as string;
    // Thread reply routes to the parent thread session, not its own ts
    expect(sessionKey).toContain(":thread:1770408530.000000");
    expect(sessionKey).not.toContain("1770408535.000000");
  });

  it("keeps distinct senders on separate sessions in a channel with replyToMode=all", async () => {
    const ctx = buildCtx({ replyToMode: "all" });
    ctx.resolveUserName = async () => ({ name: "User" });
    const account = createSlackTestAccount({ replyToMode: "all" });

    const alice = await prepareSlackMessage({
      ctx,
      account,
      message: buildChannelMessage({ user: "U1", ts: "1770408540.000000" }),
      opts: { source: "message" },
    });
    const bob = await prepareSlackMessage({
      ctx,
      account,
      message: buildChannelMessage({ user: "U2", ts: "1770408541.000000" }),
      opts: { source: "message" },
    });

    expect(alice).toBeTruthy();
    expect(bob).toBeTruthy();
    const aliceKey = alice!.ctxPayload.SessionKey as string;
    const bobKey = bob!.ctxPayload.SessionKey as string;
    // Different senders' top-level messages must not share a session
    expect(aliceKey).not.toBe(bobKey);
  });

  it("does not add thread suffix for DMs when replyToMode=off", async () => {
    const ctx = buildCtx({ replyToMode: "off" });
    ctx.resolveUserName = async () => ({ name: "Carol" });
    const account = createSlackTestAccount({ replyToMode: "off" });

    const message: SlackMessageEvent = {
      channel: "D456",
      channel_type: "im",
      user: "U3",
      text: "dm message",
      ts: "1770408530.000000",
    } as SlackMessageEvent;

    const prepared = await prepareSlackMessage({
      ctx,
      account,
      message,
      opts: { source: "message" },
    });

    expect(prepared).toBeTruthy();
    // DMs should NOT have :thread: in the session key
    const sessionKey = prepared!.ctxPayload.SessionKey as string;
    expect(sessionKey).not.toContain(":thread:");
  });
});
