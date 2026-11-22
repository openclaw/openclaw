import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import type { ModelSizeClass } from "../config/types.models.js";
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

const autoConfig: OpenClawConfig = { agents: { defaults: { agentProfileId: "auto" } } };

describe("Agent Profile selection", () => {
  it.each(["tiny", "small", "medium", "large"] as const)(
    "keeps a %s model on the base profile until size selection is enabled",
    (modelSizeClass) => {
      const resolved = resolveAgentProfile({ config: {}, modelSizeClass });

      expect(resolved.profile.id).toBe("openclaw/base");
      expect(resolved.selectionSource).toBe("fallback");
    },
  );

  it("keeps the base profile for a size class when no config is given", () => {
    const resolved = resolveAgentProfile({ modelSizeClass: "small" });

    expect(resolved.profile.id).toBe("openclaw/base");
    expect(resolved.selectionSource).toBe("fallback");
  });

  it("chains the small profile from the base profile", () => {
    const resolved = resolveAgentProfile({ config: autoConfig, modelSizeClass: "small" });

    expect(resolved.profile.ancestry).toEqual(["openclaw/base", "openclaw/small"]);
  });

  it.each([
    ["tiny", "openclaw/small"],
    ["small", "openclaw/small"],
    ["medium", "openclaw/base"],
    ["large", "openclaw/base"],
  ] as const)("maps %s model metadata to %s", (modelSizeClass, expectedProfileId) => {
    const resolved = resolveAgentProfile({ config: autoConfig, modelSizeClass });

    expect(resolved.profile.id).toBe(expectedProfileId);
    expect(resolved.selectionSource).toBe("model-size");
  });

  it("falls back to the base profile without trusted matching facts", () => {
    const resolved = resolveAgentProfile({
      config: autoConfig,
    });

    expect(resolved.profile.id).toBe("openclaw/base");
    expect(resolved.selectionSource).toBe("fallback");
  });

  it("uses an explicit default profile before automatic bindings", () => {
    const config: OpenClawConfig = {
      agents: { defaults: { agentProfileId: "openclaw/base" } },
    };
    const resolved = resolveAgentProfile({ config, modelSizeClass: "small" });

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

  it("lets a per-agent auto selector bypass an explicit default", () => {
    const config: OpenClawConfig = {
      agents: {
        defaults: { agentProfileId: "openclaw/base" },
        entries: {
          main: { agentProfileId: "auto" },
        },
      },
    };
    const resolved = resolveAgentProfile({
      config,
      agentId: "main",
      modelSizeClass: "small",
    });

    expect(resolved.profile.id).toBe("openclaw/small");
    expect(resolved.selectionSource).toBe("model-size");
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

  it("selects the small profile before applying defaults", () => {
    expect(
      applyAgentProfileToolSearchDefaults({
        config: autoConfig,
        modelSizeClass: "small",
      })?.tools?.toolSearch,
    ).toMatchObject({ enabled: true, mode: "tools" });
  });

  it("leaves Tool Search alone for a small model while size selection is off", () => {
    const config: OpenClawConfig = {};

    expect(applyAgentProfileToolSearchDefaults({ config, modelSizeClass: "small" })).toBe(config);
  });

  it("does not change config for an unmatched model", () => {
    const config: OpenClawConfig = {};

    expect(
      applyAgentProfileToolSearchDefaults({
        config,
      }),
    ).toBe(config);
  });

  it.each<ModelSizeClass>(["tiny", "small"])(
    "enables Tool Search for %s model metadata",
    (modelSizeClass) => {
      expect(
        applyAgentProfileToolSearchDefaults({
          config: autoConfig,
          modelSizeClass,
        })?.tools?.toolSearch,
      ).toMatchObject({ enabled: true });
    },
  );
});
