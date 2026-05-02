import { normalizeProviderId } from "@openclaw/model-catalog-core/provider-id";
import { formatCliCommand } from "../../cli/command-format.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { buildProviderAuthDoctorHintWithPlugin } from "../../plugins/provider-runtime.runtime.js";
import { listProfilesForProvider } from "./profiles.js";
import { suggestOAuthProfileIdForLegacyDefault } from "./repair.js";
import { sanitizeProfileIdForDisplay } from "./sanitize.js";
import type { AuthProfileStore } from "./types.js";

const QWEN_PORTAL_OAUTH_MIGRATION_HINT =
  "Legacy Qwen Portal OAuth profiles are not refreshable. Re-authenticate with a current portal token: openclaw onboard --auth-choice qwen-oauth.";

function hasLegacyQwenPortalOAuthProfile(store: AuthProfileStore, profileId?: string): boolean {
  const profiles = profileId ? [store.profiles[profileId]] : Object.values(store.profiles);
  return profiles.some(
    (profile) =>
      profile?.type === "oauth" && normalizeProviderId(profile.provider) === "qwen-portal",
  );
}

function sanitizeDoctorDisplayValue(value: unknown): string | undefined {
  return typeof value === "string" ? sanitizeProfileIdForDisplay(value) : undefined;
}

export async function formatAuthDoctorHint(params: {
  cfg?: OpenClawConfig;
  store: AuthProfileStore;
  provider: string;
  profileId?: string;
}): Promise<string> {
  const normalizedProvider = normalizeProviderId(params.provider);
  if (
    normalizedProvider === "qwen-portal" &&
    hasLegacyQwenPortalOAuthProfile(params.store, params.profileId)
  ) {
    return QWEN_PORTAL_OAUTH_MIGRATION_HINT;
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
    .map((id) => sanitizeDoctorDisplayValue(id) ?? "")
    .join(", ");

  const cfgMode = params.cfg?.auth?.profiles?.[legacyProfileId]?.mode;
  const cfgProvider = params.cfg?.auth?.profiles?.[legacyProfileId]?.provider;

  // Sanitize all user/config-derived display fields before embedding them in
  // error/log output to prevent terminal injection via crafted values.
  const safeProvider = sanitizeDoctorDisplayValue(normalizedProvider) ?? normalizedProvider;
  const safeConfigProvider = sanitizeDoctorDisplayValue(cfgProvider);
  const safeConfigMode = sanitizeDoctorDisplayValue(cfgMode);
  const safeProfileId = sanitizeDoctorDisplayValue(legacyProfileId) ?? legacyProfileId;
  const safeSuggested = sanitizeDoctorDisplayValue(suggested) ?? suggested;

  return [
    "Doctor hint (for GitHub issue):",
    `- provider: ${safeProvider}`,
    `- config: ${safeProfileId}${
      safeConfigProvider || safeConfigMode
        ? ` (provider=${safeConfigProvider ?? "?"}, mode=${safeConfigMode ?? "?"})`
        : ""
    }`,
    `- auth store oauth profiles: ${storeOauthProfiles || "(none)"}`,
    `- suggested profile: ${safeSuggested}`,
    `Fix: run "${formatCliCommand("openclaw doctor --yes")}"`,
  ].join("\n");
}
