import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { App } from "@slack/bolt";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { SlackMessageEvent } from "../../types.js";

type PrepareSlackMessage = typeof import("./prepare.js").prepareSlackMessage;
type CreateInboundSlackTestContext =
  typeof import("./prepare.test-helpers.js").createInboundSlackTestContext;
type CreateSlackTestAccount = typeof import("./prepare.test-helpers.js").createSlackTestAccount;

let prepareSlackMessage: PrepareSlackMessage;
let createInboundSlackTestContext: CreateInboundSlackTestContext;
let createSlackTestAccount: CreateSlackTestAccount;
let fixtureRoot = "";
let caseId = 0;

async function loadSlackPrepareModules() {
  const [{ prepareSlackMessage: loadedPrepareSlackMessage }, helpers] = await Promise.all([
    import("./prepare.js"),
    import("./prepare.test-helpers.js"),
  ]);
  prepareSlackMessage = loadedPrepareSlackMessage;
  createInboundSlackTestContext = helpers.createInboundSlackTestContext;
  createSlackTestAccount = helpers.createSlackTestAccount;
}

function makeTmpStorePath() {
  if (!fixtureRoot) {
    throw new Error("fixtureRoot missing");
  }
  const dir = path.join(fixtureRoot, `case-${caseId++}`);
  fs.mkdirSync(dir);
  return path.join(dir, "sessions.json");
}

