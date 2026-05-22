import { n as resolveGlobalSingleton } from "./global-singleton-DZyLAEQq.js";
//#region src/cron/active-jobs.ts
const CRON_ACTIVE_JOB_STATE_KEY = Symbol.for("openclaw.cron.activeJobs");
function getCronActiveJobState() {
	return resolveGlobalSingleton(CRON_ACTIVE_JOB_STATE_KEY, () => ({ activeJobIds: /* @__PURE__ */ new Set() }));
}
function markCronJobActive(jobId) {
	if (!jobId) return;
	getCronActiveJobState().activeJobIds.add(jobId);
}
function clearCronJobActive(jobId) {
	if (!jobId) return;
	getCronActiveJobState().activeJobIds.delete(jobId);
}
function isCronJobActive(jobId) {
	if (!jobId) return false;
	return getCronActiveJobState().activeJobIds.has(jobId);
}
function hasActiveCronJobs() {
	return getCronActiveJobState().activeJobIds.size > 0;
}
//#endregion
export { markCronJobActive as i, hasActiveCronJobs as n, isCronJobActive as r, clearCronJobActive as t };
