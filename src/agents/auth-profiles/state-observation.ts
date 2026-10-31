import { createSubsystemLogger } from "../../logging/subsystem.js";

const observationLog = createSubsystemLogger("agent/embedded");

export function logDroppedAuthProfileBookkeeping(kind: string, profileId: string): void {
  observationLog.warn("dropped auth profile bookkeeping after locked store update failed", {
    event: "auth_profile_bookkeeping_dropped",
    kind,
    profileId,
    tags: ["auth_profiles", "persistence"],
  });
}
