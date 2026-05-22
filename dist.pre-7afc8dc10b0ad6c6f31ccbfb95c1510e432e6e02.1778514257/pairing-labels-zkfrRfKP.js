import { f as getPairingAdapter } from "./pairing-store-hjG6lYPV.js";
//#region src/pairing/pairing-labels.ts
function resolvePairingIdLabel(channel) {
	return getPairingAdapter(channel)?.idLabel ?? "userId";
}
//#endregion
export { resolvePairingIdLabel as t };
