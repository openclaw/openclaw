//#region src/commands/doctor.ts
async function doctorCommand(runtime, options) {
	await (await import("./doctor-health-DE0CPaSJ.js")).doctorCommand(runtime, options);
}
//#endregion
export { doctorCommand as t };
