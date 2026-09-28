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

  it("includes file-only messages and drops empty-only entries", async () => {
    replies.mockResolvedValueOnce({
      messages: [
        { text: "  ", ts: "1.000", files: [{ id: "FSCREEN", name: "screenshot.png" }] },
        { text: "   ", ts: "2.000" },
        { text: "hello", ts: "3.000", user: "U1" },
      ],
      response_metadata: { next_cursor: "" },
    });
    const result = await history();

    expect(result).toHaveLength(2);
    expect(result[0]?.text).toBe("[attached: screenshot.png (fileId: FSCREEN)]");
    expect(result[1]?.text).toBe("hello");
  });

  it("extracts thread text from Slack attachment and block surfaces", async () => {
    replies.mockResolvedValueOnce({
      messages: [
        {
          text: "  ",
          bot_id: "BMONITOR",
          ts: "1.000",
          attachments: [
            {
              title: "Filesystem on /dev/sda1 has only 14.93% available space left.",
              fallback: "Alert: filesystem space is low",
              fields: [{ title: "Host", value: "dc2.ipa.mgt" }],
            },
          ],
        },
        {
          text: "  ",
          bot_id: "BMONITOR",
          ts: "2.000",
          blocks: [{ type: "section", text: { type: "mrkdwn", text: "Pod restart rate is high" } }],
        },
        {
          text: "  ",
          bot_id: "BMONITOR",
          ts: "3.000",
          attachments: [
            {
              blocks: [
                { type: "header", text: { type: "plain_text", text: "Alert firing" } },
                {
                  type: "section",
                  fields: [
                    { type: "mrkdwn", text: "*host:* dc2.ipa.mgt" },
                    { type: "mrkdwn", text: "*device:* /dev/sda1" },
                  ],
                },
                {
                  type: "section",
                  text: { type: "mrkdwn", text: "Free space below threshold" },
                },
              ],
            },
          ],
        },
        {
          text: "  line one\nline two  ",
          ts: "4.000",
        },
        {
          ts: "5.000",
          attachments: [{ is_share: true, image_url: "https://files.slack.com/shared.png" }],
        },
      ],
      response_metadata: { next_cursor: "" },
    });
    const result = await history();

    expect(result.map((entry) => entry.text)).toEqual([
      "Filesystem on /dev/sda1 has only 14.93% available space left.\nAlert: filesystem space is low\nHost\ndc2.ipa.mgt",
      "Pod restart rate is high",
      "Alert firing\n*host:* dc2.ipa.mgt\n*device:* /dev/sda1\nFree space below threshold",
      "line one\nline two",
      "[Slack media attachment]",
    ]);
    expect(result.map((entry) => entry.botId)).toEqual([
      "BMONITOR",
      "BMONITOR",
      "BMONITOR",
      undefined,
      undefined,
    ]);
  });

  it("keeps native chart values with top-level text in thread history", async () => {
    replies.mockResolvedValueOnce({
      messages: [
        {
          text: "Latency report",
          bot_id: "BMONITOR",
          ts: "1.000",
          blocks: [
            {
              type: "data_visualization",
              title: "Weekly latency",
              chart: {
                type: "line",
                series: [{ name: "p95", data: [{ label: "Mon", value: 250 }] }],
                axis_config: { categories: ["Mon"] },
              },
            },
          ],
        },
      ],
      response_metadata: { next_cursor: "" },
    });
    const result = await history();

    expect(result).toEqual([
      {
        text: "Latency report\nWeekly latency (line chart)\n- p95: Mon: 250",
        userId: undefined,
        botId: "BMONITOR",
        ts: "1.000",
        files: undefined,
      },
    ]);
  });

  it("keeps attachment table rows with top-level text in thread history", async () => {
    replies.mockResolvedValueOnce({
      messages: [
        {
          text: "Please check these.",
          user: "U1",
          ts: "1.000",
          attachments: [
            {
              fallback: "[no preview available]",
              blocks: [
                {
                  type: "table",
                  rows: [
                    [
                      { type: "raw_text", text: "ID" },
                      { type: "raw_text", text: "Status" },
                    ],
                    [
                      { type: "raw_number", value: 12345 },
                      { type: "raw_text", text: "enabled" },
                    ],
                  ],
                },
              ],
            },
          ],
        },
      ],
      response_metadata: { next_cursor: "" },
    });
    const result = await history();

    expect(result[0]?.text).toBe("Please check these.\nID\tStatus\n12345\tenabled");
    expect(result[0]?.text).not.toContain("[no preview available]");
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
