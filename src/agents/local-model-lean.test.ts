import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { retainLegacyDefaultAgentId } from "../config/legacy.default-agent-owner.js";
import type { AnyAgentTool } from "./agent-tools.types.js";
import {
  filterLocalModelLeanTools,
  isLocalModelLeanEnabled,
  resolveLocalModelLeanPreserveToolNames,
} from "./local-model-lean.js";

// Tool Search overlays are covered by tool-search-runtime-config.test.ts.
function tools(names: string[]): AnyAgentTool[] {
  return names.map((name) => ({ name })) as AnyAgentTool[];
}

const lean = (localModelLean: boolean) => ({ experimental: { localModelLean } });
const ownedEntries = { ops: lean(false), gemma: lean(true) };
function defaultLeanConfig(
  entries: NonNullable<OpenClawConfig["agents"]>["entries"] = { main: {} },
): OpenClawConfig {
  return { agents: { entries, defaults: lean(true) } };
}

function filteredNames(
  config: OpenClawConfig,
  options: Omit<Parameters<typeof filterLocalModelLeanTools>[0], "config" | "tools"> = {},
  names = ["read", "browser", "cron", "message", "exec"],
) {
  return filterLocalModelLeanTools({ config, tools: tools(names), ...options }).map(
    (tool) => tool.name,
  );
}

describe("local model lean tool filtering", () => {
  it("keeps explicitly preserved tools when lean mode is enabled", () => {
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
        defaultLeanConfig(),
        {
          preserveToolNames: ["browser", "cron", "group:messaging", "group:media", "pdf"],
        },
        names,
      ),
    ).toEqual(names);
  });

  it.each([
    [{ forceMessageTool: true }, ["message"]],
    [{ sourceReplyDeliveryMode: "message_tool_only" }, ["message"]],
    [{ toolNames: ["group:messaging"], forceMessageTool: true }, ["group:messaging", "message"]],
  ] as const)("adds reply-required message tools to lean preservation: %j", (options, expected) => {
    expect(resolveLocalModelLeanPreserveToolNames(options)).toEqual(expected);
  });

  it("matches wildcard preservation without treating a bare wildcard as an override", () => {
    expect(
      filteredNames(defaultLeanConfig(), { preserveToolNames: ["image_*", "*"] }, [
        "read",
        "image_generate",
        "video_generate",
        "browser",
      ]),
    ).toEqual(["read", "image_generate"]);
  });

  it.each([
    ["main", defaultLeanConfig({ main: lean(false) }), false],
    ["ad-hoc", { agents: { defaults: lean(true) } }, true],
  ] as const)("resolves inherited lean mode for %s", (agentId, config, enabled) => {
    expect(isLocalModelLeanEnabled({ config, agentId })).toBe(enabled);
    expect(filteredNames(config, { agentId })).toEqual(
      enabled ? ["read", "exec"] : ["read", "browser", "cron", "message", "exec"],
    );
  });

  it("requires explicit selection despite retained Doctor ownership when no session is provided", () => {
    const cfg = retainLegacyDefaultAgentId(
      {
        agents: { ownership: "explicit", entries: ownedEntries },
      } satisfies OpenClawConfig,
      "gemma",
    );

    expect(() => isLocalModelLeanEnabled({ config: cfg })).toThrowError(
      expect.objectContaining({ code: "AGENT_SELECTION_REQUIRED" }),
    );
    expect(isLocalModelLeanEnabled({ config: cfg, agentId: "gemma" })).toBe(true);
    expect(isLocalModelLeanEnabled({ config: cfg, agentId: "ops" })).toBe(false);
  });

  it("uses the agent from an agent session key", () => {
    const cfg: OpenClawConfig = { agents: { entries: { main: lean(false), gemma: lean(true) } } };

    expect(isLocalModelLeanEnabled({ config: cfg, sessionKey: "agent:gemma:main" })).toBe(true);
    expect(filteredNames(cfg, { sessionKey: "agent:gemma:main" })).toEqual(["read", "exec"]);
  });

  it("uses the configured fixed-store owner for an unscoped session key", () => {
    const cfg: OpenClawConfig = {
      session: { store: "/stores/shared.sqlite" },
      agents: {
        ownership: "explicit",
        defaults: { sessionStore: { agentId: "gemma" } },
        entries: ownedEntries,
      },
    };

    expect(isLocalModelLeanEnabled({ config: cfg, sessionKey: "global" })).toBe(true);
    expect(() =>
      isLocalModelLeanEnabled({ config: cfg, agentId: "ops", sessionKey: "global" }),
    ).toThrow(/belongs to "gemma"/);
  });
});
