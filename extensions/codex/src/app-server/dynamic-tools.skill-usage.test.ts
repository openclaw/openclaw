// A skill read's attribution joins the Codex transcript result after legacy result
// extensions, and never reaches the model-facing protocol response.
import path from "node:path";
import type { AgentToolResult } from "openclaw/plugin-sdk/agent-core";
import {
  createEmptyPluginRegistry,
  setActivePluginRegistry,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import { Type } from "typebox";
import { afterEach, expect, it } from "vitest";
import { toCodexDynamicToolProtocolResponse } from "./dynamic-tool-execution.js";
import { createCodexDynamicToolBridge } from "./dynamic-tools.js";

afterEach(() => {
  setActivePluginRegistry(createEmptyPluginRegistry());
});

it("keeps a skill read's attribution after legacy extensions replace details", async () => {
  const registry = createEmptyPluginRegistry();
  const factory = async (codex: {
    on: (
      event: "tool_result",
      handler: (event: { result: AgentToolResult<unknown> }) => Promise<{
        result: AgentToolResult<unknown>;
      }>,
    ) => void;
  }) => {
    codex.on("tool_result", async (event) => ({
      result: { content: event.result.content, details: { replaced: true } },
    }));
  };
  registry.codexAppServerExtensionFactories.push({
    pluginId: "legacy",
    pluginName: "Legacy",
    rawFactory: factory,
    factory,
    source: "test",
  });
  setActivePluginRegistry(registry);
  const skillDir = path.join("/workspace", ".agents", "skills", "demo-skill");
  const bridge = createCodexDynamicToolBridge({
    tools: [
      {
        name: "read",
        label: "read",
        description: "Read fixture",
        parameters: Type.Object({}, { additionalProperties: true }),
        execute: async () => ({
          content: [{ type: "text" as const, text: "# Demo" }],
          details: { kind: "text", content: "# Demo" },
        }),
      },
    ],
    signal: new AbortController().signal,
    hookContext: {
      runId: "run-codex-skill",
      workspaceDir: "/workspace",
      skillsSnapshot: {
        prompt: "",
        skills: [{ name: "demo-skill" }],
        resolvedSkills: [
          {
            name: "demo-skill",
            description: "Demo",
            filePath: path.join(skillDir, "SKILL.md"),
            baseDir: skillDir,
            source: "workspace",
            sourceInfo: {
              path: path.join(skillDir, "SKILL.md"),
              source: "workspace",
              scope: "project",
              origin: "top-level",
              baseDir: skillDir,
            },
            disableModelInvocation: false,
          },
        ],
      },
    },
  });
  const read = (callId: string, filePath: string) =>
    bridge.handleToolCall({
      threadId: "thread-1",
      turnId: "turn-1",
      callId,
      namespace: null,
      tool: "read",
      arguments: { path: filePath },
    });

  const skillRead = await read("call-skill", ".agents/skills/demo-skill/SKILL.md");
  const otherRead = await read("call-readme", "README.md");

  expect(skillRead.transcriptDetails).toEqual({
    replaced: true,
    openclawSkillUsage: { skillName: "demo-skill", skillSource: "workspace", activation: "read" },
  });
  expect(otherRead.transcriptDetails).toEqual({ replaced: true });
  expect(JSON.stringify(toCodexDynamicToolProtocolResponse(skillRead))).not.toContain(
    "openclawSkillUsage",
  );
});
