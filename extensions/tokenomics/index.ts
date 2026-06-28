// Tokenomics plugin entrypoint registers its OpenClaw integration.
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { createTokenomicsService } from "./src/service.js";

const tokenomics = createTokenomicsService();

export default definePluginEntry({
  id: "tokenomics",
  name: "Tokenomics",
  description: "Local-first LLM spend ledger and report built on OpenClaw's per-call cost data",
  register(api) {
    api.registerService(tokenomics.service);
    api.registerHttpRoute({
      path: "/api/diagnostics/tokenomics",
      auth: "gateway",
      match: "exact",
      gatewayRuntimeScopeSurface: "trusted-operator",
      handler: tokenomics.handler,
    });
  },
});
