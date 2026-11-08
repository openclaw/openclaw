import { WebClient } from "@slack/web-api";
import { logVerbose } from "openclaw/plugin-sdk/runtime-env";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  resolveSlackChannelHistory,
  resolveSlackThreadHistory,
  resolveSlackThreadStarter,
} from "./thread.js";

vi.mock("openclaw/plugin-sdk/runtime-env", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/runtime-env")>()),
  logVerbose: vi.fn(),
}));

function expectVerboseLogContains(expected: string): void {
  expect(vi.mocked(logVerbose).mock.calls.flat().join("\n")).toContain(expected);
}

const client = new WebClient("xoxb-test-token");
const replies = vi.fn();
let workspace = 0;
beforeEach(() => {
  workspace++;
  replies.mockReset().mockResolvedValue({ messages: [{ text: "root message" }] });
  vi.mocked(logVerbose).mockClear();
  vi.spyOn(client.conversations, "replies").mockImplementation(replies);
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});
const starter = (options: Partial<Parameters<typeof resolveSlackThreadStarter>[0]> = {}) =>
  resolveSlackThreadStarter({
    channelId: "C1",
    threadTs: "1000.1",
    client,
    workspaceScope: { accountId: `test-${workspace}`, teamId: `T${workspace}` },
    ...options,
  });

const botMessage = <T extends object>(ts: string, content: T) => ({
  text: "  ",
  bot_id: "BMONITOR",
  ts,
  ...content,
});
const botText = (text: string) =>
  expect.objectContaining({ text, botId: "BMONITOR", userId: undefined, files: undefined });
const mrkdwn = (text: string) => ({ type: "mrkdwn", text });
const section = (text: string) => ({ type: "section", text: mrkdwn(text) });
const attachedBot = (ts: string, attachment: object) =>
  botMessage(ts, { attachments: [attachment] });

it("returns bounded channel history chronologically without mutating the API window", async () => {
  const messages = [
    { text: "current", ts: "5.000" },
    { text: "latest", ts: "4.000" },
    { text: "excluded", ts: "3.000" },
    { text: "earlier", ts: "2.000" },
    { text: "oldest", ts: "1.000" },
  ];
  vi.spyOn(client.conversations, "history").mockResolvedValue({ ok: true, messages });
  const result = await resolveSlackChannelHistory({
    channelId: "C1",
    client,
    currentMessageTs: "5.000",
    excludedMessageIds: new Set(["3.000"]),
    limit: 2,
  });
  expect(result.map(({ text, ts }) => ({ text, ts }))).toEqual([
    { text: "earlier", ts: "2.000" },
    { text: "latest", ts: "4.000" },
  ]);
  expect(messages.map(({ ts }) => ts)).toEqual(["5.000", "4.000", "3.000", "2.000", "1.000"]);
});

function replyPage(start: number, count: number, nextCursor = "") {
  return {
    messages: Array.from({ length: count }, (_, i) => ({
      text: `msg-${start + i}`,
      user: "U1",
      ts: `${start + i}.000`,
    })),
    response_metadata: { next_cursor: nextCursor },
  };
}

