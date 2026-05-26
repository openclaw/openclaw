import { a as normalizeLowercaseStringOrEmpty, c as normalizeOptionalString } from "./string-coerce-DyL154ka.js";
import { r as asOptionalObjectRecord } from "./record-coerce-aMlBWINm.js";
//#region src/agents/tool-display-exec-shell.ts
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
	return normalizeLowercaseStringOrEmpty(cleaned.split(/[/]/).at(-1) ?? cleaned);
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
//#endregion
//#region src/agents/tool-display-exec.ts
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
function normalizePathForDisplay(path) {
	return path.replace(/\\/g, "/").replace(/\/+$/g, "");
}
function classifyWorkspacePath(path) {
	const segments = normalizePathForDisplay(path).split("/").filter(Boolean);
	if (segments.length === 0) return;
	for (let index = 0; index < segments.length; index += 1) {
		const segment = segments[index];
		if (!segment) continue;
		if (segment === ".openclaw" && segments[index + 1] === "workspace") return "agent";
		if (segment === ".openclaw" && segments[index + 1] === "sandboxes") return "sandbox";
		if (/[-_]workspace$/i.test(segment) && segment.toLowerCase() !== "workspace") return "agent";
		if (/^workspace[-_]/i.test(segment)) return "agent";
	}
	if (segments.includes("Projects") || segments.includes("projects")) return "repo";
	if (segments.at(-1)?.toLowerCase() === "workspace") return "workspace";
}
function formatCwdSuffix(cwd) {
	const workspace = classifyWorkspacePath(cwd);
	if (workspace === "sandbox") return;
	return workspace ? `(${workspace})` : `(in ${cwd})`;
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
		allGeneric: summaries.every((summary) => isGenericSummary(summary))
	};
}
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
function isGenericSummary(summary) {
	if (summary === "run command") return true;
	if (summary.startsWith("run ")) return !KNOWN_SUMMARY_PREFIXES.some((prefix) => summary.startsWith(prefix));
	return false;
}
function compactRawCommand(raw, maxLength = 120) {
	const oneLine = raw.replace(/\s*\n\s*/g, " ").replace(/\s{2,}/g, " ").trim();
	if (oneLine.length <= maxLength) return oneLine;
	return `${oneLine.slice(0, Math.max(0, maxLength - 1))}…`;
}
function resolveExecDetail(args, options) {
	const record = asOptionalObjectRecord(args);
	if (!record) return;
	const raw = typeof record.command === "string" ? record.command.trim() : void 0;
	if (!raw) return;
	const unwrapped = unwrapShellWrapper(raw);
	const result = summarizeExecCommand(unwrapped) ?? summarizeExecCommand(raw);
	const summary = result?.text || "run command";
	const cwd = (typeof record.workdir === "string" ? record.workdir : typeof record.cwd === "string" ? record.cwd : void 0)?.trim() || result?.chdirPath || void 0;
	const compact = compactRawCommand(unwrapped);
	const cwdSuffix = cwd ? formatCwdSuffix(cwd) : void 0;
	if (result?.allGeneric !== false && isGenericSummary(summary)) return cwdSuffix ? `${compact} ${cwdSuffix}` : compact;
	const displaySummary = cwdSuffix ? `${summary} ${cwdSuffix}` : summary;
	if (options?.detailMode !== "explain" && compact && compact !== displaySummary && compact !== summary) return `${displaySummary} · \`${compact}\``;
	return displaySummary;
}
//#endregion
//#region src/agents/tool-display-common.ts
function normalizeToolName(name) {
	return (name ?? "tool").trim();
}
function defaultTitle(name) {
	const cleaned = name.replace(/_/g, " ").trim();
	if (!cleaned) return "Tool";
	const parts = [];
	for (const part of cleaned.split(/\s+/)) parts.push(part.length <= 2 && part.toUpperCase() === part ? part : `${part.at(0)?.toUpperCase() ?? ""}${part.slice(1)}`);
	return parts.join(" ");
}
function normalizeVerb(value) {
	const trimmed = normalizeOptionalString(value);
	if (!trimmed) return;
	return trimmed.replace(/_/g, " ");
}
function resolveActionArg(args) {
	if (!args || typeof args !== "object") return;
	const actionRaw = args.action;
	if (typeof actionRaw !== "string") return;
	return normalizeOptionalString(actionRaw) || void 0;
}
function resolveToolVerbAndDetailForArgs(params) {
	return resolveToolVerbAndDetail({
		toolKey: params.toolKey,
		args: params.args,
		meta: params.meta,
		action: resolveActionArg(params.args),
		spec: params.spec,
		fallbackDetailKeys: params.fallbackDetailKeys,
		detailMode: params.detailMode,
		toolDetailMode: params.toolDetailMode,
		detailCoerce: params.detailCoerce,
		detailMaxEntries: params.detailMaxEntries,
		detailFormatKey: params.detailFormatKey
	});
}
function coerceDisplayValue(value, opts = {}) {
	const maxStringChars = opts.maxStringChars ?? 160;
	const maxArrayEntries = opts.maxArrayEntries ?? 3;
	if (value === null || value === void 0) return;
	if (typeof value === "string") {
		const trimmed = value.trim();
		if (!trimmed) return;
		const firstLine = normalizeOptionalString(trimmed.split(/\r?\n/)[0]) ?? "";
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
		const values = [];
		let displayValueCount = 0;
		for (const item of value) {
			const display = coerceDisplayValue(item, opts);
			if (!display) continue;
			displayValueCount += 1;
			if (values.length < maxArrayEntries) values.push(display);
		}
		if (displayValueCount === 0) return;
		const preview = values.join(", ");
		return displayValueCount > maxArrayEntries ? `${preview}…` : preview;
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
	let last = "";
	for (const segment of raw.split(".")) if (segment) last = segment;
	last ||= raw;
	const override = overrides[last];
	if (override) return override;
	return normalizeLowercaseStringOrEmpty(last.replace(/_/g, " ").replace(/-/g, " ").replace(/([a-z0-9])([A-Z])/g, "$1 $2")) || normalizeLowercaseStringOrEmpty(last);
}
function resolvePathArg(args) {
	const record = asOptionalObjectRecord(args);
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
	const record = asOptionalObjectRecord(args);
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
	const record = asOptionalObjectRecord(args);
	if (!record) return;
	const path = resolvePathArg(record) ?? normalizeOptionalString(record.url);
	if (!path) return;
	if (toolKey === "attach") return `from ${path}`;
	const destinationPrefix = toolKey === "edit" ? "in" : "to";
	const content = typeof record.content === "string" ? record.content : typeof record.newText === "string" ? record.newText : typeof record.new_string === "string" ? record.new_string : void 0;
	if (content && content.length > 0) return `${destinationPrefix} ${path} (${content.length} chars)`;
	return `${destinationPrefix} ${path}`;
}
function resolveWebSearchDetail(args) {
	const record = asOptionalObjectRecord(args);
	if (!record) return;
	const queries = collectWebSearchQueries(record);
	const count = typeof record.count === "number" && Number.isFinite(record.count) && record.count > 0 ? Math.floor(record.count) : typeof record.max_results === "number" && Number.isFinite(record.max_results) && record.max_results > 0 ? Math.floor(record.max_results) : typeof record.num_results === "number" && Number.isFinite(record.num_results) && record.num_results > 0 ? Math.floor(record.num_results) : typeof record.limit === "number" && Number.isFinite(record.limit) && record.limit > 0 ? Math.floor(record.limit) : typeof record.top_k === "number" && Number.isFinite(record.top_k) && record.top_k > 0 ? Math.floor(record.top_k) : void 0;
	if (queries.length === 0) return;
	const displayedQueries = queries.slice(0, 3).map((query) => `"${query}"`);
	const queryText = queries.length > displayedQueries.length ? `${displayedQueries.join(", ")}…` : displayedQueries.join(", ");
	return count !== void 0 ? `for ${queryText} (top ${count})` : `for ${queryText}`;
}
function collectWebSearchQueries(record) {
	const queries = [];
	const seen = /* @__PURE__ */ new Set();
	const add = (value) => {
		const normalized = normalizeOptionalString(value);
		if (!normalized || seen.has(normalized)) return;
		seen.add(normalized);
		queries.push(normalized);
	};
	add(record.query);
	add(record.q);
	add(record.search);
	add(record.input);
	for (const key of [
		"search_query",
		"image_query",
		"queries"
	]) {
		const value = record[key];
		if (!Array.isArray(value)) continue;
		for (const entry of value) {
			if (typeof entry === "string") {
				add(entry);
				continue;
			}
			const entryRecord = asOptionalObjectRecord(entry);
			if (!entryRecord) continue;
			add(entryRecord.query);
			add(entryRecord.q);
			add(entryRecord.search);
		}
	}
	return queries;
}
function parseToolSearchCall(code) {
	const prefixMatch = code.match(/openclaw\.tools\.call\s*\(\s*/s);
	if (!prefixMatch || prefixMatch.index === void 0) return;
	const rest = code.slice(prefixMatch.index + prefixMatch[0].length);
	const targetMatch = rest.match(/^("[^"]{1,240}"|'[^']{1,240}'|[^,)\s]{1,240})/s);
	if (!targetMatch?.[1]) return;
	const afterTarget = rest.slice(targetMatch[0].length);
	const commaIndex = afterTarget.indexOf(",");
	if (commaIndex < 0) return { target: targetMatch[1] };
	const args = afterTarget.slice(commaIndex + 1);
	return {
		target: targetMatch[1],
		args
	};
}
function normalizeToolSearchDisplayToolName(toolName) {
	const value = normalizeOptionalString(toolName);
	if (!value) return;
	return normalizeOptionalString(value.match(/^(?:openclaw|mcp|client):[^:]+:(.+)$/s)?.[1]) ?? value;
}
function collectToolSearchDescribeBindings(code) {
	const bindings = /* @__PURE__ */ new Map();
	for (const match of code.matchAll(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:await\s+)?openclaw\.tools\.describe\s*\(\s*("[^"]{1,240}"|'[^']{1,240}')\s*(?:,|\))/gs)) {
		const variableName = match[1];
		const target = summarizeToolSearchTarget(match[2]);
		if (variableName && target) bindings.set(variableName, target);
	}
	return bindings;
}
function resolveToolSearchCallTarget(code, rawTarget) {
	const target = normalizeOptionalString(rawTarget);
	if (!target) return;
	const idReference = target.match(/^([A-Za-z_$][\w$]*)\.id\b/s);
	if (idReference?.[1]) {
		const describedTarget = collectToolSearchDescribeBindings(code).get(idReference[1]);
		if (describedTarget) return describedTarget;
	}
	return summarizeToolSearchTarget(target);
}
function summarizeToolSearchTarget(raw) {
	const value = normalizeOptionalString(raw);
	if (!value) return;
	const literalMatch = value.match(/^[\s]*["']([^"']{1,160})["'][\s]*$/s);
	if (literalMatch?.[1]) return normalizeOptionalString(literalMatch[1]);
	if (value.match(/\.id\b/)) return normalizeOptionalString(value.replace(/\.id\b.*/s, ""));
	const namePropertyMatch = value.match(/name\s*:\s*["']([^"']{1,120})["']/s);
	if (namePropertyMatch?.[1]) return normalizeOptionalString(namePropertyMatch[1]);
	const compact = value.replace(/\s+/g, " ").trim();
	return compact.length <= 80 ? compact : void 0;
}
function parseToolSearchCallArgs(raw) {
	const source = extractObjectLiteralSource(raw);
	if (!source) return;
	const args = {};
	for (const match of source.matchAll(/(?:^|[,{\s])([A-Za-z_$][\w$]*)\s*:\s*("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|true|false|null|-?\d+(?:\.\d+)?)/g)) {
		const key = match[1];
		const value = match[2];
		if (!key || value === void 0) continue;
		args[key] = parseSimpleToolSearchArgValue(value);
	}
	return Object.keys(args).length > 0 ? args : void 0;
}
function extractObjectLiteralSource(raw) {
	const value = normalizeOptionalString(raw);
	if (!value) return;
	const start = value.indexOf("{");
	if (start < 0) return;
	let depth = 0;
	let quote;
	let escaped = false;
	for (let i = start; i < value.length; i += 1) {
		const char = value[i];
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
		if (char === "{") {
			depth += 1;
			continue;
		}
		if (char === "}") {
			depth -= 1;
			if (depth === 0) return value.slice(start, i + 1);
		}
	}
}
function parseSimpleToolSearchArgValue(raw) {
	if (raw === "true") return true;
	if (raw === "false") return false;
	if (raw === "null") return null;
	if (/^-?\d+(?:\.\d+)?$/.test(raw)) return Number(raw);
	const quote = raw[0];
	const inner = raw.slice(1, -1);
	if (quote === "\"") try {
		return JSON.parse(raw);
	} catch {
		return inner;
	}
	return inner.replace(/\\'/g, "'").replace(/\\\\/g, "\\");
}
function summarizeToolSearchCallInput(raw) {
	const value = normalizeOptionalString(raw)?.replace(/[);\s]+$/g, "").trim();
	if (!value) return;
	const queryMatch = value.match(/query\s*:\s*["']([^"']{1,80})["']/s);
	if (queryMatch?.[1]) return "query " + queryMatch[1].trim();
	const actionMatch = value.match(/action\s*:\s*["']([^"']{1,80})["']/s);
	if (actionMatch?.[1]) return normalizeOptionalString(actionMatch[1]);
	const commandMatch = value.match(/command\s*:\s*["']([^"'\n]{1,120})["']/s);
	if (commandMatch?.[1]) return normalizeOptionalString(commandMatch[1]);
	const sessionMatch = value.match(/sessionId\s*:\s*["']([^"']{1,80})["']/s);
	if (sessionMatch?.[1]) return "session " + sessionMatch[1].trim();
	const idMatch = value.match(/id\s*:\s*["']([^"']{1,80})["']/s);
	if (idMatch?.[1]) return idMatch[1].trim();
}
function resolveToolSearchCodeDisplayTarget(args) {
	const record = asOptionalObjectRecord(args);
	if (!record || typeof record.code !== "string") return;
	const code = record.code;
	const call = parseToolSearchCall(code);
	if (call) {
		const toolName = resolveToolSearchCallTarget(code, call.target);
		if (!toolName) return {
			toolName: "tool_search_code",
			detail: "call selected tool",
			bridgeVerb: "call"
		};
		return {
			toolName,
			displayToolName: normalizeToolSearchDisplayToolName(toolName),
			displayArgs: parseToolSearchCallArgs(call.args),
			detail: summarizeToolSearchCallInput(call.args),
			bridgeVerb: "call"
		};
	}
	const describeMatch = code.match(/openclaw\.tools\.describe\s*\(\s*([^)]+?)\s*(?:,|\))/s);
	if (describeMatch) {
		const toolName = summarizeToolSearchTarget(describeMatch[1]);
		return toolName ? {
			toolName,
			detail: "describe via tool search",
			bridgeVerb: "describe"
		} : {
			toolName: "tool_search_code",
			detail: "describe selected tool",
			bridgeVerb: "describe"
		};
	}
	const searchMatch = code.match(/openclaw\.tools\.search\s*\(\s*([^)]+?)\s*(?:,|\))/s);
	if (searchMatch) {
		const query = summarizeToolSearchTarget(searchMatch[1]);
		return {
			toolName: "tool_search_code",
			detail: query ? "search " + query : "search tools",
			bridgeVerb: "search"
		};
	}
	return {
		toolName: "tool_search_code",
		detail: "run bridge code"
	};
}
function resolveToolSearchCodeDetail(args) {
	return resolveToolSearchCodeDisplayTarget(args)?.detail;
}
function resolveWebFetchDetail(args) {
	const record = asOptionalObjectRecord(args);
	if (!record) return;
	const url = normalizeOptionalString(record.url);
	if (!url) return;
	const mode = normalizeOptionalString(record.extractMode);
	const maxChars = typeof record.maxChars === "number" && Number.isFinite(record.maxChars) && record.maxChars > 0 ? Math.floor(record.maxChars) : void 0;
	let suffix = "";
	if (mode) suffix = `mode ${mode}`;
	if (maxChars !== void 0) suffix = suffix ? `${suffix}, max ${maxChars} chars` : `max ${maxChars} chars`;
	return suffix ? `from ${url} (${suffix})` : `from ${url}`;
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
	const maxEntries = opts.maxEntries ?? 8;
	const parts = [];
	for (let index = 0; index < unique.length && index < maxEntries; index += 1) {
		const entry = unique[index];
		if (entry) parts.push(`${entry.label} ${entry.value}`);
	}
	return parts.join(" · ");
}
function resolveToolVerbAndDetail(params) {
	const actionSpec = resolveActionSpec(params.spec, params.action);
	const fallbackVerb = params.toolKey === "web_search" ? "search" : params.toolKey === "web_fetch" ? "fetch" : params.toolKey.replace(/_/g, " ").replace(/\./g, " ");
	const verb = normalizeVerb(actionSpec?.label ?? params.action ?? fallbackVerb);
	let detail;
	if (params.toolKey === "exec" || params.toolKey === "bash") detail = resolveExecDetail(params.args, { detailMode: params.toolDetailMode });
	if (!detail && params.toolKey === "read") detail = resolveReadDetail(params.args);
	if (!detail && (params.toolKey === "write" || params.toolKey === "edit" || params.toolKey === "attach")) detail = resolveWriteDetail(params.toolKey, params.args);
	if (!detail && params.toolKey === "web_search") detail = resolveWebSearchDetail(params.args);
	if (!detail && params.toolKey === "web_fetch") detail = resolveWebFetchDetail(params.args);
	if (!detail && params.toolKey === "tool_search_code") detail = resolveToolSearchCodeDetail(params.args);
	const detailKeys = actionSpec?.detailKeys ?? params.spec?.detailKeys ?? params.fallbackDetailKeys ?? [];
	if (!detail && detailKeys.length > 0) detail = resolveDetailFromKeys(params.args, detailKeys, {
		mode: params.detailMode,
		coerce: params.detailCoerce,
		maxEntries: params.detailMaxEntries,
		formatKey: params.detailFormatKey
	});
	if (!detail && params.meta) detail = params.meta;
	return {
		verb,
		detail
	};
}
function formatToolDetailText(detail, opts = {}) {
	if (!detail) return;
	const normalized = detail.includes(" · ") ? (() => {
		const parts = [];
		for (const part of detail.split(" · ")) {
			const trimmed = part.trim();
			if (trimmed) parts.push(trimmed);
		}
		return parts.join(", ");
	})() : detail;
	if (!normalized) return;
	return opts.prefixWithWith ? `with ${normalized}` : normalized;
}
//#endregion
export { resolveToolSearchCodeDisplayTarget as a, normalizeToolName as i, formatDetailKey as n, resolveToolVerbAndDetailForArgs as o, formatToolDetailText as r, defaultTitle as t };
