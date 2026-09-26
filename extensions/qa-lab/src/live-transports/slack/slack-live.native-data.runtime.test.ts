// QA Lab tests cover native Slack chart and table scenario contracts.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SLACK_QA_NATIVE_CHART, SLACK_QA_NATIVE_TABLE } from "./slack-live.contracts.js";
import { findScenario } from "./slack-live.scenario.test-helpers.js";

// Keep real Slack operations in Vitest's graph instead of recompiling them through Jiti.
// The separate facade tests own plugin loading; this suite owns delivery behavior.
vi.mock("./slack-plugin.runtime.js", async () => {
  const runtime = await import("@openclaw/slack/test-api.js");
  return { loadSlackQaRuntime: () => runtime };
});

function renderExpectedSlackChartAccessibleText(summaryText: string) {
  return [
    summaryText,
    "",
    "QA latency trend (line chart)",
    "X axis: Percentile",
    "Y axis: Milliseconds",
    "- Latency: P50: 120; P95: 240",
  ].join("\n");
}

function renderExpectedSlackTableAccessibleText(summaryText: string) {
  return [
    summaryText,
    "",
    "QA pipeline report (table)",
    "Account\tStage\tARR",
    "Acme\tWon\t125000",
    "Globex\tReview\t82000",
  ].join("\n");
}

