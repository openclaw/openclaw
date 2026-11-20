import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import {
  applyAgentProfileToolSearchDefaults,
  filterToolsByAgentProfile,
  resolveAgentProfile,
  resolveAgentProfilePreserveToolNames,
} from "./agent-profiles.js";
import type { AnyAgentTool } from "./agent-tools.types.js";
import { AUTOMATIONS_TOOL_NAME } from "./tools/automations-tool-name.js";

function tools(names: string[]): AnyAgentTool[] {
  return names.map((name) => ({ name })) as AnyAgentTool[];
}

const heavyTools = [
  "read",
  "browser",
  "cron",
  "message",
  "image_generate",
  "music_generate",
  "pdf",
  "tts",
  "video_generate",
  "exec",
];

describe("Agent Profile selection", () => {
  it("keeps the base profile when no profile is configured", () => {
    for (const resolved of [resolveAgentProfile({ config: {} }), resolveAgentProfile({})]) {
      expect(resolved.profile.id).toBe("openclaw/base");
      expect(resolved.selectionSource).toBe("fallback");
    }
  });

  it("chains the small profile from the base profile", () => {
    const config: OpenClawConfig = { agents: { defaults: { agentProfileId: "openclaw/small" } } };
    const resolved = resolveAgentProfile({ config });

    expect(resolved.profile.ancestry).toEqual(["openclaw/base", "openclaw/small"]);
    expect(resolved.selectionSource).toBe("defaults-explicit");
  });

  it("uses an explicit default profile", () => {
    const config: OpenClawConfig = {
      agents: { defaults: { agentProfileId: "openclaw/base" } },
    };
    const resolved = resolveAgentProfile({ config });

    expect(resolved.profile.id).toBe("openclaw/base");
    expect(resolved.selectionSource).toBe("defaults-explicit");
  });

  it("uses a per-agent profile before an explicit default", () => {
    const config: OpenClawConfig = {
      agents: {
        defaults: { agentProfileId: "openclaw/base" },
        entries: {
          main: { agentProfileId: "openclaw/small" },
        },
      },
    };
    const resolved = resolveAgentProfile({ config, agentId: "main" });

    expect(resolved.profile.id).toBe("openclaw/small");
    expect(resolved.selectionSource).toBe("agent-explicit");
  });
});

describe("small profile tool behavior", () => {
  const smallConfig: OpenClawConfig = {
    agents: { defaults: { agentProfileId: "openclaw/small" } },
  };

  it("filters heavyweight tools but keeps the scheduler", () => {
    expect(
      filterToolsByAgentProfile({
        tools: tools(heavyTools),
        config: smallConfig,
      }).map((tool) => tool.name),
    ).toEqual(["read", "cron", "exec"]);
  });

  it("keeps the automations tool on the small surface without any preserve list", () => {
    expect(
      filterToolsByAgentProfile({
        tools: tools(["read", AUTOMATIONS_TOOL_NAME, "browser", "exec"]),
        config: smallConfig,
      }).map((tool) => tool.name),
    ).toEqual(["read", AUTOMATIONS_TOOL_NAME, "exec"]);
  });

  it("keeps message when the message tool owns visible replies", () => {
    const preserveToolNames = resolveAgentProfilePreserveToolNames({
      sourceReplyDeliveryMode: "message_tool_only",
    });
    const names = (preserve?: string[]) =>
      filterToolsByAgentProfile({
        tools: tools(["read", "message", AUTOMATIONS_TOOL_NAME]),
        config: smallConfig,
        preserveToolNames: preserve,
      }).map((tool) => tool.name);

    expect(names(preserveToolNames)).toEqual(["read", "message", AUTOMATIONS_TOOL_NAME]);
    expect(names()).toEqual(["read", AUTOMATIONS_TOOL_NAME]);
  });

  it("keeps explicit tool groups and names", () => {
    expect(
      filterToolsByAgentProfile({
        tools: tools(heavyTools),
        config: smallConfig,
        preserveToolNames: ["browser", "cron", "group:messaging", "group:media", "pdf"],
      }).map((tool) => tool.name),
    ).toEqual(heavyTools);
  });

  it("keeps forced message delivery", () => {
    const preserveToolNames = resolveAgentProfilePreserveToolNames({
      forceMessageTool: true,
    });

    expect(
      filterToolsByAgentProfile({
        tools: tools(["read", "message", "exec"]),
        config: smallConfig,
        preserveToolNames,
      }).map((tool) => tool.name),
    ).toEqual(["read", "message", "exec"]);
  });

  it("treats a global wildcard as non-preserving", () => {
    expect(
      filterToolsByAgentProfile({
        tools: tools(["read", "browser", "image_generate"]),
        config: smallConfig,
        preserveToolNames: ["image_*", "*"],
      }).map((tool) => tool.name),
    ).toEqual(["read", "image_generate"]);
  });

  it("leaves base profile tools unchanged", () => {
    const config: OpenClawConfig = {
      agents: { defaults: { agentProfileId: "openclaw/base" } },
    };

    expect(
      filterToolsByAgentProfile({
        tools: tools(["read", "browser", "message", "exec"]),
        config,
      }).map((tool) => tool.name),
    ).toEqual(["read", "browser", "message", "exec"]);
  });
});

describe("small profile Tool Search defaults", () => {
  it("enables bounded Tool Search when unset", () => {
    const config: OpenClawConfig = {
      agents: { defaults: { agentProfileId: "openclaw/small" } },
    };

    expect(applyAgentProfileToolSearchDefaults({ config })?.tools?.toolSearch).toEqual({
      enabled: true,
      mode: "tools",
      searchDefaultLimit: 5,
      maxSearchLimit: 10,
    });
  });

  it("preserves explicit Tool Search configuration", () => {
    const config: OpenClawConfig = {
      agents: { defaults: { agentProfileId: "openclaw/small" } },
      tools: { toolSearch: { enabled: false, mode: "directory" } },
    };

    expect(applyAgentProfileToolSearchDefaults({ config })).toBe(config);
  });

  it("does not change config when no profile is selected", () => {
    const config: OpenClawConfig = {};

    expect(applyAgentProfileToolSearchDefaults({ config })).toBe(config);
  });
});
