import { c as isRecord } from "./utils-sBTEdeml.js";
import { T as validateConfigObjectWithPlugins, m as readSourceConfigSnapshot } from "./io-DoswVvYe.js";
import { i as replaceConfigFile } from "./mutate-DLC8bveh.js";
import { r as normalizeConfiguredMcpServers, t as canonicalizeConfiguredMcpServer } from "./mcp-config-normalize-GXslRjiB.js";
//#region src/auto-reply/reply/config-value.ts
function parseConfigValue(raw) {
	const trimmed = raw.trim();
	if (!trimmed) return { error: "Missing value." };
	if (trimmed.startsWith("{") || trimmed.startsWith("[")) try {
		return { value: JSON.parse(trimmed) };
	} catch (err) {
		return { error: `Invalid JSON: ${String(err)}` };
	}
	if (trimmed === "true") return { value: true };
	if (trimmed === "false") return { value: false };
	if (trimmed === "null") return { value: null };
	if (/^-?\d+(\.\d+)?$/.test(trimmed)) {
		const num = Number(trimmed);
		if (Number.isFinite(num)) return { value: num };
	}
	if (trimmed.startsWith("\"") && trimmed.endsWith("\"") || trimmed.startsWith("'") && trimmed.endsWith("'")) try {
		return { value: JSON.parse(trimmed) };
	} catch {
		return { value: trimmed.slice(1, -1) };
	}
	return { value: trimmed };
}
//#endregion
//#region src/config/mcp-config.ts
async function listConfiguredMcpServers() {
	const snapshot = await readSourceConfigSnapshot();
	if (!snapshot.valid) return {
		ok: false,
		path: snapshot.path,
		error: "Config file is invalid; fix it before using MCP config commands."
	};
	const sourceConfig = snapshot.sourceConfig ?? snapshot.resolved;
	return {
		ok: true,
		path: snapshot.path,
		config: structuredClone(sourceConfig),
		mcpServers: normalizeConfiguredMcpServers(sourceConfig.mcp?.servers),
		baseHash: snapshot.hash
	};
}
async function setConfiguredMcpServer(params) {
	const name = params.name.trim();
	if (!name) return {
		ok: false,
		path: "",
		error: "MCP server name is required."
	};
	if (!isRecord(params.server)) return {
		ok: false,
		path: "",
		error: "MCP server config must be a JSON object."
	};
	const loaded = await listConfiguredMcpServers();
	if (!loaded.ok) return loaded;
	const next = structuredClone(loaded.config);
	const servers = normalizeConfiguredMcpServers(next.mcp?.servers);
	servers[name] = canonicalizeConfiguredMcpServer(params.server);
	next.mcp = {
		...next.mcp,
		servers
	};
	const validated = validateConfigObjectWithPlugins(next);
	if (!validated.ok) {
		const issue = validated.issues[0];
		return {
			ok: false,
			path: loaded.path,
			error: `Config invalid after MCP set (${issue.path}: ${issue.message}).`
		};
	}
	await replaceConfigFile({
		nextConfig: validated.config,
		baseHash: loaded.baseHash
	});
	return {
		ok: true,
		path: loaded.path,
		config: validated.config,
		mcpServers: servers
	};
}
async function unsetConfiguredMcpServer(params) {
	const name = params.name.trim();
	if (!name) return {
		ok: false,
		path: "",
		error: "MCP server name is required."
	};
	const loaded = await listConfiguredMcpServers();
	if (!loaded.ok) return loaded;
	if (!Object.hasOwn(loaded.mcpServers, name)) return {
		ok: true,
		path: loaded.path,
		config: loaded.config,
		mcpServers: loaded.mcpServers,
		removed: false
	};
	const next = structuredClone(loaded.config);
	const servers = normalizeConfiguredMcpServers(next.mcp?.servers);
	delete servers[name];
	if (Object.keys(servers).length > 0) next.mcp = {
		...next.mcp,
		servers
	};
	else if (next.mcp) {
		delete next.mcp.servers;
		if (Object.keys(next.mcp).length === 0) delete next.mcp;
	}
	const validated = validateConfigObjectWithPlugins(next);
	if (!validated.ok) {
		const issue = validated.issues[0];
		return {
			ok: false,
			path: loaded.path,
			error: `Config invalid after MCP unset (${issue.path}: ${issue.message}).`
		};
	}
	await replaceConfigFile({
		nextConfig: validated.config,
		baseHash: loaded.baseHash
	});
	return {
		ok: true,
		path: loaded.path,
		config: validated.config,
		mcpServers: servers,
		removed: true
	};
}
//#endregion
export { parseConfigValue as i, setConfiguredMcpServer as n, unsetConfiguredMcpServer as r, listConfiguredMcpServers as t };
