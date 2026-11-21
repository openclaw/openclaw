import type { ProviderPlugin } from "openclaw/plugin-sdk/provider-model-shared";
import { buildMinimaxProvider } from "./provider-catalog.js";

const minimaxProviderDiscovery: ProviderPlugin[] = ["minimax", "minimax-portal"].map((id) => ({
  id,
  label: "MiniMax",
  docsPath: "/providers/minimax",
  auth: [],
  staticCatalog: {
    order: "simple",
    run: async (ctx) => ({ providers: { [id]: buildMinimaxProvider(ctx.env) } }),
  },
}));

export default minimaxProviderDiscovery;
