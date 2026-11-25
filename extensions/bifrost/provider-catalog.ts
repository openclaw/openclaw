import { resolveMergedModelProviderConfig } from "openclaw/plugin-sdk/provider-catalog-shared";
import type { ProviderPlugin } from "openclaw/plugin-sdk/provider-model-shared";

export default {
  id: "bifrost",
  label: "Bifrost",
  docsPath: "/providers/bifrost",
  envVars: ["BIFROST_VIRTUAL_KEY"],
  auth: [],
  catalog: {
    order: "simple",
    run: async (ctx) => {
      if (ctx.providerIds && !ctx.providerIds.includes("bifrost")) {
        return null;
      }
      const configured = resolveMergedModelProviderConfig(ctx.config, "bifrost");
      if (!configured) {
        return null;
      }
      const auth = ctx.resolveProviderApiKey("bifrost");
      const [{ listBifrostModels }, { runLiveProviderCatalog }] = await Promise.all([
        import("./models.js"),
        import("openclaw/plugin-sdk/provider-catalog-live-runtime"),
      ]);
      const result = await runLiveProviderCatalog({
        providerId: "bifrost",
        profileId: auth.profileId,
        run: async () => ({
          provider: {
            ...(await listBifrostModels({ ...ctx, apiKey: auth.discoveryApiKey })),
            apiKey: configured.auth === "none" ? undefined : (configured.apiKey ?? auth.apiKey),
          },
        }),
      });
      ctx.signal?.throwIfAborted();
      return result;
    },
  },
} satisfies ProviderPlugin;
