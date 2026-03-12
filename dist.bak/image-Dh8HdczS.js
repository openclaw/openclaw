import { t as __exportAll } from "./rolldown-runtime-Cbj13DAv.js";
import { G as resolveAgentModelPrimaryValue, W as resolveAgentModelFallbackValues } from "./agent-scope-CSkwQImO.js";
import { M as isRecord, V as shortenHomeInString } from "./subsystem-B3k5RmW0.js";
import { L as loadConfig, S as getApiKeyForModel, _ as resolveImplicitBedrockProvider, _n as normalizeSecretInput, fn as resolveOpenClawAgentDir, g as normalizeProviders, v as resolveImplicitCopilotProvider, w as requireApiKey, y as resolveImplicitProviders } from "./model-selection-aaCyoEgM.js";
import { n as discoverModels, t as discoverAuthStorage } from "./pi-model-discovery-B_t1owo2.js";
import { P as sanitizeUserFacingText } from "./pi-embedded-helpers-CXxSKQAW.js";
import { n as redactToolDetail } from "./redact-DfkHGMkU.js";
import path from "node:path";
import fs from "node:fs/promises";
import { complete } from "@mariozechner/pi-ai";

//#region src/agents/models-config.ts
const DEFAULT_MODE = "merge";
function resolvePreferredTokenLimit(explicitValue, implicitValue) {
	return explicitValue > implicitValue ? explicitValue : implicitValue;
}
function mergeProviderModels(implicit, explicit) {
	const implicitModels = Array.isArray(implicit.models) ? implicit.models : [];
	const explicitModels = Array.isArray(explicit.models) ? explicit.models : [];
	if (implicitModels.length === 0) return {
		...implicit,
		...explicit
	};
	const getId = (model) => {
		if (!model || typeof model !== "object") return "";
		const id = model.id;
		return typeof id === "string" ? id.trim() : "";
	};
	const implicitById = new Map(implicitModels.map((model) => [getId(model), model]).filter(([id]) => Boolean(id)));
	const seen = /* @__PURE__ */ new Set();
	const mergedModels = explicitModels.map((explicitModel) => {
		const id = getId(explicitModel);
		if (!id) return explicitModel;
		seen.add(id);
		const implicitModel = implicitById.get(id);
		if (!implicitModel) return explicitModel;
		return {
			...explicitModel,
			input: implicitModel.input,
			reasoning: "reasoning" in explicitModel ? explicitModel.reasoning : implicitModel.reasoning,
			contextWindow: resolvePreferredTokenLimit(explicitModel.contextWindow, implicitModel.contextWindow),
			maxTokens: resolvePreferredTokenLimit(explicitModel.maxTokens, implicitModel.maxTokens)
		};
	});
	for (const implicitModel of implicitModels) {
		const id = getId(implicitModel);
		if (!id || seen.has(id)) continue;
		seen.add(id);
		mergedModels.push(implicitModel);
	}
	return {
		...implicit,
		...explicit,
		models: mergedModels
	};
}
function mergeProviders(params) {
	const out = params.implicit ? { ...params.implicit } : {};
	for (const [key, explicit] of Object.entries(params.explicit ?? {})) {
		const providerKey = key.trim();
		if (!providerKey) continue;
		const implicit = out[providerKey];
		out[providerKey] = implicit ? mergeProviderModels(implicit, explicit) : explicit;
	}
	return out;
}
async function readJson(pathname) {
	try {
		const raw = await fs.readFile(pathname, "utf8");
		return JSON.parse(raw);
	} catch {
		return null;
	}
}
async function ensureOpenClawModelsJson(config, agentDirOverride) {
	const cfg = config ?? loadConfig();
	const agentDir = agentDirOverride?.trim() ? agentDirOverride.trim() : resolveOpenClawAgentDir();
	const explicitProviders = cfg.models?.providers ?? {};
	const providers = mergeProviders({
		implicit: await resolveImplicitProviders({
			agentDir,
			explicitProviders
		}),
		explicit: explicitProviders
	});
	const implicitBedrock = await resolveImplicitBedrockProvider({
		agentDir,
		config: cfg
	});
	if (implicitBedrock) {
		const existing = providers["amazon-bedrock"];
		providers["amazon-bedrock"] = existing ? mergeProviderModels(implicitBedrock, existing) : implicitBedrock;
	}
	const implicitCopilot = await resolveImplicitCopilotProvider({ agentDir });
	if (implicitCopilot && !providers["github-copilot"]) providers["github-copilot"] = implicitCopilot;
	if (Object.keys(providers).length === 0) return {
		agentDir,
		wrote: false
	};
	const mode = cfg.models?.mode ?? DEFAULT_MODE;
	const targetPath = path.join(agentDir, "models.json");
	let mergedProviders = providers;
	let existingRaw = "";
	if (mode === "merge") {
		const existing = await readJson(targetPath);
		if (isRecord(existing) && isRecord(existing.providers)) {
			const existingProviders = existing.providers;
			mergedProviders = {};
			for (const [key, entry] of Object.entries(existingProviders)) mergedProviders[key] = entry;
			for (const [key, newEntry] of Object.entries(providers)) {
				const existing = existingProviders[key];
				if (existing) {
					const preserved = {};
					if (typeof existing.apiKey === "string" && existing.apiKey) preserved.apiKey = existing.apiKey;
					if (typeof existing.baseUrl === "string" && existing.baseUrl) preserved.baseUrl = existing.baseUrl;
					mergedProviders[key] = {
						...newEntry,
						...preserved
					};
				} else mergedProviders[key] = newEntry;
			}
		}
	}
	const normalizedProviders = normalizeProviders({
		providers: mergedProviders,
		agentDir
	});
	const next = `${JSON.stringify({ providers: normalizedProviders }, null, 2)}\n`;
	try {
		existingRaw = await fs.readFile(targetPath, "utf8");
	} catch {
		existingRaw = "";
	}
	if (existingRaw === next) return {
		agentDir,
		wrote: false
	};
	await fs.mkdir(agentDir, {
		recursive: true,
		mode: 448
	});
	await fs.writeFile(targetPath, next, { mode: 384 });
	return {
		agentDir,
		wrote: true
	};
}

//#endregion
//#region src/shared/chat-content.ts
function extractTextFromChatContent(content, opts) {
	const normalize = opts?.normalizeText ?? ((text) => text.replace(/\s+/g, " ").trim());
	const joinWith = opts?.joinWith ?? " ";
	if (typeof content === "string") {
		const normalized = normalize(opts?.sanitizeText ? opts.sanitizeText(content) : content);
		return normalized ? normalized : null;
	}
	if (!Array.isArray(content)) return null;
	const chunks = [];
	for (const block of content) {
		if (!block || typeof block !== "object") continue;
		if (block.type !== "text") continue;
		const text = block.text;
		if (typeof text !== "string") continue;
		const value = opts?.sanitizeText ? opts.sanitizeText(text) : text;
		if (value.trim()) chunks.push(value);
	}
	const joined = normalize(chunks.join(joinWith));
	return joined ? joined : null;
}

