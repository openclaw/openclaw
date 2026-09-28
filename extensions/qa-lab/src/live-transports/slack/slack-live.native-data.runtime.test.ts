import { afterEach, describe, expect, it, vi } from "vitest";
import { SLACK_QA_NATIVE_CHART, SLACK_QA_NATIVE_TABLE } from "./slack-live.contracts.js";
import { findScenario } from "./slack-live.scenario.test-helpers.js";

// Keep real Slack operations in Vitest's graph instead of recompiling them through Jiti.
// The separate facade tests own plugin loading; this suite owns delivery behavior.
vi.mock("./slack-plugin.runtime.js", async () => {
  const runtime = await import("@openclaw/slack/test-api.js");
  return { loadSlackQaRuntime: () => runtime };
});

function buildRun(kind: "chart" | "table") {
  const run = findScenario([`slack-${kind}-presentation-native`])[0]?.buildRun("U_SUT");
  if (!run || !("input" in run) || !run.captureBeforeReply || !run.afterReply) {
    throw new Error(`missing Slack native ${kind} scenario verifier`);
  }
  const summaryText = run.input.match(
    new RegExp(`SLACK_QA_${kind.toUpperCase()}_SUMMARY_[A-Z0-9]+`, "u"),
  )?.[0];
  if (!summaryText) {
    throw new Error(`missing Slack native ${kind} summary marker`);
  }
  const accessibleText = [
    summaryText,
    "",
    ...(kind === "chart"
      ? [
          "QA latency trend (line chart)",
          "X axis: Percentile",
          "Y axis: Milliseconds",
          "- Latency: P50: 120; P95: 240",
        ]
      : [
          "QA pipeline report (table)",
          "Account\tStage\tARR",
          "Acme\tWon\t125000",
          "Globex\tReview\t82000",
        ]),
  ].join("\n");
  return {
    afterReply: run.afterReply,
    captureBeforeReply: run.captureBeforeReply,
    finalMarker: run.matchText,
    summaryText,
    accessibleText,
  };
}

describe("Slack native data QA scenarios", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it.each(["chart", "table"] as const)(
    "keeps interleaved native %s message identities within each run",
    async (kind) => {
      const first = buildRun(kind);
      const second = buildRun(kind);
      expect(first.summaryText).not.toBe(second.summaryText);
      expect(first.finalMarker).not.toBe(second.finalMarker);
      const writes = [
        { channelId: "C123456789", text: second.summaryText, ts: "22.000000" },
        { channelId: "C123456789", text: first.summaryText, ts: "11.000000" },
      ];
      expect(first.captureBeforeReply(writes)).toBe(true);
      expect(second.captureBeforeReply(writes)).toBe(true);
      const expectedReads = writes.map((write, index) => ({
        ts: write.ts,
        accessibleText: [second, first][index]!.accessibleText,
      }));
      const history = vi.fn(async (query: unknown) => {
        const expected = expectedReads.shift();
        if (!expected) {
          throw new Error("unexpected Slack history retry");
        }
        expect(query).toEqual({
          channel: "C123456789",
          inclusive: true,
          latest: expected.ts,
          limit: 1,
        });
        return {
          messages: [
            {
              blocks: [kind === "chart" ? SLACK_QA_NATIVE_CHART : SLACK_QA_NATIVE_TABLE],
              // Slack history flattens accessibility newlines on readback.
              text: expected.accessibleText.replace(/\s+/gu, " "),
              ts: expected.ts,
              user: "U_SUT",
            },
          ],
        };
      });
      const context = {
        channelId: "C123456789",
        sentTs: "1.000000",
        sutIdentity: { userId: "U_SUT" },
        sutReadClient: { conversations: { history } },
      } as never;
      const verdict = `verified native ${kind === "chart" ? "data_visualization" : "data_table"} block and deterministic accessible text`;

      await expect(second.afterReply({}, context)).resolves.toBe(verdict);
      await expect(first.afterReply({}, context)).resolves.toBe(verdict);
      expect(history).toHaveBeenCalledTimes(2);
    },
  );

  it("rejects native verification without capture before querying history", async () => {
    const run = buildRun("chart");
    const history = vi.fn();

    await expect(
      run.afterReply({}, {
        channelId: "C123456789",
        sutIdentity: { userId: "U_SUT" },
        sutReadClient: { conversations: { history } },
      } as never),
    ).rejects.toThrow("Slack native chart verification did not retain its message id");
    expect(history).not.toHaveBeenCalled();
  });

  it.each(["chart", "table"] as const)("rejects fallback-only Slack %s delivery", async (kind) => {
    vi.useFakeTimers();
    const run = buildRun(kind);
    const history = vi.fn(async () => ({
      messages: [
        {
          text: run.accessibleText.replace(/\s+/gu, " "),
          ts: "2.000000",
          user: "U_SUT",
        },
      ],
    }));
    expect(
      run.captureBeforeReply([{ channelId: "C123456789", text: run.summaryText, ts: "2.000000" }]),
    ).toBe(true);
    const result = expect(
      run.afterReply({}, {
        channelId: "C123456789",
        sentTs: "1.000000",
        sutIdentity: { userId: "U_SUT" },
        sutReadClient: { conversations: { history } },
      } as never),
    ).rejects.toThrow("waiting for Slack message");

    await vi.advanceTimersByTimeAsync(16_000);
    await result;
  });
});
