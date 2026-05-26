//#region extensions/matrix/src/matrix/credentials-write.runtime.ts
let matrixCredentialsRuntimePromise;
function loadMatrixCredentialsRuntime() {
	matrixCredentialsRuntimePromise ??= import("./credentials-DAI3gruL.js");
	return matrixCredentialsRuntimePromise;
}
async function saveMatrixCredentials(...args) {
	return (await loadMatrixCredentialsRuntime()).saveMatrixCredentials(...args);
}
async function saveBackfilledMatrixDeviceId(...args) {
	return (await loadMatrixCredentialsRuntime()).saveBackfilledMatrixDeviceId(...args);
}
async function touchMatrixCredentials(...args) {
	return (await loadMatrixCredentialsRuntime()).touchMatrixCredentials(...args);
}
//#endregion
export { saveBackfilledMatrixDeviceId, saveMatrixCredentials, touchMatrixCredentials };
