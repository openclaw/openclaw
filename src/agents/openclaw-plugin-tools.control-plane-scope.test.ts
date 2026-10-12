/**
 * Regression coverage for control-plane plugin-tool selection.
 *
 * A session whose model requires dynamic resolution prepares a runtime
 * generation narrowed to the selected model owners. `tools.effective` reads
 * that session's tools inside the narrowed generation, so plugin-tool selection
 * must fall back to the full enabled set instead of the narrowed snapshot
 * (issue #167365: every non-memory plugin tool, e.g. `workboard_*`, was hidden).
 */
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createPluginMetadataSnapshot } from "../config/plugin-auto-enable.test-helpers.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { clearPluginMetadataLifecycleCaches } from "../plugins/plugin-metadata-lifecycle.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import { resetPluginRuntimeStateForTest } from "../plugins/runtime.js";
import { withPluginRuntimeGenerationScope } from "../plugins/runtime/generation-scope.js";
import { setPluginRuntimeLoadContext } from "../plugins/runtime/load-context.js";
import { resolvePluginRuntimeLoadContext } from "../plugins/runtime/load-context.resolve.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { resolveOpenClawPluginToolsForOptions } from "./openclaw-plugin-tools.js";

const TOOL_PLUGIN_ID = "enabled-scope-worker";
const TOOL_NAME = `${TOOL_PLUGIN_ID}_tool`;

afterEach(() => {
  clearPluginMetadataLifecycleCaches();
  resetPluginRuntimeStateForTest();
});

function writeToolPlugin(params: { root: string; id: string }): string {
  fs.mkdirSync(params.root, { recursive: true });
  fs.writeFileSync(
    path.join(params.root, "package.json"),
    JSON.stringify({
      name: params.id,
      version: "1.0.0",
      openclaw: { extensions: ["./index.cjs"] },
    }),
  );
  fs.writeFileSync(
    path.join(params.root, "openclaw.plugin.json"),
    JSON.stringify({
      id: params.id,
      contracts: { tools: [`${params.id}_tool`] },
      toolMetadata: { [`${params.id}_tool`]: { optional: true } },
      configSchema: { type: "object", additionalProperties: false },
    }),
  );
  fs.writeFileSync(
    path.join(params.root, "index.cjs"),
    `module.exports = { id: ${JSON.stringify(params.id)}, register(api) {
  api.registerTool(() => ({
    name: ${JSON.stringify(`${params.id}_tool`)},
    label: "Enabled scope fixture",
    description: "Synthetic control-plane scope fixture",
    parameters: { type: "object", properties: {} },
    execute: async () => ({ content: [{ type: "text", text: "ok" }] }),
  }), { name: ${JSON.stringify(`${params.id}_tool`)} });
} };\n`,
  );
  return params.root;
}

describe("control-plane plugin tool selection scope", () => {
  it("lists enabled tool-only plugins despite a narrowed run generation", async () => {
    await withOpenClawTestState(
      { env: { OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1" } },
      async (state) => {
        const pluginRoot = writeToolPlugin({
          root: state.path("plugins", TOOL_PLUGIN_ID),
          id: TOOL_PLUGIN_ID,
        });
        const config: OpenClawConfig = {
          agents: { defaults: { workspace: state.workspaceDir } },
          plugins: {
            allow: [TOOL_PLUGIN_ID],
            load: { paths: [pluginRoot] },
            slots: { memory: "none" },
            entries: { [TOOL_PLUGIN_ID]: { enabled: true } },
          },
        };
        const fullContext = resolvePluginRuntimeLoadContext({ config, env: process.env });
        // Mimic the narrowed model generation: metadata without the tool-only plugin.
        const narrowedSnapshot = createPluginMetadataSnapshot({
          config,
          manifestRegistry: { plugins: [], diagnostics: [] },
          workspaceDir: state.workspaceDir,
        });
        const registry = createEmptyPluginRegistry();
        setPluginRuntimeLoadContext(registry, {
          ...fullContext,
          metadataSnapshot: narrowedSnapshot,
          manifestRegistry: narrowedSnapshot.manifestRegistry,
        });
        const resolveToolNames = (selectionScope?: "enabled") =>
          withPluginRuntimeGenerationScope(
            { metadataSnapshot: narrowedSnapshot, pluginRegistry: registry },
            () =>
              resolveOpenClawPluginToolsForOptions({
                options: {
                  config,
                  requesterAgentIdOverride: "main",
                  agentDir: state.agentDir(),
                  workspaceDir: state.workspaceDir,
                  pluginToolAllowlist: [TOOL_NAME],
                  ...(selectionScope ? { pluginToolSelectionScope: selectionScope } : {}),
                },
                resolvedConfig: config,
              }).map((tool) => tool.name),
          );

        // The narrowed generation alone hides the enabled tool-only plugin.
        expect(resolveToolNames()).not.toContain(TOOL_NAME);
        // The control-plane inventory scope restores the full enabled set.
        expect(resolveToolNames("enabled")).toEqual([TOOL_NAME]);
      },
    );
  });
});
