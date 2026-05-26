import { c as normalizeOptionalString, s as normalizeOptionalLowercaseString } from "./string-coerce-DyL154ka.js";
import { t as sanitizeTerminalText } from "./safe-text-J_0sTthZ.js";
import { t as isCliProvider } from "./model-selection-cli-DS-HhXIv.js";
import "./model-selection-P-81eBKx.js";
//#region src/status/agent-runtime-label.ts
const AGENT_RUNTIME_LABELS = {
	pi: "OpenClaw Pi Default",
	codex: "OpenAI Codex",
	"codex-cli": "OpenAI Codex",
	"claude-cli": "Claude CLI",
	"google-gemini-cli": "Gemini CLI"
};
function resolveAgentRuntimeLabel(args) {
	const acpAgentRaw = normalizeOptionalString(args.sessionEntry?.acp?.agent);
	const acpAgent = acpAgentRaw ? sanitizeTerminalText(acpAgentRaw) : void 0;
	if (acpAgent) {
		const backendRaw = normalizeOptionalString(args.sessionEntry?.acp?.backend);
		const backend = backendRaw ? sanitizeTerminalText(backendRaw) : void 0;
		return backend ? `${acpAgent} (acp/${backend})` : `${acpAgent} (acp)`;
	}
	const runtimeRaw = normalizeOptionalString(args.resolvedHarness);
	const runtime = normalizeOptionalLowercaseString(runtimeRaw);
	if (runtime && runtime !== "auto" && runtime !== "default") return AGENT_RUNTIME_LABELS[runtime] ?? sanitizeTerminalText(runtimeRaw ?? runtime);
	const providerRaw = normalizeOptionalString(args.sessionEntry?.modelProvider) ?? normalizeOptionalString(args.sessionEntry?.providerOverride) ?? normalizeOptionalString(args.fallbackProvider);
	const provider = providerRaw ? sanitizeTerminalText(providerRaw) : void 0;
	if (provider && isCliProvider(provider, args.config)) return AGENT_RUNTIME_LABELS[normalizeOptionalLowercaseString(providerRaw) ?? ""] ?? `${provider} (cli)`;
	return AGENT_RUNTIME_LABELS.pi;
}
//#endregion
export { resolveAgentRuntimeLabel as t };
