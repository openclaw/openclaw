//#region src/commands/doctor.ts
async function doctorCommand(runtime, options) {
	await (await import("./doctor-health-B-zdK2UR.js")).doctorCommand(runtime, options);
}
//#endregion
export { doctorCommand as t };
