import fs from "node:fs";
import path from "node:path";
import { afterAll, afterEach, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  cleanupPluginLoaderFixturesForTest,
  makePluginLoaderTempDir,
  resetPluginLoaderTestStateForTest,
  useNoBundledPlugins,
  writePlugin,
} from "../plugins/loader.test-fixtures.js";
import { loadPluginMetadataSnapshot } from "../plugins/plugin-metadata-snapshot.js";
import { withPluginRuntimeGenerationRegistryScope } from "../plugins/runtime/generation-state.js";
import { resolveRuntimeWebSearchProviders } from "../plugins/web-search-providers.runtime.js";
import { loadAgentRuntimePluginRegistryHandle } from "./runtime-plugins.js";

afterEach(resetPluginLoaderTestStateForTest);
afterAll(cleanupPluginLoaderFixturesForTest);

it.each(["allowed", "disabled", "denied"])(
  "admits only the exact permitted run search owner: %s",
  async (policy) => {
    useNoBundledPlugins();
    const plugins = ["inherited", "selected", "unrelated"].map((id) => {
      const plugin = writePlugin({
        id,
        registration: `api.registerWebSearchProvider({
        id: ${JSON.stringify(id)}, label: ${JSON.stringify(id)}, hint: "fixture",
        envVars: [], placeholder: "fixture", signupUrl: "https://example.com",
        credentialPath: "unused", requiresCredential: false,
        getCredentialValue: () => undefined, setCredentialValue: () => {},
        createTool: () => ({ description: "fixture", parameters: {},
          execute: async () => ({ provider: ${JSON.stringify(id)} }) })
      });`,
      });
      fs.writeFileSync(
        path.join(plugin.dir, "openclaw.plugin.json"),
        JSON.stringify({
          id,
          configSchema: { type: "object", properties: {} },
          contracts: { webSearchProviders: [id] },
        }),
      );
      return plugin;
    });
    const config: OpenClawConfig = {
      tools: { web: { search: { provider: "inherited" } } },
      plugins: {
        allow: policy === "denied" ? ["inherited", "unrelated"] : plugins.map(({ id }) => id),
        load: { paths: plugins.map(({ file }) => file) },
        entries: Object.fromEntries(
          plugins.map(({ id }) => [id, { enabled: id !== "selected" || policy !== "disabled" }]),
        ),
        slots: { memory: "none" },
      },
    };
    const workspaceDir = makePluginLoaderTempDir();
    const metadataSnapshot = loadPluginMetadataSnapshot({
      config,
      workspaceDir,
      allowCurrent: false,
    });
    const common = { config, workspaceDir, metadataSnapshot, configuredHarnessRuntimes: [] };
    const inherited = loadAgentRuntimePluginRegistryHandle({
      ...common,
      basePluginIds: ["inherited"],
      selections: [],
    });
    const selection = {
      provider: "",
      modelId: "",
      runtime: "openclaw",
      webSearchProvider: "selected",
    };
    const selected = loadAgentRuntimePluginRegistryHandle({
      ...common,
      basePluginIds: ["inherited"],
      reusableRegistry: inherited,
      selections: [selection],
    });
    const visible = (registry: typeof selected) =>
      withPluginRuntimeGenerationRegistryScope(registry, () =>
        resolveRuntimeWebSearchProviders({
          config,
          workspaceDir,
          manifestRecords: metadataSnapshot.plugins,
        }),
      );
    expect(visible(inherited).map(({ id }) => id)).toEqual(["inherited"]);
    expect(visible(selected).map(({ id }) => id)).toEqual(
      policy === "allowed" ? ["inherited", "selected"] : ["inherited"],
    );
    if (policy === "allowed") {
      const tool = visible(selected)
        .find(({ id }) => id === "selected")!
        .createTool({ config });
      expect(await tool!.execute({ query: "fixture" })).toEqual({ provider: "selected" });
    }
    expect(config.tools?.web?.search?.provider).toBe("inherited");
  },
);
