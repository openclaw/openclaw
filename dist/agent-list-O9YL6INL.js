import { c as normalizeOptionalString } from "./string-coerce-DyL154ka.js";
import { y as resolveStateDir } from "./paths-Cw7f9XhU.js";
import "./agent-scope-CtLXGcWm.js";
import { l as normalizeAgentId, u as normalizeMainKey } from "./session-key-Bte0mmcq.js";
import { c as resolveDefaultAgentId } from "./agent-scope-config-CMp71_27.js";
import { Nn as record, Rn as string, Zn as unknown } from "./schemas-Del5uzR8.js";
import { t as safeParseJsonWithSchema } from "./zod-parse-B4dzFRWI.js";
import { t as normalizePersistedSessionEntryShape } from "./store-entry-shape-D9hG2cVL.js";
import fs from "node:fs";
import path from "node:path";
//#region src/config/sessions/store-read.ts
const SessionStoreSchema = record(string(), unknown());
function readSessionStoreReadOnly(storePath) {
	try {
		const raw = fs.readFileSync(storePath, "utf-8");
		if (!raw.trim()) return {};
		const parsed = safeParseJsonWithSchema(SessionStoreSchema, raw) ?? {};
		return Object.fromEntries(Object.entries(parsed).flatMap(([key, entry]) => {
			const normalized = normalizePersistedSessionEntryShape(entry);
			return normalized ? [[key, normalized]] : [];
		}));
	} catch {
		return {};
	}
}
//#endregion
//#region src/gateway/agent-list.ts
function listExistingAgentIdsFromDisk() {
	const root = resolveStateDir();
	const agentsDir = path.join(root, "agents");
	try {
		return fs.readdirSync(agentsDir, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => normalizeAgentId(entry.name)).filter(Boolean);
	} catch {
		return [];
	}
}
function listConfiguredAgentIds(cfg) {
	const ids = /* @__PURE__ */ new Set();
	const defaultId = normalizeAgentId(resolveDefaultAgentId(cfg));
	ids.add(defaultId);
	for (const entry of cfg.agents?.list ?? []) if (entry?.id) ids.add(normalizeAgentId(entry.id));
	for (const id of listExistingAgentIdsFromDisk()) ids.add(id);
	const sorted = Array.from(ids).filter(Boolean);
	sorted.sort((a, b) => a.localeCompare(b));
	return sorted.includes(defaultId) ? [defaultId, ...sorted.filter((id) => id !== defaultId)] : sorted;
}
function listGatewayAgentsBasic(cfg) {
	const defaultId = normalizeAgentId(resolveDefaultAgentId(cfg));
	const mainKey = normalizeMainKey(cfg.session?.mainKey);
	const scope = cfg.session?.scope ?? "per-sender";
	const configuredById = /* @__PURE__ */ new Map();
	for (const entry of cfg.agents?.list ?? []) {
		if (!entry?.id) continue;
		const configuredName = normalizeOptionalString(entry.name);
		const identityName = normalizeOptionalString(entry.identity?.name);
		configuredById.set(normalizeAgentId(entry.id), { name: configuredName ?? identityName });
	}
	const explicitIds = new Set((cfg.agents?.list ?? []).map((entry) => entry?.id ? normalizeAgentId(entry.id) : "").filter(Boolean));
	const allowedIds = explicitIds.size > 0 ? new Set([...explicitIds, defaultId]) : null;
	let agentIds = listConfiguredAgentIds(cfg).filter((id) => allowedIds ? allowedIds.has(id) : true);
	if (mainKey && !agentIds.includes(mainKey) && (!allowedIds || allowedIds.has(mainKey))) agentIds = [...agentIds, mainKey];
	return {
		defaultId,
		mainKey,
		scope,
		agents: agentIds.map((id) => {
			return {
				id,
				name: configuredById.get(id)?.name
			};
		})
	};
}
//#endregion
export { readSessionStoreReadOnly as n, listGatewayAgentsBasic as t };
