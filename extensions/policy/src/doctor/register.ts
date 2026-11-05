import {
  getHealthCheck,
  registerHealthCheck as registerPluginHealthCheck,
  type HealthCheck,
} from "openclaw/plugin-sdk/health";
import { createPolicyDoctorChecks } from "./checks.js";

let policyDoctorChecks: readonly HealthCheck[] | undefined;
const registeredPolicyDoctorRegistrars = new WeakSet<(check: HealthCheck) => void>();

type PolicyDoctorRegistrationHost = {
  readonly registerHealthCheck: (check: HealthCheck) => void;
};

export function registerPolicyDoctorChecks(host?: PolicyDoctorRegistrationHost): void {
  if (host !== undefined && registeredPolicyDoctorRegistrars.has(host.registerHealthCheck)) {
    return;
  }
  const registerHealthCheck = host?.registerHealthCheck ?? registerPluginHealthCheck;
  policyDoctorChecks ??= createPolicyDoctorChecks();
  for (const check of policyDoctorChecks) {
    if (host === undefined && getHealthCheck(check.id) === check) {
      continue;
    }
    registerHealthCheck(check);
  }
  registeredPolicyDoctorRegistrars.add(registerHealthCheck);
}
