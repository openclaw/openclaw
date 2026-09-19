import { expect, it } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import { resolveRunModelFallbacksOverride } from "../agent-scope.js";
import { resolveCompactionFallbacksOverride } from "./compact-fallbacks.js";
import type { CompactEmbeddedAgentSessionParams } from "./compact.types.js";

function explicitFleetConfig(): OpenClawConfig {
  return {
    agents: {
      ownership: "explicit",
      defaults: {},
      entries: {
        main: {
          model: {
            fallbacks: ["openai/gpt-5.4"],
          },
        },
        work: {},
      },
    },
  };
}

function compactParams(
  config: OpenClawConfig,
  agentId?: string,
): CompactEmbeddedAgentSessionParams {
  return {
    sessionId: "compaction-global-owner",
    sessionKey: "global",
    sessionFile: "global",
    workspaceDir: "/tmp/openclaw-compaction-global-owner",
    config,
    ...(agentId ? { agentId } : {}),
  };
}

it("keeps an explicit agentId when compacting a literal global session", () => {
  const config = explicitFleetConfig();

  expect(() =>
    resolveRunModelFallbacksOverride({
      cfg: config,
      sessionKey: "global",
    }),
  ).toThrow(/no explicit owner/);
  expect(() => resolveCompactionFallbacksOverride(compactParams(config))).toThrow(
    /no explicit owner/,
  );
  expect(resolveCompactionFallbacksOverride(compactParams(config, "main"))).toEqual([
    "openai/gpt-5.4",
  ]);
});
