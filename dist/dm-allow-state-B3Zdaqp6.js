import { s as normalizeStringEntries } from "./string-normalization-DiPHgdft.js";
import { r as readChannelIngressStoreAllowFromForDmPolicy } from "./runtime-BUVuto5K.js";
//#region src/channels/message-access/dm-allow-state.ts
async function resolveDmAllowAuditState(params) {
	const configAllowFrom = normalizeStringEntries(Array.isArray(params.allowFrom) ? params.allowFrom : void 0);
	const hasWildcard = configAllowFrom.includes("*");
	const storeAllowFrom = await readChannelIngressStoreAllowFromForDmPolicy({
		provider: params.provider,
		accountId: params.accountId,
		dmPolicy: params.dmPolicy,
		readStore: params.readStore
	});
	const normalizeEntry = params.normalizeEntry ?? ((value) => value);
	const normalizedCfg = configAllowFrom.filter((value) => value !== "*").map((value) => normalizeEntry(value)).map((value) => value.trim()).filter(Boolean);
	const normalizedStore = storeAllowFrom.map((value) => normalizeEntry(value)).map((value) => value.trim()).filter(Boolean);
	const allowCount = new Set([...normalizedCfg, ...normalizedStore]).size;
	return {
		configAllowFrom,
		hasWildcard,
		allowCount,
		isMultiUserDm: hasWildcard || allowCount > 1
	};
}
//#endregion
export { resolveDmAllowAuditState as t };
