import { c as normalizeOptionalString } from "./string-coerce-Bje8XVt9.js";
import { M as isPrereleaseSemverVersion, N as parseRegistryNpmSpec } from "./discovery-B19Xdk1_.js";
//#region src/plugins/channel-npm-spec.ts
function resolveChannelAwareNpmSpec(params) {
	const npmSpec = normalizeOptionalString(params.npmSpec) ?? normalizeOptionalString(params.packageName);
	if (!npmSpec) return;
	const parsed = parseRegistryNpmSpec(npmSpec);
	if (!parsed || parsed.selectorKind !== "none") return npmSpec;
	const packageName = normalizeOptionalString(params.packageName);
	const expectedName = packageName ? parseRegistryNpmSpec(packageName)?.name ?? packageName : void 0;
	if (expectedName && parsed.name !== expectedName) return npmSpec;
	const packageVersion = normalizeOptionalString(params.packageVersion);
	if (packageVersion && isPrereleaseSemverVersion(packageVersion)) return `${parsed.name}@${packageVersion}`;
	if (params.channel === "beta") return `${parsed.name}@beta`;
	return npmSpec;
}
//#endregion
export { resolveChannelAwareNpmSpec as t };
