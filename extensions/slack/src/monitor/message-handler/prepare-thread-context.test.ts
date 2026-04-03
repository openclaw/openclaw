import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { App } from "@slack/bolt";
import { resolveEnvelopeFormatOptions } from "openclaw/plugin-sdk/channel-inbound";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { SlackMessageEvent } from "../../types.js";
import * as mediaModule from "../media.js";
import { resolveSlackThreadContextData } from "./prepare-thread-context.js";
import { createInboundSlackTestContext, createSlackTestAccount } from "./prepare.test-helpers.js";

describe("resolveSlackThreadContextData", () => {
  let fixtureRoot = "";
  let caseId = 0;

  function makeTmpStorePath() {
    if (!fixtureRoot) {
      throw new Error("fixtureRoot missing");
    }
    const dir = path.join(fixtureRoot, `case-${caseId++}`);
    fs.mkdirSync(dir);
    return { dir, storePath: path.join(dir, "sessions.json") };
  }

  beforeAll(() => {
    fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-slack-thread-context-"));
  });

  afterAll(() => {
    if (fixtureRoot) {
      fs.rmSync(fixtureRoot, { recursive: true, force: true });
      fixtureRoot = "";
    }
  });

  function createThreadContext(params: { replies: unknown }) {
    return createInboundSlackTestContext({
      cfg: {
        channels: { slack: { enabled: true, replyToMode: "all", groupPolicy: "open" } },
      } as OpenClawConfig,
      appClient: { conversations: { replies: params.replies } } as App["client"],
      defaultRequireMention: false,
      replyToMode: "all",
    });
  }

  function createThreadMessage(overrides: Partial<SlackMessageEvent> = {}): SlackMessageEvent {
    return {
      channel: "C123",
      channel_type: "channel",
      user: "U1",
      text: "current message",
      ts: "101.000",
      thread_ts: "100.000",
      ...overrides,
    } as SlackMessageEvent;
  }

  it("omits non-allowlisted starter text and thread history messages", async () => {
    const { storePath } = makeTmpStorePath();
    const replies = vi.fn().mockResolvedValue({
      messages: [
        { text: "starter secret", user: "U2", ts: "100.000" },
        { text: "assistant reply", bot_id: "B1", ts: "100.500" },
        { text: "blocked follow-up", user: "U2", ts: "100.700" },
        { text: "allowed follow-up", user: "U1", ts: "100.800" },
        { text: "current message", user: "U1", ts: "101.000" },
      ],
      response_metadata: { next_cursor: "" },
    });
    const ctx = createThreadContext({ replies });
    ctx.resolveUserName = async (id: string) => ({
      name: id === "U1" ? "Alice" : "Mallory",
    });

    const result = await resolveSlackThreadContextData({
      ctx,
      account: createSlackTestAccount({ thread: { initialHistoryLimit: 20 } }),
      message: createThreadMessage(),
      isThreadReply: true,
      threadTs: "100.000",
      threadStarter: {
        text: "starter secret",
        userId: "U2",
        ts: "100.000",
      },
      roomLabel: "#general",
      storePath,
      sessionKey: "thread-session",
      allowFromLower: ["u1"],
      allowNameMatching: false,
      contextVisibilityMode: "allowlist",
      envelopeOptions: resolveEnvelopeFormatOptions({} as OpenClawConfig),
      effectiveDirectMedia: null,
    });

    expect(result.threadStarterBody).toBeUndefined();
    expect(result.threadLabel).toBe("Slack thread #general");
    expect(result.threadHistoryBody).toContain("assistant reply");
    expect(result.threadHistoryBody).toContain("allowed follow-up");
    expect(result.threadHistoryBody).not.toContain("starter secret");
    expect(result.threadHistoryBody).not.toContain("blocked follow-up");
    expect(result.threadHistoryBody).not.toContain("current message");
    expect(replies).toHaveBeenCalledTimes(1);
  });

  it("keeps starter text and history when allowNameMatching authorizes the sender", async () => {
    const { storePath } = makeTmpStorePath();
    const replies = vi.fn().mockResolvedValue({
      messages: [
        { text: "starter from Alice", user: "U1", ts: "100.000" },
        { text: "blocked follow-up", user: "U2", ts: "100.700" },
        { text: "current message", user: "U1", ts: "101.000" },
      ],
      response_metadata: { next_cursor: "" },
    });
    const ctx = createThreadContext({ replies });
    ctx.resolveUserName = async (id: string) => ({
      name: id === "U1" ? "Alice" : "Mallory",
    });

    const result = await resolveSlackThreadContextData({
      ctx,
      account: createSlackTestAccount({ thread: { initialHistoryLimit: 20 } }),
      message: createThreadMessage(),
      isThreadReply: true,
      threadTs: "100.000",
      threadStarter: {
        text: "starter from Alice",
        userId: "U1",
        ts: "100.000",
      },
      roomLabel: "#general",
      storePath,
      sessionKey: "thread-session",
      allowFromLower: ["alice"],
      allowNameMatching: true,
      contextVisibilityMode: "allowlist",
      envelopeOptions: resolveEnvelopeFormatOptions({} as OpenClawConfig),
      effectiveDirectMedia: null,
    });

    expect(result.threadStarterBody).toBe("starter from Alice");
    expect(result.threadLabel).toContain("starter from Alice");
    expect(result.threadHistoryBody).toContain("starter from Alice");
    expect(result.threadHistoryBody).not.toContain("blocked follow-up");
  });
});

