import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { App } from "@slack/bolt";
import { resolveEnvelopeFormatOptions } from "openclaw/plugin-sdk/channel-inbound";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { SlackMessageEvent } from "../../types.js";
import * as mediaModule from "../media.js";
import { resolveSlackThreadContextData } from "./prepare-thread-context.js";
import { createInboundSlackTestContext, createSlackTestAccount } from "./prepare.test-helpers.js";

vi.mock("../media.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../media.js")>();
  return {
    ...actual,
    resolveSlackMedia: vi.fn(actual.resolveSlackMedia),
    resolveSlackAttachmentContent: vi.fn(actual.resolveSlackAttachmentContent),
  };
});

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

  it("hydrates forwarded thread-root attachment images when the starter has no files", async () => {
    const { storePath } = makeTmpStorePath();
    const resolveSlackAttachmentContentMock = vi.mocked(mediaModule.resolveSlackAttachmentContent);
    resolveSlackAttachmentContentMock.mockResolvedValueOnce({
      text: "",
      media: [
        {
          path: "/tmp/thread-root-share.png",
          contentType: "image/png",
          placeholder: "[Slack file: thread-root-share.png]",
        },
      ],
    });

    const result = await resolveSlackThreadContextData({
      ctx: createThreadContext({ replies: vi.fn() }),
      account: createSlackTestAccount({ thread: { initialHistoryLimit: 0 } }),
      message: createThreadMessage(),
      isThreadReply: true,
      threadTs: "100.000",
      threadStarter: {
        userId: "U1",
        ts: "100.000",
        attachments: [
          {
            is_share: true,
            image_url: "https://files.slack.com/files-pri/T123-F123/thread-root-share.png",
            fallback: "shared image",
          },
        ],
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

    expect(result.threadStarterMedia).toEqual([
      expect.objectContaining({ path: "/tmp/thread-root-share.png", contentType: "image/png" }),
    ]);
  });

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

  it("hydrates starter files for file-only thread roots", async () => {
    const { storePath } = makeTmpStorePath();
    const replies = vi.fn().mockResolvedValue({
      messages: [{ text: "current message", user: "U1", ts: "101.000" }],
      response_metadata: { next_cursor: "" },
    });
    const ctx = createThreadContext({ replies });
    const resolveSlackMediaMock = vi.mocked(mediaModule.resolveSlackMedia);
    resolveSlackMediaMock.mockResolvedValueOnce([
      {
        path: "/tmp/root.har",
        contentType: "application/json",
        placeholder: "[Slack file: root.har]",
      },
    ]);

    const result = await resolveSlackThreadContextData({
      ctx,
      account: createSlackTestAccount({ thread: { initialHistoryLimit: 20 } }),
      message: createThreadMessage(),
      isThreadReply: true,
      threadTs: "100.000",
      threadStarter: {
        text: "",
        userId: "U1",
        ts: "100.000",
        files: [{ id: "F1", name: "root.har" }],
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
    expect(result.threadStarterMedia).toEqual([
      {
        path: "/tmp/root.har",
        contentType: "application/json",
        placeholder: "[Slack file: root.har]",
      },
    ]);
    expect(resolveSlackMediaMock).toHaveBeenCalledWith(
      expect.objectContaining({
        files: expect.arrayContaining([expect.objectContaining({ id: "F1", name: "root.har" })]),
      }),
    );
  });
});
