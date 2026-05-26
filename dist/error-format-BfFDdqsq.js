import { t as formatCliCommand } from "./command-format-BPjMauol.js";
//#region src/cli/error-format.ts
const DEFAULT_GATEWAY_PORT_EXAMPLE = 18789;
function formatInlineCliCommand(command) {
	return `\`${formatCliCommand(command)}\``;
}
function formatPortRangeHint(example = DEFAULT_GATEWAY_PORT_EXAMPLE) {
	return `Use a port number from 1 to 65535, for example ${example}.`;
}
function formatInvalidPortOption(option, example = DEFAULT_GATEWAY_PORT_EXAMPLE) {
	return `Invalid ${option}. ${formatPortRangeHint(example)}`;
}
function formatInvalidConfigPort(path, example = DEFAULT_GATEWAY_PORT_EXAMPLE) {
	return `Invalid ${path} in config. Set ${path} to a number from 1 to 65535, or pass --port ${example}.`;
}
function formatUnknownChannelMessage(params) {
	const purpose = params.purpose ? ` for ${params.purpose}` : "";
	const listCommand = params.listCommand ?? "openclaw channels list --all";
	return `Unknown channel "${params.channel}"${purpose}. Run ${formatInlineCliCommand(listCommand)} to see configured and installable channels.`;
}
function formatUnsupportedChannelActionMessage(params) {
	const inspectCommand = params.inspectCommand ?? `openclaw channels capabilities --channel ${params.channel}`;
	return `Channel "${params.channel}" does not support ${params.action}. Run ${formatInlineCliCommand(inspectCommand)} to inspect supported actions.`;
}
function formatStrictJsonParseFailure(params) {
	const cause = (params.cause instanceof Error ? params.cause.message : String(params.cause)).trim().replace(/[.。]+$/u, "");
	const preview = params.value.length > 48 ? `${params.value.slice(0, 45).trimEnd()}...` : params.value;
	return [
		`Could not parse ${JSON.stringify(preview)} as JSON for --strict-json.`,
		`${cause}.`,
		`Use valid JSON, for example ${formatInlineCliCommand("openclaw config set gateway.port 18789 --strict-json")}.`,
		"For plain strings, omit --strict-json."
	].join(" ");
}
function formatGatewayCommandFailure(params) {
	const message = (params.error instanceof Error ? params.error.message : String(params.error)).replace(/\s*Run [`"]?openclaw doctor[`"]? for diagnostics\.?/gi, "").replace(/\s+Gateway target:\s+.*$/isu, "").replace(/\s+/g, " ").trim().replace(/[.。]+$/u, "");
	const inspectCommand = params.inspectCommand ?? "openclaw gateway status --deep";
	const detail = message ? `: ${message}` : "";
	return `Could not ${params.action} because the Gateway did not respond${detail}. Run ${formatInlineCliCommand(inspectCommand)} to inspect the active Gateway.`;
}
function formatLookupMiss(params) {
	const valueLabel = params.valueLabel ?? params.noun.toLowerCase();
	return `${params.noun} not found: ${params.value}. Run ${formatInlineCliCommand(params.listCommand)} to see recent ${valueLabel}s.`;
}
function formatMissingPluginMessage(params) {
	const listCommand = params.listCommand ?? "openclaw plugins list";
	const searchHint = params.includeSearch ? `, or ${formatInlineCliCommand("openclaw plugins search " + params.id)} to look for installable plugins` : "";
	return `Plugin not found: ${params.id}. Run ${formatInlineCliCommand(listCommand)} to see installed plugins${searchHint}.`;
}
//#endregion
export { formatMissingPluginMessage as a, formatUnknownChannelMessage as c, formatLookupMiss as i, formatUnsupportedChannelActionMessage as l, formatInvalidConfigPort as n, formatPortRangeHint as o, formatInvalidPortOption as r, formatStrictJsonParseFailure as s, formatGatewayCommandFailure as t };
