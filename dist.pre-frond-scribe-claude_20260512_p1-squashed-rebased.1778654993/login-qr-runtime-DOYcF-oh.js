//#region extensions/whatsapp/login-qr-runtime.ts
let loginQrModulePromise = null;
function loadLoginQrModule() {
	loginQrModulePromise ??= import("./login-qr-DLAjgB8B.js");
	return loginQrModulePromise;
}
async function startWebLoginWithQr(...args) {
	const { startWebLoginWithQr } = await loadLoginQrModule();
	return await startWebLoginWithQr(...args);
}
async function waitForWebLogin(...args) {
	const { waitForWebLogin } = await loadLoginQrModule();
	return await waitForWebLogin(...args);
}
//#endregion
export { waitForWebLogin as n, startWebLoginWithQr as t };
