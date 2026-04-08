export { normalizeCompatibilityConfig } from "./src/doctor-contract.js";

// Stub legacyConfigRules to prevent crash when jiti fails to resolve nested ESM imports.
// The real rules are in ./src/doctor-contract.js but the bundled re-export breaks under
// jiti when the plugin is disabled. An empty array is safe because disabled plugins never
// evaluate contract rules. See: https://github.com/openclaw/openclaw/issues/63358
import type { ChannelDoctorLegacyConfigRule } from "openclaw/plugin-sdk/channel-contract";
export const legacyConfigRules: ChannelDoctorLegacyConfigRule[] = [];
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
