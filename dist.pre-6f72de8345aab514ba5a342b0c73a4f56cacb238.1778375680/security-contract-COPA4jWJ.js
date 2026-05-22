import { c as isRecord } from "./utils-DG9b7Tlg.js";
import "./text-runtime-BFTVdjnu.js";
//#region extensions/whatsapp/src/security-contract.ts
const unsupportedSecretRefSurfacePatterns = ["channels.whatsapp.creds.json", "channels.whatsapp.accounts.*.creds.json"];
function collectUnsupportedSecretRefConfigCandidates(raw) {
	if (!isRecord(raw)) return [];
	if (!isRecord(raw.channels) || !isRecord(raw.channels.whatsapp)) return [];
	const candidates = [];
	const whatsapp = raw.channels.whatsapp;
	const creds = isRecord(whatsapp.creds) ? whatsapp.creds : null;
	if (creds) candidates.push({
		path: "channels.whatsapp.creds.json",
		value: creds.json
	});
	const accounts = isRecord(whatsapp.accounts) ? whatsapp.accounts : null;
	if (!accounts) return candidates;
	for (const [accountId, account] of Object.entries(accounts)) {
		if (!isRecord(account) || !isRecord(account.creds)) continue;
		candidates.push({
			path: `channels.whatsapp.accounts.${accountId}.creds.json`,
			value: account.creds.json
		});
	}
	return candidates;
}
//#endregion
export { unsupportedSecretRefSurfacePatterns as n, collectUnsupportedSecretRefConfigCandidates as t };
