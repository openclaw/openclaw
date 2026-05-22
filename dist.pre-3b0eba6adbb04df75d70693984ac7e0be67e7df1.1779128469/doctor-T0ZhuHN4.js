//#region src/commands/doctor.ts
async function doctorCommand(runtime, options) {
	await (await import("./doctor-health-DSI-a3-l.js")).doctorCommand(runtime, options);
}
//#endregion
export { doctorCommand as t };
