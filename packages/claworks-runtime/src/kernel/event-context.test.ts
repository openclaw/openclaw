import { describe, expect, it } from "vitest";
import { buildEventContext } from "./event-context.js";
import { buildLlmContext } from "./llm-context-builder.js";

describe("buildEventContext", () => {
  it("extracts patrol snapshot into meta and elevates sentiment when pending_runs > 5", () => {
    const packet = buildEventContext({ pending_runs: 8, playbook_count: 12 }, "robot.patrol");

    expect(packet.meta).toEqual({ pending_runs: 8, playbook_count: 12 });
    expect(packet.sentiment).toBe("warning");
  });

  it("keeps normal sentiment when pending_runs is at or below threshold", () => {
    const packet = buildEventContext({ pending_runs: 5, playbook_count: 3 }, "robot.patrol");

    expect(packet.meta).toEqual({ pending_runs: 5, playbook_count: 3 });
    expect(packet.sentiment).toBeUndefined();
  });
});

describe("buildEventContext → buildLlmContext integration", () => {
  it("flows patrol meta into rich mode system status summary", async () => {
    const packet = buildEventContext({ pending_runs: 8, playbook_count: 12 }, "robot.patrol");

    const result = await buildLlmContext({
      prompt: "summarize patrol findings",
      context_level: "rich",
      event_context: packet,
    });

    expect(result.enriched_prompt).toContain("系统状态: 运行中 Playbook 8 个, 共 12 个 Playbook");
    expect(result.enriched_prompt).toContain("summarize patrol findings");
    expect(result.effective_context_level).toBe("rich");
  });
});
