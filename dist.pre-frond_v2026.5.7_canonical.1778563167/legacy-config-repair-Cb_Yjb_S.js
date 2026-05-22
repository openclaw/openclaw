import { c as isRecord } from "./utils-CRkrr5e6.js";
import { T as validateConfigObjectWithPlugins, u as readConfigFileSnapshot } from "./io-C7AkIz5l.js";
import "./includes-7BCPhR8J.js";
import { r as replaceConfigFile } from "./mutate-D8hwQ_06.js";
import "./config-oSZ2D4Be.js";
import { t as migrateLegacyConfig } from "./legacy-config-migrate-C2l9KDsR.js";
//#region src/commands/doctor/legacy-config-repair.ts
function containsAuthoredInclude(value) {
	if (!isRecord(value)) return false;
	if (Object.prototype.hasOwnProperty.call(value, "$include")) return true;
	return Object.values(value).some((entry) => containsAuthoredInclude(entry));
}
async function repairLegacyConfigForUpdateChannel(params) {
	if (containsAuthoredInclude(params.configSnapshot.parsed)) return {
		snapshot: params.configSnapshot,
		repaired: false
	};
	const migrated = migrateLegacyConfig(params.configSnapshot.parsed);
	if (!migrated.config) return {
		snapshot: params.configSnapshot,
		repaired: false
	};
	const validated = validateConfigObjectWithPlugins(migrated.config);
	if (!validated.ok) return {
		snapshot: params.configSnapshot,
		repaired: false
	};
	await replaceConfigFile({
		nextConfig: validated.config,
		baseHash: params.configSnapshot.hash,
		writeOptions: {
			allowConfigSizeDrop: true,
			skipOutputLogs: params.jsonMode
		}
	});
	const snapshot = await readConfigFileSnapshot();
	return {
		snapshot,
		repaired: snapshot.valid
	};
}
//#endregion
export { repairLegacyConfigForUpdateChannel };
