import { l as HealthCheck } from "../../health-YASLajUj.js";

//#region extensions/policy/src/doctor/register.d.ts
type PolicyDoctorRegistrationHost = {
  readonly registerHealthCheck: (check: HealthCheck) => void;
};
declare function registerPolicyDoctorChecks(host?: PolicyDoctorRegistrationHost): void;
//#endregion
export { registerPolicyDoctorChecks };