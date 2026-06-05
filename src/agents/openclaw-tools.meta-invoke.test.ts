import { describe, expect, it, vi } from "vitest";
import type { MetaSkillCatalog } from "../skills/meta/catalog.js";
import type { MetaPlan } from "../skills/meta/types.js";
import { stubTool } from "./test-helpers/fast-tool-stubs.js";

const { resolveOpenClawPluginToolsForOptions } = vi.hoisted(() => ({
  resolveOpenClawPluginToolsForOptions: vi.fn(() => [stubTool("plugin_tool")]),
}));

vi.mock("./openclaw-plugin-tools.js", () => ({
  resolveOpenClawPluginToolsForOptions,
}));

import { createOpenClawTools } from "./openclaw-tools.js";

const testPlan = {
  name: "draft_reply",
  description: "Draft a concise reply",
  triggers: [],
  steps: [
    {
      id: "draft",
      kind: "llm_chat",
      dependsOn: [],
      prompt: "Write the reply.",
      onFailure: { kind: "fail" },
    },
  ],
  finalTextMode: { kind: "auto" },
} satisfies MetaPlan;

const metaSkillCatalog = {
  plans: [testPlan],
  diagnostics: [],
} satisfies MetaSkillCatalog;

function toolNames(tools: ReturnType<typeof createOpenClawTools>): string[] {
  return tools.map((tool) => tool.name);
}

describe("openclaw-tools meta_invoke registration", () => {
  it("omits meta_invoke by default and when only one meta dependency is provided", () => {
    const runMetaPlan = vi.fn();

    expect(
      toolNames(
        createOpenClawTools({
          config: {},
          disablePluginTools: true,
          wrapBeforeToolCallHook: false,
        }),
      ),
    ).not.toContain("meta_invoke");
    expect(
      toolNames(
        createOpenClawTools({
          config: {},
          disablePluginTools: true,
          wrapBeforeToolCallHook: false,
          metaSkillCatalog,
        }),
      ),
    ).not.toContain("meta_invoke");
    expect(
      toolNames(
        createOpenClawTools({
          config: {},
          disablePluginTools: true,
          wrapBeforeToolCallHook: false,
          runMetaPlan,
        }),
      ),
    ).not.toContain("meta_invoke");
  });

  it("registers meta_invoke only when both meta dependencies are present and keeps it before plugin tools", () => {
    const runMetaPlan = vi.fn().mockResolvedValue({
      status: "succeeded",
      finalText: "ok",
      outputs: {},
      steps: {},
    });
    const names = toolNames(
      createOpenClawTools({
        config: {},
        wrapBeforeToolCallHook: false,
        metaSkillCatalog,
        runMetaPlan,
      }),
    );

    expect(names).toContain("meta_invoke");
    expect(names.indexOf("meta_invoke")).toBeLessThan(names.indexOf("plugin_tool"));
  });
});
