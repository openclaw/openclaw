import type { OpenClawConfig } from "openclaw/plugin-sdk/provider-auth";
import { LLAMA_CPP_PROVIDER_ID } from "./defaults.js";

export const LLAMA_CPP_DEFAULT_PROFILE_ID = `${LLAMA_CPP_PROVIDER_ID}:default`;

export function buildLlamaCppAuthProfileRemovalPatch(
  config: OpenClawConfig,
  profileId = LLAMA_CPP_DEFAULT_PROFILE_ID,
): Partial<OpenClawConfig> {
  const profileExists = Boolean(config.auth?.profiles?.[profileId]);
  const referencedOrders = Object.entries(config.auth?.order ?? {}).filter(([, ids]) =>
    ids.includes(profileId),
  );
  if (!profileExists && referencedOrders.length === 0) {
    return {};
  }
  const authPatch: NonNullable<OpenClawConfig["auth"]> = {};
  // Config patches use undefined map values as deletion markers.
  if (profileExists) {
    Reflect.set(authPatch, "profiles", { [profileId]: undefined });
  }
  if (referencedOrders.length > 0) {
    Reflect.set(
      authPatch,
      "order",
      Object.fromEntries(
        referencedOrders.map(([providerId, ids]) => {
          const next = ids.filter((id) => id !== profileId);
          return [providerId, next.length > 0 ? next : undefined];
        }),
      ),
    );
  }
  return { auth: authPatch };
}
