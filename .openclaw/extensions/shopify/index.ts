import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { createShopifyTools } from "./shopify.js";

const shopifyPlugin = {
  id: "shopify",
  name: "Shopify Ops",
  description: "Shopify inventory operations and staged-drop scaffolding.",
  register(api: OpenClawPluginApi) {
    const tools = createShopifyTools({ api });

    api.registerTool(tools.healthcheck);
    api.registerTool(tools.variantSearch);
    api.registerTool(tools.inventoryPreview);

    // Side effects are opt-in only.
    api.registerTool(tools.inventoryApply, { optional: true });

    // Staging flow is intentionally stubbed and optional until publish behavior is implemented.
    api.registerTool(tools.stageDrop, { optional: true });
  },
};

export default shopifyPlugin;