//#endregion
//#region src/shared/text/code-regions.ts
function findCodeRegions(text) {
	const regions = [];
	for (const match of text.matchAll(/(^|\n)(```|~~~)[^\n]*\n[\s\S]*?(?:\n\2(?:\n|$)|$)/g)) {
		const start = (match.index ?? 0) + match[1].length;
		regions.push({
			start,
			end: start + match[0].length - match[1].length
		});
	}
	for (const match of text.matchAll(/`+[^`]+`+/g)) {
		const start = match.index ?? 0;
		const end = start + match[0].length;
		if (!regions.some((r) => start >= r.start && end <= r.end)) regions.push({
			start,
			end
		});
	}
	regions.sort((a, b) => a.start - b.start);
	return regions;
}
function isInsideCode(pos, regions) {
	return regions.some((r) => pos >= r.start && pos < r.end);
}

//#endregion
//#region src/shared/text/reasoning-tags.ts
const QUICK_TAG_RE = /<\s*\/?\s*(?:think(?:ing)?|thought|antthinking|final)\b/i;
const FINAL_TAG_RE = /<\s*\/?\s*final\b[^<>]*>/gi;
const THINKING_TAG_RE = /<\s*(\/?)\s*(?:think(?:ing)?|thought|antthinking)\b[^<>]*>/gi;
function applyTrim(value, mode) {
	if (mode === "none") return value;
	if (mode === "start") return value.trimStart();
	return value.trim();
}
function stripReasoningTagsFromText(text, options) {
	if (!text) return text;
	if (!QUICK_TAG_RE.test(text)) return text;
	const mode = options?.mode ?? "strict";
	const trimMode = options?.trim ?? "both";
	let cleaned = text;
	if (FINAL_TAG_RE.test(cleaned)) {
		FINAL_TAG_RE.lastIndex = 0;
		const finalMatches = [];
		const preCodeRegions = findCodeRegions(cleaned);
		for (const match of cleaned.matchAll(FINAL_TAG_RE)) {
			const start = match.index ?? 0;
			finalMatches.push({
				start,
				length: match[0].length,
				inCode: isInsideCode(start, preCodeRegions)
			});
		}
		for (let i = finalMatches.length - 1; i >= 0; i--) {
			const m = finalMatches[i];
			if (!m.inCode) cleaned = cleaned.slice(0, m.start) + cleaned.slice(m.start + m.length);
		}
	} else FINAL_TAG_RE.lastIndex = 0;
	const codeRegions = findCodeRegions(cleaned);
	THINKING_TAG_RE.lastIndex = 0;
	let result = "";
	let lastIndex = 0;
	let inThinking = false;
	for (const match of cleaned.matchAll(THINKING_TAG_RE)) {
		const idx = match.index ?? 0;
		const isClose = match[1] === "/";
		if (isInsideCode(idx, codeRegions)) continue;
		if (!inThinking) {
			result += cleaned.slice(lastIndex, idx);
			if (!isClose) inThinking = true;
		} else if (isClose) inThinking = false;
		lastIndex = idx + match[0].length;
	}
	if (!inThinking || mode === "preserve") result += cleaned.slice(lastIndex);
	return applyTrim(result, trimMode);
}

//#endregion
//#region src/agents/tool-display-common.ts
function asRecord(args) {
	return args && typeof args === "object" ? args : void 0;
}
function normalizeToolName(name) {
	return (name ?? "tool").trim();
}
function defaultTitle(name) {
	const cleaned = name.replace(/_/g, " ").trim();
	if (!cleaned) return "Tool";
	return cleaned.split(/\s+/).map((part) => part.length <= 2 && part.toUpperCase() === part ? part : `${part.at(0)?.toUpperCase() ?? ""}${part.slice(1)}`).join(" ");
}
function normalizeVerb(value) {
	const trimmed = value?.trim();
	if (!trimmed) return;
	return trimmed.replace(/_/g, " ");
}
function coerceDisplayValue(value, opts = {}) {
	const maxStringChars = opts.maxStringChars ?? 160;
	const maxArrayEntries = opts.maxArrayEntries ?? 3;
	if (value === null || value === void 0) return;
	if (typeof value === "string") {
		const trimmed = value.trim();
		if (!trimmed) return;
		const firstLine = trimmed.split(/\r?\n/)[0]?.trim() ?? "";
		if (!firstLine) return;
		if (firstLine.length > maxStringChars) return `${firstLine.slice(0, Math.max(0, maxStringChars - 3))}…`;
		return firstLine;
	}
	if (typeof value === "boolean") {
		if (!value && !opts.includeFalse) return;
		return value ? "true" : "false";
	}
	if (typeof value === "number") {
		if (!Number.isFinite(value)) return opts.includeNonFinite ? String(value) : void 0;
		if (value === 0 && !opts.includeZero) return;
		return String(value);
	}
	if (Array.isArray(value)) {
		const values = value.map((item) => coerceDisplayValue(item, opts)).filter((item) => Boolean(item));
		if (values.length === 0) return;
		const preview = values.slice(0, maxArrayEntries).join(", ");
		return values.length > maxArrayEntries ? `${preview}…` : preview;
	}
}
function lookupValueByPath(args, path) {
	if (!args || typeof args !== "object") return;
	let current = args;
	for (const segment of path.split(".")) {
		if (!segment) return;
		if (!current || typeof current !== "object") return;
		current = current[segment];
	}
	return current;
}
function formatDetailKey(raw, overrides = {}) {
	const last = raw.split(".").filter(Boolean).at(-1) ?? raw;
	const override = overrides[last];
	if (override) return override;
	return last.replace(/_/g, " ").replace(/-/g, " ").replace(/([a-z0-9])([A-Z])/g, "$1 $2").trim().toLowerCase() || last.toLowerCase();
}
function resolvePathArg(args) {
	const record = asRecord(args);
	if (!record) return;
	for (const candidate of [
		record.path,
		record.file_path,
		record.filePath
	]) {
		if (typeof candidate !== "string") continue;
		const trimmed = candidate.trim();
		if (trimmed) return trimmed;
	}
}
function resolveReadDetail(args) {
	const record = asRecord(args);
	if (!record) return;
	const path = resolvePathArg(record);
	if (!path) return;
	const offsetRaw = typeof record.offset === "number" && Number.isFinite(record.offset) ? Math.floor(record.offset) : void 0;
	const limitRaw = typeof record.limit === "number" && Number.isFinite(record.limit) ? Math.floor(record.limit) : void 0;
	const offset = offsetRaw !== void 0 ? Math.max(1, offsetRaw) : void 0;
	const limit = limitRaw !== void 0 ? Math.max(1, limitRaw) : void 0;
	if (offset !== void 0 && limit !== void 0) return `${limit === 1 ? "line" : "lines"} ${offset}-${offset + limit - 1} from ${path}`;
	if (offset !== void 0) return `from line ${offset} in ${path}`;
	if (limit !== void 0) return `first ${limit} ${limit === 1 ? "line" : "lines"} of ${path}`;
	return `from ${path}`;
}
function resolveWriteDetail(toolKey, args) {
	const record = asRecord(args);
	if (!record) return;
	const path = resolvePathArg(record) ?? (typeof record.url === "string" ? record.url.trim() : void 0);
	if (!path) return;
	if (toolKey === "attach") return `from ${path}`;
	const destinationPrefix = toolKey === "edit" ? "in" : "to";
	const content = typeof record.content === "string" ? record.content : typeof record.newText === "string" ? record.newText : typeof record.new_string === "string" ? record.new_string : void 0;
	if (content && content.length > 0) return `${destinationPrefix} ${path} (${content.length} chars)`;
	return `${destinationPrefix} ${path}`;
}
function resolveWebSearchDetail(args) {
	const record = asRecord(args);
	if (!record) return;
	const query = typeof record.query === "string" ? record.query.trim() : void 0;
	const count = typeof record.count === "number" && Number.isFinite(record.count) && record.count > 0 ? Math.floor(record.count) : void 0;
	if (!query) return;
	return count !== void 0 ? `for "${query}" (top ${count})` : `for "${query}"`;
}
function resolveWebFetchDetail(args) {
	const record = asRecord(args);
	if (!record) return;
	const url = typeof record.url === "string" ? record.url.trim() : void 0;
	if (!url) return;
	const mode = typeof record.extractMode === "string" ? record.extractMode.trim() : void 0;
	const maxChars = typeof record.maxChars === "number" && Number.isFinite(record.maxChars) && record.maxChars > 0 ? Math.floor(record.maxChars) : void 0;
	const suffix = [mode ? `mode ${mode}` : void 0, maxChars !== void 0 ? `max ${maxChars} chars` : void 0].filter((value) => Boolean(value)).join(", ");
	return suffix ? `from ${url} (${suffix})` : `from ${url}`;
}
function stripOuterQuotes(value) {
	if (!value) return value;
	const trimmed = value.trim();
	if (trimmed.length >= 2 && (trimmed.startsWith("\"") && trimmed.endsWith("\"") || trimmed.startsWith("'") && trimmed.endsWith("'"))) return trimmed.slice(1, -1).trim();
	return trimmed;
}
function splitShellWords(input, maxWords = 48) {
	if (!input) return [];
	const words = [];
	let current = "";
	let quote;
	let escaped = false;
	for (let i = 0; i < input.length; i += 1) {
		const char = input[i];
		if (escaped) {
			current += char;
			escaped = false;
			continue;
		}
		if (char === "\\") {
			escaped = true;
			continue;
		}
		if (quote) {
			if (char === quote) quote = void 0;
			else current += char;
			continue;
		}
		if (char === "\"" || char === "'") {
			quote = char;
			continue;
		}
		if (/\s/.test(char)) {
			if (!current) continue;
			words.push(current);
			if (words.length >= maxWords) return words;
			current = "";
			continue;
		}
		current += char;
	}
	if (current) words.push(current);
	return words;
}
function binaryName(token) {
	if (!token) return;
	const cleaned = stripOuterQuotes(token) ?? token;
	return (cleaned.split(/[/]/).at(-1) ?? cleaned).trim().toLowerCase();
}
function optionValue(words, names) {
	const lookup = new Set(names);
	for (let i = 0; i < words.length; i += 1) {
		const token = words[i];
		if (!token) continue;
		if (lookup.has(token)) {
			const value = words[i + 1];
			if (value && !value.startsWith("-")) return value;
			continue;
		}
		for (const name of names) if (name.startsWith("--") && token.startsWith(`${name}=`)) return token.slice(name.length + 1);
	}
}
function positionalArgs(words, from = 1, optionsWithValue = []) {
	const args = [];
	const takesValue = new Set(optionsWithValue);
	for (let i = from; i < words.length; i += 1) {
		const token = words[i];
		if (!token) continue;
		if (token === "--") {
			for (let j = i + 1; j < words.length; j += 1) {
				const candidate = words[j];
				if (candidate) args.push(candidate);
			}
			break;
		}
		if (token.startsWith("--")) {
			if (token.includes("=")) continue;
			if (takesValue.has(token)) i += 1;
			continue;
		}
		if (token.startsWith("-")) {
			if (takesValue.has(token)) i += 1;
			continue;
		}
		args.push(token);
	}
	return args;
}
function firstPositional(words, from = 1, optionsWithValue = []) {
	return positionalArgs(words, from, optionsWithValue)[0];
}
function trimLeadingEnv(words) {
	if (words.length === 0) return words;
	let index = 0;
	if (binaryName(words[0]) === "env") {
		index = 1;
		while (index < words.length) {
			const token = words[index];
			if (!token) break;
			if (token.startsWith("-")) {
				index += 1;
				continue;
			}
			if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(token)) {
				index += 1;
				continue;
			}
			break;
		}
		return words.slice(index);
	}
	while (index < words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[index])) index += 1;
	return words.slice(index);
}
function unwrapShellWrapper(command) {
	const words = splitShellWords(command, 10);
	if (words.length < 3) return command;
	const bin = binaryName(words[0]);
	if (!(bin === "bash" || bin === "sh" || bin === "zsh" || bin === "fish")) return command;
	const flagIndex = words.findIndex((token, index) => index > 0 && (token === "-c" || token === "-lc" || token === "-ic"));
	if (flagIndex === -1) return command;
	const inner = words.slice(flagIndex + 1).join(" ").trim();
	return inner ? stripOuterQuotes(inner) ?? command : command;
}
function scanTopLevelChars(command, visit) {
	let quote;
	let escaped = false;
	for (let i = 0; i < command.length; i += 1) {
		const char = command[i];
		if (escaped) {
			escaped = false;
			continue;
		}
		if (char === "\\") {
			escaped = true;
			continue;
		}
		if (quote) {
			if (char === quote) quote = void 0;
			continue;
		}
		if (char === "\"" || char === "'") {
			quote = char;
			continue;
		}
		if (visit(char, i) === false) return;
	}
}
function splitTopLevelStages(command) {
	const parts = [];
	let start = 0;
	scanTopLevelChars(command, (char, index) => {
		if (char === ";") {
			parts.push(command.slice(start, index));
			start = index + 1;
			return true;
		}
		if ((char === "&" || char === "|") && command[index + 1] === char) {
			parts.push(command.slice(start, index));
			start = index + 2;
			return true;
		}
		return true;
	});
	parts.push(command.slice(start));
	return parts.map((part) => part.trim()).filter((part) => part.length > 0);
}
function splitTopLevelPipes(command) {
	const parts = [];
	let start = 0;
	scanTopLevelChars(command, (char, index) => {
		if (char === "|" && command[index - 1] !== "|" && command[index + 1] !== "|") {
			parts.push(command.slice(start, index));
			start = index + 1;
		}
		return true;
	});
	parts.push(command.slice(start));
	return parts.map((part) => part.trim()).filter((part) => part.length > 0);
}
function parseChdirTarget(head) {
	const words = splitShellWords(head, 3);
	const bin = binaryName(words[0]);
	if (bin === "cd" || bin === "pushd") return words[1] || void 0;
}
function isChdirCommand(head) {
	const bin = binaryName(splitShellWords(head, 2)[0]);
	return bin === "cd" || bin === "pushd" || bin === "popd";
}
function isPopdCommand(head) {
	return binaryName(splitShellWords(head, 2)[0]) === "popd";
}
function stripShellPreamble(command) {
	let rest = command.trim();
	let chdirPath;
	for (let i = 0; i < 4; i += 1) {
		let first;
		scanTopLevelChars(rest, (char, idx) => {
			if (char === "&" && rest[idx + 1] === "&") {
				first = {
					index: idx,
					length: 2
				};
				return false;
			}
			if (char === "|" && rest[idx + 1] === "|") {
				first = {
					index: idx,
					length: 2,
					isOr: true
				};
				return false;
			}
			if (char === ";" || char === "\n") {
				first = {
					index: idx,
					length: 1
				};
				return false;
			}
		});
		const head = (first ? rest.slice(0, first.index) : rest).trim();
		const isChdir = (first ? !first.isOr : i > 0) && isChdirCommand(head);
		if (!(head.startsWith("set ") || head.startsWith("export ") || head.startsWith("unset ") || isChdir)) break;
		if (isChdir) if (isPopdCommand(head)) chdirPath = void 0;
		else chdirPath = parseChdirTarget(head) ?? chdirPath;
		rest = first ? rest.slice(first.index + first.length).trimStart() : "";
		if (!rest) break;
	}
	return {
		command: rest.trim(),
		chdirPath
	};
}
function summarizeKnownExec(words) {
	if (words.length === 0) return "run command";
	const bin = binaryName(words[0]) ?? "command";
	if (bin === "git") {
		const globalWithValue = new Set([
			"-C",
			"-c",
			"--git-dir",
			"--work-tree",
			"--namespace",
			"--config-env"
		]);
		const gitCwd = optionValue(words, ["-C"]);
		let sub;
		for (let i = 1; i < words.length; i += 1) {
			const token = words[i];
			if (!token) continue;
			if (token === "--") {
				sub = firstPositional(words, i + 1);
				break;
			}
			if (token.startsWith("--")) {
				if (token.includes("=")) continue;
				if (globalWithValue.has(token)) i += 1;
				continue;
			}
			if (token.startsWith("-")) {
				if (globalWithValue.has(token)) i += 1;
				continue;
			}
			sub = token;
			break;
		}
		const map = {
			status: "check git status",
			diff: "check git diff",
			log: "view git history",
			show: "show git object",
			branch: "list git branches",
			checkout: "switch git branch",
			switch: "switch git branch",
			commit: "create git commit",
			pull: "pull git changes",
			push: "push git changes",
			fetch: "fetch git changes",
			merge: "merge git changes",
			rebase: "rebase git branch",
			add: "stage git changes",
			restore: "restore git files",
			reset: "reset git state",
			stash: "stash git changes"
		};
		if (sub && map[sub]) return map[sub];
		if (!sub || sub.startsWith("/") || sub.startsWith("~") || sub.includes("/")) return gitCwd ? `run git command in ${gitCwd}` : "run git command";
		return `run git ${sub}`;
	}
	if (bin === "grep" || bin === "rg" || bin === "ripgrep") {
		const positional = positionalArgs(words, 1, [
			"-e",
			"--regexp",
			"-f",
			"--file",
			"-m",
			"--max-count",
			"-A",
			"--after-context",
			"-B",
			"--before-context",
			"-C",
			"--context"
		]);
		const pattern = optionValue(words, ["-e", "--regexp"]) ?? positional[0];
		const target = positional.length > 1 ? positional.at(-1) : void 0;
		if (pattern) return target ? `search "${pattern}" in ${target}` : `search "${pattern}"`;
		return "search text";
	}
	if (bin === "find") {
		const path = words[1] && !words[1].startsWith("-") ? words[1] : ".";
		const name = optionValue(words, ["-name", "-iname"]);
		return name ? `find files named "${name}" in ${path}` : `find files in ${path}`;
	}
	if (bin === "ls") {
		const target = firstPositional(words, 1);
		return target ? `list files in ${target}` : "list files";
	}
	if (bin === "head" || bin === "tail") {
		const lines = optionValue(words, ["-n", "--lines"]) ?? words.slice(1).find((token) => /^-\d+$/.test(token))?.slice(1);
		const positional = positionalArgs(words, 1, ["-n", "--lines"]);
		let target = positional.at(-1);
		if (target && /^\d+$/.test(target) && positional.length === 1) target = void 0;
		const side = bin === "head" ? "first" : "last";
		const unit = lines === "1" ? "line" : "lines";
		if (lines && target) return `show ${side} ${lines} ${unit} of ${target}`;
		if (lines) return `show ${side} ${lines} ${unit}`;
		if (target) return `show ${target}`;
		return `show ${bin} output`;
	}
	if (bin === "cat") {
		const target = firstPositional(words, 1);
		return target ? `show ${target}` : "show output";
	}
	if (bin === "sed") {
		const expression = optionValue(words, ["-e", "--expression"]);
		const positional = positionalArgs(words, 1, [
			"-e",
			"--expression",
			"-f",
			"--file"
		]);
		const script = expression ?? positional[0];
		const target = expression ? positional[0] : positional[1];
		if (script) {
			const compact = (stripOuterQuotes(script) ?? script).replace(/\s+/g, "");
			const range = compact.match(/^([0-9]+),([0-9]+)p$/);
			if (range) return target ? `print lines ${range[1]}-${range[2]} from ${target}` : `print lines ${range[1]}-${range[2]}`;
			const single = compact.match(/^([0-9]+)p$/);
			if (single) return target ? `print line ${single[1]} from ${target}` : `print line ${single[1]}`;
		}
		return target ? `run sed on ${target}` : "run sed transform";
	}
	if (bin === "printf" || bin === "echo") return "print text";
	if (bin === "cp" || bin === "mv") {
		const positional = positionalArgs(words, 1, [
			"-t",
			"--target-directory",
			"-S",
			"--suffix"
		]);
		const src = positional[0];
		const dst = positional[1];
		const action = bin === "cp" ? "copy" : "move";
		if (src && dst) return `${action} ${src} to ${dst}`;
		if (src) return `${action} ${src}`;
		return `${action} files`;
	}
	if (bin === "rm") {
		const target = firstPositional(words, 1);
		return target ? `remove ${target}` : "remove files";
	}
	if (bin === "mkdir") {
		const target = firstPositional(words, 1);
		return target ? `create folder ${target}` : "create folder";
	}
	if (bin === "touch") {
		const target = firstPositional(words, 1);
		return target ? `create file ${target}` : "create file";
	}
	if (bin === "curl" || bin === "wget") {
		const url = words.find((token) => /^https?:\/\//i.test(token));
		return url ? `fetch ${url}` : "fetch url";
	}
	if (bin === "npm" || bin === "pnpm" || bin === "yarn" || bin === "bun") {
		const positional = positionalArgs(words, 1, [
			"--prefix",
			"-C",
			"--cwd",
			"--config"
		]);
		const sub = positional[0] ?? "command";
		return {
			install: "install dependencies",
			test: "run tests",
			build: "run build",
			start: "start app",
			lint: "run lint",
			run: positional[1] ? `run ${positional[1]}` : "run script"
		}[sub] ?? `run ${bin} ${sub}`;
	}
	if (bin === "node" || bin === "python" || bin === "python3" || bin === "ruby" || bin === "php") {
		if (words.slice(1).find((token) => token.startsWith("<<"))) return `run ${bin} inline script (heredoc)`;
		if ((bin === "node" ? optionValue(words, ["-e", "--eval"]) : bin === "python" || bin === "python3" ? optionValue(words, ["-c"]) : void 0) !== void 0) return `run ${bin} inline script`;
		const script = firstPositional(words, 1, bin === "node" ? [
			"-e",
			"--eval",
			"-m"
		] : [
			"-c",
			"-e",
			"--eval",
			"-m"
		]);
		if (!script) return `run ${bin}`;
		if (bin === "node") return `${words.includes("--check") || words.includes("-c") ? "check js syntax for" : "run node script"} ${script}`;
		return `run ${bin} ${script}`;
	}
	if (bin === "openclaw") {
		const sub = firstPositional(words, 1);
		return sub ? `run openclaw ${sub}` : "run openclaw";
	}
	const arg = firstPositional(words, 1);
	if (!arg || arg.length > 48) return `run ${bin}`;
	return /^[A-Za-z0-9._/-]+$/.test(arg) ? `run ${bin} ${arg}` : `run ${bin}`;
}
function summarizePipeline(stage) {
	const pipeline = splitTopLevelPipes(stage);
	if (pipeline.length > 1) return `${summarizeKnownExec(trimLeadingEnv(splitShellWords(pipeline[0])))} -> ${summarizeKnownExec(trimLeadingEnv(splitShellWords(pipeline[pipeline.length - 1])))}${pipeline.length > 2 ? ` (+${pipeline.length - 2} steps)` : ""}`;
	return summarizeKnownExec(trimLeadingEnv(splitShellWords(stage)));
}
function summarizeExecCommand(command) {
	const { command: cleaned, chdirPath } = stripShellPreamble(command);
	if (!cleaned) return chdirPath ? {
		text: "",
		chdirPath
	} : void 0;
	const stages = splitTopLevelStages(cleaned);
	if (stages.length === 0) return;
	const summaries = stages.map((stage) => summarizePipeline(stage));
	return {
		text: summaries.length === 1 ? summaries[0] : summaries.join(" → "),
		chdirPath,
		allGeneric: summaries.every((s) => isGenericSummary(s))
	};
}
/** Known summarizer prefixes that indicate a recognized command with useful context. */
const KNOWN_SUMMARY_PREFIXES = [
	"check git",
	"view git",
	"show git",
	"list git",
	"switch git",
	"create git",
	"pull git",
	"push git",
	"fetch git",
	"merge git",
	"rebase git",
	"stage git",
	"restore git",
	"reset git",
	"stash git",
	"search ",
	"find files",
	"list files",
	"show first",
	"show last",
	"print line",
	"print text",
	"copy ",
	"move ",
	"remove ",
	"create folder",
	"create file",
	"fetch http",
	"install dependencies",
	"run tests",
	"run build",
	"start app",
	"run lint",
	"run openclaw",
	"run node script",
	"run node ",
	"run python",
	"run ruby",
	"run php",
	"run sed",
	"run git ",
	"run npm ",
	"run pnpm ",
	"run yarn ",
	"run bun ",
	"check js syntax"
];
/** True when the summary is generic and the raw command would be more informative. */
function isGenericSummary(summary) {
	if (summary === "run command") return true;
	if (summary.startsWith("run ")) return !KNOWN_SUMMARY_PREFIXES.some((prefix) => summary.startsWith(prefix));
	return false;
}
/** Compact the raw command for display: collapse whitespace, trim long strings. */
function compactRawCommand(raw, maxLength = 120) {
	const oneLine = raw.replace(/\s*\n\s*/g, " ").replace(/\s{2,}/g, " ").trim();
	if (oneLine.length <= maxLength) return oneLine;
	return `${oneLine.slice(0, Math.max(0, maxLength - 1))}…`;
}
function resolveExecDetail(args) {
	const record = asRecord(args);
	if (!record) return;
	const raw = typeof record.command === "string" ? record.command.trim() : void 0;
	if (!raw) return;
	const unwrapped = unwrapShellWrapper(raw);
	const result = summarizeExecCommand(unwrapped) ?? summarizeExecCommand(raw);
	const summary = result?.text || "run command";
	const cwd = (typeof record.workdir === "string" ? record.workdir : typeof record.cwd === "string" ? record.cwd : void 0)?.trim() || result?.chdirPath || void 0;
	const compact = compactRawCommand(unwrapped);
	if (result?.allGeneric !== false && isGenericSummary(summary)) return cwd ? `${compact} (in ${cwd})` : compact;
	const displaySummary = cwd ? `${summary} (in ${cwd})` : summary;
	if (compact && compact !== displaySummary && compact !== summary) return `${displaySummary}\n\n\`${compact}\``;
	return displaySummary;
}
function resolveActionSpec(spec, action) {
	if (!spec || !action) return;
	return spec.actions?.[action] ?? void 0;
}
function resolveDetailFromKeys(args, keys, opts) {
	if (opts.mode === "first") {
		for (const key of keys) {
			const display = coerceDisplayValue(lookupValueByPath(args, key), opts.coerce);
			if (display) return display;
		}
		return;
	}
	const entries = [];
	for (const key of keys) {
		const display = coerceDisplayValue(lookupValueByPath(args, key), opts.coerce);
		if (!display) continue;
		entries.push({
			label: opts.formatKey ? opts.formatKey(key) : key,
			value: display
		});
	}
	if (entries.length === 0) return;
	if (entries.length === 1) return entries[0].value;
	const seen = /* @__PURE__ */ new Set();
	const unique = [];
	for (const entry of entries) {
		const token = `${entry.label}:${entry.value}`;
		if (seen.has(token)) continue;
		seen.add(token);
		unique.push(entry);
	}
	if (unique.length === 0) return;
	return unique.slice(0, opts.maxEntries ?? 8).map((entry) => `${entry.label} ${entry.value}`).join(" · ");
}

//#endregion
//#region src/agents/tool-display.json
var tool_display_default = {
	version: 1,
	fallback: {
		"emoji": "🧩",
		"detailKeys": [
			"command",
			"path",
			"url",
			"targetUrl",
			"targetId",
			"ref",
			"element",
			"node",
			"nodeId",
			"id",
			"requestId",
			"to",
			"channelId",
			"guildId",
			"userId",
			"name",
			"query",
			"pattern",
			"messageId"
		]
	},
	tools: {
		"exec": {
			"emoji": "🛠️",
			"title": "Exec",
			"detailKeys": ["command"]
		},
		"process": {
			"emoji": "🧰",
			"title": "Process",
			"detailKeys": ["sessionId"]
		},
		"read": {
			"emoji": "📖",
			"title": "Read",
			"detailKeys": ["path"]
		},
		"write": {
			"emoji": "✍️",
			"title": "Write",
			"detailKeys": ["path"]
		},
		"edit": {
			"emoji": "📝",
			"title": "Edit",
			"detailKeys": ["path"]
		},
		"apply_patch": {
			"emoji": "🩹",
			"title": "Apply Patch",
			"detailKeys": []
		},
		"attach": {
			"emoji": "📎",
			"title": "Attach",
			"detailKeys": [
				"path",
				"url",
				"fileName"
			]
		},
		"browser": {
			"emoji": "🌐",
			"title": "Browser",
			"actions": {
				"status": { "label": "status" },
				"start": { "label": "start" },
				"stop": { "label": "stop" },
				"tabs": { "label": "tabs" },
				"open": {
					"label": "open",
					"detailKeys": ["targetUrl"]
				},
				"focus": {
					"label": "focus",
					"detailKeys": ["targetId"]
				},
				"close": {
					"label": "close",
					"detailKeys": ["targetId"]
				},
				"snapshot": {
					"label": "snapshot",
					"detailKeys": [
						"targetUrl",
						"targetId",
						"ref",
						"element",
						"format"
					]
				},
				"screenshot": {
					"label": "screenshot",
					"detailKeys": [
						"targetUrl",
						"targetId",
						"ref",
						"element"
					]
				},
				"navigate": {
					"label": "navigate",
					"detailKeys": ["targetUrl", "targetId"]
				},
				"console": {
					"label": "console",
					"detailKeys": ["level", "targetId"]
				},
				"pdf": {
					"label": "pdf",
					"detailKeys": ["targetId"]
				},
				"upload": {
					"label": "upload",
					"detailKeys": [
						"paths",
						"ref",
						"inputRef",
						"element",
						"targetId"
					]
				},
				"dialog": {
					"label": "dialog",
					"detailKeys": [
						"accept",
						"promptText",
						"targetId"
					]
				},
				"act": {
					"label": "act",
					"detailKeys": [
						"request.kind",
						"request.ref",
						"request.selector",
						"request.text",
						"request.value"
					]
				}
			}
		},
		"canvas": {
			"emoji": "🖼️",
			"title": "Canvas",
			"actions": {
				"present": {
					"label": "present",
					"detailKeys": [
						"target",
						"node",
						"nodeId"
					]
				},
				"hide": {
					"label": "hide",
					"detailKeys": ["node", "nodeId"]
				},
				"navigate": {
					"label": "navigate",
					"detailKeys": [
						"url",
						"node",
						"nodeId"
					]
				},
				"eval": {
					"label": "eval",
					"detailKeys": [
						"javaScript",
						"node",
						"nodeId"
					]
				},
				"snapshot": {
					"label": "snapshot",
					"detailKeys": [
						"format",
						"node",
						"nodeId"
					]
				},
				"a2ui_push": {
					"label": "A2UI push",
					"detailKeys": [
						"jsonlPath",
						"node",
						"nodeId"
					]
				},
				"a2ui_reset": {
					"label": "A2UI reset",
					"detailKeys": ["node", "nodeId"]
				}
			}
		},
		"nodes": {
			"emoji": "📱",
			"title": "Nodes",
			"actions": {
				"status": { "label": "status" },
				"describe": {
					"label": "describe",
					"detailKeys": ["node", "nodeId"]
				},
				"pending": { "label": "pending" },
				"approve": {
					"label": "approve",
					"detailKeys": ["requestId"]
				},
				"reject": {
					"label": "reject",
					"detailKeys": ["requestId"]
				},
				"notify": {
					"label": "notify",
					"detailKeys": [
						"node",
						"nodeId",
						"title",
						"body"
					]
				},
				"camera_snap": {
					"label": "camera snap",
					"detailKeys": [
						"node",
						"nodeId",
						"facing",
						"deviceId"
					]
				},
				"camera_list": {
					"label": "camera list",
					"detailKeys": ["node", "nodeId"]
				},
				"camera_clip": {
					"label": "camera clip",
					"detailKeys": [
						"node",
						"nodeId",
						"facing",
						"duration",
						"durationMs"
					]
				},
				"screen_record": {
					"label": "screen record",
					"detailKeys": [
						"node",
						"nodeId",
						"duration",
						"durationMs",
						"fps",
						"screenIndex"
					]
				}
			}
		},
		"cron": {
			"emoji": "⏰",
			"title": "Cron",
			"actions": {
				"status": { "label": "status" },
				"list": { "label": "list" },
				"add": {
					"label": "add",
					"detailKeys": [
						"job.name",
						"job.id",
						"job.schedule",
						"job.cron"
					]
				},
				"update": {
					"label": "update",
					"detailKeys": ["id"]
				},
				"remove": {
					"label": "remove",
					"detailKeys": ["id"]
				},
				"run": {
					"label": "run",
					"detailKeys": ["id"]
				},
				"runs": {
					"label": "runs",
					"detailKeys": ["id"]
				},
				"wake": {
					"label": "wake",
					"detailKeys": ["text", "mode"]
				}
			}
		},
		"gateway": {
			"emoji": "🔌",
			"title": "Gateway",
			"actions": { "restart": {
				"label": "restart",
				"detailKeys": ["reason", "delayMs"]
			} }
		},
		"message": {
			"emoji": "✉️",
			"title": "Message",
			"actions": {
				"send": {
					"label": "send",
					"detailKeys": [
						"provider",
						"to",
						"media",
						"replyTo",
						"threadId"
					]
				},
				"poll": {
					"label": "poll",
					"detailKeys": [
						"provider",
						"to",
						"pollQuestion"
					]
				},
				"react": {
					"label": "react",
					"detailKeys": [
						"provider",
						"to",
						"messageId",
						"emoji",
						"remove"
					]
				},
				"reactions": {
					"label": "reactions",
					"detailKeys": [
						"provider",
						"to",
						"messageId",
						"limit"
					]
				},
				"read": {
					"label": "read",
					"detailKeys": [
						"provider",
						"to",
						"limit"
					]
				},
				"edit": {
					"label": "edit",
					"detailKeys": [
						"provider",
						"to",
						"messageId"
					]
				},
				"delete": {
					"label": "delete",
					"detailKeys": [
						"provider",
						"to",
						"messageId"
					]
				},
				"pin": {
					"label": "pin",
					"detailKeys": [
						"provider",
						"to",
						"messageId"
					]
				},
				"unpin": {
					"label": "unpin",
					"detailKeys": [
						"provider",
						"to",
						"messageId"
					]
				},
				"list-pins": {
					"label": "list pins",
					"detailKeys": ["provider", "to"]
				},
				"permissions": {
					"label": "permissions",
					"detailKeys": [
						"provider",
						"channelId",
						"to"
					]
				},
				"thread-create": {
					"label": "thread create",
					"detailKeys": [
						"provider",
						"channelId",
						"threadName"
					]
				},
				"thread-list": {
					"label": "thread list",
					"detailKeys": [
						"provider",
						"guildId",
						"channelId"
					]
				},
				"thread-reply": {
					"label": "thread reply",
					"detailKeys": [
						"provider",
						"channelId",
						"messageId"
					]
				},
				"search": {
					"label": "search",
					"detailKeys": [
						"provider",
						"guildId",
						"query"
					]
				},
				"sticker": {
					"label": "sticker",
					"detailKeys": [
						"provider",
						"to",
						"stickerId"
					]
				},
				"member-info": {
					"label": "member",
					"detailKeys": [
						"provider",
						"guildId",
						"userId"
					]
				},
				"role-info": {
					"label": "roles",
					"detailKeys": ["provider", "guildId"]
				},
				"emoji-list": {
					"label": "emoji list",
					"detailKeys": ["provider", "guildId"]
				},
				"emoji-upload": {
					"label": "emoji upload",
					"detailKeys": [
						"provider",
						"guildId",
						"emojiName"
					]
				},
				"sticker-upload": {
					"label": "sticker upload",
					"detailKeys": [
						"provider",
						"guildId",
						"stickerName"
					]
				},
				"role-add": {
					"label": "role add",
					"detailKeys": [
						"provider",
						"guildId",
						"userId",
						"roleId"
					]
				},
				"role-remove": {
					"label": "role remove",
					"detailKeys": [
						"provider",
						"guildId",
						"userId",
						"roleId"
					]
				},
				"channel-info": {
					"label": "channel",
					"detailKeys": ["provider", "channelId"]
				},
				"channel-list": {
					"label": "channels",
					"detailKeys": ["provider", "guildId"]
				},
				"voice-status": {
					"label": "voice",
					"detailKeys": [
						"provider",
						"guildId",
						"userId"
					]
				},
				"event-list": {
					"label": "events",
					"detailKeys": ["provider", "guildId"]
				},
				"event-create": {
					"label": "event create",
					"detailKeys": [
						"provider",
						"guildId",
						"eventName"
					]
				},
				"timeout": {
					"label": "timeout",
					"detailKeys": [
						"provider",
						"guildId",
						"userId"
					]
				},
				"kick": {
					"label": "kick",
					"detailKeys": [
						"provider",
						"guildId",
						"userId"
					]
				},
				"ban": {
					"label": "ban",
					"detailKeys": [
						"provider",
						"guildId",
						"userId"
					]
				}
			}
		},
		"agents_list": {
			"emoji": "🧭",
			"title": "Agents",
			"detailKeys": []
		},
		"sessions_list": {
			"emoji": "🗂️",
			"title": "Sessions",
			"detailKeys": [
				"kinds",
				"limit",
				"activeMinutes",
				"messageLimit"
			]
		},
		"sessions_history": {
			"emoji": "🧾",
			"title": "Session History",
			"detailKeys": [
				"sessionKey",
				"limit",
				"includeTools"
			]
		},
		"sessions_send": {
			"emoji": "📨",
			"title": "Session Send",
			"detailKeys": [
				"label",
				"sessionKey",
				"agentId",
				"timeoutSeconds"
			]
		},
		"sessions_spawn": {
			"emoji": "🧑‍🔧",
			"title": "Sub-agent",
			"detailKeys": [
				"label",
				"task",
				"agentId",
				"model",
				"thinking",
				"runTimeoutSeconds",
				"cleanup"
			]
		},
		"subagents": {
			"emoji": "🤖",
			"title": "Subagents",
			"actions": {
				"list": {
					"label": "list",
					"detailKeys": ["recentMinutes"]
				},
				"kill": {
					"label": "kill",
					"detailKeys": ["target"]
				},
				"steer": {
					"label": "steer",
					"detailKeys": ["target"]
				}
			}
		},
		"session_status": {
			"emoji": "📊",
			"title": "Session Status",
			"detailKeys": ["sessionKey", "model"]
		},
		"memory_search": {
			"emoji": "🧠",
			"title": "Memory Search",
			"detailKeys": ["query"]
		},
		"memory_get": {
			"emoji": "📓",
			"title": "Memory Get",
			"detailKeys": [
				"path",
				"from",
				"lines"
			]
		},
		"web_search": {
			"emoji": "🔎",
			"title": "Web Search",
			"detailKeys": ["query", "count"]
		},
		"web_fetch": {
			"emoji": "📄",
			"title": "Web Fetch",
			"detailKeys": [
				"url",
				"extractMode",
				"maxChars"
			]
		},
		"whatsapp_login": {
			"emoji": "🟢",
			"title": "WhatsApp Login",
			"actions": {
				"start": { "label": "start" },
				"wait": { "label": "wait" }
			}
		}
	}
};

//#endregion
//#region src/agents/tool-display.ts
const TOOL_DISPLAY_CONFIG = tool_display_default;
const FALLBACK = TOOL_DISPLAY_CONFIG.fallback ?? { emoji: "🧩" };
const TOOL_MAP = TOOL_DISPLAY_CONFIG.tools ?? {};
const DETAIL_LABEL_OVERRIDES = {
	agentId: "agent",
	sessionKey: "session",
	targetId: "target",
	targetUrl: "url",
	nodeId: "node",
	requestId: "request",
	messageId: "message",
	threadId: "thread",
	channelId: "channel",
	guildId: "guild",
	userId: "user",
	runTimeoutSeconds: "timeout",
	timeoutSeconds: "timeout",
	includeTools: "tools",
	pollQuestion: "poll",
	maxChars: "max chars"
};
const MAX_DETAIL_ENTRIES = 8;
function resolveToolDisplay(params) {
	const name = normalizeToolName(params.name);
	const key = name.toLowerCase();
	const spec = TOOL_MAP[key];
	const emoji = spec?.emoji ?? FALLBACK.emoji ?? "🧩";
	const title = spec?.title ?? defaultTitle(name);
	const label = spec?.label ?? title;
	const actionRaw = params.args && typeof params.args === "object" ? params.args.action : void 0;
	const action = typeof actionRaw === "string" ? actionRaw.trim() : void 0;
	const actionSpec = resolveActionSpec(spec, action);
	const fallbackVerb = key === "web_search" ? "search" : key === "web_fetch" ? "fetch" : key.replace(/_/g, " ").replace(/\./g, " ");
	const verb = normalizeVerb(actionSpec?.label ?? action ?? fallbackVerb);
	let detail;
	if (key === "exec") detail = resolveExecDetail(params.args);
	if (!detail && key === "read") detail = resolveReadDetail(params.args);
	if (!detail && (key === "write" || key === "edit" || key === "attach")) detail = resolveWriteDetail(key, params.args);
	if (!detail && key === "web_search") detail = resolveWebSearchDetail(params.args);
	if (!detail && key === "web_fetch") detail = resolveWebFetchDetail(params.args);
	const detailKeys = actionSpec?.detailKeys ?? spec?.detailKeys ?? FALLBACK.detailKeys ?? [];
	if (!detail && detailKeys.length > 0) detail = resolveDetailFromKeys(params.args, detailKeys, {
		mode: "summary",
		maxEntries: MAX_DETAIL_ENTRIES,
		formatKey: (raw) => formatDetailKey(raw, DETAIL_LABEL_OVERRIDES)
	});
	if (!detail && params.meta) detail = params.meta;
	if (detail) detail = shortenHomeInString(detail);
	return {
		name,
		emoji,
		title,
		label,
		verb,
		detail
	};
}
function formatToolDetail(display) {
	const detailRaw = display.detail ? redactToolDetail(display.detail) : void 0;
	if (!detailRaw) return;
	if (detailRaw.includes(" · ")) {
		const compact = detailRaw.split(" · ").map((part) => part.trim()).filter((part) => part.length > 0).join(", ");
		return compact ? `with ${compact}` : void 0;
	}
	return detailRaw;
}

//#endregion
//#region src/agents/pi-embedded-utils.ts
function isAssistantMessage(msg) {
	return msg?.role === "assistant";
}
/**
* Strip malformed Minimax tool invocations that leak into text content.
* Minimax sometimes embeds tool calls as XML in text blocks instead of
* proper structured tool calls. This removes:
* - <invoke name="...">...</invoke> blocks
* - </minimax:tool_call> closing tags
*/
function stripMinimaxToolCallXml(text) {
	if (!text) return text;
	if (!/minimax:tool_call/i.test(text)) return text;
	let cleaned = text.replace(/<invoke\b[^>]*>[\s\S]*?<\/invoke>/gi, "");
	cleaned = cleaned.replace(/<\/?minimax:tool_call>/gi, "");
	return cleaned;
}
/**
* Strip downgraded tool call text representations that leak into text content.
* When replaying history to Gemini, tool calls without `thought_signature` are
* downgraded to text blocks like `[Tool Call: name (ID: ...)]`. These should
* not be shown to users.
*/
function stripDowngradedToolCallText(text) {
	if (!text) return text;
	if (!/\[Tool (?:Call|Result)/i.test(text) && !/\[Historical context/i.test(text)) return text;
	const consumeJsonish = (input, start, options) => {
		const { allowLeadingNewlines = false } = options ?? {};
		let index = start;
		while (index < input.length) {
			const ch = input[index];
			if (ch === " " || ch === "	") {
				index += 1;
				continue;
			}
			if (allowLeadingNewlines && (ch === "\n" || ch === "\r")) {
				index += 1;
				continue;
			}
			break;
		}
		if (index >= input.length) return null;
		const startChar = input[index];
		if (startChar === "{" || startChar === "[") {
			let depth = 0;
			let inString = false;
			let escape = false;
			for (let i = index; i < input.length; i += 1) {
				const ch = input[i];
				if (inString) {
					if (escape) escape = false;
					else if (ch === "\\") escape = true;
					else if (ch === "\"") inString = false;
					continue;
				}
				if (ch === "\"") {
					inString = true;
					continue;
				}
				if (ch === "{" || ch === "[") {
					depth += 1;
					continue;
				}
				if (ch === "}" || ch === "]") {
					depth -= 1;
					if (depth === 0) return i + 1;
				}
			}
			return null;
		}
		if (startChar === "\"") {
			let escape = false;
			for (let i = index + 1; i < input.length; i += 1) {
				const ch = input[i];
				if (escape) {
					escape = false;
					continue;
				}
				if (ch === "\\") {
					escape = true;
					continue;
				}
				if (ch === "\"") return i + 1;
			}
			return null;
		}
		let end = index;
		while (end < input.length && input[end] !== "\n" && input[end] !== "\r") end += 1;
		return end;
	};
	const stripToolCalls = (input) => {
		const markerRe = /\[Tool Call:[^\]]*\]/gi;
		let result = "";
		let cursor = 0;
		for (const match of input.matchAll(markerRe)) {
			const start = match.index ?? 0;
			if (start < cursor) continue;
			result += input.slice(cursor, start);
			let index = start + match[0].length;
			while (index < input.length && (input[index] === " " || input[index] === "	")) index += 1;
			if (input[index] === "\r") {
				index += 1;
				if (input[index] === "\n") index += 1;
			} else if (input[index] === "\n") index += 1;
			while (index < input.length && (input[index] === " " || input[index] === "	")) index += 1;
			if (input.slice(index, index + 9).toLowerCase() === "arguments") {
				index += 9;
				if (input[index] === ":") index += 1;
				if (input[index] === " ") index += 1;
				const end = consumeJsonish(input, index, { allowLeadingNewlines: true });
				if (end !== null) index = end;
			}
			if ((input[index] === "\n" || input[index] === "\r") && (result.endsWith("\n") || result.endsWith("\r") || result.length === 0)) {
				if (input[index] === "\r") index += 1;
				if (input[index] === "\n") index += 1;
			}
			cursor = index;
		}
		result += input.slice(cursor);
		return result;
	};
	let cleaned = stripToolCalls(text);
	cleaned = cleaned.replace(/\[Tool Result for ID[^\]]*\]\n?[\s\S]*?(?=\n*\[Tool |\n*$)/gi, "");
	cleaned = cleaned.replace(/\[Historical context:[^\]]*\]\n?/gi, "");
	return cleaned.trim();
}
/**
* Strip thinking tags and their content from text.
* This is a safety net for cases where the model outputs <think> tags
* that slip through other filtering mechanisms.
*/
function stripThinkingTagsFromText(text) {
	return stripReasoningTagsFromText(text, {
		mode: "strict",
		trim: "both"
	});
}
function extractAssistantText(msg) {
	return sanitizeUserFacingText(extractTextFromChatContent(msg.content, {
		sanitizeText: (text) => stripThinkingTagsFromText(stripDowngradedToolCallText(stripMinimaxToolCallXml(text))).trim(),
		joinWith: "\n",
		normalizeText: (text) => text.trim()
	}) ?? "", { errorContext: msg.stopReason === "error" || Boolean(msg.errorMessage?.trim()) });
}
function extractAssistantThinking(msg) {
	if (!Array.isArray(msg.content)) return "";
	return msg.content.map((block) => {
		if (!block || typeof block !== "object") return "";
		const record = block;
		if (record.type === "thinking" && typeof record.thinking === "string") return record.thinking.trim();
		return "";
	}).filter(Boolean).join("\n").trim();
}
function formatReasoningMessage(text) {
	const trimmed = text.trim();
	if (!trimmed) return "";
	return `Reasoning:\n${trimmed.split("\n").map((line) => line ? `_${line}_` : line).join("\n")}`;
}
function splitThinkingTaggedText(text) {
	const trimmedStart = text.trimStart();
	if (!trimmedStart.startsWith("<")) return null;
	const openRe = /<\s*(?:think(?:ing)?|thought|antthinking)\s*>/i;
	const closeRe = /<\s*\/\s*(?:think(?:ing)?|thought|antthinking)\s*>/i;
	if (!openRe.test(trimmedStart)) return null;
	if (!closeRe.test(text)) return null;
	const scanRe = /<\s*(\/?)\s*(?:think(?:ing)?|thought|antthinking)\s*>/gi;
	let inThinking = false;
	let cursor = 0;
	let thinkingStart = 0;
	const blocks = [];
	const pushText = (value) => {
		if (!value) return;
		blocks.push({
			type: "text",
			text: value
		});
	};
	const pushThinking = (value) => {
		const cleaned = value.trim();
		if (!cleaned) return;
		blocks.push({
			type: "thinking",
			thinking: cleaned
		});
	};
	for (const match of text.matchAll(scanRe)) {
		const index = match.index ?? 0;
		const isClose = Boolean(match[1]?.includes("/"));
		if (!inThinking && !isClose) {
			pushText(text.slice(cursor, index));
			thinkingStart = index + match[0].length;
			inThinking = true;
			continue;
		}
		if (inThinking && isClose) {
			pushThinking(text.slice(thinkingStart, index));
			cursor = index + match[0].length;
			inThinking = false;
		}
	}
	if (inThinking) return null;
	pushText(text.slice(cursor));
	if (!blocks.some((b) => b.type === "thinking")) return null;
	return blocks;
}
function promoteThinkingTagsToBlocks(message) {
	if (!Array.isArray(message.content)) return;
	if (message.content.some((block) => block.type === "thinking")) return;
	const next = [];
	let changed = false;
	for (const block of message.content) {
		if (block.type !== "text") {
			next.push(block);
			continue;
		}
		const split = splitThinkingTaggedText(block.text);
		if (!split) {
			next.push(block);
			continue;
		}
		changed = true;
		for (const part of split) if (part.type === "thinking") next.push({
			type: "thinking",
			thinking: part.thinking
		});
		else if (part.type === "text") {
			const cleaned = part.text.trimStart();
			if (cleaned) next.push({
				type: "text",
				text: cleaned
			});
		}
	}
	if (!changed) return;
	message.content = next;
}
function extractThinkingFromTaggedText(text) {
	if (!text) return "";
	const scanRe = /<\s*(\/?)\s*(?:think(?:ing)?|thought|antthinking)\s*>/gi;
	let result = "";
	let lastIndex = 0;
	let inThinking = false;
	for (const match of text.matchAll(scanRe)) {
		const idx = match.index ?? 0;
		if (inThinking) result += text.slice(lastIndex, idx);
		inThinking = !(match[1] === "/");
		lastIndex = idx + match[0].length;
	}
	return result.trim();
}
function extractThinkingFromTaggedStream(text) {
	if (!text) return "";
	const closed = extractThinkingFromTaggedText(text);
	if (closed) return closed;
	const openRe = /<\s*(?:think(?:ing)?|thought|antthinking)\s*>/gi;
	const closeRe = /<\s*\/\s*(?:think(?:ing)?|thought|antthinking)\s*>/gi;
	const openMatches = [...text.matchAll(openRe)];
	if (openMatches.length === 0) return "";
	const closeMatches = [...text.matchAll(closeRe)];
	const lastOpen = openMatches[openMatches.length - 1];
	const lastClose = closeMatches[closeMatches.length - 1];
	if (lastClose && (lastClose.index ?? -1) > (lastOpen.index ?? -1)) return closed;
	const start = (lastOpen.index ?? 0) + lastOpen[0].length;
	return text.slice(start).trim();
}
function inferToolMetaFromArgs(toolName, args) {
	return formatToolDetail(resolveToolDisplay({
		name: toolName,
		args
	}));
}

//#endregion
//#region src/agents/minimax-vlm.ts
function coerceApiHost(params) {
	const env = params.env ?? process.env;
	const raw = params.apiHost?.trim() || env.MINIMAX_API_HOST?.trim() || params.modelBaseUrl?.trim() || "https://api.minimax.io";
	try {
		return new URL(raw).origin;
	} catch {}
	try {
		return new URL(`https://${raw}`).origin;
	} catch {
		return "https://api.minimax.io";
	}
}
function pickString(rec, key) {
	const v = rec[key];
	return typeof v === "string" ? v : "";
}
async function minimaxUnderstandImage(params) {
	const apiKey = normalizeSecretInput(params.apiKey);
	if (!apiKey) throw new Error("MiniMax VLM: apiKey required");
	const prompt = params.prompt.trim();
	if (!prompt) throw new Error("MiniMax VLM: prompt required");
	const imageDataUrl = params.imageDataUrl.trim();
	if (!imageDataUrl) throw new Error("MiniMax VLM: imageDataUrl required");
	if (!/^data:image\/(png|jpeg|webp);base64,/i.test(imageDataUrl)) throw new Error("MiniMax VLM: imageDataUrl must be a base64 data:image/(png|jpeg|webp) URL");
	const host = coerceApiHost({
		apiHost: params.apiHost,
		modelBaseUrl: params.modelBaseUrl
	});
	const url = new URL("/v1/coding_plan/vlm", host).toString();
	const res = await fetch(url, {
		method: "POST",
		headers: {
			Authorization: `Bearer ${apiKey}`,
			"Content-Type": "application/json",
			"MM-API-Source": "OpenClaw"
		},
		body: JSON.stringify({
			prompt,
			image_url: imageDataUrl
		})
	});
	const traceId = res.headers.get("Trace-Id") ?? "";
	if (!res.ok) {
		const body = await res.text().catch(() => "");
		const trace = traceId ? ` Trace-Id: ${traceId}` : "";
		throw new Error(`MiniMax VLM request failed (${res.status} ${res.statusText}).${trace}${body ? ` Body: ${body.slice(0, 400)}` : ""}`);
	}
	const json = await res.json().catch(() => null);
	if (!isRecord(json)) {
		const trace = traceId ? ` Trace-Id: ${traceId}` : "";
		throw new Error(`MiniMax VLM response was not JSON.${trace}`);
	}
	const baseResp = isRecord(json.base_resp) ? json.base_resp : {};
	const code = typeof baseResp.status_code === "number" ? baseResp.status_code : -1;
	if (code !== 0) {
		const msg = (baseResp.status_msg ?? "").trim();
		const trace = traceId ? ` Trace-Id: ${traceId}` : "";
		throw new Error(`MiniMax VLM API error (${code})${msg ? `: ${msg}` : ""}.${trace}`);
	}
	const content = pickString(json, "content").trim();
	if (!content) {
		const trace = traceId ? ` Trace-Id: ${traceId}` : "";
		throw new Error(`MiniMax VLM returned no content.${trace}`);
	}
	return content;
}

//#endregion
//#region src/agents/tools/image-tool.helpers.ts
function decodeDataUrl(dataUrl) {
	const trimmed = dataUrl.trim();
	const match = /^data:([^;,]+);base64,([a-z0-9+/=\r\n]+)$/i.exec(trimmed);
	if (!match) throw new Error("Invalid data URL (expected base64 data: URL).");
	const mimeType = (match[1] ?? "").trim().toLowerCase();
	if (!mimeType.startsWith("image/")) throw new Error(`Unsupported data URL type: ${mimeType || "unknown"}`);
	const b64 = (match[2] ?? "").trim();
	const buffer = Buffer.from(b64, "base64");
	if (buffer.length === 0) throw new Error("Invalid data URL: empty payload.");
	return {
		buffer,
		mimeType,
		kind: "image"
	};
}
function coerceImageAssistantText(params) {
	const stop = params.message.stopReason;
	const errorMessage = params.message.errorMessage?.trim();
	if (stop === "error" || stop === "aborted") throw new Error(errorMessage ? `Image model failed (${params.provider}/${params.model}): ${errorMessage}` : `Image model failed (${params.provider}/${params.model})`);
	if (errorMessage) throw new Error(`Image model failed (${params.provider}/${params.model}): ${errorMessage}`);
	const text = extractAssistantText(params.message);
	if (text.trim()) return text.trim();
	throw new Error(`Image model returned no text (${params.provider}/${params.model}).`);
}
function coerceImageModelConfig(cfg) {
	const primary = resolveAgentModelPrimaryValue(cfg?.agents?.defaults?.imageModel);
	const fallbacks = resolveAgentModelFallbackValues(cfg?.agents?.defaults?.imageModel);
	return {
		...primary?.trim() ? { primary: primary.trim() } : {},
		...fallbacks.length > 0 ? { fallbacks } : {}
	};
}
function resolveProviderVisionModelFromConfig(params) {
	const models = (params.cfg?.models?.providers?.[params.provider])?.models ?? [];
	const id = (((params.provider === "minimax" ? models.find((m) => (m?.id ?? "").trim() === "MiniMax-VL-01" && Array.isArray(m?.input) && m.input.includes("image")) : null) ?? models.find((m) => Boolean((m?.id ?? "").trim()) && m.input?.includes("image")))?.id ?? "").trim();
	return id ? `${params.provider}/${id}` : null;
}

//#endregion
//#region src/media-understanding/providers/image.ts
var image_exports = /* @__PURE__ */ __exportAll({ describeImageWithModel: () => describeImageWithModel });
async function describeImageWithModel(params) {
	await ensureOpenClawModelsJson(params.cfg, params.agentDir);
	const authStorage = discoverAuthStorage(params.agentDir);
	const model = discoverModels(authStorage, params.agentDir).find(params.provider, params.model);
	if (!model) throw new Error(`Unknown model: ${params.provider}/${params.model}`);
	if (!model.input?.includes("image")) throw new Error(`Model does not support images: ${params.provider}/${params.model}`);
	const apiKey = requireApiKey(await getApiKeyForModel({
		model,
		cfg: params.cfg,
		agentDir: params.agentDir,
		profileId: params.profile,
		preferredProfile: params.preferredProfile
	}), model.provider);
	authStorage.setRuntimeApiKey(model.provider, apiKey);
	const base64 = params.buffer.toString("base64");
	if (model.provider === "minimax") return {
		text: await minimaxUnderstandImage({
			apiKey,
			prompt: params.prompt ?? "Describe the image.",
			imageDataUrl: `data:${params.mime ?? "image/jpeg"};base64,${base64}`,
			modelBaseUrl: model.baseUrl
		}),
		model: model.id
	};
	return {
		text: coerceImageAssistantText({
			message: await complete(model, { messages: [{
				role: "user",
				content: [{
					type: "text",
					text: params.prompt ?? "Describe the image."
				}, {
					type: "image",
					data: base64,
					mimeType: params.mime ?? "image/jpeg"
				}],
				timestamp: Date.now()
			}] }, {
				apiKey,
				maxTokens: params.maxTokens ?? 512
			}),
			provider: model.provider,
			model: model.id
		}),
		model: model.id
	};
}

//#endregion
export { extractTextFromChatContent as C, isInsideCode as S, stripMinimaxToolCallXml as _, decodeDataUrl as a, stripReasoningTagsFromText as b, extractAssistantText as c, extractThinkingFromTaggedText as d, formatReasoningMessage as f, stripDowngradedToolCallText as g, promoteThinkingTagsToBlocks as h, coerceImageModelConfig as i, extractAssistantThinking as l, isAssistantMessage as m, image_exports as n, resolveProviderVisionModelFromConfig as o, inferToolMetaFromArgs as p, coerceImageAssistantText as r, minimaxUnderstandImage as s, describeImageWithModel as t, extractThinkingFromTaggedStream as u, stripThinkingTagsFromText as v, ensureOpenClawModelsJson as w, findCodeRegions as x, resolveToolDisplay as y };