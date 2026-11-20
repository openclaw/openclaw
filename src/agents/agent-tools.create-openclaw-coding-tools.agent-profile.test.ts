import { describe, expect, it } from "vitest";
import "./test-helpers/fast-bash-tools.js";
import "./test-helpers/fast-coding-tools.js";
import "./test-helpers/fast-openclaw-tools.js";
import { createOpenClawCodingTools } from "./agent-tools.js";

function toolNameList(tools: readonly { name: string }[]): string[] {
  return tools.map((tool) => tool.name);
}

describe("createOpenClawCodingTools agent profiles", () => {
  it("does not treat built-in profile tools as Agent Profile overrides", () => {
    const tools = createOpenClawCodingTools({
      config: {
        agents: {
          defaults: {
            agentProfileId: "openclaw/small",
          },
        },
        tools: {
          profile: "coding",
        },
      },
      toolConstructionPlan: {
        includeBaseCodingTools: false,
        includeShellTools: false,
        includeChannelTools: false,
        includeOpenClawTools: true,
        includePluginTools: false,
      },
    });

    expect(toolNameList(tools)).not.toEqual(
      expect.arrayContaining(["image_generate", "video_generate"]),
    );
  });

  it("preserves runtime-allowed message through small Agent Profile filtering", () => {
    const tools = createOpenClawCodingTools({
      config: {
        agents: {
          defaults: {
            agentProfileId: "openclaw/small",
          },
        },
        tools: { profile: "minimal" },
      },
      runtimeToolAllowlist: ["message"],
      toolConstructionPlan: {
        includeBaseCodingTools: false,
        includeShellTools: false,
        includeChannelTools: false,
        includeOpenClawTools: true,
        includePluginTools: false,
      },
    });

    expect(toolNameList(tools)).toContain("message");
  });

  it("preserves forced message through small Agent Profile filtering without runtime allowlist", () => {
    const tools = createOpenClawCodingTools({
      config: {
        agents: {
          defaults: {
            agentProfileId: "openclaw/small",
          },
        },
        tools: { profile: "minimal" },
      },
      forceMessageTool: true,
      toolConstructionPlan: {
        includeBaseCodingTools: false,
        includeShellTools: false,
        includeChannelTools: false,
        includeOpenClawTools: true,
        includePluginTools: false,
      },
    });

    expect(toolNameList(tools)).toContain("message");
  });

  it("preserves message-tool-only replies through small Agent Profile filtering without runtime allowlist", () => {
    const tools = createOpenClawCodingTools({
      config: {
        agents: {
          defaults: {
            agentProfileId: "openclaw/small",
          },
        },
        tools: { profile: "minimal" },
      },
      sourceReplyDeliveryMode: "message_tool_only",
      toolConstructionPlan: {
        includeBaseCodingTools: false,
        includeShellTools: false,
        includeChannelTools: false,
        includeOpenClawTools: true,
        includePluginTools: false,
      },
    });

    expect(toolNameList(tools)).toContain("message");
  });
});
