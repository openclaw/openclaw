//#region extensions/matrix/src/matrix/device-health.ts
const OPENCLAW_DEVICE_NAME_PREFIX = "OpenClaw ";
function isOpenClawManagedMatrixDevice(displayName) {
	return displayName?.startsWith(OPENCLAW_DEVICE_NAME_PREFIX) === true;
}
function summarizeMatrixDeviceHealth(devices) {
	const currentDeviceId = devices.find((device) => device.current)?.deviceId ?? null;
	const openClawDevices = devices.filter((device) => isOpenClawManagedMatrixDevice(device.displayName));
	return {
		currentDeviceId,
		staleOpenClawDevices: openClawDevices.filter((device) => !device.current),
		currentOpenClawDevices: openClawDevices.filter((device) => device.current)
	};
}
//#endregion
export { summarizeMatrixDeviceHealth as n, isOpenClawManagedMatrixDevice as t };
