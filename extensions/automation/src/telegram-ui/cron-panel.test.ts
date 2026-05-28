import { describe, expect, it } from "vitest";
import {
  buildCronPanel,
  buildCronRunPicker,
  buildCronRunResult,
  type CronJobInfo,
} from "./cron-panel.js";
import type { InteractiveReply } from "./types.js";

function textOf(panel: InteractiveReply) {
  return panel.blocks
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("\n");
}

function buttonValues(panel: InteractiveReply) {
  return panel.blocks
    .filter((block) => block.type === "buttons")
    .flatMap((block) => block.buttons.map((btn) => btn.value));
}

describe("telegram-ui cron panel", () => {
  it("escapes html text fields", () => {
    const jobs: CronJobInfo[] = [
      {
        id: "<job>&1",
        enabled: true,
        schedule: "0 9 * * * <x>&",
        timezone: 'Asia/"Taipei"&',
        nextRun: "2026-05-21 <09:00>&",
        lastResult: "success",
      },
    ];
    const panel = buildCronPanel(jobs);
    const text = textOf(panel);
    expect(text).toContain("&lt;job&gt;&amp;1");
    expect(text).toContain("&lt;x&gt;&amp;");
    expect(text).toContain('Asia/"Taipei"&amp;');
    expect(text).toContain("&lt;09:00&gt;&amp;");

    const result = buildCronRunResult("<job>&1", false, "bad <detail>&");
    const resultText = textOf(result);
    expect(resultText).toContain("&lt;job&gt;&amp;1");
    expect(resultText).toContain("bad &lt;detail&gt;&amp;");
  });

  it("falls back to sc:cron when callback would exceed 64 bytes", () => {
    const longId = "x".repeat(80);
    const panel = buildCronPanel([{ id: longId, enabled: true, schedule: "* * * * *" }]);
    expect(buttonValues(panel)).toContain("sc:cron");

    const picker = buildCronRunPicker([{ id: longId, enabled: true, schedule: "* * * * *" }]);
    expect(buttonValues(picker)).toContain("sc:cron");
  });

  it("keeps callback values within telegram 64-byte limit", () => {
    const jobs: CronJobInfo[] = [
      { id: "job-a", enabled: true, schedule: "* * * * *" },
      { id: "job-b", enabled: false, schedule: "0 9 * * *" },
    ];
    const panels = [
      buildCronPanel(jobs),
      buildCronRunPicker(jobs),
      buildCronRunResult("job-a", true),
    ];
    for (const panel of panels) {
      for (const value of buttonValues(panel)) {
        expect(Buffer.byteLength(value, "utf8")).toBeLessThanOrEqual(64);
      }
    }
  });
});
