//#region src/cron/run-id.ts
function createCronExecutionId(jobId, startedAt) {
	return `cron:${jobId}:${startedAt}`;
}
//#endregion
export { createCronExecutionId as t };
