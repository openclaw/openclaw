// Optional source bridge: the native identity owners remain authoritative.
import fs from "node:fs";
import { isRecord } from "./record-shared.mjs";

export async function loadDistArtifactIdentity() {
  try {
    const [identity, bootModule] = await Promise.all([
      import("../../src/shared/pid-alive.ts"),
      import("../../src/infra/update-managed-service-handoff-boot.ts"),
    ]);
    const readBoot = bootModule.createManagedHandoffBootIdentityReader(process.env);
    return {
      getProcessInstanceStartTime: identity.getProcessInstanceStartTime,
      isPidDefinitelyDead: identity.isPidDefinitelyDead,
      readScope(): string | null {
        try {
          const boot = readBoot();
          return JSON.stringify([
            boot.platform,
            boot.identity,
            process.platform === "linux" ? fs.readlinkSync("/proc/self/ns/pid") : null,
          ]);
        } catch {
          return null;
        }
      },
    };
  } catch (error) {
    // Scripts-only/sparse installs can lack these source dependencies. Missing
    // identity is unknown, never permission to reclaim an abandoned owner.
    if (
      !isRecord(error) ||
      !["ERR_MODULE_NOT_FOUND", "MODULE_NOT_FOUND"].includes(String(error.code))
    ) {
      throw error;
    }
    return undefined;
  }
}
