//#region src/commands/doctor.ts
async function doctorCommand(runtime, options) {
	await (await import("./doctor-health-DAAv4Moz.js")).doctorCommand(runtime, options);
}
//#endregion
export { doctorCommand as t };
