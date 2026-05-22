import { f as readStringValue } from "./string-coerce-Bje8XVt9.js";
//#region src/commands/gateway-presence.ts
function pickGatewaySelfPresence(presence) {
	if (!Array.isArray(presence)) return null;
	const entries = presence;
	const self = entries.find((e) => e.mode === "gateway" && e.reason === "self") ?? entries.find((e) => typeof e.text === "string" && e.text.startsWith("Gateway:")) ?? null;
	if (!self) return null;
	return {
		host: readStringValue(self.host),
		ip: readStringValue(self.ip),
		version: readStringValue(self.version),
		platform: readStringValue(self.platform)
	};
}
//#endregion
export { pickGatewaySelfPresence as t };
