import { createSubsystemLogger } from "../../logging/subsystem.js";

export const log = createSubsystemLogger("agent/embedded");
export const failoverLog = log.child("failover");
