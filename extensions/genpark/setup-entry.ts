/**
 * GenPark Plugin Setup Entry
 *
 * Handles plugin lifecycle: setup (config validation, health check)
 * and teardown (cleanup webhooks, close connections).
 */

import { GenParkClient, GenParkApiError } from "./src/api-client.ts";

export interface GenParkSetupConfig {
  genpark_api_token?: string;
  circle_id?: string;
  circle_webhook_secret?: string;
  marketplace_enabled?: boolean;
}

export function setup(config?: GenParkSetupConfig) {
  console.log("[GenPark] Setting up plugin...");

  // Validate required config
  if (!config?.genpark_api_token) {
    console.warn(
      "[GenPark] ⚠️  No API token configured.\n" +
        "  Set channels.genpark.genpark_api_token in your openclaw.json\n" +
        "  Get your token at https://genpark.ai/settings/api",
    );
  } else {
    // Run async health check (non-blocking)
    void healthCheck(config.genpark_api_token);
  }

  if (config?.circle_id) {
    console.log(`[GenPark] Circle ID: ${config.circle_id}`);
  }

  if (config?.marketplace_enabled !== false) {
    console.log("[GenPark] Marketplace search tool: enabled");
  }

  // Return teardown function
  return async () => {
    console.log("[GenPark] Tearing down plugin...");
    // Future: unregister webhooks, close long-poll connections, etc.
    console.log("[GenPark] Plugin teardown complete.");
  };
}

/**
 * Verify API token is valid on startup.
 */
async function healthCheck(apiToken: string): Promise<void> {
  try {
    const client = new GenParkClient({ apiToken });
    const me = await client.getMe();
    console.log(
      `[GenPark] ✅ Health check passed — authenticated as ${me.displayName ?? me.username}`,
    );
  } catch (err) {
    if (err instanceof GenParkApiError) {
      if (err.isUnauthorized) {
        console.error(
          "[GenPark] ❌ Health check FAILED — invalid API token. Update your config.",
        );
      } else {
        console.warn(
          `[GenPark] ⚠️  Health check returned ${err.status}: ${err.statusText}`,
        );
      }
    } else {
      console.warn(
        "[GenPark] ⚠️  Health check failed (network error) — will retry on first message.",
      );
    }
  }
}
