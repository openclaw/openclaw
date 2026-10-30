import type { SessionToolDiscoveryPresentation } from "../../config/sessions/tool-discovery.types.js";

/** Node execution exposes only personal Workshop operations; presentation carries no authority. */
export function resolveCliToolDiscovery(
  presentation: SessionToolDiscoveryPresentation | undefined,
  nodeWorkshopEnabled: boolean,
): SessionToolDiscoveryPresentation | undefined {
  if (!presentation?.workshop || !nodeWorkshopEnabled) {
    return presentation;
  }
  return {
    ...presentation,
    workshop: { ...presentation.workshop, defaultTarget: "personal" },
  };
}
