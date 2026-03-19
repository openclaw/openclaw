import { formatCliCommand } from "../../cli/command-format.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { buildProviderAuthDoctorHintWithPlugin } from "../../plugins/provider-runtime.runtime.js";
import { normalizeProviderId } from "../provider-id.js";
import { listProfilesForProvider } from "./profiles.js";
import { suggestOAuthProfileIdForLegacyDefault } from "./repair.js";
import type { AuthProfileStore } from "./types.js";

/**
 * Sanitize a profile ID before embedding it in error messages or log output.
 * Strips ANSI escape sequences and control characters to prevent terminal/log
 * injection via crafted profile IDs.
 *
 * Handles CSI, OSC, DCS/SOS/PM/APC, and bare ESC sequences.
 */
function sanitizeProfileIdForDisplay(id: string): string {
  return (
    id
      .replace(
        // eslint-disable-next-line no-control-regex
        /\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\)|[PX^_][^\x1b]*\x1b\\|[\s\S]?)/g,
        "",
      )
      // eslint-disable-next-line no-control-regex
      .replace(/[\u0000-\u001f\u007f]/g, "")
  );
}

/**
 * Migration hints for deprecated/removed OAuth providers.
 * Users with stale credentials should be guided to migrate.
 */
const DEPRECATED_PROVIDER_MIGRATION_HINTS: Record<string, string> = {
  "qwen-portal":
    "Qwen OAuth via portal.qwen.ai has been deprecated. Please migrate to Qwen Cloud Coding Plan. Run: openclaw onboard --auth-choice qwen-api-key (or qwen-api-key-cn for the China endpoint). Legacy modelstudio auth-choice ids still work.",
};

export async function formatAuthDoctorHint(params: {
  cfg?: OpenClawConfig;
  store: AuthProfileStore;
  provider: string;
  profileId?: string;
}): Promise<string> {
  const normalizedProvider = normalizeProviderId(params.provider);

  // Check for deprecated provider migration hints first
  const migrationHint = DEPRECATED_PROVIDER_MIGRATION_HINTS[normalizedProvider];
  if (migrationHint) {
    return migrationHint;
  }

  const pluginHint = await buildProviderAuthDoctorHintWithPlugin({
    provider: normalizedProvider,
    context: {
      config: params.cfg,
      store: params.store,
      provider: normalizedProvider,
      profileId: params.profileId,
    },
  });
  if (typeof pluginHint === "string" && pluginHint.trim()) {
    return pluginHint;
  }

  const legacyProfileId = params.profileId ?? "anthropic:default";
  const suggested = suggestOAuthProfileIdForLegacyDefault({
    cfg: params.cfg,
    store: params.store,
    provider: normalizedProvider,
    legacyProfileId,
  });
  if (!suggested || suggested === legacyProfileId) {
    return "";
  }

  const storeOauthProfiles = listProfilesForProvider(params.store, normalizedProvider)
    .filter((id) => params.store.profiles[id]?.type === "oauth")
    .map(sanitizeProfileIdForDisplay)
    .join(", ");

  const cfgMode = params.cfg?.auth?.profiles?.[legacyProfileId]?.mode;
  const cfgProvider = params.cfg?.auth?.profiles?.[legacyProfileId]?.provider;

  // Sanitize profile IDs before embedding in error/log output to prevent
  // terminal injection via crafted profile names.
  const safeProfileId = sanitizeProfileIdForDisplay(legacyProfileId);
  const safeSuggested = sanitizeProfileIdForDisplay(suggested);

  return [
    "Doctor hint (for GitHub issue):",
    `- provider: ${normalizedProvider}`,
    `- config: ${safeProfileId}${
      cfgProvider || cfgMode ? ` (provider=${cfgProvider ?? "?"}, mode=${cfgMode ?? "?"})` : ""
    }`,
    `- auth store oauth profiles: ${storeOauthProfiles || "(none)"}`,
    `- suggested profile: ${safeSuggested}`,
    `Fix: run "${formatCliCommand("openclaw doctor --yes")}"`,
  ].join("\n");
}
