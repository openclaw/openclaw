import { s as normalizeStringEntries } from "./string-normalization-C5SGsaST.js";
//#region src/channels/plugins/dm-access.ts
function normalizeChannelDmPolicy(value) {
	return value === "pairing" || value === "allowlist" || value === "open" || value === "disabled" ? value : void 0;
}
function asObjectRecord(value) {
	return value && typeof value === "object" && !Array.isArray(value) ? value : null;
}
function cloneDm(entry) {
	const dm = asObjectRecord(entry.dm);
	return dm ? { ...dm } : null;
}
function resolveDmFieldPaths(mode, kind) {
	const topKey = kind === "policy" ? "dmPolicy" : "allowFrom";
	const nestedKey = kind === "policy" ? "policy" : "allowFrom";
	if (mode === "nestedOnly") return {
		canonicalPath: ["dm", nestedKey],
		legacyPath: [topKey]
	};
	return {
		canonicalPath: [topKey],
		legacyPath: ["dm", nestedKey]
	};
}
function readPath(entry, path) {
	let current = entry;
	for (const segment of path) {
		const record = asObjectRecord(current);
		if (!record) return;
		current = record[segment];
	}
	return current;
}
function deletePath(entry, path) {
	if (path.length === 1) {
		if (entry[path[0]] === void 0) return false;
		delete entry[path[0]];
		return true;
	}
	const parent = asObjectRecord(entry[path[0]]);
	if (!parent || parent[path[1]] === void 0) return false;
	delete parent[path[1]];
	if (Object.keys(parent).length === 0) delete entry[path[0]];
	else entry[path[0]] = parent;
	return true;
}
function writePath(entry, path, value) {
	if (path.length === 1) {
		entry[path[0]] = value;
		return;
	}
	const parent = asObjectRecord(entry[path[0]]) ? { ...entry[path[0]] } : {};
	parent[path[1]] = value;
	entry[path[0]] = parent;
}
function allowFromListsMatch(left, right) {
	if (!Array.isArray(left) || !Array.isArray(right)) return false;
	const normalizedLeft = normalizeStringEntries(left);
	const normalizedRight = normalizeStringEntries(right);
	if (normalizedLeft.length !== normalizedRight.length) return false;
	return normalizedLeft.every((value, index) => value === normalizedRight[index]);
}
function formatPath(pathPrefix, path) {
	return `${pathPrefix}.${path.join(".")}`;
}
function readCanonicalOrLegacy(entry, mode, kind) {
	const paths = resolveDmFieldPaths(mode, kind);
	return readPath(entry, paths.canonicalPath) ?? readPath(entry, paths.legacyPath);
}
function resolveChannelDmPolicy(params) {
	const mode = params.mode ?? "topOnly";
	const value = readCanonicalOrLegacy(params.account, mode, "policy") ?? readCanonicalOrLegacy(params.parent, mode, "policy") ?? params.defaultPolicy;
	return typeof value === "string" ? normalizeChannelDmPolicy(value) : void 0;
}
function resolveChannelDmAllowFrom(params) {
	const mode = params.mode ?? "topOnly";
	const value = readCanonicalOrLegacy(params.account, mode, "allowFrom") ?? readCanonicalOrLegacy(params.parent, mode, "allowFrom");
	return Array.isArray(value) ? value : void 0;
}
function resolveChannelDmAccess(params) {
	return {
		dmPolicy: resolveChannelDmPolicy(params),
		allowFrom: resolveChannelDmAllowFrom(params)
	};
}
function setCanonicalDmAllowFrom(params) {
	const paths = resolveDmFieldPaths(params.mode, "allowFrom");
	writePath(params.entry, paths.canonicalPath, [...params.allowFrom]);
	if (deletePath(params.entry, paths.legacyPath)) params.changes?.push(`- ${formatPath(params.pathPrefix, paths.legacyPath)}: removed after moving allowlist to ${formatPath(params.pathPrefix, paths.canonicalPath)}`);
	params.changes?.push(`- ${formatPath(params.pathPrefix, paths.canonicalPath)}: ${params.reason}`);
}
function normalizeLegacyDmAliases(params) {
	let changed = false;
	let updated = params.entry;
	const rawDm = updated.dm;
	const dm = cloneDm(updated);
	let dmChanged = false;
	const topDmPolicy = updated.dmPolicy;
	const legacyDmPolicy = dm?.policy;
	if (topDmPolicy === void 0 && legacyDmPolicy !== void 0) {
		updated = {
			...updated,
			dmPolicy: legacyDmPolicy
		};
		changed = true;
		if (dm) {
			delete dm.policy;
			dmChanged = true;
		}
		params.changes.push(`Moved ${params.pathPrefix}.dm.policy → ${params.pathPrefix}.dmPolicy.`);
	} else if (topDmPolicy !== void 0 && legacyDmPolicy !== void 0 && topDmPolicy === legacyDmPolicy) {
		if (dm) {
			delete dm.policy;
			dmChanged = true;
			params.changes.push(`Removed ${params.pathPrefix}.dm.policy (dmPolicy already set).`);
		}
	}
	if (params.promoteAllowFrom !== false) {
		const topAllowFrom = updated.allowFrom;
		const legacyAllowFrom = dm?.allowFrom;
		if (topAllowFrom === void 0 && legacyAllowFrom !== void 0) {
			updated = {
				...updated,
				allowFrom: legacyAllowFrom
			};
			changed = true;
			if (dm) {
				delete dm.allowFrom;
				dmChanged = true;
			}
			params.changes.push(`Moved ${params.pathPrefix}.dm.allowFrom → ${params.pathPrefix}.allowFrom.`);
		} else if (topAllowFrom !== void 0 && legacyAllowFrom !== void 0 && allowFromListsMatch(topAllowFrom, legacyAllowFrom)) {
			if (dm) {
				delete dm.allowFrom;
				dmChanged = true;
				params.changes.push(`Removed ${params.pathPrefix}.dm.allowFrom (allowFrom already set).`);
			}
		}
	}
	if (dm && asObjectRecord(rawDm) && dmChanged) if (Object.keys(dm).length === 0) {
		if (updated.dm !== void 0) {
			const { dm: _ignored, ...rest } = updated;
			updated = rest;
			changed = true;
			params.changes.push(`Removed empty ${params.pathPrefix}.dm after migration.`);
		}
	} else {
		updated = {
			...updated,
			dm
		};
		changed = true;
	}
	return {
		entry: updated,
		changed
	};
}
function hasWildcard(list) {
	return list?.some((value) => String(value).trim() === "*") ?? false;
}
function ensureOpenDmPolicyAllowFromWildcard(params) {
	if (resolveChannelDmPolicy({
		account: params.entry,
		mode: params.mode
	}) !== "open") return;
	const policyPaths = resolveDmFieldPaths(params.mode, "policy");
	const canonicalPolicy = readPath(params.entry, policyPaths.canonicalPath);
	const legacyPolicy = readPath(params.entry, policyPaths.legacyPath);
	if (canonicalPolicy === void 0 && legacyPolicy === "open") {
		writePath(params.entry, policyPaths.canonicalPath, "open");
		deletePath(params.entry, policyPaths.legacyPath);
		params.changes.push(`- ${formatPath(params.pathPrefix, policyPaths.canonicalPath)}: set to "open" (migrated from ${formatPath(params.pathPrefix, policyPaths.legacyPath)})`);
	}
	const allowPaths = resolveDmFieldPaths(params.mode, "allowFrom");
	const canonicalAllowFrom = readPath(params.entry, allowPaths.canonicalPath);
	const legacyAllowFrom = readPath(params.entry, allowPaths.legacyPath);
	const sourceAllowFrom = Array.isArray(canonicalAllowFrom) ? canonicalAllowFrom : Array.isArray(legacyAllowFrom) ? legacyAllowFrom : void 0;
	if (hasWildcard(sourceAllowFrom)) {
		if (canonicalAllowFrom === void 0 && sourceAllowFrom) setCanonicalDmAllowFrom({
			entry: params.entry,
			mode: params.mode,
			allowFrom: sourceAllowFrom,
			pathPrefix: params.pathPrefix,
			changes: params.changes,
			reason: `moved wildcard allowlist from ${formatPath(params.pathPrefix, allowPaths.legacyPath)}`
		});
		return;
	}
	const nextAllowFrom = [...sourceAllowFrom ?? [], "*"];
	setCanonicalDmAllowFrom({
		entry: params.entry,
		mode: params.mode,
		allowFrom: nextAllowFrom,
		pathPrefix: params.pathPrefix,
		changes: params.changes,
		reason: Array.isArray(sourceAllowFrom) ? "added \"*\" (required by dmPolicy=\"open\")" : "set to [\"*\"] (required by dmPolicy=\"open\")"
	});
}
//#endregion
export { resolveChannelDmAllowFrom as a, resolveChannelDmAccess as i, normalizeChannelDmPolicy as n, resolveChannelDmPolicy as o, normalizeLegacyDmAliases as r, setCanonicalDmAllowFrom as s, ensureOpenDmPolicyAllowFromWildcard as t };
