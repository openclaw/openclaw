import path from "node:path";
import type { StreamFn } from "openclaw/plugin-sdk/agent-core";
import { createLazyRuntimeModule } from "openclaw/plugin-sdk/lazy-runtime";
import { defineSingleProviderPluginEntry } from "openclaw/plugin-sdk/provider-entry";
import { APPLE_FM_LOCAL_AUTH_MARKER, APPLE_FM_PROVIDER_ID } from "./defaults.js";
import manifest from "./openclaw.plugin.json" with { type: "json" };

const loadSetup = createLazyRuntimeModule(() => import("./setup.js"));
const loadStream = createLazyRuntimeModule(() => import("./stream.js"));

export default defineSingleProviderPluginEntry({
  id: APPLE_FM_PROVIDER_ID,
  name: "Apple Foundation Models",
  description: "On-device Apple Intelligence inference for lightweight OpenClaw setup",
  manifest,
  provider: (api) => {
    const pluginRoot = api.rootDir ?? path.dirname(api.source);
    const loadNative = createLazyRuntimeModule(async () =>
      (await import("./native.js")).createAppleFmNative(pluginRoot),
    );
    const nativeStream: StreamFn = async (...args) =>
      (await loadStream()).createAppleFmStream(await loadNative())(...args);
    return {
      label: "Apple Foundation Models",
      docsPath: "/plugins/apple-fm",
      extraAuth: [
        {
          id: "local",
          label: "Apple Foundation Models (on-device)",
          kind: "custom",
          wizard: { modelTarget: "utility" },
          run: async (ctx) => (await loadSetup()).runAppleFmSetup(ctx, await loadNative()),
          runNonInteractive: async (ctx) =>
            (await loadSetup()).configureAppleFmNonInteractive(ctx, await loadNative()),
          validateNonInteractive: async (ctx) =>
            (await loadSetup()).validateAppleFmNonInteractive(ctx, await loadNative()),
          appGuidedSetup: {
            detect: async (ctx) => (await loadSetup()).detectAppleFmSetup(ctx, await loadNative()),
            detectAvailability: async (ctx) =>
              Boolean(await (await loadSetup()).detectAppleFmSetup(ctx, await loadNative())),
            prepare: async (ctx) =>
              (await loadSetup()).prepareAppleFmSetup(ctx, await loadNative()),
          },
        },
      ],
      catalog: {
        order: "late",
        run: async (ctx) => {
          const provider = ctx.config.models?.providers?.[APPLE_FM_PROVIDER_ID];
          return provider && process.platform === "darwin" ? { provider } : null;
        },
      },
      resolveSyntheticAuth: ({ providerConfig }) =>
        process.platform === "darwin" && providerConfig
          ? {
              apiKey: APPLE_FM_LOCAL_AUTH_MARKER,
              source: "on-device Apple Foundation Models",
              mode: "api-key",
            }
          : undefined,
      buildMissingAuthMessage: () =>
        "Run openclaw onboard and select Apple Foundation Models on a supported Mac to prepare local inference. No API key is required.",
      createStreamFn: () => nativeStream,
      wrapSimpleCompletionStreamFn: () => nativeStream,
    };
  },
});
