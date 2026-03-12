import { describe, expect, it } from "vitest";
import { renderAgentFiles } from "./templates.js";
import type { WempScaffoldAnswers } from "./types.js";

function buildAnswers(template: WempScaffoldAnswers["template"]): WempScaffoldAnswers {
  return {
    brandName: "Test Brand",
    audience: "SMB 用户",
    services: "- 智能问答\n- 咨询转化",
    contact: "微信: test-brand",
    escalationRules: "报价与投诉转人工",
    tone: "专业",
    template,
  };
}

describe("wemp templates", () => {
  it("renderAgentFiles contains template-specific conversation guidance", () => {
    const enterprise = renderAgentFiles(buildAnswers("enterprise"))["AGENTS.md"];
    const content = renderAgentFiles(buildAnswers("content"))["AGENTS.md"];
    const general = renderAgentFiles(buildAnswers("general"))["AGENTS.md"];

    expect(enterprise).toMatch(/合作意向|业务目标/);
    expect(content).toMatch(/内容推荐|相关文章/);
    expect(general).toMatch(/直接回答核心问题/);
  });
});