describe("Slack native data QA scenarios", () => {
  beforeEach(() => {
    vi.useRealTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("drives the live native chart scenario through a portable message-tool presentation", () => {
    const scenario = findScenario(["slack-chart-presentation-native"])[0];
    const run = scenario?.buildRun("U999999999");
    const input = run && "input" in run ? run.input : "";
    const summaryText = input.match(/SLACK_QA_CHART_SUMMARY_[A-Z0-9]+/u)?.[0];

    expect(run).toMatchObject({ expectReply: true });
    expect(scenario?.configOverrides).toEqual({ messageTool: true });
    if (!summaryText) {
      throw new Error("missing Slack chart summary token");
    }
    expect(input).toContain(
      JSON.stringify({
        action: "send",
        message: summaryText,
        presentation: {
          blocks: [
            {
              type: "chart",
              chartType: "line",
              title: "QA latency trend",
              categories: ["P50", "P95"],
              series: [{ name: "Latency", values: [120, 240] }],
              xLabel: "Percentile",
              yLabel: "Milliseconds",
            },
          ],
        },
      }),
    );
    expect(run && "matchText" in run ? run.matchText : "").toMatch(
      /^SLACK_QA_CHART_DONE_[A-Z0-9]+$/u,
    );
  });

  it("verifies the SUT-owned native chart and exact accessible top-level text", async () => {
    const scenario = findScenario(["slack-chart-presentation-native"])[0];
    const run = scenario?.buildRun("U999999999");
    const input = run && "input" in run ? run.input : "";
    const summaryText = input.match(/SLACK_QA_CHART_SUMMARY_[A-Z0-9]+/u)?.[0];
    const afterReply = run && "afterReply" in run ? run.afterReply : undefined;
    const captureBeforeReply =
      run && "captureBeforeReply" in run ? run.captureBeforeReply : undefined;
    if (!summaryText || !afterReply || !captureBeforeReply) {
      throw new Error("missing Slack chart scenario verifier");
    }
    const accessibleText = renderExpectedSlackChartAccessibleText(summaryText);
    const history = vi.fn(async () => ({
      messages: [
        {
          blocks: [
            {
              type: "data_visualization",
              title: "QA latency trend",
              chart: {
                type: "line",
                series: [
                  {
                    name: "Latency",
                    data: [
                      { label: "P50", value: 120 },
                      { label: "P95", value: 240 },
                    ],
                  },
                ],
                axis_config: {
                  categories: ["P50", "P95"],
                  x_label: "Percentile",
                  y_label: "Milliseconds",
                },
              },
            },
          ],
          // Slack history flattens the top-level accessibility newlines on readback.
          text: accessibleText.replace(/\s+/gu, " "),
          ts: "2.000000",
          user: "U999999999",
        },
      ],
    }));
    expect(
      captureBeforeReply([{ channelId: "C123456789", text: summaryText, ts: "2.000000" }]),
    ).toBe(true);

    await expect(
      afterReply(
        {} as never,
        {
          channelId: "C123456789",
          sentTs: "1.000000",
          sutIdentity: { userId: "U999999999" },
          sutReadClient: { conversations: { history } },
        } as never,
      ),
    ).resolves.toBe("verified native data_visualization block and deterministic accessible text");
    expect(history).toHaveBeenCalledOnce();
    expect(history).toHaveBeenCalledWith({
      channel: "C123456789",
      inclusive: true,
      latest: "2.000000",
      limit: 1,
    });
  });

  it("rejects fallback-only Slack chart delivery", async () => {
    vi.useFakeTimers();
    const scenario = findScenario(["slack-chart-presentation-native"])[0];
    const run = scenario?.buildRun("U999999999");
    const input = run && "input" in run ? run.input : "";
    const summaryText = input.match(/SLACK_QA_CHART_SUMMARY_[A-Z0-9]+/u)?.[0];
    const afterReply = run && "afterReply" in run ? run.afterReply : undefined;
    const captureBeforeReply =
      run && "captureBeforeReply" in run ? run.captureBeforeReply : undefined;
    if (!summaryText || !afterReply || !captureBeforeReply) {
      throw new Error("missing Slack chart scenario verifier");
    }
    const accessibleText = renderExpectedSlackChartAccessibleText(summaryText);
    const history = vi.fn(async () => ({
      messages: [
        {
          text: accessibleText.replace(/\s+/gu, " "),
          ts: "2.000000",
          user: "U999999999",
        },
      ],
    }));
    expect(
      captureBeforeReply([{ channelId: "C123456789", text: summaryText, ts: "2.000000" }]),
    ).toBe(true);
    const result = expect(
      afterReply(
        {} as never,
        {
          channelId: "C123456789",
          sentTs: "1.000000",
          sutIdentity: { userId: "U999999999" },
          sutReadClient: { conversations: { history } },
        } as never,
      ),
    ).rejects.toThrow("waiting for Slack message");

    await vi.advanceTimersByTimeAsync(16_000);
    await result;
  });

  it("drives the live native table scenario through a portable message-tool presentation", () => {
    const scenario = findScenario(["slack-table-presentation-native"])[0];
    const run = scenario?.buildRun("U999999999");
    const input = run && "input" in run ? run.input : "";
    const summaryText = input.match(/SLACK_QA_TABLE_SUMMARY_[A-Z0-9]+/u)?.[0];

    expect(run).toMatchObject({ expectReply: true });
    expect(scenario?.configOverrides).toEqual({ messageTool: true });
    if (!summaryText) {
      throw new Error("missing Slack table summary token");
    }
    expect(input).toContain(
      JSON.stringify({
        action: "send",
        message: summaryText,
        presentation: {
          blocks: [
            {
              type: "table",
              caption: "QA pipeline report",
              headers: ["Account", "Stage", "ARR"],
              rows: [
                ["Acme", "Won", 125000],
                ["Globex", "Review", 82000],
              ],
              rowHeaderColumnIndex: 0,
            },
          ],
        },
      }),
    );
    expect(run && "matchText" in run ? run.matchText : "").toMatch(
      /^SLACK_QA_TABLE_DONE_[A-Z0-9]+$/u,
    );
  });

  it("verifies the SUT-owned native table and exact accessible top-level text", async () => {
    const scenario = findScenario(["slack-table-presentation-native"])[0];
    const run = scenario?.buildRun("U999999999");
    const input = run && "input" in run ? run.input : "";
    const summaryText = input.match(/SLACK_QA_TABLE_SUMMARY_[A-Z0-9]+/u)?.[0];
    const afterReply = run && "afterReply" in run ? run.afterReply : undefined;
    const captureBeforeReply =
      run && "captureBeforeReply" in run ? run.captureBeforeReply : undefined;
    if (!summaryText || !afterReply || !captureBeforeReply) {
      throw new Error("missing Slack table scenario verifier");
    }
    const accessibleText = renderExpectedSlackTableAccessibleText(summaryText);
    const history = vi.fn(async () => ({
      messages: [
        {
          blocks: [
            {
              type: "data_table",
              caption: "QA pipeline report",
              rows: [
                [
                  { type: "raw_text", text: "Account" },
                  { type: "raw_text", text: "Stage" },
                  { type: "raw_text", text: "ARR" },
                ],
                [
                  { type: "raw_text", text: "Acme" },
                  { type: "raw_text", text: "Won" },
                  { type: "raw_number", value: 125000, text: "125000" },
                ],
                [
                  { type: "raw_text", text: "Globex" },
                  { type: "raw_text", text: "Review" },
                  { type: "raw_number", value: 82000, text: "82000" },
                ],
              ],
              row_header_column_index: 0,
            },
          ],
          text: accessibleText.replace(/\s+/gu, " "),
          ts: "2.000000",
          user: "U999999999",
        },
      ],
    }));
    expect(
      captureBeforeReply([{ channelId: "C123456789", text: summaryText, ts: "2.000000" }]),
    ).toBe(true);

    await expect(
      afterReply(
        {} as never,
        {
          channelId: "C123456789",
          sentTs: "1.000000",
          sutIdentity: { userId: "U999999999" },
          sutReadClient: { conversations: { history } },
        } as never,
      ),
    ).resolves.toBe("verified native data_table block and deterministic accessible text");
    expect(history).toHaveBeenCalledOnce();
    expect(history).toHaveBeenCalledWith({
      channel: "C123456789",
      inclusive: true,
      latest: "2.000000",
      limit: 1,
    });
  });

  it.each(["chart", "table"] as const)(
    "keeps interleaved native %s message identities within each run",
    async (kind) => {
      const scenario = findScenario([`slack-${kind}-presentation-native`])[0];
      const buildRun = () => {
        const run = scenario?.buildRun("U_SUT");
        if (!run || !("input" in run) || !run.captureBeforeReply || !run.afterReply) {
          throw new Error(`missing Slack native ${kind} scenario verifier`);
        }
        const summaryText = run.input.match(
          new RegExp(`SLACK_QA_${kind.toUpperCase()}_SUMMARY_[A-Z0-9]+`, "u"),
        )?.[0];
        if (!summaryText) {
          throw new Error(`missing Slack native ${kind} summary marker`);
        }
        return {
          afterReply: run.afterReply,
          captureBeforeReply: run.captureBeforeReply,
          finalMarker: run.matchText,
          summaryText,
        };
      };
      const first = buildRun();
      const second = buildRun();
      expect(first.summaryText).not.toBe(second.summaryText);
      expect(first.finalMarker).not.toBe(second.finalMarker);
      const writes = [
        { channelId: "C123456789", text: second.summaryText, ts: "22.000000" },
        { channelId: "C123456789", text: first.summaryText, ts: "11.000000" },
      ];
      expect(first.captureBeforeReply(writes)).toBe(true);
      expect(second.captureBeforeReply(writes)).toBe(true);
      const expectedReads = [...writes];
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
              text:
                kind === "chart"
                  ? renderExpectedSlackChartAccessibleText(expected.text)
                  : renderExpectedSlackTableAccessibleText(expected.text),
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

      await expect(second.afterReply({} as never, context)).resolves.toBe(verdict);
      await expect(first.afterReply({} as never, context)).resolves.toBe(verdict);
      expect(history).toHaveBeenCalledTimes(2);
    },
  );

  it.each(["chart", "table"] as const)(
    "rejects native %s verification without capture before querying history",
    async (kind) => {
      const run = findScenario([`slack-${kind}-presentation-native`])[0]?.buildRun("U_SUT");
      if (!run || !("afterReply" in run) || !run.afterReply) {
        throw new Error(`missing Slack native ${kind} scenario verifier`);
      }
      const history = vi.fn();

      await expect(
        run.afterReply(
          {} as never,
          {
            channelId: "C123456789",
            sutIdentity: { userId: "U_SUT" },
            sutReadClient: { conversations: { history } },
          } as never,
        ),
      ).rejects.toThrow(`Slack native ${kind} verification did not retain its message id`);
      expect(history).not.toHaveBeenCalled();
    },
  );

  it("rejects fallback-only Slack table delivery", async () => {
    vi.useFakeTimers();
    const scenario = findScenario(["slack-table-presentation-native"])[0];
    const run = scenario?.buildRun("U999999999");
    const input = run && "input" in run ? run.input : "";
    const summaryText = input.match(/SLACK_QA_TABLE_SUMMARY_[A-Z0-9]+/u)?.[0];
    const afterReply = run && "afterReply" in run ? run.afterReply : undefined;
    const captureBeforeReply =
      run && "captureBeforeReply" in run ? run.captureBeforeReply : undefined;
    if (!summaryText || !afterReply || !captureBeforeReply) {
      throw new Error("missing Slack table scenario verifier");
    }
    const history = vi.fn(async () => ({
      messages: [
        {
          text: renderExpectedSlackTableAccessibleText(summaryText).replace(/\s+/gu, " "),
          ts: "2.000000",
          user: "U999999999",
        },
      ],
    }));
    expect(
      captureBeforeReply([{ channelId: "C123456789", text: summaryText, ts: "2.000000" }]),
    ).toBe(true);
    const result = expect(
      afterReply(
        {} as never,
        {
          channelId: "C123456789",
          sentTs: "1.000000",
          sutIdentity: { userId: "U999999999" },
          sutReadClient: { conversations: { history } },
        } as never,
      ),
    ).rejects.toThrow("waiting for Slack message");

    await vi.advanceTimersByTimeAsync(16_000);
    await result;
  });
});
