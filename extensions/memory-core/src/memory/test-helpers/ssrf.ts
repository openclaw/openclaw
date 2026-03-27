import * as ssrf from "openclaw/plugin-sdk/ssrf-runtime";
import { vi } from "vitest";

export function mockPublicPinnedHostname() {
  return vi.spyOn(ssrf, "resolvePinnedHostnameWithPolicy").mockImplementation(async (hostname) => {
    const normalized = hostname.trim().toLowerCase().replace(/\.$/, "");
    const addresses = ["93.184.216.34"];
    const lookup = ((host: string, options?: unknown, callback?: unknown) => {
      const cb =
        typeof options === "function"
          ? (options as (err: NodeJS.ErrnoException | null, address: unknown) => void)
          : (callback as (err: NodeJS.ErrnoException | null, address: unknown) => void);
      if (!cb) {
        return;
      }
      if (host.trim().toLowerCase().replace(/\.$/, "") !== normalized) {
        cb(null, []);
        return;
      }
      cb(
        null,
        addresses.map((address) => ({
          address,
          family: address.includes(":") ? 6 : 4,
        })),
      );
    }) as never;
    return {
      hostname: normalized,
      addresses,
      lookup,
    };
  });
}
