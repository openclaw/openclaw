import {
  registerHealthCheck as registerPluginHealthCheck,
  type HealthCheck,
} from "openclaw/plugin-sdk/health";
import { createPolicyDoctorChecks } from "./checks.js";
import { evaluatePolicy, findingsForCheck } from "./evaluation.js";
import {
  channelIdsFromFindings,
  disableChannels,
  workspaceRepairsDisabledResult,
  workspaceRepairsEnabled,
} from "./policy-runtime.js";

let registered = false;

type PolicyDoctorRegistrationHost = {
  readonly registerHealthCheck: (check: HealthCheck) => void;
};

export function registerPolicyDoctorChecks(host?: PolicyDoctorRegistrationHost): void {
  if (registered) {
    return;
  }
  const registerHealthCheck = host?.registerHealthCheck ?? registerPluginHealthCheck;
  for (const check of createPolicyDoctorChecks({
    channelIdsFromFindings,
    disableChannels,
    evaluatePolicy,
    findingsForCheck,
    workspaceRepairsDisabledResult,
    workspaceRepairsEnabled,
  })) {
    registerHealthCheck(check);
  }
  registered = true;
}

export function resetPolicyDoctorChecksForTest(): void {
  registered = false;
}

export { evaluatePolicy };
export { policyContainerShapeFindings } from "./policy-shape.js";
export {
  POLICY_CHECK_IDS,
  POLICY_RULE_METADATA,
  type PolicyRuleMetadata,
  type PolicyScopeSelectorKind,
} from "./metadata.js";
export { isPolicyValueAtLeastAsStrict } from "./strictness.js";
