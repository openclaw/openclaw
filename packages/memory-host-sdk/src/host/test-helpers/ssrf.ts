import { vi } from "vitest";
import * as ssrf from "../../../../../src/infra/net/ssrf.js";

export function mockPublicPinnedHostname() {
  return vi.spyOn(ssrf, "resolvePinnedHostnameWithPolicy").mockImplementation(async (hostname) => {
    const normalized = hostname.trim().toLowerCase().replace(/\.$/, "");
    const addresses = ["93.184.216.34"];
    return {
      hostname: normalized,
      addresses,
      lookup: ssrf.createPinnedLookup({ hostname: normalized, addresses }),
    };
  });
}
