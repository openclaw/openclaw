//#region src/commands/doctor.ts
async function doctorCommand(runtime, options) {
	await (await import("./doctor-health-BHIBbc4k.js")).doctorCommand(runtime, options);
}
//#endregion
export { doctorCommand as t };
