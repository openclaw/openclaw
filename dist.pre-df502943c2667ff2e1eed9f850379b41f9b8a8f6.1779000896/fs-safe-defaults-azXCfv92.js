//#region node_modules/@openclaw/fs-safe/dist/pinned-python-config.js
let overrideConfig = {};
function parseMode(value) {
	if (!value) return;
	const normalized = value.trim().toLowerCase();
	if (normalized === "0" || normalized === "false" || normalized === "off" || normalized === "never") return "off";
	if (normalized === "1" || normalized === "true" || normalized === "on" || normalized === "auto") return "auto";
	if (normalized === "required" || normalized === "require") return "require";
}
function configureFsSafePython(config) {
	overrideConfig = {
		...overrideConfig,
		...config
	};
}
function getFsSafePythonConfig() {
	return {
		mode: overrideConfig.mode ?? parseMode(process.env.FS_SAFE_PYTHON_MODE) ?? parseMode(process.env.OPENCLAW_FS_SAFE_PYTHON_MODE) ?? "auto",
		pythonPath: overrideConfig.pythonPath ?? process.env.FS_SAFE_PYTHON ?? process.env.OPENCLAW_FS_SAFE_PYTHON ?? process.env.OPENCLAW_PINNED_PYTHON ?? process.env.OPENCLAW_PINNED_WRITE_PYTHON
	};
}
function canFallbackFromPythonError(error) {
	const code = error instanceof Error && "code" in error ? error.code : void 0;
	return getFsSafePythonConfig().mode !== "require" && (code === "helper-unavailable" || code === "unsupported-platform");
}
//#endregion
//#region src/infra/fs-safe-defaults.ts
if (!(process.env.FS_SAFE_PYTHON_MODE != null || process.env.OPENCLAW_FS_SAFE_PYTHON_MODE != null)) configureFsSafePython({ mode: "off" });
//#endregion
export { configureFsSafePython as n, getFsSafePythonConfig as r, canFallbackFromPythonError as t };
