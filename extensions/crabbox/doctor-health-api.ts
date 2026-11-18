import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveOpenClawRoot } from "./src/crabbox-worker-profile.js";
import {
  CRABBOX_CLOUD_WORKER_PROFILE_CHECK_ID,
  type CrabboxDoctorRegistrationHost,
  registerCrabboxWorkerProviderDoctorChecks as registerChecks,
} from "./src/doctor.js";

const CRABBOX_PLUGIN_ROOT = path.dirname(fileURLToPath(import.meta.url));

export { CRABBOX_CLOUD_WORKER_PROFILE_CHECK_ID };

export function registerWorkerProviderDoctorChecks(
  host: Omit<CrabboxDoctorRegistrationHost, "openclawRoot">,
): void {
  registerChecks({
    ...host,
    openclawRoot: resolveOpenClawRoot(CRABBOX_PLUGIN_ROOT),
  });
}
