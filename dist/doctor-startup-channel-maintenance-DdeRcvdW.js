import { t as runChannelPluginStartupMaintenance } from "./lifecycle-startup-27Xs1e5s.js";
//#region src/flows/doctor-startup-channel-maintenance.ts
async function maybeRunDoctorStartupChannelMaintenance(params) {
	if (!params.shouldRepair) return;
	await (params.runChannelPluginStartupMaintenance ?? runChannelPluginStartupMaintenance)({
		cfg: params.cfg,
		env: params.env ?? process.env,
		log: {
			info: (message) => params.runtime.log(message),
			warn: (message) => params.runtime.error(message)
		},
		trigger: "doctor-fix",
		logPrefix: "doctor"
	});
}
//#endregion
export { maybeRunDoctorStartupChannelMaintenance };
