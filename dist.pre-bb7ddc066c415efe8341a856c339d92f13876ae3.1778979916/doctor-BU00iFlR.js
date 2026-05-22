//#region src/commands/doctor.ts
async function doctorCommand(runtime, options) {
	await (await import("./doctor-health-CV7SEP2k.js")).doctorCommand(runtime, options);
}
//#endregion
export { doctorCommand as t };
