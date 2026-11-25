import { createExternalCdpEngine } from "./external-cdp.js";
import { createKitesurfCdpNormalizer } from "./kitesurf-cdp.js";

export const kitesurfEngine = createExternalCdpEngine({
  id: "kitesurf",
  label: "Kitesurf",
  screenshots: true,
  createCdpNormalizer: createKitesurfCdpNormalizer,
});
