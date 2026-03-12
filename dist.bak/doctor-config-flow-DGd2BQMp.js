import { f as resolveLegacyStateDirs, g as resolveStateDir, m as resolveOAuthDir, p as resolveNewStateDir, t as CONFIG_PATH } from "./paths-B4BZAPZh.js";
import { _ as resolveHomeDir, d as isRecord } from "./utils-BKDT474X.js";
import { d as resolveDefaultAgentId } from "./agent-scope-D8K2SjR7.js";
import { T as normalizeChatChannelId } from "./subsystem-LTWJBEIv.js";
import { h as normalizeAccountId, m as DEFAULT_ACCOUNT_ID, n as DEFAULT_MAIN_KEY, r as buildAgentMainSessionKey, s as normalizeAgentId } from "./session-key-D5gwKk5E.js";
import { It as migrateLegacyConfig, Mn as isTrustedSafeBinPath, Pn as normalizeTrustedSafeBinDirs, Vt as readConfigFileSnapshot, Wn as resolveCommandResolutionFromArgv, cr as resolveDiscordPreviewStreamMode, dr as resolveTelegramPreviewStreamMode, jn as getTrustedSafeBinDirs, lr as resolveSlackNativeStreaming, qt as OpenClawSchema, ur as resolveSlackStreamingMode } from "./model-selection-DILdVnl8.js";
import { t as formatCliCommand } from "./command-format-ChfKqObn.js";
import { f as parseToolsBySenderTypedKey } from "./dock-C2VnAw6v.js";
import { X as canonicalizeMainSessionAlias, p as saveSessionStore } from "./sessions-DUzDEcXs.js";
import { d as resolveTelegramAccount, l as listTelegramAccountIds } from "./plugins-B9xwwhdE.js";
import { i as readChannelAllowFromStore } from "./pairing-store-BTqK0Qm4.js";
import { r as resolveMergedSafeBinProfileFixtures, t as listInterpreterLikeSafeBins } from "./exec-safe-bin-runtime-policy-BfwBfxiF.js";
import { t as collectProviderDangerousNameMatchingScopes } from "./dangerous-name-matching-CTQpOYZ9.js";
import { t as applyPluginAutoEnable } from "./plugin-auto-enable-BWCvwRTr.js";
import { r as shouldMoveSingleAccountChannelKey, t as fetchTelegramChatId } from "./api-DLQBICrX.js";
import { t as note } from "./note-DcEdE35k.js";
import { t as isWithinDir } from "./path-safety-Dgp0AHn7.js";
import { a as isMattermostMutableAllowEntry, c as normalizeTelegramAllowFromEntry, i as isMSTeamsMutableAllowEntry, n as isGoogleChatMutableAllowEntry, o as isSlackMutableAllowEntry, r as isIrcMutableAllowEntry, s as isNumericTelegramUserId, t as isDiscordMutableAllowEntry } from "./mutable-allowlist-detectors-b_lZYYny.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import JSON5 from "json5";
import fs$1 from "node:fs/promises";

//#region src/commands/doctor-legacy-config.ts
function normalizeCompatibilityConfigValues(cfg) {
	const changes = [];
	let next = cfg;
	const isRecord = (value) => Boolean(value) && typeof value === "object" && !Array.isArray(value);
	const normalizeDmAliases = (params) => {
		let changed = false;
		let updated = params.entry;
		const rawDm = updated.dm;
		const dm = isRecord(rawDm) ? structuredClone(rawDm) : null;
		let dmChanged = false;
		const allowFromEqual = (a, b) => {
			if (!Array.isArray(a) || !Array.isArray(b)) return false;
			const na = a.map((v) => String(v).trim()).filter(Boolean);
			const nb = b.map((v) => String(v).trim()).filter(Boolean);
			if (na.length !== nb.length) return false;
			return na.every((v, i) => v === nb[i]);
		};
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
			changes.push(`Moved ${params.pathPrefix}.dm.policy → ${params.pathPrefix}.dmPolicy.`);
		} else if (topDmPolicy !== void 0 && legacyDmPolicy !== void 0) {
			if (topDmPolicy === legacyDmPolicy) {
				if (dm) {
					delete dm.policy;
					dmChanged = true;
					changes.push(`Removed ${params.pathPrefix}.dm.policy (dmPolicy already set).`);
				}
			}
		}
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
			changes.push(`Moved ${params.pathPrefix}.dm.allowFrom → ${params.pathPrefix}.allowFrom.`);
		} else if (topAllowFrom !== void 0 && legacyAllowFrom !== void 0) {
			if (allowFromEqual(topAllowFrom, legacyAllowFrom)) {
				if (dm) {
					delete dm.allowFrom;
					dmChanged = true;
					changes.push(`Removed ${params.pathPrefix}.dm.allowFrom (allowFrom already set).`);
				}
			}
		}
		if (dm && isRecord(rawDm) && dmChanged) if (Object.keys(dm).length === 0) {
			if (updated.dm !== void 0) {
				const { dm: _ignored, ...rest } = updated;
				updated = rest;
				changed = true;
				changes.push(`Removed empty ${params.pathPrefix}.dm after migration.`);
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
	};
	const normalizePreviewStreamingAliases = (params) => {
		let updated = params.entry;
		const hadLegacyStreamMode = updated.streamMode !== void 0;
		const beforeStreaming = updated.streaming;
		const resolved = params.resolveStreaming(updated);
		if (!(hadLegacyStreamMode || typeof beforeStreaming === "boolean" || typeof beforeStreaming === "string" && beforeStreaming !== resolved)) return {
			entry: updated,
			changed: false
		};
		let changed = false;
		if (beforeStreaming !== resolved) {
			updated = {
				...updated,
				streaming: resolved
			};
			changed = true;
		}
		if (hadLegacyStreamMode) {
			const { streamMode: _ignored, ...rest } = updated;
			updated = rest;
			changed = true;
			changes.push(`Moved ${params.pathPrefix}.streamMode → ${params.pathPrefix}.streaming (${resolved}).`);
		}
		if (typeof beforeStreaming === "boolean") changes.push(`Normalized ${params.pathPrefix}.streaming boolean → enum (${resolved}).`);
		else if (typeof beforeStreaming === "string" && beforeStreaming !== resolved) changes.push(`Normalized ${params.pathPrefix}.streaming (${beforeStreaming}) → (${resolved}).`);
		return {
			entry: updated,
			changed
		};
	};
	const normalizeSlackStreamingAliases = (params) => {
		let updated = params.entry;
		const hadLegacyStreamMode = updated.streamMode !== void 0;
		const legacyStreaming = updated.streaming;
		const beforeStreaming = updated.streaming;
		const beforeNativeStreaming = updated.nativeStreaming;
		const resolvedStreaming = resolveSlackStreamingMode(updated);
		const resolvedNativeStreaming = resolveSlackNativeStreaming(updated);
		if (!(hadLegacyStreamMode || typeof legacyStreaming === "boolean" || typeof legacyStreaming === "string" && legacyStreaming !== resolvedStreaming)) return {
			entry: updated,
			changed: false
		};
		let changed = false;
		if (beforeStreaming !== resolvedStreaming) {
			updated = {
				...updated,
				streaming: resolvedStreaming
			};
			changed = true;
		}
		if (typeof beforeNativeStreaming !== "boolean" || beforeNativeStreaming !== resolvedNativeStreaming) {
			updated = {
				...updated,
				nativeStreaming: resolvedNativeStreaming
			};
			changed = true;
		}
		if (hadLegacyStreamMode) {
			const { streamMode: _ignored, ...rest } = updated;
			updated = rest;
			changed = true;
			changes.push(`Moved ${params.pathPrefix}.streamMode → ${params.pathPrefix}.streaming (${resolvedStreaming}).`);
		}
		if (typeof legacyStreaming === "boolean") changes.push(`Moved ${params.pathPrefix}.streaming (boolean) → ${params.pathPrefix}.nativeStreaming (${resolvedNativeStreaming}).`);
		else if (typeof legacyStreaming === "string" && legacyStreaming !== resolvedStreaming) changes.push(`Normalized ${params.pathPrefix}.streaming (${legacyStreaming}) → (${resolvedStreaming}).`);
		return {
			entry: updated,
			changed
		};
	};
	const normalizeStreamingAliasesForProvider = (params) => {
		if (params.provider === "telegram") return normalizePreviewStreamingAliases({
			entry: params.entry,
			pathPrefix: params.pathPrefix,
			resolveStreaming: resolveTelegramPreviewStreamMode
		});
		if (params.provider === "discord") return normalizePreviewStreamingAliases({
			entry: params.entry,
			pathPrefix: params.pathPrefix,
			resolveStreaming: resolveDiscordPreviewStreamMode
		});
		return normalizeSlackStreamingAliases({
			entry: params.entry,
			pathPrefix: params.pathPrefix
		});
	};
	const normalizeProvider = (provider) => {
		const rawEntry = next.channels?.[provider];
		if (!isRecord(rawEntry)) return;
		let updated = rawEntry;
		let changed = false;
		if (provider !== "telegram") {
			const base = normalizeDmAliases({
				provider,
				entry: rawEntry,
				pathPrefix: `channels.${provider}`
			});
			updated = base.entry;
			changed = base.changed;
		}
		const providerStreaming = normalizeStreamingAliasesForProvider({
			provider,
			entry: updated,
			pathPrefix: `channels.${provider}`
		});
		updated = providerStreaming.entry;
		changed = changed || providerStreaming.changed;
		const rawAccounts = updated.accounts;
		if (isRecord(rawAccounts)) {
			let accountsChanged = false;
			const accounts = { ...rawAccounts };
			for (const [accountId, rawAccount] of Object.entries(rawAccounts)) {
				if (!isRecord(rawAccount)) continue;
				let accountEntry = rawAccount;
				let accountChanged = false;
				if (provider !== "telegram") {
					const res = normalizeDmAliases({
						provider,
						entry: rawAccount,
						pathPrefix: `channels.${provider}.accounts.${accountId}`
					});
					accountEntry = res.entry;
					accountChanged = res.changed;
				}
				const accountStreaming = normalizeStreamingAliasesForProvider({
					provider,
					entry: accountEntry,
					pathPrefix: `channels.${provider}.accounts.${accountId}`
				});
				accountEntry = accountStreaming.entry;
				accountChanged = accountChanged || accountStreaming.changed;
				if (accountChanged) {
					accounts[accountId] = accountEntry;
					accountsChanged = true;
				}
			}
			if (accountsChanged) {
				updated = {
					...updated,
					accounts
				};
				changed = true;
			}
		}
		if (changed) next = {
			...next,
			channels: {
				...next.channels,
				[provider]: updated
			}
		};
	};
	const seedMissingDefaultAccountsFromSingleAccountBase = () => {
		const channels = next.channels;
		if (!channels) return;
		let channelsChanged = false;
		const nextChannels = { ...channels };
		for (const [channelId, rawChannel] of Object.entries(channels)) {
			if (!isRecord(rawChannel)) continue;
			const rawAccounts = rawChannel.accounts;
			if (!isRecord(rawAccounts)) continue;
			const accountKeys = Object.keys(rawAccounts);
			if (accountKeys.length === 0) continue;
			if (accountKeys.some((key) => key.trim().toLowerCase() === DEFAULT_ACCOUNT_ID)) continue;
			const keysToMove = Object.entries(rawChannel).filter(([key, value]) => key !== "accounts" && key !== "enabled" && value !== void 0 && shouldMoveSingleAccountChannelKey({
				channelKey: channelId,
				key
			})).map(([key]) => key);
			if (keysToMove.length === 0) continue;
			const defaultAccount = {};
			for (const key of keysToMove) {
				const value = rawChannel[key];
				defaultAccount[key] = value && typeof value === "object" ? structuredClone(value) : value;
			}
			const nextChannel = { ...rawChannel };
			for (const key of keysToMove) delete nextChannel[key];
			nextChannel.accounts = {
				...rawAccounts,
				[DEFAULT_ACCOUNT_ID]: defaultAccount
			};
			nextChannels[channelId] = nextChannel;
			channelsChanged = true;
			changes.push(`Moved channels.${channelId} single-account top-level values into channels.${channelId}.accounts.default.`);
		}
		if (!channelsChanged) return;
		next = {
			...next,
			channels: nextChannels
		};
	};
	normalizeProvider("telegram");
	normalizeProvider("slack");
	normalizeProvider("discord");
	seedMissingDefaultAccountsFromSingleAccountBase();
	const normalizeBrowserSsrFPolicyAlias = () => {
		const rawBrowser = next.browser;
		if (!isRecord(rawBrowser)) return;
		const rawSsrFPolicy = rawBrowser.ssrfPolicy;
		if (!isRecord(rawSsrFPolicy) || !("allowPrivateNetwork" in rawSsrFPolicy)) return;
		const legacyAllowPrivateNetwork = rawSsrFPolicy.allowPrivateNetwork;
		const currentDangerousAllowPrivateNetwork = rawSsrFPolicy.dangerouslyAllowPrivateNetwork;
		let resolvedDangerousAllowPrivateNetwork = currentDangerousAllowPrivateNetwork;
		if (typeof legacyAllowPrivateNetwork === "boolean" || typeof currentDangerousAllowPrivateNetwork === "boolean") resolvedDangerousAllowPrivateNetwork = legacyAllowPrivateNetwork === true || currentDangerousAllowPrivateNetwork === true;
		else if (currentDangerousAllowPrivateNetwork === void 0) resolvedDangerousAllowPrivateNetwork = legacyAllowPrivateNetwork;
		const nextSsrFPolicy = { ...rawSsrFPolicy };
		delete nextSsrFPolicy.allowPrivateNetwork;
		if (resolvedDangerousAllowPrivateNetwork !== void 0) nextSsrFPolicy.dangerouslyAllowPrivateNetwork = resolvedDangerousAllowPrivateNetwork;
		const migratedBrowser = { ...next.browser };
		migratedBrowser.ssrfPolicy = nextSsrFPolicy;
		next = {
			...next,
			browser: migratedBrowser
		};
		changes.push(`Moved browser.ssrfPolicy.allowPrivateNetwork → browser.ssrfPolicy.dangerouslyAllowPrivateNetwork (${String(resolvedDangerousAllowPrivateNetwork)}).`);
	};
	normalizeBrowserSsrFPolicyAlias();
	const legacyAckReaction = cfg.messages?.ackReaction?.trim();
	const hasWhatsAppConfig = cfg.channels?.whatsapp !== void 0;
	if (legacyAckReaction && hasWhatsAppConfig) {
		if (!(cfg.channels?.whatsapp?.ackReaction !== void 0)) {
			const legacyScope = cfg.messages?.ackReactionScope ?? "group-mentions";
			let direct = true;
			let group = "mentions";
			if (legacyScope === "all") {
				direct = true;
				group = "always";
			} else if (legacyScope === "direct") {
				direct = true;
				group = "never";
			} else if (legacyScope === "group-all") {
				direct = false;
				group = "always";
			} else if (legacyScope === "group-mentions") {
				direct = false;
				group = "mentions";
			}
			next = {
				...next,
				channels: {
					...next.channels,
					whatsapp: {
						...next.channels?.whatsapp,
						ackReaction: {
							emoji: legacyAckReaction,
							direct,
							group
						}
					}
				}
			};
			changes.push(`Copied messages.ackReaction → channels.whatsapp.ackReaction (scope: ${legacyScope}).`);
		}
	}
	return {
		config: next,
		changes
	};
}

