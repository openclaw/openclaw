//#region src/commands/doctor.ts
async function doctorCommand(runtime, options) {
	await (await import("./doctor-health-C68v12SO.js")).doctorCommand(runtime, options);
}
//#endregion
export { doctorCommand as t };
