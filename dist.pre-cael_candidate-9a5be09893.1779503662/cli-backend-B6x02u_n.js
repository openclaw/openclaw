import { n as CLI_RESUME_WATCHDOG_DEFAULTS, t as CLI_FRESH_WATCHDOG_DEFAULTS } from "./cli-watchdog-defaults-CzmnkdzO.js";
//#region extensions/google/cli-backend.ts
const GEMINI_MODEL_ALIASES = {
	pro: "gemini-3.1-pro-preview",
	flash: "gemini-3.1-flash-preview",
	"flash-lite": "gemini-3.1-flash-lite-preview"
};
const GEMINI_CLI_DEFAULT_MODEL_REF = "google-gemini-cli/gemini-3-flash-preview";
function buildGoogleGeminiCliBackend() {
	return {
		id: "google-gemini-cli",
		liveTest: {
			defaultModelRef: GEMINI_CLI_DEFAULT_MODEL_REF,
			defaultImageProbe: true,
			defaultMcpProbe: true,
			docker: {
				npmPackage: "@google/gemini-cli",
				binaryName: "gemini"
			}
		},
		bundleMcp: true,
		bundleMcpMode: "gemini-system-settings",
		nativeToolMode: "always-on",
		config: {
			command: "gemini",
			args: [
				"--skip-trust",
				"--output-format",
				"json",
				"--prompt",
				"{prompt}"
			],
			resumeArgs: [
				"--skip-trust",
				"--resume",
				"{sessionId}",
				"--output-format",
				"json",
				"--prompt",
				"{prompt}"
			],
			output: "json",
			input: "arg",
			imageArg: "@",
			imagePathScope: "workspace",
			modelArg: "--model",
			modelAliases: GEMINI_MODEL_ALIASES,
			sessionMode: "existing",
			sessionIdFields: ["session_id", "sessionId"],
			reliability: { watchdog: {
				fresh: { ...CLI_FRESH_WATCHDOG_DEFAULTS },
				resume: { ...CLI_RESUME_WATCHDOG_DEFAULTS }
			} },
			serialize: true
		}
	};
}
//#endregion
export { buildGoogleGeminiCliBackend as t };
