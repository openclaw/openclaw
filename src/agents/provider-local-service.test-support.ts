import { acquireTestPortBlock, type TestPortClaim } from "../test-utils/port-claims.js";
import { probeTestPort } from "../test-utils/ports.js";
import { stopManagedProviderLocalServices } from "./provider-local-service.js";

export function createProviderLocalServiceTestFixture() {
  const claims = new Map<TestPortClaim, number[]>();

  return {
    async claimPort(offsets: number[] = [0]): Promise<number> {
      const claim = await acquireTestPortBlock({ offsets });
      claims.set(
        claim,
        offsets.map((offset) => claim.port + offset),
      );
      return claim.port;
    },
    async cleanup(this: void): Promise<void> {
      // Keep claims through shutdown; failed cleanup must not lend a live port to another file.
      await stopManagedProviderLocalServices();
      for (const ports of claims.values()) {
        for (const port of ports) {
          const probe = await probeTestPort(port);
          if (!probe.free) {
            throw new Error(`Local provider test port ${port} is still bound after cleanup`, {
              cause: probe.error,
            });
          }
        }
      }
      for (const claim of claims.keys()) {
        await claim.release();
        claims.delete(claim);
      }
    },
  };
}
