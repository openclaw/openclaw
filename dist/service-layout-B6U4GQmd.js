import { E as pathExists } from "./fs-safe-CV86zY9G.js";
import { n as readPackageName, r as readPackageVersion } from "./package-json-CWP51tfk.js";
import path from "node:path";
import fs from "node:fs/promises";
//#region src/daemon/service-layout.ts
function shellQuoteArg(value) {
	if (/^[A-Za-z0-9_./:@%+=,-]+$/u.test(value)) return value;
	return `'${value.replaceAll("'", "'\\''")}'`;
}
function formatExecStart(programArguments) {
	return programArguments.map(shellQuoteArg).join(" ");
}
function resolveSystemdScopeFromServicePath(sourcePath) {
	const normalized = sourcePath?.replaceAll("\\", "/") ?? "";
	if (!normalized.endsWith(".service")) return;
	if (normalized.startsWith("/etc/systemd/") || normalized.startsWith("/usr/lib/systemd/") || normalized.startsWith("/lib/systemd/")) return "system";
	return "user";
}
function findGatewayEntrypoint(programArguments) {
	const gatewayIndex = programArguments.indexOf("gateway");
	if (gatewayIndex <= 0) return;
	return programArguments[gatewayIndex - 1];
}
async function tryRealpath(value) {
	if (!value) return;
	const resolved = path.resolve(value);
	try {
		return await fs.realpath(resolved);
	} catch {
		return resolved;
	}
}
async function isSourceCheckoutRoot(candidate) {
	if (!(await pathExists(path.join(candidate, ".git")) || await pathExists(path.join(candidate, "pnpm-workspace.yaml")))) return false;
	return await pathExists(path.join(candidate, "src")) && await pathExists(path.join(candidate, "extensions"));
}
async function resolveOpenClawPackageRoot(entrypoint) {
	let current = path.dirname(path.resolve(entrypoint));
	for (let depth = 0; depth < 8; depth += 1) {
		if (await pathExists(path.join(current, "package.json"))) {
			if (await readPackageName(current) === "openclaw") return current;
		}
		const next = path.dirname(current);
		if (next === current) return;
		current = next;
	}
}
async function summarizeGatewayServiceLayout(command) {
	if (!command) return;
	const sourcePath = command.sourcePath?.trim() || void 0;
	const entrypoint = findGatewayEntrypoint(command.programArguments);
	const [sourcePathReal, entrypointReal] = await Promise.all([tryRealpath(sourcePath), tryRealpath(entrypoint)]);
	const packageRoot = entrypointReal ? await resolveOpenClawPackageRoot(entrypointReal) : void 0;
	const packageRootReal = await tryRealpath(packageRoot);
	const packageVersion = packageRoot ? await readPackageVersion(packageRoot) ?? void 0 : void 0;
	const entrypointSourceCheckout = packageRootReal ? await isSourceCheckoutRoot(packageRootReal) : void 0;
	return {
		execStart: formatExecStart(command.programArguments),
		...sourcePath ? { sourcePath } : {},
		...sourcePathReal ? { sourcePathReal } : {},
		...sourcePath ? { sourceScope: resolveSystemdScopeFromServicePath(sourcePath) } : {},
		...entrypoint ? { entrypoint } : {},
		...entrypointReal ? { entrypointReal } : {},
		...packageRoot ? { packageRoot } : {},
		...packageRootReal ? { packageRootReal } : {},
		...packageVersion ? { packageVersion } : {},
		...entrypointSourceCheckout !== void 0 ? { entrypointSourceCheckout } : {}
	};
}
//#endregion
export { summarizeGatewayServiceLayout as t };
