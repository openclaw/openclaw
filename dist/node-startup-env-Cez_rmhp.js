import fs from "node:fs";
//#region src/bootstrap/node-extra-ca-certs.ts
const LINUX_CA_BUNDLE_PATHS = [
	"/etc/ssl/certs/ca-certificates.crt",
	"/etc/pki/tls/certs/ca-bundle.crt",
	"/etc/ssl/ca-bundle.pem"
];
function resolveLinuxSystemCaBundle(params = {}) {
	if ((params.platform ?? process.platform) !== "linux") return;
	const accessSync = params.accessSync ?? fs.accessSync.bind(fs);
	for (const candidate of LINUX_CA_BUNDLE_PATHS) try {
		accessSync(candidate, fs.constants.R_OK);
		return candidate;
	} catch {
		continue;
	}
}
function isNodeVersionManagerRuntime(env = process.env, execPath = process.execPath) {
	if (env.NVM_DIR?.trim()) return true;
	return execPath.includes("/.nvm/");
}
function resolveAutoNodeExtraCaCerts(params = {}) {
	const env = params.env ?? process.env;
	if (env.NODE_EXTRA_CA_CERTS?.trim()) return;
	const platform = params.platform ?? process.platform;
	const execPath = params.execPath ?? process.execPath;
	if (platform !== "linux" || !isNodeVersionManagerRuntime(env, execPath)) return;
	return resolveLinuxSystemCaBundle({
		platform,
		accessSync: params.accessSync
	});
}
//#endregion
//#region src/bootstrap/node-startup-env.ts
function resolveNodeStartupTlsEnvironment(params = {}) {
	const env = params.env ?? process.env;
	const platform = params.platform ?? process.platform;
	const includeDarwinDefaults = params.includeDarwinDefaults ?? true;
	return {
		NODE_EXTRA_CA_CERTS: env.NODE_EXTRA_CA_CERTS ?? (platform === "darwin" && includeDarwinDefaults ? "/etc/ssl/cert.pem" : resolveAutoNodeExtraCaCerts({
			env,
			platform,
			execPath: params.execPath,
			accessSync: params.accessSync
		})),
		NODE_USE_SYSTEM_CA: env.NODE_USE_SYSTEM_CA ?? (platform === "darwin" && includeDarwinDefaults ? "1" : void 0)
	};
}
//#endregion
export { resolveNodeStartupTlsEnvironment as t };
