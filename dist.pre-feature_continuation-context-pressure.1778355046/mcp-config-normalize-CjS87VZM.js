import { c as isRecord } from "./utils-D5swhEXt.js";
//#region src/config/mcp-config-normalize.ts
const CLI_MCP_TYPE_TO_OPENCLAW_TRANSPORT = {
	http: "streamable-http",
	"streamable-http": "streamable-http",
	sse: "sse",
	stdio: "stdio"
};
function normalizeMcpString(value) {
	return typeof value === "string" ? value.trim().toLowerCase() : "";
}
function resolveOpenClawMcpTransportAlias(value) {
	const mapped = CLI_MCP_TYPE_TO_OPENCLAW_TRANSPORT[normalizeMcpString(value)];
	return mapped === "sse" || mapped === "streamable-http" ? mapped : void 0;
}
function isKnownCliMcpTypeAlias(value) {
	return Object.hasOwn(CLI_MCP_TYPE_TO_OPENCLAW_TRANSPORT, normalizeMcpString(value));
}
function canonicalizeConfiguredMcpServer(server) {
	const next = { ...server };
	const transportAlias = resolveOpenClawMcpTransportAlias(next.type);
	if (typeof next.transport !== "string" && transportAlias) next.transport = transportAlias;
	if (isKnownCliMcpTypeAlias(next.type)) delete next.type;
	return next;
}
function normalizeConfiguredMcpServers(value) {
	if (!isRecord(value)) return {};
	return Object.fromEntries(Object.entries(value).filter(([, server]) => isRecord(server)).map(([name, server]) => [name, { ...server }]));
}
//#endregion
export { resolveOpenClawMcpTransportAlias as i, isKnownCliMcpTypeAlias as n, normalizeConfiguredMcpServers as r, canonicalizeConfiguredMcpServer as t };
