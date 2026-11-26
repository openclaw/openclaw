import { createExternalCdpEngine } from "./external-cdp.js";
import { createLightpandaCdpNormalizer } from "./lightpanda-cdp.js";

export const lightpandaEngine = createExternalCdpEngine({
  id: "lightpanda",
  label: "Lightpanda",
  maxPagesPerConnection: 1,
  closePageClosesConnection: true,
  createCdpNormalizer: createLightpandaCdpNormalizer,
});