//#endregion
//#region src/infra/state-migrations.fs.ts
function safeReadDir(dir) {
	try {
		return fs.readdirSync(dir, { withFileTypes: true });
	} catch {
		return [];
	}
}
function existsDir(dir) {
	try {
		return fs.existsSync(dir) && fs.statSync(dir).isDirectory();
	} catch {
		return false;
	}
}
function ensureDir(dir) {
	fs.mkdirSync(dir, { recursive: true });
}
function fileExists(p) {
	try {
		return fs.existsSync(p) && fs.statSync(p).isFile();
	} catch {
		return false;
	}
}
function isLegacyWhatsAppAuthFile(name) {
	if (name === "creds.json" || name === "creds.json.bak") return true;
	if (!name.endsWith(".json")) return false;
	return /^(app-state-sync|session|sender-key|pre-key)-/.test(name);
}
function readSessionStoreJson5(storePath) {
	try {
		const raw = fs.readFileSync(storePath, "utf-8");
		const parsed = JSON5.parse(raw);
		if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return {
			store: parsed,
			ok: true
		};
	} catch {}
	return {
		store: {},
		ok: false
	};
}

//#endregion
//#region src/infra/state-migrations.ts
let autoMigrateStateDirChecked = false;
function isSurfaceGroupKey(key) {
	return key.includes(":group:") || key.includes(":channel:");
}
function isLegacyGroupKey(key) {
	const trimmed = key.trim();
	if (!trimmed) return false;
	if (trimmed.startsWith("group:")) return true;
	const lower = trimmed.toLowerCase();
	if (!lower.includes("@g.us")) return false;
	if (!trimmed.includes(":")) return true;
	if (lower.startsWith("whatsapp:") && !trimmed.includes(":group:")) return true;
	return false;
}
function canonicalizeSessionKeyForAgent(params) {
	const agentId = normalizeAgentId(params.agentId);
	const raw = params.key.trim();
	if (!raw) return raw;
	if (raw.toLowerCase() === "global" || raw.toLowerCase() === "unknown") return raw.toLowerCase();
	const canonicalMain = canonicalizeMainSessionAlias({
		cfg: { session: {
			scope: params.scope,
			mainKey: params.mainKey
		} },
		agentId,
		sessionKey: raw
	});
	if (canonicalMain !== raw) return canonicalMain.toLowerCase();
	if (raw.toLowerCase().startsWith("agent:")) return raw.toLowerCase();
	if (raw.toLowerCase().startsWith("subagent:")) return `agent:${agentId}:subagent:${raw.slice(9)}`.toLowerCase();
	if (raw.startsWith("group:")) {
		const id = raw.slice(6).trim();
		if (!id) return raw;
		return `agent:${agentId}:${id.toLowerCase().includes("@g.us") ? "whatsapp" : "unknown"}:group:${id}`.toLowerCase();
	}
	if (!raw.includes(":") && raw.toLowerCase().includes("@g.us")) return `agent:${agentId}:whatsapp:group:${raw}`.toLowerCase();
	if (raw.toLowerCase().startsWith("whatsapp:") && raw.toLowerCase().includes("@g.us")) {
		const cleaned = raw.slice(9).trim().replace(/^group:/i, "").trim();
		if (cleaned && !isSurfaceGroupKey(raw)) return `agent:${agentId}:whatsapp:group:${cleaned}`.toLowerCase();
	}
	if (isSurfaceGroupKey(raw)) return `agent:${agentId}:${raw}`.toLowerCase();
	return `agent:${agentId}:${raw}`.toLowerCase();
}
function pickLatestLegacyDirectEntry(store) {
	let best = null;
	let bestUpdated = -1;
	for (const [key, entry] of Object.entries(store)) {
		if (!entry || typeof entry !== "object") continue;
		const normalized = key.trim();
		if (!normalized) continue;
		if (normalized === "global") continue;
		if (normalized.startsWith("agent:")) continue;
		if (normalized.toLowerCase().startsWith("subagent:")) continue;
		if (isLegacyGroupKey(normalized) || isSurfaceGroupKey(normalized)) continue;
		const updatedAt = typeof entry.updatedAt === "number" ? entry.updatedAt : 0;
		if (updatedAt > bestUpdated) {
			bestUpdated = updatedAt;
			best = entry;
		}
	}
	return best;
}
function normalizeSessionEntry(entry) {
	const sessionId = typeof entry.sessionId === "string" ? entry.sessionId : null;
	if (!sessionId) return null;
	const updatedAt = typeof entry.updatedAt === "number" && Number.isFinite(entry.updatedAt) ? entry.updatedAt : Date.now();
	const normalized = {
		...entry,
		sessionId,
		updatedAt
	};
	const rec = normalized;
	if (typeof rec.groupChannel !== "string" && typeof rec.room === "string") rec.groupChannel = rec.room;
	delete rec.room;
	return normalized;
}
function resolveUpdatedAt(entry) {
	return typeof entry.updatedAt === "number" && Number.isFinite(entry.updatedAt) ? entry.updatedAt : 0;
}
function mergeSessionEntry(params) {
	if (!params.existing) return params.incoming;
	const existingUpdated = resolveUpdatedAt(params.existing);
	const incomingUpdated = resolveUpdatedAt(params.incoming);
	if (incomingUpdated > existingUpdated) return params.incoming;
	if (incomingUpdated < existingUpdated) return params.existing;
	return params.preferIncomingOnTie ? params.incoming : params.existing;
}
function canonicalizeSessionStore(params) {
	const canonical = {};
	const meta = /* @__PURE__ */ new Map();
	const legacyKeys = [];
	for (const [key, entry] of Object.entries(params.store)) {
		if (!entry || typeof entry !== "object") continue;
		const canonicalKey = canonicalizeSessionKeyForAgent({
			key,
			agentId: params.agentId,
			mainKey: params.mainKey,
			scope: params.scope
		});
		const isCanonical = canonicalKey === key;
		if (!isCanonical) legacyKeys.push(key);
		const existing = canonical[canonicalKey];
		if (!existing) {
			canonical[canonicalKey] = entry;
			meta.set(canonicalKey, {
				isCanonical,
				updatedAt: resolveUpdatedAt(entry)
			});
			continue;
		}
		const existingMeta = meta.get(canonicalKey);
		const incomingUpdated = resolveUpdatedAt(entry);
		const existingUpdated = existingMeta?.updatedAt ?? resolveUpdatedAt(existing);
		if (incomingUpdated > existingUpdated) {
			canonical[canonicalKey] = entry;
			meta.set(canonicalKey, {
				isCanonical,
				updatedAt: incomingUpdated
			});
			continue;
		}
		if (incomingUpdated < existingUpdated) continue;
		if (existingMeta?.isCanonical && !isCanonical) continue;
		if (!existingMeta?.isCanonical && isCanonical) {
			canonical[canonicalKey] = entry;
			meta.set(canonicalKey, {
				isCanonical,
				updatedAt: incomingUpdated
			});
			continue;
		}
	}
	return {
		store: canonical,
		legacyKeys
	};
}
function listLegacySessionKeys(params) {
	const legacy = [];
	for (const key of Object.keys(params.store)) if (canonicalizeSessionKeyForAgent({
		key,
		agentId: params.agentId,
		mainKey: params.mainKey,
		scope: params.scope
	}) !== key) legacy.push(key);
	return legacy;
}
function emptyDirOrMissing(dir) {
	if (!existsDir(dir)) return true;
	return safeReadDir(dir).length === 0;
}
function removeDirIfEmpty(dir) {
	if (!existsDir(dir)) return;
	if (!emptyDirOrMissing(dir)) return;
	try {
		fs.rmdirSync(dir);
	} catch {}
}
function resolveSymlinkTarget(linkPath) {
	try {
		const target = fs.readlinkSync(linkPath);
		return path.resolve(path.dirname(linkPath), target);
	} catch {
		return null;
	}
}
function formatStateDirMigration(legacyDir, targetDir) {
	return `State dir: ${legacyDir} → ${targetDir} (legacy path now symlinked)`;
}
function isDirPath(filePath) {
	try {
		return fs.statSync(filePath).isDirectory();
	} catch {
		return false;
	}
}
function isLegacyTreeSymlinkMirror(currentDir, realTargetDir) {
	let entries;
	try {
		entries = fs.readdirSync(currentDir, { withFileTypes: true });
	} catch {
		return false;
	}
	if (entries.length === 0) return false;
	for (const entry of entries) {
		const entryPath = path.join(currentDir, entry.name);
		let stat;
		try {
			stat = fs.lstatSync(entryPath);
		} catch {
			return false;
		}
		if (stat.isSymbolicLink()) {
			const resolvedTarget = resolveSymlinkTarget(entryPath);
			if (!resolvedTarget) return false;
			let resolvedRealTarget;
			try {
				resolvedRealTarget = fs.realpathSync(resolvedTarget);
			} catch {
				return false;
			}
			if (!isWithinDir(realTargetDir, resolvedRealTarget)) return false;
			continue;
		}
		if (stat.isDirectory()) {
			if (!isLegacyTreeSymlinkMirror(entryPath, realTargetDir)) return false;
			continue;
		}
		return false;
	}
	return true;
}
function isLegacyDirSymlinkMirror(legacyDir, targetDir) {
	let realTargetDir;
	try {
		realTargetDir = fs.realpathSync(targetDir);
	} catch {
		return false;
	}
	return isLegacyTreeSymlinkMirror(legacyDir, realTargetDir);
}
async function autoMigrateLegacyStateDir(params) {
	if (autoMigrateStateDirChecked) return {
		migrated: false,
		skipped: true,
		changes: [],
		warnings: []
	};
	autoMigrateStateDirChecked = true;
	if ((params.env ?? process.env).OPENCLAW_STATE_DIR?.trim()) return {
		migrated: false,
		skipped: true,
		changes: [],
		warnings: []
	};
	const homedir = params.homedir ?? os.homedir;
	const targetDir = resolveNewStateDir(homedir);
	const legacyDirs = resolveLegacyStateDirs(homedir);
	let legacyDir = legacyDirs.find((dir) => {
		try {
			return fs.existsSync(dir);
		} catch {
			return false;
		}
	});
	const warnings = [];
	const changes = [];
	let legacyStat = null;
	try {
		legacyStat = legacyDir ? fs.lstatSync(legacyDir) : null;
	} catch {
		legacyStat = null;
	}
	if (!legacyStat) return {
		migrated: false,
		skipped: false,
		changes,
		warnings
	};
	if (!legacyStat.isDirectory() && !legacyStat.isSymbolicLink()) {
		warnings.push(`Legacy state path is not a directory: ${legacyDir}`);
		return {
			migrated: false,
			skipped: false,
			changes,
			warnings
		};
	}
	let symlinkDepth = 0;
	while (legacyStat.isSymbolicLink()) {
		const legacyTarget = legacyDir ? resolveSymlinkTarget(legacyDir) : null;
		if (!legacyTarget) {
			warnings.push(`Legacy state dir is a symlink (${legacyDir ?? "unknown"}); could not resolve target.`);
			return {
				migrated: false,
				skipped: false,
				changes,
				warnings
			};
		}
		if (path.resolve(legacyTarget) === path.resolve(targetDir)) return {
			migrated: false,
			skipped: false,
			changes,
			warnings
		};
		if (legacyDirs.some((dir) => path.resolve(dir) === path.resolve(legacyTarget))) {
			legacyDir = legacyTarget;
			try {
				legacyStat = fs.lstatSync(legacyDir);
			} catch {
				legacyStat = null;
			}
			if (!legacyStat) {
				warnings.push(`Legacy state dir missing after symlink resolution: ${legacyDir}`);
				return {
					migrated: false,
					skipped: false,
					changes,
					warnings
				};
			}
			if (!legacyStat.isDirectory() && !legacyStat.isSymbolicLink()) {
				warnings.push(`Legacy state path is not a directory: ${legacyDir}`);
				return {
					migrated: false,
					skipped: false,
					changes,
					warnings
				};
			}
			symlinkDepth += 1;
			if (symlinkDepth > 2) {
				warnings.push(`Legacy state dir symlink chain too deep: ${legacyDir}`);
				return {
					migrated: false,
					skipped: false,
					changes,
					warnings
				};
			}
			continue;
		}
		warnings.push(`Legacy state dir is a symlink (${legacyDir ?? "unknown"} → ${legacyTarget}); skipping auto-migration.`);
		return {
			migrated: false,
			skipped: false,
			changes,
			warnings
		};
	}
	if (isDirPath(targetDir)) {
		if (legacyDir && isLegacyDirSymlinkMirror(legacyDir, targetDir)) return {
			migrated: false,
			skipped: false,
			changes,
			warnings
		};
		warnings.push(`State dir migration skipped: target already exists (${targetDir}). Remove or merge manually.`);
		return {
			migrated: false,
			skipped: false,
			changes,
			warnings
		};
	}
	try {
		if (!legacyDir) throw new Error("Legacy state dir not found");
		fs.renameSync(legacyDir, targetDir);
	} catch (err) {
		warnings.push(`Failed to move legacy state dir (${legacyDir ?? "unknown"} → ${targetDir}): ${String(err)}`);
		return {
			migrated: false,
			skipped: false,
			changes,
			warnings
		};
	}
	try {
		if (!legacyDir) throw new Error("Legacy state dir not found");
		fs.symlinkSync(targetDir, legacyDir, "dir");
		changes.push(formatStateDirMigration(legacyDir, targetDir));
	} catch (err) {
		try {
			if (process.platform === "win32") {
				if (!legacyDir) throw new Error("Legacy state dir not found", { cause: err });
				fs.symlinkSync(targetDir, legacyDir, "junction");
				changes.push(formatStateDirMigration(legacyDir, targetDir));
			} else throw err;
		} catch (fallbackErr) {
			try {
				if (!legacyDir) throw new Error("Legacy state dir not found", { cause: fallbackErr });
				fs.renameSync(targetDir, legacyDir);
				warnings.push(`State dir migration rolled back (failed to link legacy path): ${String(fallbackErr)}`);
				return {
					migrated: false,
					skipped: false,
					changes: [],
					warnings
				};
			} catch (rollbackErr) {
				warnings.push(`State dir moved but failed to link legacy path (${legacyDir ?? "unknown"} → ${targetDir}): ${String(fallbackErr)}`);
				warnings.push(`Rollback failed; set OPENCLAW_STATE_DIR=${targetDir} to avoid split state: ${String(rollbackErr)}`);
				changes.push(`State dir: ${legacyDir ?? "unknown"} → ${targetDir}`);
			}
		}
	}
	return {
		migrated: changes.length > 0,
		skipped: false,
		changes,
		warnings
	};
}
async function detectLegacyStateMigrations(params) {
	const env = params.env ?? process.env;
	const stateDir = resolveStateDir(env, params.homedir ?? os.homedir);
	const oauthDir = resolveOAuthDir(env, stateDir);
	const targetAgentId = normalizeAgentId(resolveDefaultAgentId(params.cfg));
	const rawMainKey = params.cfg.session?.mainKey;
	const targetMainKey = typeof rawMainKey === "string" && rawMainKey.trim().length > 0 ? rawMainKey.trim() : DEFAULT_MAIN_KEY;
	const targetScope = params.cfg.session?.scope;
	const sessionsLegacyDir = path.join(stateDir, "sessions");
	const sessionsLegacyStorePath = path.join(sessionsLegacyDir, "sessions.json");
	const sessionsTargetDir = path.join(stateDir, "agents", targetAgentId, "sessions");
	const sessionsTargetStorePath = path.join(sessionsTargetDir, "sessions.json");
	const legacySessionEntries = safeReadDir(sessionsLegacyDir);
	const hasLegacySessions = fileExists(sessionsLegacyStorePath) || legacySessionEntries.some((e) => e.isFile() && e.name.endsWith(".jsonl"));
	const targetSessionParsed = fileExists(sessionsTargetStorePath) ? readSessionStoreJson5(sessionsTargetStorePath) : {
		store: {},
		ok: true
	};
	const legacyKeys = targetSessionParsed.ok ? listLegacySessionKeys({
		store: targetSessionParsed.store,
		agentId: targetAgentId,
		mainKey: targetMainKey,
		scope: targetScope
	}) : [];
	const legacyAgentDir = path.join(stateDir, "agent");
	const targetAgentDir = path.join(stateDir, "agents", targetAgentId, "agent");
	const hasLegacyAgentDir = existsDir(legacyAgentDir);
	const targetWhatsAppAuthDir = path.join(oauthDir, "whatsapp", DEFAULT_ACCOUNT_ID);
	const hasLegacyWhatsAppAuth = fileExists(path.join(oauthDir, "creds.json")) && !fileExists(path.join(targetWhatsAppAuthDir, "creds.json"));
	const legacyTelegramAllowFromPath = path.join(oauthDir, "telegram-allowFrom.json");
	const targetTelegramAllowFromPath = path.join(oauthDir, `telegram-${DEFAULT_ACCOUNT_ID}-allowFrom.json`);
	const hasLegacyTelegramAllowFrom = fileExists(legacyTelegramAllowFromPath) && !fileExists(targetTelegramAllowFromPath);
	const preview = [];
	if (hasLegacySessions) preview.push(`- Sessions: ${sessionsLegacyDir} → ${sessionsTargetDir}`);
	if (legacyKeys.length > 0) preview.push(`- Sessions: canonicalize legacy keys in ${sessionsTargetStorePath}`);
	if (hasLegacyAgentDir) preview.push(`- Agent dir: ${legacyAgentDir} → ${targetAgentDir}`);
	if (hasLegacyWhatsAppAuth) preview.push(`- WhatsApp auth: ${oauthDir} → ${targetWhatsAppAuthDir} (keep oauth.json)`);
	if (hasLegacyTelegramAllowFrom) preview.push(`- Telegram pairing allowFrom: ${legacyTelegramAllowFromPath} → ${targetTelegramAllowFromPath}`);
	return {
		targetAgentId,
		targetMainKey,
		targetScope,
		stateDir,
		oauthDir,
		sessions: {
			legacyDir: sessionsLegacyDir,
			legacyStorePath: sessionsLegacyStorePath,
			targetDir: sessionsTargetDir,
			targetStorePath: sessionsTargetStorePath,
			hasLegacy: hasLegacySessions || legacyKeys.length > 0,
			legacyKeys
		},
		agentDir: {
			legacyDir: legacyAgentDir,
			targetDir: targetAgentDir,
			hasLegacy: hasLegacyAgentDir
		},
		whatsappAuth: {
			legacyDir: oauthDir,
			targetDir: targetWhatsAppAuthDir,
			hasLegacy: hasLegacyWhatsAppAuth
		},
		pairingAllowFrom: {
			legacyTelegramPath: legacyTelegramAllowFromPath,
			targetTelegramPath: targetTelegramAllowFromPath,
			hasLegacyTelegram: hasLegacyTelegramAllowFrom
		},
		preview
	};
}
async function migrateLegacySessions(detected, now) {
	const changes = [];
	const warnings = [];
	if (!detected.sessions.hasLegacy) return {
		changes,
		warnings
	};
	ensureDir(detected.sessions.targetDir);
	const legacyParsed = fileExists(detected.sessions.legacyStorePath) ? readSessionStoreJson5(detected.sessions.legacyStorePath) : {
		store: {},
		ok: true
	};
	const targetParsed = fileExists(detected.sessions.targetStorePath) ? readSessionStoreJson5(detected.sessions.targetStorePath) : {
		store: {},
		ok: true
	};
	const legacyStore = legacyParsed.store;
	const targetStore = targetParsed.store;
	const canonicalizedTarget = canonicalizeSessionStore({
		store: targetStore,
		agentId: detected.targetAgentId,
		mainKey: detected.targetMainKey,
		scope: detected.targetScope
	});
	const canonicalizedLegacy = canonicalizeSessionStore({
		store: legacyStore,
		agentId: detected.targetAgentId,
		mainKey: detected.targetMainKey,
		scope: detected.targetScope
	});
	const merged = { ...canonicalizedTarget.store };
	for (const [key, entry] of Object.entries(canonicalizedLegacy.store)) merged[key] = mergeSessionEntry({
		existing: merged[key],
		incoming: entry,
		preferIncomingOnTie: false
	});
	const mainKey = buildAgentMainSessionKey({
		agentId: detected.targetAgentId,
		mainKey: detected.targetMainKey
	});
	if (!merged[mainKey]) {
		const latest = pickLatestLegacyDirectEntry(legacyStore);
		if (latest?.sessionId) {
			merged[mainKey] = latest;
			changes.push(`Migrated latest direct-chat session → ${mainKey}`);
		}
	}
	if (!legacyParsed.ok) warnings.push(`Legacy sessions store unreadable; left in place at ${detected.sessions.legacyStorePath}`);
	if ((legacyParsed.ok || targetParsed.ok) && (Object.keys(legacyStore).length > 0 || Object.keys(targetStore).length > 0)) {
		const normalized = {};
		for (const [key, entry] of Object.entries(merged)) {
			const normalizedEntry = normalizeSessionEntry(entry);
			if (!normalizedEntry) continue;
			normalized[key] = normalizedEntry;
		}
		await saveSessionStore(detected.sessions.targetStorePath, normalized, { skipMaintenance: true });
		changes.push(`Merged sessions store → ${detected.sessions.targetStorePath}`);
		if (canonicalizedTarget.legacyKeys.length > 0) changes.push(`Canonicalized ${canonicalizedTarget.legacyKeys.length} legacy session key(s)`);
	}
	const entries = safeReadDir(detected.sessions.legacyDir);
	for (const entry of entries) {
		if (!entry.isFile()) continue;
		if (entry.name === "sessions.json") continue;
		const from = path.join(detected.sessions.legacyDir, entry.name);
		const to = path.join(detected.sessions.targetDir, entry.name);
		if (fileExists(to)) continue;
		try {
			fs.renameSync(from, to);
			changes.push(`Moved ${entry.name} → agents/${detected.targetAgentId}/sessions`);
		} catch (err) {
			warnings.push(`Failed moving ${from}: ${String(err)}`);
		}
	}
	if (legacyParsed.ok) try {
		if (fileExists(detected.sessions.legacyStorePath)) fs.rmSync(detected.sessions.legacyStorePath, { force: true });
	} catch {}
	removeDirIfEmpty(detected.sessions.legacyDir);
	if (safeReadDir(detected.sessions.legacyDir).filter((e) => e.isFile()).length > 0) {
		const backupDir = `${detected.sessions.legacyDir}.legacy-${now()}`;
		try {
			fs.renameSync(detected.sessions.legacyDir, backupDir);
			warnings.push(`Left legacy sessions at ${backupDir}`);
		} catch {}
	}
	return {
		changes,
		warnings
	};
}
async function migrateLegacyAgentDir(detected, now) {
	const changes = [];
	const warnings = [];
	if (!detected.agentDir.hasLegacy) return {
		changes,
		warnings
	};
	ensureDir(detected.agentDir.targetDir);
	const entries = safeReadDir(detected.agentDir.legacyDir);
	for (const entry of entries) {
		const from = path.join(detected.agentDir.legacyDir, entry.name);
		const to = path.join(detected.agentDir.targetDir, entry.name);
		if (fs.existsSync(to)) continue;
		try {
			fs.renameSync(from, to);
			changes.push(`Moved agent file ${entry.name} → agents/${detected.targetAgentId}/agent`);
		} catch (err) {
			warnings.push(`Failed moving ${from}: ${String(err)}`);
		}
	}
	removeDirIfEmpty(detected.agentDir.legacyDir);
	if (!emptyDirOrMissing(detected.agentDir.legacyDir)) {
		const backupDir = path.join(detected.stateDir, "agents", detected.targetAgentId, `agent.legacy-${now()}`);
		try {
			fs.renameSync(detected.agentDir.legacyDir, backupDir);
			warnings.push(`Left legacy agent dir at ${backupDir}`);
		} catch (err) {
			warnings.push(`Failed relocating legacy agent dir: ${String(err)}`);
		}
	}
	return {
		changes,
		warnings
	};
}
async function migrateLegacyWhatsAppAuth(detected) {
	const changes = [];
	const warnings = [];
	if (!detected.whatsappAuth.hasLegacy) return {
		changes,
		warnings
	};
	ensureDir(detected.whatsappAuth.targetDir);
	const entries = safeReadDir(detected.whatsappAuth.legacyDir);
	for (const entry of entries) {
		if (!entry.isFile()) continue;
		if (entry.name === "oauth.json") continue;
		if (!isLegacyWhatsAppAuthFile(entry.name)) continue;
		const from = path.join(detected.whatsappAuth.legacyDir, entry.name);
		const to = path.join(detected.whatsappAuth.targetDir, entry.name);
		if (fileExists(to)) continue;
		try {
			fs.renameSync(from, to);
			changes.push(`Moved WhatsApp auth ${entry.name} → whatsapp/default`);
		} catch (err) {
			warnings.push(`Failed moving ${from}: ${String(err)}`);
		}
	}
	return {
		changes,
		warnings
	};
}
async function migrateLegacyTelegramPairingAllowFrom(detected) {
	const changes = [];
	const warnings = [];
	if (!detected.pairingAllowFrom.hasLegacyTelegram) return {
		changes,
		warnings
	};
	const legacyPath = detected.pairingAllowFrom.legacyTelegramPath;
	const targetPath = detected.pairingAllowFrom.targetTelegramPath;
	try {
		ensureDir(path.dirname(targetPath));
		fs.copyFileSync(legacyPath, targetPath);
		changes.push(`Copied Telegram pairing allowFrom → ${targetPath}`);
	} catch (err) {
		warnings.push(`Failed migrating Telegram pairing allowFrom (${legacyPath}): ${String(err)}`);
	}
	return {
		changes,
		warnings
	};
}
async function runLegacyStateMigrations(params) {
	const now = params.now ?? (() => Date.now());
	const detected = params.detected;
	const sessions = await migrateLegacySessions(detected, now);
	const agentDir = await migrateLegacyAgentDir(detected, now);
	const whatsappAuth = await migrateLegacyWhatsAppAuth(detected);
	const telegramPairingAllowFrom = await migrateLegacyTelegramPairingAllowFrom(detected);
	return {
		changes: [
			...sessions.changes,
			...agentDir.changes,
			...whatsappAuth.changes,
			...telegramPairingAllowFrom.changes
		],
		warnings: [
			...sessions.warnings,
			...agentDir.warnings,
			...whatsappAuth.warnings,
			...telegramPairingAllowFrom.warnings
		]
	};
}

