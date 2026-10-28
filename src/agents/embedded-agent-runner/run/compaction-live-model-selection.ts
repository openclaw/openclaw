import { normalizeProviderId } from "@openclaw/model-catalog-core/provider-id";
import type { LiveSessionModelSelection } from "../../live-model-switch.js";

export function resolveCompactionLiveModelSelection(params: {
  current: {
    provider: string;
    model: string;
    authProfileId?: string;
    authProfileIdSource: "auto" | "user";
  };
  requested?: LiveSessionModelSelection;
}): (typeof params)["current"] {
  const { current, requested } = params;
  if (!requested) {
    return current;
  }
  const selection = { provider: requested.provider, model: requested.model };
  if (requested.authProfileId) {
    return {
      ...selection,
      authProfileId: requested.authProfileId,
      authProfileIdSource: requested.authProfileIdSource ?? "auto",
    };
  }
  if (normalizeProviderId(requested.provider) === normalizeProviderId(current.provider)) {
    return { ...current, ...selection };
  }
  return {
    ...selection,
    authProfileIdSource: "auto",
  };
}
