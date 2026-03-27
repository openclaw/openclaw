/**
 * GenPark Runtime Hooks
 *
 * Registers GenPark-specific runtime hooks and exposes the API client
 * for other extensions to consume.
 *
 * NOTE FOR GENPARK ENGINEERS:
 * The runtime object interface is modeled on OpenClaw's runtime API.
 * When integrating, ensure `runtime.registerTool` and `runtime.on`
 * match the actual OpenClaw runtime surface.
 */

import { GenParkClient, GenParkApiError } from "./api-client.ts";
import { getGenParkClient } from "./channel.ts";
import {
  TOOL_NAME,
  marketplaceToolDefinition,
  handleMarketplaceSearch,
  type MarketplaceSearchParams,
} from "./marketplace.ts";

// ---------------------------------------------------------------------------
// Runtime Setup
// ---------------------------------------------------------------------------

/**
 * Register GenPark runtime hooks with the OpenClaw runtime.
 *
 * Called by the plugin entry after the channel plugin is initialized.
 * Registers the marketplace search tool and error-handling hooks.
 */
export const setGenParkRuntime = (runtime: any): void => {
  console.log("[GenPark] Registering runtime hooks...");

  // 1. Register the marketplace search tool
  if (runtime.registerTool) {
    runtime.registerTool({
      ...marketplaceToolDefinition,
      handler: async (params: MarketplaceSearchParams) => {
        return handleMarketplaceSearch(params);
      },
    });
    console.log(`[GenPark] Registered tool: ${TOOL_NAME}`);
  }

  // 2. Register error response hooks (upgrade prompts on 403/429)
  if (runtime.on) {
    runtime.on("apiError", (error: unknown) => {
      if (error instanceof GenParkApiError) {
        if (error.isForbidden) {
          return {
            userMessage:
              "🔒 **GenPark Pro Required**\n\n" +
              "This action requires a GenPark Pro subscription.\n" +
              "Upgrade at **[genpark.ai/pricing](https://genpark.ai/pricing)** " +
              "to unlock unlimited Circle access and marketplace features.",
            handled: true,
          };
        }
        if (error.isRateLimited) {
          return {
            userMessage:
              "⏳ **Rate Limit Reached**\n\n" +
              "You've hit the GenPark API rate limit. " +
              "Upgrade to Pro for higher limits: " +
              "**[genpark.ai/pricing](https://genpark.ai/pricing)**",
            handled: true,
          };
        }
      }
      return { handled: false };
    });
    console.log("[GenPark] Registered API error hooks.");
  }

  console.log("[GenPark] Runtime hooks registered.");
};

// ---------------------------------------------------------------------------
// Public API for other extensions
// ---------------------------------------------------------------------------

/**
 * Get the initialized GenPark client for use by other plugins.
 * Returns null if GenPark is not configured.
 */
export { getGenParkClient } from "./channel.ts";
export { GenParkClient, GenParkApiError } from "./api-client.ts";
