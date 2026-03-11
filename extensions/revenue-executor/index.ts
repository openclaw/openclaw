import type { OpenClawPluginApi } from "../../src/plugins/types.js";
import { createRevenueTools } from "./src/tools.js";

const AGENT_GUIDANCE = [
  "When handling revenue commands, prefer execute_revenue_command for deterministic JSON output.",
  "If you need step-by-step diagnostics, use parse_revenue_command, ghl_check_contact, ghl_create_contact, ghl_create_opportunity, and stripe_create_payment_link.",
  "Return JSON only when asked for automation-friendly output.",
].join(" ");

const plugin = {
  id: "revenue-executor",
  name: "Revenue Executor",
  description: "GHL + Stripe business execution tools for revenue commands.",
  configSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      callbackUrl: { type: "string" },
      defaultCurrency: { type: "string" },
      ghlApiKey: { type: "string" },
      ghlBaseUrl: { type: "string" },
      ghlLocationId: { type: "string" },
      stripeSecretKey: { type: "string" },
      stripeSuccessUrl: { type: "string" },
    },
  },
  register(api: OpenClawPluginApi) {
    for (const tool of createRevenueTools(api)) {
      api.registerTool(tool, { optional: true });
    }
    api.on("before_prompt_build", async () => ({
      prependSystemContext: AGENT_GUIDANCE,
    }));
  },
};

export default plugin;
