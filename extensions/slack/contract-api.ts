export { normalizeCompatibilityConfig, legacyConfigRules } from "./src/doctor-contract.js";
export {
  collectRuntimeConfigAssignments,
  secretTargetRegistryEntries,
} from "./src/secret-contract.js";
export { createSlackOutboundPayloadHarness } from "./src/outbound-payload-harness.js";
export type {
  SlackInteractiveHandlerContext,
  SlackInteractiveHandlerRegistration,
} from "./src/interactive-dispatch.js";
export { collectSlackSecurityAuditFindings } from "./src/security-audit.js";
