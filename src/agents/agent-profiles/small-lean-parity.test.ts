import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import {
  applyAgentProfileToolSearchDefaults,
  filterToolsByAgentProfile,
  resolveAgentProfilePreserveToolNames,
} from "../agent-profiles.js";
import type { AnyAgentTool } from "../agent-tools.types.js";
import {
  prepareAgentToolSurfacePresentation,
  resolveAgentToolSurfacePlan,
} from "../tool-surface-plan.js";
import { AUTOMATIONS_TOOL_NAME } from "../tools/automations-tool-name.js";

// These cases are the local-model Lean fixtures from main (local-model-lean.test.ts and
// tool-search-runtime-config.test.ts), with agentProfileId openclaw/small in place of
// experimental.localModelLean. openclaw/small is the exact Lean migration, so every
// expected value here is the value Lean produced.
function tools(names: string[]): AnyAgentTool[] {
  return names.map((name) => ({ name })) as AnyAgentTool[];
}

const small: OpenClawConfig = { agents: { defaults: { agentProfileId: "openclaw/small" } } };

function filteredNames(
  config: OpenClawConfig,
  options: Omit<Parameters<typeof filterToolsByAgentProfile>[0], "config" | "tools"> = {},
  names = ["read", "browser", "cron", "message", "exec"],
) {
  return filterToolsByAgentProfile({ config, tools: tools(names), ...options }).map(
    (tool) => tool.name,
  );
}

describe("openclaw/small matches local-model Lean", () => {
  it("keeps explicitly preserved tools", () => {
    const names = [
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
    expect(
      filteredNames(
        small,
        { preserveToolNames: ["browser", "cron", "group:messaging", "group:media", "pdf"] },
        names,
      ),
    ).toEqual(names);
  });

  it("removes the exact Lean deny set, automations included", () => {
    expect(
      filteredNames(small, {}, [
        "read",
        "browser",
        AUTOMATIONS_TOOL_NAME,
        "image_generate",
        "message",
        "music_generate",
        "pdf",
        "tts",
        "video_generate",
        "exec",
      ]),
    ).toEqual(["read", "exec"]);
    expect(filteredNames(small)).toEqual(["read", "exec"]);
  });

  it("keeps automations when the caller preserves it", () => {
    expect(
      filteredNames(small, { preserveToolNames: [AUTOMATIONS_TOOL_NAME] }, [
        "read",
        AUTOMATIONS_TOOL_NAME,
        "browser",
      ]),
    ).toEqual(["read", AUTOMATIONS_TOOL_NAME]);
  });

  it.each([
    [{ forceMessageTool: true }, ["message"]],
    [{ sourceReplyDeliveryMode: "message_tool_only" }, ["message"]],
    [{ toolNames: ["group:messaging"], forceMessageTool: true }, ["group:messaging", "message"]],
  ] as const)("adds reply-required message tools to preservation: %j", (options, expected) => {
    expect(resolveAgentProfilePreserveToolNames(options)).toEqual(expected);
  });

  it("matches wildcard preservation without treating a bare wildcard as an override", () => {
    expect(
      filteredNames(small, { preserveToolNames: ["image_*", "*"] }, [
        "read",
        "image_generate",
        "video_generate",
        "browser",
      ]),
    ).toEqual(["read", "image_generate"]);
  });

  it("resolves the profile for an ad-hoc agent and an agent session key", () => {
    expect(filteredNames(small, { agentId: "ad-hoc" })).toEqual(["read", "exec"]);
    const config: OpenClawConfig = {
      agents: {
        entries: {
          main: { agentProfileId: "openclaw/base" },
          gemma: { agentProfileId: "openclaw/small" },
        },
      },
    };
    expect(filteredNames(config, { sessionKey: "agent:gemma:main" })).toEqual(["read", "exec"]);
    expect(filteredNames(config, { sessionKey: "agent:main:main" })).toEqual([
      "read",
      "browser",
      "cron",
      "message",
      "exec",
    ]);
  });

  it("defaults Tool Search only when it is undefined", () => {
    expect(applyAgentProfileToolSearchDefaults({ config: small })?.tools?.toolSearch).toEqual({
      enabled: true,
      mode: "tools",
      searchDefaultLimit: 5,
      maxSearchLimit: 10,
    });
    const explicit: OpenClawConfig = { ...small, tools: { toolSearch: false } };
    expect(applyAgentProfileToolSearchDefaults({ config: explicit })).toBe(explicit);
  });

  it("applies Tool Search defaults and the compact directory on the forced-reply surface", () => {
    const plan = resolveAgentToolSurfacePlan({
      config: small,
      forceDirectMessageTool: true,
      toolsEnabled: true,
      isRawModelRun: false,
    });
    expect(plan.toolSearchRuntimeConfig?.tools?.toolSearch).toEqual({
      enabled: true,
      mode: "tools",
      searchDefaultLimit: 5,
      maxSearchLimit: 10,
    });
    expect(
      prepareAgentToolSurfacePresentation({
        config: small,
        forceDirectMessageTool: true,
        toolsEnabled: true,
        isRawModelRun: false,
      }).toolSearchDirectoryLean,
    ).toBe(true);
  });
});