//#endregion
//#region src/commands/doctor-config-flow.ts
function normalizeIssuePath(path) {
	return path.filter((part) => typeof part !== "symbol");
}
function isUnrecognizedKeysIssue(issue) {
	return issue.code === "unrecognized_keys";
}
function formatPath(parts) {
	if (parts.length === 0) return "<root>";
	let out = "";
	for (const part of parts) {
		if (typeof part === "number") {
			out += `[${part}]`;
			continue;
		}
		out = out ? `${out}.${part}` : part;
	}
	return out || "<root>";
}
function resolvePathTarget(root, path) {
	let current = root;
	for (const part of path) {
		if (typeof part === "number") {
			if (!Array.isArray(current)) return null;
			if (part < 0 || part >= current.length) return null;
			current = current[part];
			continue;
		}
		if (!current || typeof current !== "object" || Array.isArray(current)) return null;
		const record = current;
		if (!(part in record)) return null;
		current = record[part];
	}
	return current;
}
function stripUnknownConfigKeys(config) {
	const parsed = OpenClawSchema.safeParse(config);
	if (parsed.success) return {
		config,
		removed: []
	};
	const next = structuredClone(config);
	const removed = [];
	for (const issue of parsed.error.issues) {
		if (!isUnrecognizedKeysIssue(issue)) continue;
		const path = normalizeIssuePath(issue.path);
		const target = resolvePathTarget(next, path);
		if (!target || typeof target !== "object" || Array.isArray(target)) continue;
		const record = target;
		for (const key of issue.keys) {
			if (typeof key !== "string") continue;
			if (!(key in record)) continue;
			delete record[key];
			removed.push(formatPath([...path, key]));
		}
	}
	return {
		config: next,
		removed
	};
}
function noteOpencodeProviderOverrides(cfg) {
	const providers = cfg.models?.providers;
	if (!providers) return;
	const overrides = [];
	if (providers.opencode) overrides.push("opencode");
	if (providers["opencode-zen"]) overrides.push("opencode-zen");
	if (overrides.length === 0) return;
	const lines = overrides.flatMap((id) => {
		const providerEntry = providers[id];
		const api = isRecord(providerEntry) && typeof providerEntry.api === "string" ? providerEntry.api : void 0;
		return [`- models.providers.${id} is set; this overrides the built-in OpenCode Zen catalog.`, api ? `- models.providers.${id}.api=${api}` : null].filter((line) => Boolean(line));
	});
	lines.push("- Remove these entries to restore per-model API routing + costs (then re-run onboarding if needed).");
	note(lines.join("\n"), "OpenCode Zen");
}
function noteIncludeConfinementWarning(snapshot) {
	const includeIssue = (snapshot.issues ?? []).find((issue) => issue.message.includes("Include path escapes config directory") || issue.message.includes("Include path resolves outside config directory"));
	if (!includeIssue) return;
	note([
		`- $include paths must stay under: ${path.dirname(snapshot.path ?? CONFIG_PATH)}`,
		"- Move shared include files under that directory and update to relative paths like \"./shared/common.json\".",
		`- Error: ${includeIssue.message}`
	].join("\n"), "Doctor warnings");
}
function asObjectRecord(value) {
	if (!value || typeof value !== "object" || Array.isArray(value)) return null;
	return value;
}
function normalizeBindingChannelKey(raw) {
	const normalized = normalizeChatChannelId(raw);
	if (normalized) return normalized;
	return (raw ?? "").trim().toLowerCase();
}
function collectMissingDefaultAccountBindingWarnings(cfg) {
	const channels = asObjectRecord(cfg.channels);
	if (!channels) return [];
	const bindings = Array.isArray(cfg.bindings) ? cfg.bindings : [];
	const warnings = [];
	for (const [channelKey, rawChannel] of Object.entries(channels)) {
		const channel = asObjectRecord(rawChannel);
		if (!channel) continue;
		const accounts = asObjectRecord(channel.accounts);
		if (!accounts) continue;
		const normalizedAccountIds = Array.from(new Set(Object.keys(accounts).map((accountId) => normalizeAccountId(accountId)).filter(Boolean)));
		if (normalizedAccountIds.length === 0 || normalizedAccountIds.includes(DEFAULT_ACCOUNT_ID)) continue;
		const accountIdSet = new Set(normalizedAccountIds);
		const channelPattern = normalizeBindingChannelKey(channelKey);
		let hasWildcardBinding = false;
		const coveredAccountIds = /* @__PURE__ */ new Set();
		for (const binding of bindings) {
			const bindingRecord = asObjectRecord(binding);
			if (!bindingRecord) continue;
			const match = asObjectRecord(bindingRecord.match);
			if (!match) continue;
			const matchChannel = typeof match.channel === "string" ? normalizeBindingChannelKey(match.channel) : "";
			if (!matchChannel || matchChannel !== channelPattern) continue;
			const rawAccountId = typeof match.accountId === "string" ? match.accountId.trim() : "";
			if (!rawAccountId) continue;
			if (rawAccountId === "*") {
				hasWildcardBinding = true;
				continue;
			}
			const normalizedBindingAccountId = normalizeAccountId(rawAccountId);
			if (accountIdSet.has(normalizedBindingAccountId)) coveredAccountIds.add(normalizedBindingAccountId);
		}
		if (hasWildcardBinding) continue;
		const uncoveredAccountIds = normalizedAccountIds.filter((accountId) => !coveredAccountIds.has(accountId));
		if (uncoveredAccountIds.length === 0) continue;
		if (coveredAccountIds.size > 0) {
			warnings.push(`- channels.${channelKey}: accounts.default is missing and account bindings only cover a subset of configured accounts. Uncovered accounts: ${uncoveredAccountIds.join(", ")}. Add bindings[].match.accountId for uncovered accounts (or "*"), or add channels.${channelKey}.accounts.default.`);
			continue;
		}
		warnings.push(`- channels.${channelKey}: accounts.default is missing and no valid account-scoped binding exists for configured accounts (${normalizedAccountIds.join(", ")}). Channel-only bindings (no accountId) match only default. Add bindings[].match.accountId for one of these accounts (or "*"), or add channels.${channelKey}.accounts.default.`);
	}
	return warnings;
}
function collectTelegramAccountScopes(cfg) {
	const scopes = [];
	const telegram = asObjectRecord(cfg.channels?.telegram);
	if (!telegram) return scopes;
	scopes.push({
		prefix: "channels.telegram",
		account: telegram
	});
	const accounts = asObjectRecord(telegram.accounts);
	if (!accounts) return scopes;
	for (const key of Object.keys(accounts)) {
		const account = asObjectRecord(accounts[key]);
		if (!account) continue;
		scopes.push({
			prefix: `channels.telegram.accounts.${key}`,
			account
		});
	}
	return scopes;
}
function collectTelegramAllowFromLists(prefix, account) {
	const refs = [{
		pathLabel: `${prefix}.allowFrom`,
		holder: account,
		key: "allowFrom"
	}, {
		pathLabel: `${prefix}.groupAllowFrom`,
		holder: account,
		key: "groupAllowFrom"
	}];
	const groups = asObjectRecord(account.groups);
	if (!groups) return refs;
	for (const groupId of Object.keys(groups)) {
		const group = asObjectRecord(groups[groupId]);
		if (!group) continue;
		refs.push({
			pathLabel: `${prefix}.groups.${groupId}.allowFrom`,
			holder: group,
			key: "allowFrom"
		});
		const topics = asObjectRecord(group.topics);
		if (!topics) continue;
		for (const topicId of Object.keys(topics)) {
			const topic = asObjectRecord(topics[topicId]);
			if (!topic) continue;
			refs.push({
				pathLabel: `${prefix}.groups.${groupId}.topics.${topicId}.allowFrom`,
				holder: topic,
				key: "allowFrom"
			});
		}
	}
	return refs;
}
function scanTelegramAllowFromUsernameEntries(cfg) {
	const hits = [];
	const scanList = (pathLabel, list) => {
		if (!Array.isArray(list)) return;
		for (const entry of list) {
			const normalized = normalizeTelegramAllowFromEntry(entry);
			if (!normalized || normalized === "*") continue;
			if (isNumericTelegramUserId(normalized)) continue;
			hits.push({
				path: pathLabel,
				entry: String(entry).trim()
			});
		}
	};
	for (const scope of collectTelegramAccountScopes(cfg)) for (const ref of collectTelegramAllowFromLists(scope.prefix, scope.account)) scanList(ref.pathLabel, ref.holder[ref.key]);
	return hits;
}
async function maybeRepairTelegramAllowFromUsernames(cfg) {
	if (scanTelegramAllowFromUsernameEntries(cfg).length === 0) return {
		config: cfg,
		changes: []
	};
	const tokens = Array.from(new Set(listTelegramAccountIds(cfg).map((accountId) => resolveTelegramAccount({
		cfg,
		accountId
	})).map((account) => account.tokenSource === "none" ? "" : account.token).map((token) => token.trim()).filter(Boolean)));
	if (tokens.length === 0) return {
		config: cfg,
		changes: [`- Telegram allowFrom contains @username entries, but no Telegram bot token is configured; cannot auto-resolve (run onboarding or replace with numeric sender IDs).`]
	};
	const resolveUserId = async (raw) => {
		const trimmed = raw.trim();
		if (!trimmed) return null;
		const stripped = normalizeTelegramAllowFromEntry(trimmed);
		if (!stripped || stripped === "*") return null;
		if (isNumericTelegramUserId(stripped)) return stripped;
		if (/\s/.test(stripped)) return null;
		const username = stripped.startsWith("@") ? stripped : `@${stripped}`;
		for (const token of tokens) {
			const controller = new AbortController();
			const timeout = setTimeout(() => controller.abort(), 4e3);
			try {
				const id = await fetchTelegramChatId({
					token,
					chatId: username,
					signal: controller.signal
				});
				if (id) return id;
			} catch {} finally {
				clearTimeout(timeout);
			}
		}
		return null;
	};
	const changes = [];
	const next = structuredClone(cfg);
	const repairList = async (pathLabel, holder, key) => {
		const raw = holder[key];
		if (!Array.isArray(raw)) return;
		const out = [];
		const replaced = [];
		for (const entry of raw) {
			const normalized = normalizeTelegramAllowFromEntry(entry);
			if (!normalized) continue;
			if (normalized === "*") {
				out.push("*");
				continue;
			}
			if (isNumericTelegramUserId(normalized)) {
				out.push(normalized);
				continue;
			}
			const resolved = await resolveUserId(String(entry));
			if (resolved) {
				out.push(resolved);
				replaced.push({
					from: String(entry).trim(),
					to: resolved
				});
			} else out.push(String(entry).trim());
		}
		const deduped = [];
		const seen = /* @__PURE__ */ new Set();
		for (const entry of out) {
			const k = String(entry).trim();
			if (!k || seen.has(k)) continue;
			seen.add(k);
			deduped.push(entry);
		}
		holder[key] = deduped;
		if (replaced.length > 0) {
			for (const rep of replaced.slice(0, 5)) changes.push(`- ${pathLabel}: resolved ${rep.from} -> ${rep.to}`);
			if (replaced.length > 5) changes.push(`- ${pathLabel}: resolved ${replaced.length - 5} more @username entries`);
		}
	};
	const repairAccount = async (prefix, account) => {
		for (const ref of collectTelegramAllowFromLists(prefix, account)) await repairList(ref.pathLabel, ref.holder, ref.key);
	};
	for (const scope of collectTelegramAccountScopes(next)) await repairAccount(scope.prefix, scope.account);
	if (changes.length === 0) return {
		config: cfg,
		changes: []
	};
	return {
		config: next,
		changes
	};
}
function collectDiscordAccountScopes(cfg) {
	const scopes = [];
	const discord = asObjectRecord(cfg.channels?.discord);
	if (!discord) return scopes;
	scopes.push({
		prefix: "channels.discord",
		account: discord
	});
	const accounts = asObjectRecord(discord.accounts);
	if (!accounts) return scopes;
	for (const key of Object.keys(accounts)) {
		const account = asObjectRecord(accounts[key]);
		if (!account) continue;
		scopes.push({
			prefix: `channels.discord.accounts.${key}`,
			account
		});
	}
	return scopes;
}
function collectDiscordIdLists(prefix, account) {
	const refs = [{
		pathLabel: `${prefix}.allowFrom`,
		holder: account,
		key: "allowFrom"
	}];
	const dm = asObjectRecord(account.dm);
	if (dm) {
		refs.push({
			pathLabel: `${prefix}.dm.allowFrom`,
			holder: dm,
			key: "allowFrom"
		});
		refs.push({
			pathLabel: `${prefix}.dm.groupChannels`,
			holder: dm,
			key: "groupChannels"
		});
	}
	const execApprovals = asObjectRecord(account.execApprovals);
	if (execApprovals) refs.push({
		pathLabel: `${prefix}.execApprovals.approvers`,
		holder: execApprovals,
		key: "approvers"
	});
	const guilds = asObjectRecord(account.guilds);
	if (!guilds) return refs;
	for (const guildId of Object.keys(guilds)) {
		const guild = asObjectRecord(guilds[guildId]);
		if (!guild) continue;
		refs.push({
			pathLabel: `${prefix}.guilds.${guildId}.users`,
			holder: guild,
			key: "users"
		});
		refs.push({
			pathLabel: `${prefix}.guilds.${guildId}.roles`,
			holder: guild,
			key: "roles"
		});
		const channels = asObjectRecord(guild.channels);
		if (!channels) continue;
		for (const channelId of Object.keys(channels)) {
			const channel = asObjectRecord(channels[channelId]);
			if (!channel) continue;
			refs.push({
				pathLabel: `${prefix}.guilds.${guildId}.channels.${channelId}.users`,
				holder: channel,
				key: "users"
			});
			refs.push({
				pathLabel: `${prefix}.guilds.${guildId}.channels.${channelId}.roles`,
				holder: channel,
				key: "roles"
			});
		}
	}
	return refs;
}
function scanDiscordNumericIdEntries(cfg) {
	const hits = [];
	const scanList = (pathLabel, list) => {
		if (!Array.isArray(list)) return;
		for (const [index, entry] of list.entries()) {
			if (typeof entry !== "number") continue;
			hits.push({
				path: `${pathLabel}[${index}]`,
				entry
			});
		}
	};
	for (const scope of collectDiscordAccountScopes(cfg)) for (const ref of collectDiscordIdLists(scope.prefix, scope.account)) scanList(ref.pathLabel, ref.holder[ref.key]);
	return hits;
}
function maybeRepairDiscordNumericIds(cfg) {
	if (scanDiscordNumericIdEntries(cfg).length === 0) return {
		config: cfg,
		changes: []
	};
	const next = structuredClone(cfg);
	const changes = [];
	const repairList = (pathLabel, holder, key) => {
		const raw = holder[key];
		if (!Array.isArray(raw)) return;
		let converted = 0;
		const updated = raw.map((entry) => {
			if (typeof entry === "number") {
				converted += 1;
				return String(entry);
			}
			return entry;
		});
		if (converted === 0) return;
		holder[key] = updated;
		changes.push(`- ${pathLabel}: converted ${converted} numeric ${converted === 1 ? "entry" : "entries"} to strings`);
	};
	for (const scope of collectDiscordAccountScopes(next)) for (const ref of collectDiscordIdLists(scope.prefix, scope.account)) repairList(ref.pathLabel, ref.holder, ref.key);
	if (changes.length === 0) return {
		config: cfg,
		changes: []
	};
	return {
		config: next,
		changes
	};
}
function addMutableAllowlistHits(params) {
	if (!Array.isArray(params.list)) return;
	for (const entry of params.list) {
		const text = String(entry).trim();
		if (!text || text === "*") continue;
		if (!params.detector(text)) continue;
		params.hits.push({
			channel: params.channel,
			path: params.pathLabel,
			entry: text,
			dangerousFlagPath: params.dangerousFlagPath
		});
	}
}
function scanMutableAllowlistEntries(cfg) {
	const hits = [];
	for (const scope of collectProviderDangerousNameMatchingScopes(cfg, "discord")) {
		if (scope.dangerousNameMatchingEnabled) continue;
		addMutableAllowlistHits({
			hits,
			pathLabel: `${scope.prefix}.allowFrom`,
			list: scope.account.allowFrom,
			detector: isDiscordMutableAllowEntry,
			channel: "discord",
			dangerousFlagPath: scope.dangerousFlagPath
		});
		const dm = asObjectRecord(scope.account.dm);
		if (dm) addMutableAllowlistHits({
			hits,
			pathLabel: `${scope.prefix}.dm.allowFrom`,
			list: dm.allowFrom,
			detector: isDiscordMutableAllowEntry,
			channel: "discord",
			dangerousFlagPath: scope.dangerousFlagPath
		});
		const guilds = asObjectRecord(scope.account.guilds);
		if (!guilds) continue;
		for (const [guildId, guildRaw] of Object.entries(guilds)) {
			const guild = asObjectRecord(guildRaw);
			if (!guild) continue;
			addMutableAllowlistHits({
				hits,
				pathLabel: `${scope.prefix}.guilds.${guildId}.users`,
				list: guild.users,
				detector: isDiscordMutableAllowEntry,
				channel: "discord",
				dangerousFlagPath: scope.dangerousFlagPath
			});
			const channels = asObjectRecord(guild.channels);
			if (!channels) continue;
			for (const [channelId, channelRaw] of Object.entries(channels)) {
				const channel = asObjectRecord(channelRaw);
				if (!channel) continue;
				addMutableAllowlistHits({
					hits,
					pathLabel: `${scope.prefix}.guilds.${guildId}.channels.${channelId}.users`,
					list: channel.users,
					detector: isDiscordMutableAllowEntry,
					channel: "discord",
					dangerousFlagPath: scope.dangerousFlagPath
				});
			}
		}
	}
	for (const scope of collectProviderDangerousNameMatchingScopes(cfg, "slack")) {
		if (scope.dangerousNameMatchingEnabled) continue;
		addMutableAllowlistHits({
			hits,
			pathLabel: `${scope.prefix}.allowFrom`,
			list: scope.account.allowFrom,
			detector: isSlackMutableAllowEntry,
			channel: "slack",
			dangerousFlagPath: scope.dangerousFlagPath
		});
		const dm = asObjectRecord(scope.account.dm);
		if (dm) addMutableAllowlistHits({
			hits,
			pathLabel: `${scope.prefix}.dm.allowFrom`,
			list: dm.allowFrom,
			detector: isSlackMutableAllowEntry,
			channel: "slack",
			dangerousFlagPath: scope.dangerousFlagPath
		});
		const channels = asObjectRecord(scope.account.channels);
		if (!channels) continue;
		for (const [channelKey, channelRaw] of Object.entries(channels)) {
			const channel = asObjectRecord(channelRaw);
			if (!channel) continue;
			addMutableAllowlistHits({
				hits,
				pathLabel: `${scope.prefix}.channels.${channelKey}.users`,
				list: channel.users,
				detector: isSlackMutableAllowEntry,
				channel: "slack",
				dangerousFlagPath: scope.dangerousFlagPath
			});
		}
	}
	for (const scope of collectProviderDangerousNameMatchingScopes(cfg, "googlechat")) {
		if (scope.dangerousNameMatchingEnabled) continue;
		addMutableAllowlistHits({
			hits,
			pathLabel: `${scope.prefix}.groupAllowFrom`,
			list: scope.account.groupAllowFrom,
			detector: isGoogleChatMutableAllowEntry,
			channel: "googlechat",
			dangerousFlagPath: scope.dangerousFlagPath
		});
		const dm = asObjectRecord(scope.account.dm);
		if (dm) addMutableAllowlistHits({
			hits,
			pathLabel: `${scope.prefix}.dm.allowFrom`,
			list: dm.allowFrom,
			detector: isGoogleChatMutableAllowEntry,
			channel: "googlechat",
			dangerousFlagPath: scope.dangerousFlagPath
		});
		const groups = asObjectRecord(scope.account.groups);
		if (!groups) continue;
		for (const [groupKey, groupRaw] of Object.entries(groups)) {
			const group = asObjectRecord(groupRaw);
			if (!group) continue;
			addMutableAllowlistHits({
				hits,
				pathLabel: `${scope.prefix}.groups.${groupKey}.users`,
				list: group.users,
				detector: isGoogleChatMutableAllowEntry,
				channel: "googlechat",
				dangerousFlagPath: scope.dangerousFlagPath
			});
		}
	}
	for (const scope of collectProviderDangerousNameMatchingScopes(cfg, "msteams")) {
		if (scope.dangerousNameMatchingEnabled) continue;
		addMutableAllowlistHits({
			hits,
			pathLabel: `${scope.prefix}.allowFrom`,
			list: scope.account.allowFrom,
			detector: isMSTeamsMutableAllowEntry,
			channel: "msteams",
			dangerousFlagPath: scope.dangerousFlagPath
		});
		addMutableAllowlistHits({
			hits,
			pathLabel: `${scope.prefix}.groupAllowFrom`,
			list: scope.account.groupAllowFrom,
			detector: isMSTeamsMutableAllowEntry,
			channel: "msteams",
			dangerousFlagPath: scope.dangerousFlagPath
		});
	}
	for (const scope of collectProviderDangerousNameMatchingScopes(cfg, "mattermost")) {
		if (scope.dangerousNameMatchingEnabled) continue;
		addMutableAllowlistHits({
			hits,
			pathLabel: `${scope.prefix}.allowFrom`,
			list: scope.account.allowFrom,
			detector: isMattermostMutableAllowEntry,
			channel: "mattermost",
			dangerousFlagPath: scope.dangerousFlagPath
		});
		addMutableAllowlistHits({
			hits,
			pathLabel: `${scope.prefix}.groupAllowFrom`,
			list: scope.account.groupAllowFrom,
			detector: isMattermostMutableAllowEntry,
			channel: "mattermost",
			dangerousFlagPath: scope.dangerousFlagPath
		});
	}
	for (const scope of collectProviderDangerousNameMatchingScopes(cfg, "irc")) {
		if (scope.dangerousNameMatchingEnabled) continue;
		addMutableAllowlistHits({
			hits,
			pathLabel: `${scope.prefix}.allowFrom`,
			list: scope.account.allowFrom,
			detector: isIrcMutableAllowEntry,
			channel: "irc",
			dangerousFlagPath: scope.dangerousFlagPath
		});
		addMutableAllowlistHits({
			hits,
			pathLabel: `${scope.prefix}.groupAllowFrom`,
			list: scope.account.groupAllowFrom,
			detector: isIrcMutableAllowEntry,
			channel: "irc",
			dangerousFlagPath: scope.dangerousFlagPath
		});
		const groups = asObjectRecord(scope.account.groups);
		if (!groups) continue;
		for (const [groupKey, groupRaw] of Object.entries(groups)) {
			const group = asObjectRecord(groupRaw);
			if (!group) continue;
			addMutableAllowlistHits({
				hits,
				pathLabel: `${scope.prefix}.groups.${groupKey}.allowFrom`,
				list: group.allowFrom,
				detector: isIrcMutableAllowEntry,
				channel: "irc",
				dangerousFlagPath: scope.dangerousFlagPath
			});
		}
	}
	return hits;
}
/**
* Scan all channel configs for dmPolicy="open" without allowFrom including "*".
* This configuration is rejected by the schema validator but can easily occur when
* users (or integrations) set dmPolicy to "open" without realising that an explicit
* allowFrom wildcard is also required.
*/
function maybeRepairOpenPolicyAllowFrom(cfg) {
	const channels = cfg.channels;
	if (!channels || typeof channels !== "object") return {
		config: cfg,
		changes: []
	};
	const next = structuredClone(cfg);
	const changes = [];
	const resolveAllowFromMode = (channelName) => {
		if (channelName === "googlechat") return "nestedOnly";
		if (channelName === "discord" || channelName === "slack") return "topOrNested";
		return "topOnly";
	};
	const hasWildcard = (list) => list?.some((v) => String(v).trim() === "*") ?? false;
	const ensureWildcard = (account, prefix, mode) => {
		const dmEntry = account.dm;
		const dm = dmEntry && typeof dmEntry === "object" && !Array.isArray(dmEntry) ? dmEntry : void 0;
		if ((account.dmPolicy ?? dm?.policy ?? void 0) !== "open") return;
		const topAllowFrom = account.allowFrom;
		const nestedAllowFrom = dm?.allowFrom;
		if (mode === "nestedOnly") {
			if (hasWildcard(nestedAllowFrom)) return;
			if (Array.isArray(nestedAllowFrom)) {
				nestedAllowFrom.push("*");
				changes.push(`- ${prefix}.dm.allowFrom: added "*" (required by dmPolicy="open")`);
				return;
			}
			const nextDm = dm ?? {};
			nextDm.allowFrom = ["*"];
			account.dm = nextDm;
			changes.push(`- ${prefix}.dm.allowFrom: set to ["*"] (required by dmPolicy="open")`);
			return;
		}
		if (mode === "topOrNested") {
			if (hasWildcard(topAllowFrom) || hasWildcard(nestedAllowFrom)) return;
			if (Array.isArray(topAllowFrom)) {
				topAllowFrom.push("*");
				changes.push(`- ${prefix}.allowFrom: added "*" (required by dmPolicy="open")`);
			} else if (Array.isArray(nestedAllowFrom)) {
				nestedAllowFrom.push("*");
				changes.push(`- ${prefix}.dm.allowFrom: added "*" (required by dmPolicy="open")`);
			} else {
				account.allowFrom = ["*"];
				changes.push(`- ${prefix}.allowFrom: set to ["*"] (required by dmPolicy="open")`);
			}
			return;
		}
		if (hasWildcard(topAllowFrom)) return;
		if (Array.isArray(topAllowFrom)) {
			topAllowFrom.push("*");
			changes.push(`- ${prefix}.allowFrom: added "*" (required by dmPolicy="open")`);
		} else {
			account.allowFrom = ["*"];
			changes.push(`- ${prefix}.allowFrom: set to ["*"] (required by dmPolicy="open")`);
		}
	};
	const nextChannels = next.channels;
	for (const [channelName, channelConfig] of Object.entries(nextChannels)) {
		if (!channelConfig || typeof channelConfig !== "object") continue;
		const allowFromMode = resolveAllowFromMode(channelName);
		ensureWildcard(channelConfig, `channels.${channelName}`, allowFromMode);
		const accounts = channelConfig.accounts;
		if (accounts && typeof accounts === "object") {
			for (const [accountName, accountConfig] of Object.entries(accounts)) if (accountConfig && typeof accountConfig === "object") ensureWildcard(accountConfig, `channels.${channelName}.accounts.${accountName}`, allowFromMode);
		}
	}
	if (changes.length === 0) return {
		config: cfg,
		changes: []
	};
	return {
		config: next,
		changes
	};
}
function hasAllowFromEntries(list) {
	return Array.isArray(list) && list.map((v) => String(v).trim()).filter(Boolean).length > 0;
}
async function maybeRepairAllowlistPolicyAllowFrom(cfg) {
	const channels = cfg.channels;
	if (!channels || typeof channels !== "object") return {
		config: cfg,
		changes: []
	};
	const resolveAllowFromMode = (channelName) => {
		if (channelName === "googlechat") return "nestedOnly";
		if (channelName === "discord" || channelName === "slack") return "topOrNested";
		return "topOnly";
	};
	const next = structuredClone(cfg);
	const changes = [];
	const applyRecoveredAllowFrom = (params) => {
		const count = params.allowFrom.length;
		const noun = count === 1 ? "entry" : "entries";
		if (params.mode === "nestedOnly") {
			const dmEntry = params.account.dm;
			const dm = dmEntry && typeof dmEntry === "object" && !Array.isArray(dmEntry) ? dmEntry : {};
			dm.allowFrom = params.allowFrom;
			params.account.dm = dm;
			changes.push(`- ${params.prefix}.dm.allowFrom: restored ${count} sender ${noun} from pairing store (dmPolicy="allowlist").`);
			return;
		}
		if (params.mode === "topOrNested") {
			const dmEntry = params.account.dm;
			const dm = dmEntry && typeof dmEntry === "object" && !Array.isArray(dmEntry) ? dmEntry : void 0;
			const nestedAllowFrom = dm?.allowFrom;
			if (dm && !Array.isArray(params.account.allowFrom) && Array.isArray(nestedAllowFrom)) {
				dm.allowFrom = params.allowFrom;
				changes.push(`- ${params.prefix}.dm.allowFrom: restored ${count} sender ${noun} from pairing store (dmPolicy="allowlist").`);
				return;
			}
		}
		params.account.allowFrom = params.allowFrom;
		changes.push(`- ${params.prefix}.allowFrom: restored ${count} sender ${noun} from pairing store (dmPolicy="allowlist").`);
	};
	const recoverAllowFromForAccount = async (params) => {
		const dmEntry = params.account.dm;
		const dm = dmEntry && typeof dmEntry === "object" && !Array.isArray(dmEntry) ? dmEntry : void 0;
		if ((params.account.dmPolicy ?? dm?.policy) !== "allowlist") return;
		const topAllowFrom = params.account.allowFrom;
		const nestedAllowFrom = dm?.allowFrom;
		if (hasAllowFromEntries(topAllowFrom) || hasAllowFromEntries(nestedAllowFrom)) return;
		const normalizedChannelId = (normalizeChatChannelId(params.channelName) ?? params.channelName).trim().toLowerCase();
		if (!normalizedChannelId) return;
		const normalizedAccountId = normalizeAccountId(params.accountId) || DEFAULT_ACCOUNT_ID;
		const fromStore = await readChannelAllowFromStore(normalizedChannelId, process.env, normalizedAccountId).catch(() => []);
		const recovered = Array.from(new Set(fromStore.map((entry) => String(entry).trim()))).filter(Boolean);
		if (recovered.length === 0) return;
		applyRecoveredAllowFrom({
			account: params.account,
			allowFrom: recovered,
			mode: resolveAllowFromMode(params.channelName),
			prefix: params.prefix
		});
	};
	const nextChannels = next.channels;
	for (const [channelName, channelConfig] of Object.entries(nextChannels)) {
		if (!channelConfig || typeof channelConfig !== "object") continue;
		await recoverAllowFromForAccount({
			channelName,
			account: channelConfig,
			prefix: `channels.${channelName}`
		});
		const accounts = channelConfig.accounts;
		if (!accounts || typeof accounts !== "object") continue;
		for (const [accountId, accountConfig] of Object.entries(accounts)) {
			if (!accountConfig || typeof accountConfig !== "object") continue;
			await recoverAllowFromForAccount({
				channelName,
				account: accountConfig,
				accountId,
				prefix: `channels.${channelName}.accounts.${accountId}`
			});
		}
	}
	if (changes.length === 0) return {
		config: cfg,
		changes: []
	};
	return {
		config: next,
		changes
	};
}
/**
* Scan all channel configs for dmPolicy="allowlist" without any allowFrom entries.
* This configuration blocks all DMs because no sender can match the empty
* allowlist. Common after upgrades that remove external allowlist
* file support.
*/
function detectEmptyAllowlistPolicy(cfg) {
	const channels = cfg.channels;
	if (!channels || typeof channels !== "object") return [];
	const warnings = [];
	const usesSenderBasedGroupAllowlist = (channelName) => {
		if (!channelName) return true;
		return !(channelName === "discord" || channelName === "slack" || channelName === "googlechat");
	};
	const allowsGroupAllowFromFallback = (channelName) => {
		if (!channelName) return true;
		return !(channelName === "googlechat" || channelName === "imessage" || channelName === "matrix" || channelName === "msteams" || channelName === "irc");
	};
	const checkAccount = (account, prefix, parent, channelName) => {
		const dmEntry = account.dm;
		const dm = dmEntry && typeof dmEntry === "object" && !Array.isArray(dmEntry) ? dmEntry : void 0;
		const parentDmEntry = parent?.dm;
		const parentDm = parentDmEntry && typeof parentDmEntry === "object" && !Array.isArray(parentDmEntry) ? parentDmEntry : void 0;
		const dmPolicy = account.dmPolicy ?? dm?.policy ?? parent?.dmPolicy ?? parentDm?.policy ?? void 0;
		const topAllowFrom = account.allowFrom ?? parent?.allowFrom;
		const nestedAllowFrom = dm?.allowFrom;
		const parentNestedAllowFrom = parentDm?.allowFrom;
		const effectiveAllowFrom = topAllowFrom ?? nestedAllowFrom ?? parentNestedAllowFrom;
		if (dmPolicy === "allowlist" && !hasAllowFromEntries(effectiveAllowFrom)) warnings.push(`- ${prefix}.dmPolicy is "allowlist" but allowFrom is empty — all DMs will be blocked. Add sender IDs to ${prefix}.allowFrom, or run "${formatCliCommand("openclaw doctor --fix")}" to auto-migrate from pairing store when entries exist.`);
		if ((account.groupPolicy ?? parent?.groupPolicy ?? void 0) === "allowlist" && usesSenderBasedGroupAllowlist(channelName)) {
			const rawGroupAllowFrom = account.groupAllowFrom ?? parent?.groupAllowFrom;
			const groupAllowFrom = hasAllowFromEntries(rawGroupAllowFrom) ? rawGroupAllowFrom : void 0;
			const fallbackToAllowFrom = allowsGroupAllowFromFallback(channelName);
			if (!hasAllowFromEntries(groupAllowFrom ?? (fallbackToAllowFrom ? effectiveAllowFrom : void 0))) if (fallbackToAllowFrom) warnings.push(`- ${prefix}.groupPolicy is "allowlist" but groupAllowFrom (and allowFrom) is empty — all group messages will be silently dropped. Add sender IDs to ${prefix}.groupAllowFrom or ${prefix}.allowFrom, or set groupPolicy to "open".`);
			else warnings.push(`- ${prefix}.groupPolicy is "allowlist" but groupAllowFrom is empty — this channel does not fall back to allowFrom, so all group messages will be silently dropped. Add sender IDs to ${prefix}.groupAllowFrom, or set groupPolicy to "open".`);
		}
	};
	for (const [channelName, channelConfig] of Object.entries(channels)) {
		if (!channelConfig || typeof channelConfig !== "object") continue;
		checkAccount(channelConfig, `channels.${channelName}`, void 0, channelName);
		const accounts = channelConfig.accounts;
		if (accounts && typeof accounts === "object") for (const [accountId, account] of Object.entries(accounts)) {
			if (!account || typeof account !== "object") continue;
			checkAccount(account, `channels.${channelName}.accounts.${accountId}`, channelConfig, channelName);
		}
	}
	return warnings;
}
function normalizeConfiguredSafeBins(entries) {
	if (!Array.isArray(entries)) return [];
	return Array.from(new Set(entries.map((entry) => typeof entry === "string" ? entry.trim().toLowerCase() : "").filter((entry) => entry.length > 0))).toSorted();
}
function normalizeConfiguredTrustedSafeBinDirs(entries) {
	if (!Array.isArray(entries)) return [];
	return normalizeTrustedSafeBinDirs(entries.filter((entry) => typeof entry === "string"));
}
function collectExecSafeBinScopes(cfg) {
	const scopes = [];
	const globalExec = asObjectRecord(cfg.tools?.exec);
	const globalTrustedDirs = normalizeConfiguredTrustedSafeBinDirs(globalExec?.safeBinTrustedDirs);
	if (globalExec) {
		const safeBins = normalizeConfiguredSafeBins(globalExec.safeBins);
		if (safeBins.length > 0) scopes.push({
			scopePath: "tools.exec",
			safeBins,
			exec: globalExec,
			mergedProfiles: resolveMergedSafeBinProfileFixtures({ global: globalExec }) ?? {},
			trustedSafeBinDirs: getTrustedSafeBinDirs({ extraDirs: globalTrustedDirs })
		});
	}
	const agents = Array.isArray(cfg.agents?.list) ? cfg.agents.list : [];
	for (const agent of agents) {
		if (!agent || typeof agent !== "object" || typeof agent.id !== "string") continue;
		const agentExec = asObjectRecord(agent.tools?.exec);
		if (!agentExec) continue;
		const safeBins = normalizeConfiguredSafeBins(agentExec.safeBins);
		if (safeBins.length === 0) continue;
		scopes.push({
			scopePath: `agents.list.${agent.id}.tools.exec`,
			safeBins,
			exec: agentExec,
			mergedProfiles: resolveMergedSafeBinProfileFixtures({
				global: globalExec,
				local: agentExec
			}) ?? {},
			trustedSafeBinDirs: getTrustedSafeBinDirs({ extraDirs: [...globalTrustedDirs, ...normalizeConfiguredTrustedSafeBinDirs(agentExec.safeBinTrustedDirs)] })
		});
	}
	return scopes;
}
function scanExecSafeBinCoverage(cfg) {
	const hits = [];
	for (const scope of collectExecSafeBinScopes(cfg)) {
		const interpreterBins = new Set(listInterpreterLikeSafeBins(scope.safeBins));
		for (const bin of scope.safeBins) {
			if (scope.mergedProfiles[bin]) continue;
			hits.push({
				scopePath: scope.scopePath,
				bin,
				isInterpreter: interpreterBins.has(bin)
			});
		}
	}
	return hits;
}
function scanExecSafeBinTrustedDirHints(cfg) {
	const hits = [];
	for (const scope of collectExecSafeBinScopes(cfg)) for (const bin of scope.safeBins) {
		const resolution = resolveCommandResolutionFromArgv([bin]);
		if (!resolution?.resolvedPath) continue;
		if (isTrustedSafeBinPath({
			resolvedPath: resolution.resolvedPath,
			trustedDirs: scope.trustedSafeBinDirs
		})) continue;
		hits.push({
			scopePath: scope.scopePath,
			bin,
			resolvedPath: resolution.resolvedPath
		});
	}
	return hits;
}
function maybeRepairExecSafeBinProfiles(cfg) {
	const next = structuredClone(cfg);
	const changes = [];
	const warnings = [];
	for (const scope of collectExecSafeBinScopes(next)) {
		const interpreterBins = new Set(listInterpreterLikeSafeBins(scope.safeBins));
		const missingBins = scope.safeBins.filter((bin) => !scope.mergedProfiles[bin]);
		if (missingBins.length === 0) continue;
		const profileHolder = asObjectRecord(scope.exec.safeBinProfiles) ?? (scope.exec.safeBinProfiles = {});
		for (const bin of missingBins) {
			if (interpreterBins.has(bin)) {
				warnings.push(`- ${scope.scopePath}.safeBins includes interpreter/runtime '${bin}' without profile; remove it from safeBins or use explicit allowlist entries.`);
				continue;
			}
			if (profileHolder[bin] !== void 0) continue;
			profileHolder[bin] = {};
			changes.push(`- ${scope.scopePath}.safeBinProfiles.${bin}: added scaffold profile {} (review and tighten flags/positionals).`);
		}
	}
	if (changes.length === 0 && warnings.length === 0) return {
		config: cfg,
		changes: [],
		warnings: []
	};
	return {
		config: next,
		changes,
		warnings
	};
}
function collectLegacyToolsBySenderKeyHits(value, pathParts, hits) {
	if (Array.isArray(value)) {
		for (const [index, entry] of value.entries()) collectLegacyToolsBySenderKeyHits(entry, [...pathParts, index], hits);
		return;
	}
	const record = asObjectRecord(value);
	if (!record) return;
	const toolsBySender = asObjectRecord(record.toolsBySender);
	if (toolsBySender) {
		const path = [...pathParts, "toolsBySender"];
		const pathLabel = formatPath(path);
		for (const rawKey of Object.keys(toolsBySender)) {
			const trimmed = rawKey.trim();
			if (!trimmed || trimmed === "*" || parseToolsBySenderTypedKey(trimmed)) continue;
			hits.push({
				toolsBySenderPath: path,
				pathLabel,
				key: rawKey,
				targetKey: `id:${trimmed}`
			});
		}
	}
	for (const [key, nested] of Object.entries(record)) {
		if (key === "toolsBySender") continue;
		collectLegacyToolsBySenderKeyHits(nested, [...pathParts, key], hits);
	}
}
function scanLegacyToolsBySenderKeys(cfg) {
	const hits = [];
	collectLegacyToolsBySenderKeyHits(cfg, [], hits);
	return hits;
}
function maybeRepairLegacyToolsBySenderKeys(cfg) {
	const next = structuredClone(cfg);
	const hits = scanLegacyToolsBySenderKeys(next);
	if (hits.length === 0) return {
		config: cfg,
		changes: []
	};
	const summary = /* @__PURE__ */ new Map();
	let changed = false;
	for (const hit of hits) {
		const toolsBySender = asObjectRecord(resolvePathTarget(next, hit.toolsBySenderPath));
		if (!toolsBySender || !(hit.key in toolsBySender)) continue;
		const row = summary.get(hit.pathLabel) ?? {
			migrated: 0,
			dropped: 0,
			examples: []
		};
		if (toolsBySender[hit.targetKey] === void 0) {
			toolsBySender[hit.targetKey] = toolsBySender[hit.key];
			row.migrated++;
			if (row.examples.length < 3) row.examples.push(`${hit.key} -> ${hit.targetKey}`);
		} else {
			row.dropped++;
			if (row.examples.length < 3) row.examples.push(`${hit.key} (kept existing ${hit.targetKey})`);
		}
		delete toolsBySender[hit.key];
		summary.set(hit.pathLabel, row);
		changed = true;
	}
	if (!changed) return {
		config: cfg,
		changes: []
	};
	const changes = [];
	for (const [pathLabel, row] of summary) {
		if (row.migrated > 0) {
			const suffix = row.examples.length > 0 ? ` (${row.examples.join(", ")})` : "";
			changes.push(`- ${pathLabel}: migrated ${row.migrated} legacy key${row.migrated === 1 ? "" : "s"} to typed id: entries${suffix}.`);
		}
		if (row.dropped > 0) changes.push(`- ${pathLabel}: removed ${row.dropped} legacy key${row.dropped === 1 ? "" : "s"} where typed id: entries already existed.`);
	}
	return {
		config: next,
		changes
	};
}
async function maybeMigrateLegacyConfig() {
	const changes = [];
	const home = resolveHomeDir();
	if (!home) return changes;
	const targetDir = path.join(home, ".openclaw");
	const targetPath = path.join(targetDir, "openclaw.json");
	try {
		await fs$1.access(targetPath);
		return changes;
	} catch {}
	const legacyCandidates = [
		path.join(home, ".clawdbot", "clawdbot.json"),
		path.join(home, ".moldbot", "moldbot.json"),
		path.join(home, ".moltbot", "moltbot.json")
	];
	let legacyPath = null;
	for (const candidate of legacyCandidates) try {
		await fs$1.access(candidate);
		legacyPath = candidate;
		break;
	} catch {}
	if (!legacyPath) return changes;
	await fs$1.mkdir(targetDir, { recursive: true });
	try {
		await fs$1.copyFile(legacyPath, targetPath, fs$1.constants.COPYFILE_EXCL);
		changes.push(`Migrated legacy config: ${legacyPath} -> ${targetPath}`);
	} catch {}
	return changes;
}
async function loadAndMaybeMigrateDoctorConfig(params) {
	const shouldRepair = params.options.repair === true || params.options.yes === true;
	const stateDirResult = await autoMigrateLegacyStateDir({ env: process.env });
	if (stateDirResult.changes.length > 0) note(stateDirResult.changes.map((entry) => `- ${entry}`).join("\n"), "Doctor changes");
	if (stateDirResult.warnings.length > 0) note(stateDirResult.warnings.map((entry) => `- ${entry}`).join("\n"), "Doctor warnings");
	const legacyConfigChanges = await maybeMigrateLegacyConfig();
	if (legacyConfigChanges.length > 0) note(legacyConfigChanges.map((entry) => `- ${entry}`).join("\n"), "Doctor changes");
	let snapshot = await readConfigFileSnapshot();
	const baseCfg = snapshot.config ?? {};
	let cfg = baseCfg;
	let candidate = structuredClone(baseCfg);
	let pendingChanges = false;
	let shouldWriteConfig = false;
	const fixHints = [];
	if (snapshot.exists && !snapshot.valid && snapshot.legacyIssues.length === 0) {
		note("Config invalid; doctor will run with best-effort config.", "Config");
		noteIncludeConfinementWarning(snapshot);
	}
	const warnings = snapshot.warnings ?? [];
	if (warnings.length > 0) note(warnings.map((issue) => `- ${issue.path}: ${issue.message}`).join("\n"), "Config warnings");
	if (snapshot.legacyIssues.length > 0) {
		note(snapshot.legacyIssues.map((issue) => `- ${issue.path}: ${issue.message}`).join("\n"), "Compatibility config keys detected");
		const { config: migrated, changes } = migrateLegacyConfig(snapshot.parsed);
		if (changes.length > 0) note(changes.join("\n"), "Doctor changes");
		if (migrated) {
			candidate = migrated;
			pendingChanges = pendingChanges || changes.length > 0;
		}
		if (shouldRepair) {
			if (migrated) cfg = migrated;
		} else fixHints.push(`Run "${formatCliCommand("openclaw doctor --fix")}" to apply compatibility migrations.`);
	}
	const normalized = normalizeCompatibilityConfigValues(candidate);
	if (normalized.changes.length > 0) {
		note(normalized.changes.join("\n"), "Doctor changes");
		candidate = normalized.config;
		pendingChanges = true;
		if (shouldRepair) cfg = normalized.config;
		else fixHints.push(`Run "${formatCliCommand("openclaw doctor --fix")}" to apply these changes.`);
	}
	const autoEnable = applyPluginAutoEnable({
		config: candidate,
		env: process.env
	});
	if (autoEnable.changes.length > 0) {
		note(autoEnable.changes.join("\n"), "Doctor changes");
		candidate = autoEnable.config;
		pendingChanges = true;
		if (shouldRepair) cfg = autoEnable.config;
		else fixHints.push(`Run "${formatCliCommand("openclaw doctor --fix")}" to apply these changes.`);
	}
	const missingDefaultAccountBindingWarnings = collectMissingDefaultAccountBindingWarnings(candidate);
	if (missingDefaultAccountBindingWarnings.length > 0) note(missingDefaultAccountBindingWarnings.join("\n"), "Doctor warnings");
	if (shouldRepair) {
		const repair = await maybeRepairTelegramAllowFromUsernames(candidate);
		if (repair.changes.length > 0) {
			note(repair.changes.join("\n"), "Doctor changes");
			candidate = repair.config;
			pendingChanges = true;
			cfg = repair.config;
		}
		const discordRepair = maybeRepairDiscordNumericIds(candidate);
		if (discordRepair.changes.length > 0) {
			note(discordRepair.changes.join("\n"), "Doctor changes");
			candidate = discordRepair.config;
			pendingChanges = true;
			cfg = discordRepair.config;
		}
		const allowFromRepair = maybeRepairOpenPolicyAllowFrom(candidate);
		if (allowFromRepair.changes.length > 0) {
			note(allowFromRepair.changes.join("\n"), "Doctor changes");
			candidate = allowFromRepair.config;
			pendingChanges = true;
			cfg = allowFromRepair.config;
		}
		const allowlistRepair = await maybeRepairAllowlistPolicyAllowFrom(candidate);
		if (allowlistRepair.changes.length > 0) {
			note(allowlistRepair.changes.join("\n"), "Doctor changes");
			candidate = allowlistRepair.config;
			pendingChanges = true;
			cfg = allowlistRepair.config;
		}
		const emptyAllowlistWarnings = detectEmptyAllowlistPolicy(candidate);
		if (emptyAllowlistWarnings.length > 0) note(emptyAllowlistWarnings.join("\n"), "Doctor warnings");
		const toolsBySenderRepair = maybeRepairLegacyToolsBySenderKeys(candidate);
		if (toolsBySenderRepair.changes.length > 0) {
			note(toolsBySenderRepair.changes.join("\n"), "Doctor changes");
			candidate = toolsBySenderRepair.config;
			pendingChanges = true;
			cfg = toolsBySenderRepair.config;
		}
		const safeBinProfileRepair = maybeRepairExecSafeBinProfiles(candidate);
		if (safeBinProfileRepair.changes.length > 0) {
			note(safeBinProfileRepair.changes.join("\n"), "Doctor changes");
			candidate = safeBinProfileRepair.config;
			pendingChanges = true;
			cfg = safeBinProfileRepair.config;
		}
		if (safeBinProfileRepair.warnings.length > 0) note(safeBinProfileRepair.warnings.join("\n"), "Doctor warnings");
	} else {
		const hits = scanTelegramAllowFromUsernameEntries(candidate);
		if (hits.length > 0) note([`- Telegram allowFrom contains ${hits.length} non-numeric entries (e.g. ${hits[0]?.entry ?? "@"}); Telegram authorization requires numeric sender IDs.`, `- Run "${formatCliCommand("openclaw doctor --fix")}" to auto-resolve @username entries to numeric IDs (requires a Telegram bot token).`].join("\n"), "Doctor warnings");
		const discordHits = scanDiscordNumericIdEntries(candidate);
		if (discordHits.length > 0) note([`- Discord allowlists contain ${discordHits.length} numeric entries (e.g. ${discordHits[0]?.path}=${discordHits[0]?.entry}).`, `- Discord IDs must be strings; run "${formatCliCommand("openclaw doctor --fix")}" to convert numeric IDs to quoted strings.`].join("\n"), "Doctor warnings");
		const allowFromScan = maybeRepairOpenPolicyAllowFrom(candidate);
		if (allowFromScan.changes.length > 0) note([...allowFromScan.changes, `- Run "${formatCliCommand("openclaw doctor --fix")}" to add missing allowFrom wildcards.`].join("\n"), "Doctor warnings");
		const emptyAllowlistWarnings = detectEmptyAllowlistPolicy(candidate);
		if (emptyAllowlistWarnings.length > 0) note(emptyAllowlistWarnings.join("\n"), "Doctor warnings");
		const toolsBySenderHits = scanLegacyToolsBySenderKeys(candidate);
		if (toolsBySenderHits.length > 0) {
			const sample = toolsBySenderHits[0];
			const sampleLabel = sample ? `${sample.pathLabel}.${sample.key}` : "toolsBySender";
			note([
				`- Found ${toolsBySenderHits.length} legacy untyped toolsBySender key${toolsBySenderHits.length === 1 ? "" : "s"} (for example ${sampleLabel}).`,
				"- Untyped sender keys are deprecated; use explicit prefixes (id:, e164:, username:, name:).",
				`- Run "${formatCliCommand("openclaw doctor --fix")}" to migrate legacy keys to typed id: entries.`
			].join("\n"), "Doctor warnings");
		}
		const safeBinCoverage = scanExecSafeBinCoverage(candidate);
		if (safeBinCoverage.length > 0) {
			const interpreterHits = safeBinCoverage.filter((hit) => hit.isInterpreter);
			const customHits = safeBinCoverage.filter((hit) => !hit.isInterpreter);
			const lines = [];
			if (interpreterHits.length > 0) {
				for (const hit of interpreterHits.slice(0, 5)) lines.push(`- ${hit.scopePath}.safeBins includes interpreter/runtime '${hit.bin}' without profile.`);
				if (interpreterHits.length > 5) lines.push(`- ${interpreterHits.length - 5} more interpreter/runtime safeBins entries are missing profiles.`);
			}
			if (customHits.length > 0) {
				for (const hit of customHits.slice(0, 5)) lines.push(`- ${hit.scopePath}.safeBins entry '${hit.bin}' is missing safeBinProfiles.${hit.bin}.`);
				if (customHits.length > 5) lines.push(`- ${customHits.length - 5} more custom safeBins entries are missing profiles.`);
			}
			lines.push(`- Run "${formatCliCommand("openclaw doctor --fix")}" to scaffold missing custom safeBinProfiles entries.`);
			note(lines.join("\n"), "Doctor warnings");
		}
		const safeBinTrustedDirHints = scanExecSafeBinTrustedDirHints(candidate);
		if (safeBinTrustedDirHints.length > 0) {
			const lines = safeBinTrustedDirHints.slice(0, 5).map((hit) => `- ${hit.scopePath}.safeBins entry '${hit.bin}' resolves to '${hit.resolvedPath}' outside trusted safe-bin dirs.`);
			if (safeBinTrustedDirHints.length > 5) lines.push(`- ${safeBinTrustedDirHints.length - 5} more safeBins entries resolve outside trusted safe-bin dirs.`);
			lines.push("- If intentional, add the binary directory to tools.exec.safeBinTrustedDirs (global or agent scope).");
			note(lines.join("\n"), "Doctor warnings");
		}
	}
	const mutableAllowlistHits = scanMutableAllowlistEntries(candidate);
	if (mutableAllowlistHits.length > 0) {
		const channels = Array.from(new Set(mutableAllowlistHits.map((hit) => hit.channel))).toSorted();
		const exampleLines = mutableAllowlistHits.slice(0, 8).map((hit) => `- ${hit.path}: ${hit.entry}`).join("\n");
		const remaining = mutableAllowlistHits.length > 8 ? `- +${mutableAllowlistHits.length - 8} more mutable allowlist entries.` : null;
		const flagPaths = Array.from(new Set(mutableAllowlistHits.map((hit) => hit.dangerousFlagPath)));
		const flagHint = flagPaths.length === 1 ? flagPaths[0] : `${flagPaths[0]} (and ${flagPaths.length - 1} other scope flags)`;
		note([
			`- Found ${mutableAllowlistHits.length} mutable allowlist ${mutableAllowlistHits.length === 1 ? "entry" : "entries"} across ${channels.join(", ")} while name matching is disabled by default.`,
			exampleLines,
			...remaining ? [remaining] : [],
			`- Option A (break-glass): enable ${flagHint}=true to keep name/email/nick matching.`,
			"- Option B (recommended): resolve names/emails/nicks to stable sender IDs and rewrite the allowlist entries."
		].join("\n"), "Doctor warnings");
	}
	const unknown = stripUnknownConfigKeys(candidate);
	if (unknown.removed.length > 0) {
		const lines = unknown.removed.map((path) => `- ${path}`).join("\n");
		candidate = unknown.config;
		pendingChanges = true;
		if (shouldRepair) {
			cfg = unknown.config;
			note(lines, "Doctor changes");
		} else {
			note(lines, "Unknown config keys");
			fixHints.push("Run \"openclaw doctor --fix\" to remove these keys.");
		}
	}
	if (!shouldRepair && pendingChanges) {
		if (await params.confirm({
			message: "Apply recommended config repairs now?",
			initialValue: true
		})) {
			cfg = candidate;
			shouldWriteConfig = true;
		} else if (fixHints.length > 0) note(fixHints.join("\n"), "Doctor");
	}
	if (shouldRepair && pendingChanges) shouldWriteConfig = true;
	noteOpencodeProviderOverrides(cfg);
	return {
		cfg,
		path: snapshot.path ?? CONFIG_PATH,
		shouldWriteConfig,
		sourceConfigValid: snapshot.valid
	};
}

//#endregion
export { detectLegacyStateMigrations as n, runLegacyStateMigrations as r, loadAndMaybeMigrateDoctorConfig as t };