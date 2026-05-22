import { n as waitForWebLogin$1, t as startWebLoginWithQr$1 } from "./login-qr-runtime-DO3obSuc.js";
import { a as getWebAuthAgeMs$1, b as webAuthExists$1, d as readWebAuthExistsForDecision$1, f as readWebAuthSnapshot$1, h as readWebSelfId$1, m as readWebAuthState$1, o as logWebSelfId$1, p as readWebAuthSnapshotBestEffort$1, s as logoutWeb$1, u as readWebAuthExistsBestEffort$1 } from "./auth-store-DXipfax1.js";
import { t as getActiveWebListener$1 } from "./active-listener-C9bGc19I.js";
import { t as monitorWebChannel$1 } from "./monitor-BTZbT29i.js";
import { t as loginWeb$1 } from "./login-R5xJCJ7v.js";
import { t as whatsappSetupWizard$1 } from "./setup-surface-Be3VrJrf.js";
//#region extensions/whatsapp/src/channel.runtime.ts
function getActiveWebListener(...args) {
	return getActiveWebListener$1(...args);
}
function getWebAuthAgeMs(...args) {
	return getWebAuthAgeMs$1(...args);
}
function logWebSelfId(...args) {
	return logWebSelfId$1(...args);
}
function logoutWeb(...args) {
	return logoutWeb$1(...args);
}
function readWebAuthSnapshot(...args) {
	return readWebAuthSnapshot$1(...args);
}
function readWebAuthState(...args) {
	return readWebAuthState$1(...args);
}
function readWebAuthExistsBestEffort(...args) {
	return readWebAuthExistsBestEffort$1(...args);
}
function readWebAuthExistsForDecision(...args) {
	return readWebAuthExistsForDecision$1(...args);
}
function readWebAuthSnapshotBestEffort(...args) {
	return readWebAuthSnapshotBestEffort$1(...args);
}
function readWebSelfId(...args) {
	return readWebSelfId$1(...args);
}
function webAuthExists(...args) {
	return webAuthExists$1(...args);
}
function loginWeb(...args) {
	return loginWeb$1(...args);
}
async function startWebLoginWithQr(...args) {
	return await startWebLoginWithQr$1(...args);
}
async function waitForWebLogin(...args) {
	return await waitForWebLogin$1(...args);
}
const whatsappSetupWizard = { ...whatsappSetupWizard$1 };
function monitorWebChannel(...args) {
	return monitorWebChannel$1(...args);
}
//#endregion
export { getActiveWebListener, getWebAuthAgeMs, logWebSelfId, loginWeb, logoutWeb, monitorWebChannel, readWebAuthExistsBestEffort, readWebAuthExistsForDecision, readWebAuthSnapshot, readWebAuthSnapshotBestEffort, readWebAuthState, readWebSelfId, startWebLoginWithQr, waitForWebLogin, webAuthExists, whatsappSetupWizard };
