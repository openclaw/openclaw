import { t as isTruthyEnvValue } from "./env-Dhqok4CP.js";
//#region src/commands/doctor/shared/update-phase.ts
const UPDATE_IN_PROGRESS_ENV = "OPENCLAW_UPDATE_IN_PROGRESS";
const UPDATE_POST_CORE_CONVERGENCE_ENV = "OPENCLAW_UPDATE_POST_CORE_CONVERGENCE";
const UPDATE_DEFER_CONFIGURED_PLUGIN_INSTALL_REPAIR_ENV = "OPENCLAW_UPDATE_DEFER_CONFIGURED_PLUGIN_INSTALL_REPAIR";
const UPDATE_PARENT_SUPPORTS_DOCTOR_CONFIG_WRITE_ENV = "OPENCLAW_UPDATE_PARENT_SUPPORTS_DOCTOR_CONFIG_WRITE";
/**
* True iff the caller is the doctor pass that runs WHILE the core package
* files are actively being swapped (e.g. inside `runGlobalPackageUpdateSteps`'
* `postVerifyStep`). At this moment npm/pnpm machinery is busy and we must
* NOT trigger fresh plugin installs that race with the in-flight package
* manager activity. Configured plugin repair is deferred to the post-core
* convergence pass.
*
* If post-core convergence is also set, treat the call as post-core
* convergence (post-core wins). This lets a parent process re-enter doctor
* with both flags set and still get repair behavior.
*
* NOTE: only consumers that route through this helper observe the
* "post-core wins" semantics. Files that still read
* `OPENCLAW_UPDATE_IN_PROGRESS` directly (`commands/doctor-update.ts`,
* `commands/doctor-repair-mode.ts`, `commands/doctor.e2e-harness.ts`,
* `flows/doctor-health-contributions.ts`) treat both flags as
* "update-in-progress". This is intentional: those paths are control-flow
* gates (skip warnings, skip checks, e2e shims) where update-in-progress
* suppression is still the correct behavior even mid-convergence. Migrate
* a direct reader only when its semantics genuinely diverge between the
* two phases.
*/
function isUpdatePackageSwapInProgress(env) {
	if (isPostCoreConvergencePass(env)) return false;
	return isTruthyEnvValue(env[UPDATE_IN_PROGRESS_ENV]);
}
/**
* True iff configured plugin install repair should be deferred because the
* updater guarantees a later post-core convergence pass. Older shipped
* parents may set only the writable-config marker. Those parents still have a
* post-core handoff, but their in-memory install records are stale after the
* candidate doctor exits, so defer payload repair to the updated child process.
*/
function shouldDeferConfiguredPluginInstallRepair(env) {
	return isUpdatePackageSwapInProgress(env) && (isTruthyEnvValue(env["OPENCLAW_UPDATE_DEFER_CONFIGURED_PLUGIN_INSTALL_REPAIR"]) || isTruthyEnvValue(env["OPENCLAW_UPDATE_PARENT_SUPPORTS_DOCTOR_CONFIG_WRITE"]));
}
/**
* True iff a new doctor is running inside a shipped parent that can persist
* doctor config repairs. Config writes must stay old-parent-readable because
* that parent resumes after the candidate doctor exits. Modern parents also
* set the explicit deferral marker, so they should keep current metadata
* writes while still deferring payload repair.
*/
function isLegacyParentWritableUpdateDoctorPass(env) {
	return isUpdatePackageSwapInProgress(env) && isTruthyEnvValue(env["OPENCLAW_UPDATE_PARENT_SUPPORTS_DOCTOR_CONFIG_WRITE"]) && !isTruthyEnvValue(env["OPENCLAW_UPDATE_DEFER_CONFIGURED_PLUGIN_INSTALL_REPAIR"]);
}
/**
* True iff this newer doctor is running under an older updater that does not
* advertise any post-core handoff marker. Those parents set only
* `OPENCLAW_UPDATE_IN_PROGRESS`, so configured plugin repair must happen now.
*/
function isLegacyPackageUpdateDoctorPass(env) {
	return isUpdatePackageSwapInProgress(env) && !shouldDeferConfiguredPluginInstallRepair(env);
}
/**
* True iff we are running the post-core convergence pass: the core package
* swap is done, the gateway has not been restarted yet, and configured plugin
* repair MUST run before we hand control back for the restart.
*/
function isPostCoreConvergencePass(env) {
	return isTruthyEnvValue(env[UPDATE_POST_CORE_CONVERGENCE_ENV]);
}
//#endregion
export { isLegacyParentWritableUpdateDoctorPass as a, shouldDeferConfiguredPluginInstallRepair as c, isLegacyPackageUpdateDoctorPass as i, UPDATE_PARENT_SUPPORTS_DOCTOR_CONFIG_WRITE_ENV as n, isPostCoreConvergencePass as o, UPDATE_POST_CORE_CONVERGENCE_ENV as r, isUpdatePackageSwapInProgress as s, UPDATE_DEFER_CONFIGURED_PLUGIN_INSTALL_REPAIR_ENV as t };