describe("resolveSlackThreadHistory", () => {
  const history = (options: Partial<Parameters<typeof resolveSlackThreadHistory>[0]> = {}) =>
    resolveSlackThreadHistory({
      channelId: "C1",
      threadTs: "1.000",
      client,
      limit: 10,
      ...options,
    });
  it("paginates and returns the latest N messages across pages", async () => {
    replies
      .mockResolvedValueOnce(replyPage(1, 200, "cursor-2"))
      .mockResolvedValueOnce(replyPage(201, 60));
    const result = await history({ currentMessageTs: "260.000", limit: 5 });
    expect(replies).toHaveBeenCalledTimes(2);
    expect(replies.mock.calls[1]?.[0]?.cursor).toBe("cursor-2");
    expect(result.map((entry) => entry.ts).join(",")).toBe(
      "255.000,256.000,257.000,258.000,259.000",
    );
  });
  it("returns no thread history when pagination exceeds the bounded fetched window", async () => {
    replies
      .mockResolvedValueOnce(replyPage(1, 200, "cursor-2"))
      .mockResolvedValueOnce(replyPage(201, 200, "cursor-3"))
      .mockResolvedValueOnce(replyPage(401, 200, "cursor-4"));
    const result = await history({ limit: 3 });
    expect(replies).toHaveBeenCalledTimes(3);
    expect(result).toEqual([]);
    expectVerboseLogContains("slack thread history capped");
    expectVerboseLogContains("channel=C1");
  });
  it.each([
    {
      name: "file-only messages and empty filtering",
      messages: [
        { text: "  ", ts: "1.000", files: [{ id: "FSCREEN", name: "screenshot.png" }] },
        { text: "   ", ts: "2.000" },
        { text: "hello", ts: "3.000", user: "U1" },
      ],
      expected: [
        expect.objectContaining({ text: "[attached: screenshot.png (fileId: FSCREEN)]" }),
        expect.objectContaining({ text: "hello", userId: "U1", ts: "3.000" }),
      ],
    },
    {
      name: "attachment and block fallback surfaces",
      messages: [
        attachedBot("1.000", {
          title: "Low disk",
          fallback: "Alert",
          fields: [{ title: "Host", value: "example" }],
        }),
        botMessage("2.000", { blocks: [section("Restarting")] }),
        attachedBot("3.000", {
          blocks: [
            { type: "header", text: { type: "plain_text", text: "Alert firing" } },
            { type: "section", fields: [mrkdwn("*host:* example"), mrkdwn("*device:* disk")] },
            section("Free space below threshold"),
          ],
        }),
        { text: "  line one\nline two  ", ts: "4.000" },
        {
          ts: "5.000",
          attachments: [{ is_share: true, image_url: "https://files.slack.com/shared.png" }],
        },
      ],
      expected: [
        botText("Low disk\nAlert\nHost\nexample"),
        botText("Restarting"),
        botText("Alert firing\n*host:* example\n*device:* disk\nFree space below threshold"),
        expect.objectContaining({ text: "line one\nline two", botId: undefined }),
        expect.objectContaining({ text: "[Slack media attachment]", botId: undefined }),
      ],
    },
  ])("preserves $name in thread history", async ({ messages, expected }) => {
    replies.mockResolvedValueOnce({ messages, response_metadata: { next_cursor: "" } });
    expect(await history()).toEqual(expected);
  });
  it("returns empty when limit is zero without calling Slack API", async () => {
    expect(await history({ limit: 0 })).toStrictEqual([]);
    expect(replies).not.toHaveBeenCalled();
  });
  it("returns empty and surfaces the error via logVerbose when Slack API throws", async () => {
    replies.mockRejectedValueOnce(new Error("slack down"));
    expect(await history({ limit: 20 })).toStrictEqual([]);
    expectVerboseLogContains("slack thread history fetch failed");
    expectVerboseLogContains("slack down");
    expectVerboseLogContains("channel=C1");
  });
});

describe("resolveSlackThreadStarter cache", () => {
  it("shares in-flight and cached roots without leaking across accounts", async () => {
    const root = Promise.withResolvers<{ messages: { text: string }[] }>();
    replies
      .mockImplementationOnce(() => root.promise)
      .mockResolvedValueOnce({ messages: [{ text: "team two root" }] });
    const one = { workspaceScope: { accountId: "account-one", teamId: "T1" } };
    const two = { workspaceScope: { accountId: "account-two", teamId: "T2" } };
    const first = starter(one);
    const shared = starter(one);
    expect((await starter(two))?.text).toBe("team two root");
    root.resolve({ messages: [{ text: "team one root" }] });
    const result = await first;
    expect(result?.text).toBe("team one root");
    expect(await shared).toEqual(result);
    expect(await starter(one)).toEqual(result);
    expect(replies).toHaveBeenCalledTimes(2);
  });
  it("refreshes cached starters and retries after a failed refresh", async () => {
    await starter();
    replies.mockRejectedValueOnce(new Error("slack down"));
    expect(await starter({ refresh: true })).toBeNull();
    replies.mockResolvedValueOnce({ messages: [{ text: "updated root" }] });
    expect((await starter())?.text).toBe("updated root");
    expect((await starter())?.text).toBe("updated root");
    expect(replies).toHaveBeenCalledTimes(3);
  });
  it("evicts oldest entries once cache exceeds bounded size", async () => {
    for (let i = 0; i <= 2000; i++) {
      await starter({ threadTs: `1000.${i}` });
    }
    const callsAfterFill = replies.mock.calls.length;
    await starter({ threadTs: "1000.0" });
    expect(replies.mock.calls.length).toBe(callsAfterFill + 1);
  });
});
