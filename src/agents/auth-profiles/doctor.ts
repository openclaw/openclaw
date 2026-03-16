import type { OpenClawConfig } from "../../config/config.js";
import { normalizeProviderId } from "../model-selection.js";
import type { AuthProfileStore } from "./types.js";

let providerRuntimePromise:
  | Promise<typeof import("../../plugins/provider-runtime.runtime.js")>
  | undefined;

function loadProviderRuntime() {
  providerRuntimePromise ??= import("../../plugins/provider-runtime.runtime.js");
  return providerRuntimePromise;
}

export async function formatAuthDoctorHint(params: {
  cfg?: OpenClawConfig;
  store: AuthProfileStore;
  provider: string;
  profileId?: string;
}): Promise<string> {
  const normalizedProvider = normalizeProviderId(params.provider);
  const { buildProviderAuthDoctorHintWithPlugin } = await loadProviderRuntime();
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
  return "";
}
