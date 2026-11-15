import { normalizeProviderIdForAuth } from "@openclaw/model-catalog-core/provider-id";
import type { ProviderModelRouteAuthRequirement } from "../plugin-sdk/provider-model-types.js";
import { resolveProviderModelRouteAuthRequirement } from "./provider-model-route-auth.js";

export type SelectedModelCredential =
  | { source: "harness" }
  | ({ mode?: string; requirement?: ProviderModelRouteAuthRequirement; identityKey: string } & (
      | { source: "profile"; profileId: string }
      | { source: "direct"; provider: string }
    ));

/** Normalize a selection made by availability or the physical attempt's auth owner. */
export function resolveSelectedModelCredential(params: {
  provider: string;
  profileId?: string;
  mode?: string;
  authRequirement?: ProviderModelRouteAuthRequirement | null;
  runtimeAuth?: { id: string; source: "native" };
}): SelectedModelCredential | undefined {
  if (params.runtimeAuth) {
    return { source: "harness" };
  }
  if (!params.profileId && !params.mode) {
    return undefined;
  }
  const auth = {
    mode: params.mode,
    requirement: resolveProviderModelRouteAuthRequirement(params.mode, params.authRequirement),
  };
  return params.profileId
    ? {
        ...auth,
        source: "profile",
        profileId: params.profileId,
        identityKey: `profile:${params.profileId}`,
      }
    : {
        ...auth,
        source: "direct",
        provider: normalizeProviderIdForAuth(params.provider),
        identityKey: `direct:${normalizeProviderIdForAuth(params.provider)}`,
      };
}
