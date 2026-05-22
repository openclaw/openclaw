//#region src/commands/doctor.ts
async function doctorCommand(runtime, options) {
	await (await import("./doctor-health-CS3TkRYR.js")).doctorCommand(runtime, options);
}
//#endregion
export { doctorCommand as t };
