import { t as createSubsystemLogger } from "./subsystem-kcl1qAou.js";
//#region src/process/supervisor/supervisor-log.runtime.ts
const log = createSubsystemLogger("process/supervisor");
function warnProcessSupervisorSpawnFailure(message) {
	log.warn(message);
}
//#endregion
export { warnProcessSupervisorSpawnFailure };