describe("resolveSlackThreadContextData — thread starter media", () => {
  let fixtureRoot = "";
  let caseId = 0;

  function makeTmpStorePath() {
    if (!fixtureRoot) {
      throw new Error("fixtureRoot missing");
    }
    const dir = path.join(fixtureRoot, `case-media-${caseId++}`);
    fs.mkdirSync(dir);
    return { dir, storePath: path.join(dir, "sessions.json") };
  }

  function makeTmpStorePathWithSession(sessionKey: string) {
    const { dir, storePath } = makeTmpStorePath();
    // Write a minimal session store with updatedAt so readSessionUpdatedAt returns a value.
    fs.writeFileSync(
      storePath,
      JSON.stringify({ [sessionKey]: { updatedAt: Date.now() - 60_000 } }),
    );
    return { dir, storePath };
  }

  beforeAll(() => {
    fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-slack-thread-media-"));
  });

  afterAll(() => {
    if (fixtureRoot) {
      fs.rmSync(fixtureRoot, { recursive: true, force: true });
      fixtureRoot = "";
    }
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function createThreadContext() {
    return createInboundSlackTestContext({
      cfg: {
        channels: { slack: { enabled: true, replyToMode: "all", groupPolicy: "open" } },
      } as OpenClawConfig,
      appClient: {
        conversations: {
          replies: vi.fn().mockResolvedValue({
            messages: [],
            response_metadata: { next_cursor: "" },
          }),
        },
      } as unknown as App["client"],
      defaultRequireMention: false,
      replyToMode: "all",
    });
  }

  const starterFiles = [
    { id: "F001", name: "photo.jpg", url_private_download: "https://files.slack.com/photo.jpg" },
  ];
  const fakeMedia = [
    { path: "/tmp/photo.jpg", contentType: "image/jpeg", placeholder: "[Slack file: photo.jpg]" },
  ];

  it("never hydrates thread starter media for a new thread session (first turn)", async () => {
    const { storePath } = makeTmpStorePath(); // no prior session
    const resolveSlackMediaSpy = vi
      .spyOn(mediaModule, "resolveSlackMedia")
      .mockResolvedValue(fakeMedia);

    const result = await resolveSlackThreadContextData({
      ctx: createThreadContext(),
      account: createSlackTestAccount({ thread: { initialHistoryLimit: 0 } }),
      message: {
        channel: "C123",
        channel_type: "channel",
        user: "U1",
        text: "follow-up reply",
        ts: "101.000",
        thread_ts: "100.000",
      } as SlackMessageEvent,
      isThreadReply: true,
      threadTs: "100.000",
      threadStarter: {
        text: "starter with image",
        userId: "U1",
        ts: "100.000",
        files: starterFiles,
      },
      roomLabel: "#general",
      storePath,
      sessionKey: "thread-session",
      allowFromLower: ["u1"],
      allowNameMatching: false,
      contextVisibilityMode: "all",
      envelopeOptions: resolveEnvelopeFormatOptions({} as OpenClawConfig),
      effectiveDirectMedia: null,
    });

    // Thread replies never hydrate parent media — the image was already
    // processed on the channel-level turn that started the thread.
    expect(result.threadStarterMedia).toBeNull();
    expect(resolveSlackMediaSpy).not.toHaveBeenCalled();
  });

  it("never hydrates thread starter media for subsequent replies in an existing session", async () => {
    const sessionKey = "thread-session";
    const { storePath } = makeTmpStorePathWithSession(sessionKey); // existing session
    const resolveSlackMediaSpy = vi
      .spyOn(mediaModule, "resolveSlackMedia")
      .mockResolvedValue(fakeMedia);

    const result = await resolveSlackThreadContextData({
      ctx: createThreadContext(),
      account: createSlackTestAccount({ thread: { initialHistoryLimit: 0 } }),
      message: {
        channel: "C123",
        channel_type: "channel",
        user: "U1",
        text: "second reply",
        ts: "102.000",
        thread_ts: "100.000",
      } as SlackMessageEvent,
      isThreadReply: true,
      threadTs: "100.000",
      threadStarter: {
        text: "starter with image",
        userId: "U1",
        ts: "100.000",
        files: starterFiles,
      },
      roomLabel: "#general",
      storePath,
      sessionKey,
      allowFromLower: ["u1"],
      allowNameMatching: false,
      contextVisibilityMode: "all",
      envelopeOptions: resolveEnvelopeFormatOptions({} as OpenClawConfig),
      effectiveDirectMedia: null,
    });

    expect(result.threadStarterMedia).toBeNull();
    expect(resolveSlackMediaSpy).not.toHaveBeenCalled();
  });

  it("does NOT hydrate thread starter media when the reply has its own direct media", async () => {
    const { storePath } = makeTmpStorePath(); // new session
    const resolveSlackMediaSpy = vi
      .spyOn(mediaModule, "resolveSlackMedia")
      .mockResolvedValue(fakeMedia);
    const ownMedia = [
      { path: "/tmp/own.jpg", contentType: "image/jpeg", placeholder: "[Slack file: own.jpg]" },
    ];

    const result = await resolveSlackThreadContextData({
      ctx: createThreadContext(),
      account: createSlackTestAccount({ thread: { initialHistoryLimit: 0 } }),
      message: {
        channel: "C123",
        channel_type: "channel",
        user: "U1",
        text: "reply with own image",
        ts: "101.000",
        thread_ts: "100.000",
      } as SlackMessageEvent,
      isThreadReply: true,
      threadTs: "100.000",
      threadStarter: {
        text: "starter with image",
        userId: "U1",
        ts: "100.000",
        files: starterFiles,
      },
      roomLabel: "#general",
      storePath,
      sessionKey: "thread-session",
      allowFromLower: ["u1"],
      allowNameMatching: false,
      contextVisibilityMode: "all",
      envelopeOptions: resolveEnvelopeFormatOptions({} as OpenClawConfig),
      effectiveDirectMedia: ownMedia, // reply has its own media
    });

    // Thread replies never hydrate parent media regardless of own media
    expect(result.threadStarterMedia).toBeNull();
    expect(resolveSlackMediaSpy).not.toHaveBeenCalled();
  });
});
