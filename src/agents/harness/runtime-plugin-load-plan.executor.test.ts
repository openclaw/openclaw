import { describe, expect, it } from "vitest";
import {
  createPluginMetadataSnapshot,
  makeRegistry,
} from "../../config/plugin-auto-enable.test-helpers.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { resolveAgentRuntimePluginLoadPlan } from "./runtime-plugin-load-plan.js";

describe("executor plugin runtime activation", () => {
  it.each([true, false])(
    "includes an independent executor plugin only when enabled: %s",
    (enabled) => {
      const config: OpenClawConfig = {
        plugins: {
          allow: ["fixture-harness", "fixture-executor"],
          slots: { memory: "none" },
          entries: {
            "fixture-harness": { enabled: true },
            "fixture-executor": { enabled },
          },
        },
      };
      const manifestRegistry = makeRegistry(
        ["fixture-harness", "fixture-executor"].map((id) => ({
          id,
          channels: [],
          activation: { onAgentHarnesses: ["fixture-harness"] },
        })),
      );
      const metadataSnapshot = createPluginMetadataSnapshot({ config, manifestRegistry });
      const plan = resolveAgentRuntimePluginLoadPlan({
        config,
        workspaceDir: "/fixture/workspace",
        basePluginIds: [],
        selections: [{ provider: "", modelId: "", runtime: "fixture-harness" }],
        metadataSnapshot,
      });
      expect(plan.pluginIds).toEqual(
        enabled ? ["fixture-executor", "fixture-harness"] : ["fixture-harness"],
      );
    },
  );
});