describe("prepareSlackMessage thread context allowlists", () => {
  beforeAll(async () => {
    await loadSlackPrepareModules();
    fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-slack-room-thread-context-"));
  });

  afterAll(() => {
    if (fixtureRoot) {
      fs.rmSync(fixtureRoot, { recursive: true, force: true });
      fixtureRoot = "";
    }
  });

  it("uses room users allowlist for thread context filtering", async () => {
    const replies = vi
      .fn()
      .mockResolvedValueOnce({
        messages: [{ text: "starter from room user", user: "U1", ts: "100.000" }],
      })
      .mockResolvedValueOnce({
        messages: [
          { text: "starter from room user", user: "U1", ts: "100.000" },
          { text: "assistant reply", bot_id: "B1", ts: "100.500" },
          { text: "allowed follow-up", user: "U1", ts: "100.800" },
          { text: "current message", user: "U1", ts: "101.000" },
        ],
        response_metadata: { next_cursor: "" },
      });
    const storePath = makeTmpStorePath();
    const ctx = createInboundSlackTestContext({
      cfg: {
        session: { store: storePath },
        channels: { slack: { enabled: true, replyToMode: "all", groupPolicy: "open" } },
      } as OpenClawConfig,
      appClient: { conversations: { replies } } as unknown as App["client"],
      defaultRequireMention: false,
      replyToMode: "all",
      channelsConfig: {
        C123: {
          users: ["U1"],
          requireMention: false,
        },
      },
    });
    ctx.allowFrom = ["u-owner"];
    ctx.resolveUserName = async (id: string) => ({
      name: id === "U1" ? "Alice" : "Owner",
    });
    ctx.resolveChannelName = async () => ({ name: "general", type: "channel" });

    const prepared = await prepareSlackMessage({
      ctx,
      account: createSlackTestAccount({
        replyToMode: "all",
        thread: { initialHistoryLimit: 20 },
      }),
      message: {
        channel: "C123",
        channel_type: "channel",
        user: "U1",
        text: "current message",
        ts: "101.000",
        thread_ts: "100.000",
      } as SlackMessageEvent,
      opts: { source: "message" },
    });

    expect(prepared).toBeTruthy();
    expect(prepared!.ctxPayload.ThreadStarterBody).toBe("starter from room user");
    expect(prepared!.ctxPayload.ThreadHistoryBody).toContain("starter from room user");
    expect(prepared!.ctxPayload.ThreadHistoryBody).toContain("assistant reply");
    expect(prepared!.ctxPayload.ThreadHistoryBody).toContain("allowed follow-up");
    expect(prepared!.ctxPayload.ThreadHistoryBody).not.toContain("current message");
    expect(replies).toHaveBeenCalledTimes(2);
  });

  it("does not apply the owner allowlist to open-room thread context", async () => {
    const replies = vi
      .fn()
      .mockResolvedValueOnce({
        messages: [{ text: "starter from open room", user: "U2", ts: "200.000" }],
      })
      .mockResolvedValueOnce({
        messages: [
          { text: "starter from open room", user: "U2", ts: "200.000" },
          { text: "assistant reply", bot_id: "B1", ts: "200.500" },
          { text: "open-room follow-up", user: "U2", ts: "200.800" },
          { text: "current message", user: "U2", ts: "201.000" },
        ],
        response_metadata: { next_cursor: "" },
      });
    const storePath = makeTmpStorePath();
    const ctx = createInboundSlackTestContext({
      cfg: {
        session: { store: storePath },
        channels: { slack: { enabled: true, replyToMode: "all", groupPolicy: "open" } },
      } as OpenClawConfig,
      appClient: { conversations: { replies } } as unknown as App["client"],
      defaultRequireMention: false,
      replyToMode: "all",
      channelsConfig: {
        C124: {
          requireMention: false,
        },
      },
    });
    ctx.allowFrom = ["u-owner"];
    ctx.resolveUserName = async (id: string) => ({
      name: id === "U2" ? "Bob" : "Owner",
    });
    ctx.resolveChannelName = async () => ({ name: "general", type: "channel" });

    const prepared = await prepareSlackMessage({
      ctx,
      account: createSlackTestAccount({
        replyToMode: "all",
        thread: { initialHistoryLimit: 20 },
      }),
      message: {
        channel: "C124",
        channel_type: "channel",
        user: "U2",
        text: "current message",
        ts: "201.000",
        thread_ts: "200.000",
      } as SlackMessageEvent,
      opts: { source: "message" },
    });

    expect(prepared).toBeTruthy();
    expect(prepared!.ctxPayload.ThreadStarterBody).toBe("starter from open room");
    expect(prepared!.ctxPayload.ThreadHistoryBody).toContain("starter from open room");
    expect(prepared!.ctxPayload.ThreadHistoryBody).toContain("assistant reply");
    expect(prepared!.ctxPayload.ThreadHistoryBody).toContain("open-room follow-up");
    expect(prepared!.ctxPayload.ThreadHistoryBody).not.toContain("current message");
    expect(replies).toHaveBeenCalledTimes(2);
  });

  it("does not apply the owner allowlist to open DMs when dmPolicy is open", async () => {
    const replies = vi
      .fn()
      .mockResolvedValueOnce({
        messages: [{ text: "starter from open dm", user: "U3", ts: "300.000" }],
      })
      .mockResolvedValueOnce({
        messages: [
          { text: "starter from open dm", user: "U3", ts: "300.000" },
          { text: "assistant reply", bot_id: "B1", ts: "300.500" },
          { text: "dm follow-up", user: "U3", ts: "300.800" },
          { text: "current message", user: "U3", ts: "301.000" },
        ],
        response_metadata: { next_cursor: "" },
      });
    const storePath = makeTmpStorePath();
    const ctx = createInboundSlackTestContext({
      cfg: {
        session: { store: storePath },
        channels: { slack: { enabled: true, replyToMode: "all", groupPolicy: "open" } },
      } as OpenClawConfig,
      appClient: { conversations: { replies } } as unknown as App["client"],
      defaultRequireMention: false,
      replyToMode: "all",
    });
    ctx.allowFrom = ["u-owner"];
    ctx.resolveUserName = async (id: string) => ({
      name: id === "U3" ? "Dana" : "Owner",
    });

    const prepared = await prepareSlackMessage({
      ctx,
      account: createSlackTestAccount({
        replyToMode: "all",
        thread: { initialHistoryLimit: 20 },
      }),
      message: {
        channel: "D300",
        channel_type: "im",
        user: "U3",
        text: "current message",
        ts: "301.000",
        thread_ts: "300.000",
      } as SlackMessageEvent,
      opts: { source: "message" },
    });

    expect(prepared).toBeTruthy();
    expect(prepared!.ctxPayload.ThreadStarterBody).toBe("starter from open dm");
    expect(prepared!.ctxPayload.ThreadHistoryBody).toContain("starter from open dm");
    expect(prepared!.ctxPayload.ThreadHistoryBody).toContain("assistant reply");
    expect(prepared!.ctxPayload.ThreadHistoryBody).toContain("dm follow-up");
    expect(prepared!.ctxPayload.ThreadHistoryBody).not.toContain("current message");
    expect(replies).toHaveBeenCalledTimes(2);
  });

  it("does not apply the owner allowlist to MPIM thread context", async () => {
    const replies = vi
      .fn()
      .mockResolvedValueOnce({
        messages: [{ text: "starter from mpim", user: "U4", ts: "400.000" }],
      })
      .mockResolvedValueOnce({
        messages: [
          { text: "starter from mpim", user: "U4", ts: "400.000" },
          { text: "assistant reply", bot_id: "B1", ts: "400.500" },
          { text: "mpim follow-up", user: "U4", ts: "400.800" },
          { text: "current message", user: "U4", ts: "401.000" },
        ],
        response_metadata: { next_cursor: "" },
      });
    const storePath = makeTmpStorePath();
    const ctx = createInboundSlackTestContext({
      cfg: {
        session: { store: storePath },
        channels: { slack: { enabled: true, replyToMode: "all", groupPolicy: "open" } },
      } as OpenClawConfig,
      appClient: { conversations: { replies } } as unknown as App["client"],
      defaultRequireMention: false,
      replyToMode: "all",
    });
    ctx.allowFrom = ["u-owner"];
    ctx.resolveUserName = async (id: string) => ({
      name: id === "U4" ? "Evan" : "Owner",
    });

    const prepared = await prepareSlackMessage({
      ctx,
      account: createSlackTestAccount({
        replyToMode: "all",
        thread: { initialHistoryLimit: 20 },
      }),
      message: {
        channel: "G400",
        channel_type: "mpim",
        user: "U4",
        text: "current message",
        ts: "401.000",
        thread_ts: "400.000",
      } as SlackMessageEvent,
      opts: { source: "message" },
    });

    expect(prepared).toBeTruthy();
    expect(prepared!.ctxPayload.ThreadStarterBody).toBe("starter from mpim");
    expect(prepared!.ctxPayload.ThreadHistoryBody).toContain("starter from mpim");
    expect(prepared!.ctxPayload.ThreadHistoryBody).toContain("assistant reply");
    expect(prepared!.ctxPayload.ThreadHistoryBody).toContain("mpim follow-up");
    expect(prepared!.ctxPayload.ThreadHistoryBody).not.toContain("current message");
    expect(replies).toHaveBeenCalledTimes(2);
  });
});
