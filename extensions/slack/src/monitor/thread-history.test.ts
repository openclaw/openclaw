import { WebClient } from "@slack/web-api";
import { logVerbose } from "openclaw/plugin-sdk/runtime-env";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveSlackThreadHistory } from "./thread.js";

vi.mock("openclaw/plugin-sdk/runtime-env", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/runtime-env")>()),
  logVerbose: vi.fn(),
}));

function expectVerboseLogContains(expected: string): void {
  expect(vi.mocked(logVerbose).mock.calls.flat().join("\n")).toContain(expected);
}

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
  const client = new WebClient("xoxb-test-token");
  const replies = vi.fn();
  const history = (options: Partial<Parameters<typeof resolveSlackThreadHistory>[0]> = {}) =>
    resolveSlackThreadHistory({
      channelId: "C1",
      threadTs: "1.000",
      client,
      limit: 10,
      ...options,
    });

  beforeEach(() => {
    replies.mockReset();
    vi.mocked(logVerbose).mockClear();
    vi.spyOn(client.conversations, "replies").mockImplementation(replies);
  });
  afterEach(() => vi.restoreAllMocks());

  it("paginates and returns the latest N messages across pages", async () => {
    replies
      .mockResolvedValueOnce(replyPage(1, 200, "cursor-2"))
      .mockResolvedValueOnce(replyPage(201, 60));
    const result = await history({ currentMessageTs: "260.000", limit: 5 });

    expect(replies).toHaveBeenCalledTimes(2);
    for (const [request] of replies.mock.calls) {
      expect(request).toMatchObject({
        channel: "C1",
        ts: "1.000",
        limit: 200,
        inclusive: false,
        latest: "260.000",
      });
    }
    expect(replies.mock.calls[1]?.[0]?.cursor).toBe("cursor-2");
    expect(result.map((entry) => entry.ts)).toEqual([
      "255.000",
      "256.000",
      "257.000",
      "258.000",
      "259.000",
    ]);
  });

  it("returns no thread history when pagination exceeds the bounded fetched window", async () => {
    replies
      .mockResolvedValueOnce(replyPage(1, 200, "cursor-2"))
      .mockResolvedValueOnce(replyPage(201, 200, "cursor-3"))
      .mockResolvedValueOnce(replyPage(401, 200, "cursor-4"));
    const result = await history({ limit: 3 });
    expect(replies).toHaveBeenCalledTimes(3);
    expect(replies.mock.calls[2]?.[0]).toMatchObject({
      cursor: "cursor-3",
      limit: 200,
    });
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
        botMessage("1.000", {
          attachments: [
            {
              title: "Low disk",
              fallback: "Alert",
              fields: [{ title: "Host", value: "example" }],
            },
          ],
        }),
        botMessage("2.000", { blocks: [section("Restarting")] }),
        botMessage("3.000", {
          attachments: [
            {
              blocks: [
                { type: "header", text: { type: "plain_text", text: "Alert firing" } },
                { type: "section", fields: [mrkdwn("*host:* example"), mrkdwn("*device:* disk")] },
                section("Free space below threshold"),
              ],
            },
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
    const result = await history({ limit: 0 });

    expect(result).toStrictEqual([]);
    expect(replies).not.toHaveBeenCalled();
  });

  it("returns empty and surfaces the error via logVerbose when Slack API throws", async () => {
    replies.mockRejectedValueOnce(new Error("slack down"));
    const result = await history({ limit: 20 });

    expect(result).toStrictEqual([]);
    expectVerboseLogContains("slack thread history fetch failed");
    expectVerboseLogContains("slack down");
    expectVerboseLogContains("channel=C1");
  });
});
