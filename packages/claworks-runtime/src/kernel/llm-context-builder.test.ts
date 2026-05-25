import { describe, expect, it } from "vitest";
import { buildLlmContext } from "./llm-context-builder.js";

describe("buildLlmContext", () => {
  it("fast mode passes prompt through without injection", async () => {
    const result = await buildLlmContext({
      prompt: "classify this",
      context_level: "fast",
      event_context: { meta: { pending_runs: 2, playbook_count: 5 } },
    });
    expect(result.enriched_prompt).toBe("classify this");
    expect(result.effective_context_level).toBe("fast");
    expect(result.recommended_model_tier).toBe("fast");
  });

  it("rich mode injects meta status summary when pre_summary is absent", async () => {
    const result = await buildLlmContext({
      prompt: "analyze alarm",
      context_level: "rich",
      event_context: {
        meta: { pending_runs: 2, playbook_count: 7 },
      },
    });
    expect(result.enriched_prompt).toContain("系统状态: 运行中 Playbook 2 个, 共 7 个 Playbook");
    expect(result.enriched_prompt).toContain("analyze alarm");
  });

  it("prefers pre_summary over meta status summary in rich mode", async () => {
    const result = await buildLlmContext({
      prompt: "analyze alarm",
      context_level: "rich",
      event_context: {
        pre_summary: "设备 pump-001 高温告警",
        meta: { pending_runs: 1, playbook_count: 3 },
      },
    });
    expect(result.enriched_prompt).toContain("事件摘要: 设备 pump-001 高温告警");
    expect(result.enriched_prompt).not.toContain("系统状态:");
  });

  it("skips meta summary when meta fields are absent", async () => {
    const result = await buildLlmContext({
      prompt: "hello",
      context_level: "rich",
      event_context: { meta: { other_field: true } },
    });
    expect(result.enriched_prompt).toBe("hello");
  });

  it("classify fast mode prefers intent_classify template from renderPromptTemplate", async () => {
    const result = await buildLlmContext(
      {
        prompt: "查一下 OEE",
        task_type: "classify",
      },
      {
        renderPromptTemplate: (id, vars) =>
          id === "intent_classify" ? `CLASSIFY:\n${String(vars.message)}` : null,
      },
    );
    expect(result.enriched_prompt).toBe("CLASSIFY:\n查一下 OEE");
    expect(result.effective_context_level).toBe("fast");
  });

  it("fast mode falls back to raw prompt when template render is empty", async () => {
    const result = await buildLlmContext(
      {
        prompt: "quick task",
        context_level: "fast",
      },
      {
        renderPromptTemplate: () => "",
      },
    );
    expect(result.enriched_prompt).toBe("quick task");
  });

  it("classify fast mode falls back to task_type template when intent_classify missing", async () => {
    const result = await buildLlmContext(
      {
        prompt: "route me",
        task_type: "classify",
      },
      {
        renderPromptTemplate: (id, vars) =>
          id === "classify" ? `TASK:${String(vars.message)}` : null,
      },
    );
    expect(result.enriched_prompt).toBe("TASK:route me");
  });
});
