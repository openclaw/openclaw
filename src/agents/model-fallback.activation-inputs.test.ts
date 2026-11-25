import { setImmediate } from "node:timers/promises";
import { expect, it, vi } from "vitest";
import * as materialization from "../config/plugin-auto-enable.materialize.js";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../config/runtime-snapshot.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import * as activation from "../plugins/activation-context.js";
import { withPluginMetadataSnapshotScope } from "../plugins/current-plugin-metadata-snapshot.js";
import { createPluginCache, withPluginCache } from "../plugins/plugin-cache.js";
import { rebasePluginMetadataSnapshotManifestRegistry } from "../plugins/plugin-metadata-snapshot.js";
import { createPluginMetadataSnapshotFixture } from "../plugins/plugin-metadata.test-support.js";
import { freezeJsonSnapshot } from "../shared/immutable-data.js";
import { runWithModelFallback } from "./model-fallback-runner.js";
import { completionModelDefinition } from "./simple-completion.test-support.js";

it.each(["published", "frozen"] as const)(
  "prepares fallback activation once per %s config and metadata generation",
  async (mode) => {
    const config: OpenClawConfig = {
      agents: {
        defaults: {
          model: {
            primary: "synthetic-provider/primary",
            fallbacks: ["synthetic-provider/fallback"],
          },
        },
      },
      models: {
        providers: {
          "synthetic-provider": {
            api: "openai-completions",
            auth: "api-key",
            apiKey: "synthetic-fixture-key",
            baseUrl: "https://synthetic.invalid/v1",
            models: ["primary", "fallback"].map((id) => completionModelDefinition({ id })),
          },
        },
      },
      channels: { discord: { token: "synthetic-discord-token" } },
      plugins: {
        allow: ["channel-owner"],
        slots: { memory: "none" },
        entries: {},
      },
    };
    if (mode === "published") {
      setRuntimeConfigSnapshot(config);
    } else {
      freezeJsonSnapshot(config);
    }
    const materialize = vi.spyOn(materialization, "materializePluginAutoEnableCandidatesInternal");
    const resolveActivation = vi.spyOn(activation, "resolveBundledCompatActivationInputs");
    await using firstCache = createPluginCache();
    const first = withPluginCache(firstCache, () => {
      const metadata = createPluginMetadataSnapshotFixture({
        plugins: [{ id: "channel-owner", origin: "config", channels: ["discord"] }],
      });
      metadata.discovery = { candidates: [], diagnostics: [] };
      return metadata;
    });
    const second = rebasePluginMetadataSnapshotManifestRegistry(first, first.manifestRegistry);
    const run = async (
      metadata: typeof first,
      cfg: OpenClawConfig,
      pluginId: string,
      enabled: boolean,
    ) => {
      await setImmediate();
      resolveActivation.mockClear();
      const result = await withPluginMetadataSnapshotScope(
        metadata,
        () =>
          runWithModelFallback({
            cfg,
            provider: "synthetic-provider",
            model: "primary",
            skipAuthProfileRuntime: true,
            run: async (_provider, model) => model,
          }),
        { config: cfg, trustConfigIdentity: true },
      );
      expect(result.result).toBe("primary");
      expect(resolveActivation.mock.results.length).toBeGreaterThan(0);
      for (const resolved of resolveActivation.mock.results) {
        expect(resolved.type).toBe("return");
        expect(resolved.value.normalized.entries[pluginId]?.enabled).toBe(enabled);
      }
    };
    try {
      for (let index = 0; index < 3; index++) {
        await run(first, config, "channel-owner", true);
      }
      expect(materialize).toHaveBeenCalledTimes(1);
      const disabledPlugins = {
        ...config.plugins,
        entries: { "channel-owner": { enabled: false } },
      };
      const disabled =
        mode === "published" ? config : freezeJsonSnapshot({ ...config, plugins: disabledPlugins });
      if (mode === "published") {
        expect(Object.isFrozen(config)).toBe(false);
        config.plugins = disabledPlugins;
        setRuntimeConfigSnapshot(config);
      }
      await run(first, disabled, "channel-owner", false);
      expect(materialize).toHaveBeenCalledTimes(2);
      await run(second, disabled, "channel-owner", false);
      expect(materialize).toHaveBeenCalledTimes(3);
      await run(first, config, "channel-owner", mode === "frozen");
      await run(first, disabled, "channel-owner", false);
      await run(second, disabled, "channel-owner", false);
      expect(materialize).toHaveBeenCalledTimes(3);
    } finally {
      materialize.mockRestore();
      resolveActivation.mockRestore();
      clearRuntimeConfigSnapshot();
    }
  },
);
