import { describe, expect, it } from "vitest";
import { buildAgentPanel } from "./agent-panel.js";
import { buildCronPanel } from "./cron-panel.js";
import { buildMorePanel } from "./more-panel.js";
import { buildProPanel } from "./pro-panel.js";
import { buildTradingPanel } from "./trading-panel.js";
import type { InteractiveReply } from "./types.js";

type Panel = InteractiveReply;

function collectCallbackValues(panel: Panel): string[] {
  return panel.blocks
    .filter((block) => block.type === "buttons")
    .flatMap((block) => block.buttons.map((btn) => btn.value));
}

describe("telegram-ui callback size regression", () => {
  it("keeps callbacks within telegram 64-byte limit on key control panels", () => {
    const panels: Panel[] = [
      buildMorePanel(),
      buildProPanel(false, "https://t.me/invoice/demo"),
      buildAgentPanel([{ id: "codex", name: "Codex", status: "running" }], "codex"),
      buildCronPanel([{ id: "daily-pr", enabled: true, schedule: "0 9 * * *" }]),
      buildTradingPanel({
        mode: "paper",
        connected: true,
        quoteStatus: "fresh",
        positions: [],
        quotes: [],
        blockers: [],
      }),
    ];

    for (const panel of panels) {
      for (const value of collectCallbackValues(panel)) {
        expect(value.length).toBeGreaterThan(0);
        expect(Buffer.byteLength(value, "utf8")).toBeLessThanOrEqual(64);
      }
    }
  });
});
