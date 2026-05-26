import { i as writeJsonFileAtomically, n as readJsonFileWithFallback } from "./json-store-ChgPP2Sf.js";
import { createRequire } from "node:module";
import path from "node:path";
import fs from "node:fs/promises";
import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { promisify } from "node:util";
//#region extensions/acpx/src/process-lease.ts
const OPENCLAW_ACPX_LEASE_ID_ENV = "OPENCLAW_ACPX_LEASE_ID";
const OPENCLAW_GATEWAY_INSTANCE_ID_ENV = "OPENCLAW_GATEWAY_INSTANCE_ID";
const OPENCLAW_ACPX_LEASE_ID_ARG = "--openclaw-acpx-lease-id";
const OPENCLAW_GATEWAY_INSTANCE_ID_ARG = "--openclaw-gateway-instance-id";
const LEASE_FILE = "process-leases.json";
function normalizeLease(value) {
	if (typeof value !== "object" || value === null) return;
	const record = value;
	if (typeof record.leaseId !== "string" || typeof record.gatewayInstanceId !== "string" || typeof record.sessionKey !== "string" || typeof record.wrapperRoot !== "string" || typeof record.wrapperPath !== "string" || typeof record.rootPid !== "number" || typeof record.commandHash !== "string" || typeof record.startedAt !== "number" || ![
		"open",
		"closing",
		"closed",
		"lost"
	].includes(String(record.state))) return;
	return {
		leaseId: record.leaseId,
		gatewayInstanceId: record.gatewayInstanceId,
		sessionKey: record.sessionKey,
		wrapperRoot: record.wrapperRoot,
		wrapperPath: record.wrapperPath,
		rootPid: record.rootPid,
		...typeof record.processGroupId === "number" ? { processGroupId: record.processGroupId } : {},
		commandHash: record.commandHash,
		startedAt: record.startedAt,
		state: record.state
	};
}
async function readLeaseFile(filePath) {
	const { value } = await readJsonFileWithFallback(filePath, {
		version: 1,
		leases: []
	});
	return {
		version: 1,
		leases: Array.isArray(value.leases) ? value.leases.map(normalizeLease).filter((lease) => !!lease) : []
	};
}
function writeLeaseFile(filePath, value) {
	return writeJsonFileAtomically(filePath, value);
}
function createAcpxProcessLeaseStore(params) {
	const filePath = path.join(params.stateDir, LEASE_FILE);
	let updateQueue = Promise.resolve();
	async function update(mutator) {
		const run = updateQueue.then(async () => {
			await fs.mkdir(params.stateDir, { recursive: true });
			await writeLeaseFile(filePath, {
				version: 1,
				leases: mutator((await readLeaseFile(filePath)).leases)
			});
		});
		updateQueue = run.catch(() => {});
		await run;
	}
	async function readCurrent() {
		await updateQueue;
		return await readLeaseFile(filePath);
	}
	return {
		async load(leaseId) {
			return (await readCurrent()).leases.find((lease) => lease.leaseId === leaseId);
		},
		async listOpen(gatewayInstanceId) {
			return (await readCurrent()).leases.filter((lease) => (lease.state === "open" || lease.state === "closing") && (!gatewayInstanceId || lease.gatewayInstanceId === gatewayInstanceId));
		},
		async save(lease) {
			await update((leases) => [...leases.filter((entry) => entry.leaseId !== lease.leaseId), lease]);
		},
		async markState(leaseId, state) {
			await update((leases) => leases.map((lease) => lease.leaseId === leaseId ? {
				...lease,
				state
			} : lease));
		}
	};
}
function createAcpxProcessLeaseId() {
	return randomUUID();
}
function hashAcpxProcessCommand(command) {
	return createHash("sha256").update(command).digest("hex");
}
function quoteEnvValue(value) {
	return /^[A-Za-z0-9_./:=@+-]+$/.test(value) ? value : `'${value.replace(/'/g, "'\\''")}'`;
}
function appendAcpxLeaseArgs(params) {
	return [
		params.command,
		OPENCLAW_ACPX_LEASE_ID_ARG,
		quoteEnvValue(params.leaseId),
		OPENCLAW_GATEWAY_INSTANCE_ID_ARG,
		quoteEnvValue(params.gatewayInstanceId)
	].join(" ");
}
function withAcpxLeaseEnvironment(params) {
	if ((params.platform ?? process.platform) === "win32") return appendAcpxLeaseArgs(params);
	return [
		"env",
		`${OPENCLAW_ACPX_LEASE_ID_ENV}=${quoteEnvValue(params.leaseId)}`,
		`${OPENCLAW_GATEWAY_INSTANCE_ID_ENV}=${quoteEnvValue(params.gatewayInstanceId)}`,
		appendAcpxLeaseArgs(params)
	].join(" ");
}
//#endregion
//#region extensions/acpx/src/command-line.ts
function quoteCommandPart(value) {
	return JSON.stringify(value);
}
function splitCommandParts(value) {
	const parts = [];
	let current = "";
	let quote = null;
	let escaping = false;
	for (const ch of value) {
		if (escaping) {
			current += ch;
			escaping = false;
			continue;
		}
		if (ch === "\\" && quote !== "'") {
			escaping = true;
			continue;
		}
		if (quote) {
			if (ch === quote) quote = null;
			else current += ch;
			continue;
		}
		if (ch === "'" || ch === "\"") {
			quote = ch;
			continue;
		}
		if (/\s/.test(ch)) {
			if (current) {
				parts.push(current);
				current = "";
			}
			continue;
		}
		current += ch;
	}
	if (escaping) current += "\\";
	if (current) parts.push(current);
	return parts;
}
//#endregion
//#region extensions/acpx/src/process-reaper.ts
const execFileAsync = promisify(execFile);
const requireFromHere = createRequire(import.meta.url);
const GENERATED_WRAPPER_BASENAMES = new Set(["codex-acp-wrapper.mjs", "claude-agent-acp-wrapper.mjs"]);
const OPENCLAW_PLUGIN_DEPS_MARKER = "/plugin-runtime-deps/";
const OWNED_ACP_PACKAGE_NAMES = [
	"@zed-industries/codex-acp",
	"@zed-industries/codex-acp-darwin-arm64",
	"@zed-industries/codex-acp-darwin-x64",
	"@zed-industries/codex-acp-linux-arm64",
	"@zed-industries/codex-acp-linux-x64",
	"@zed-industries/codex-acp-win32-arm64",
	"@zed-industries/codex-acp-win32-x64",
	"@agentclientprotocol/claude-agent-acp",
	"acpx"
];
const ACP_PACKAGE_MARKERS = [
	"/@zed-industries/codex-acp/",
	"/@agentclientprotocol/claude-agent-acp/",
	"/acpx/dist/"
];
function normalizePathLike(value) {
	return value.replaceAll("\\", "/");
}
function resolvePackageRoot(packageName) {
	try {
		return normalizePathLike(path.dirname(requireFromHere.resolve(`${packageName}/package.json`)));
	} catch {
		return;
	}
}
const OWNED_ACP_PACKAGE_ROOTS = OWNED_ACP_PACKAGE_NAMES.map(resolvePackageRoot).filter((root) => Boolean(root));
function commandBelongsToResolvedAcpPackage(command) {
	return OWNED_ACP_PACKAGE_ROOTS.some((root) => command.includes(`${root}/`));
}
function commandMentionsGeneratedWrapper(command) {
	return Array.from(GENERATED_WRAPPER_BASENAMES).some((basename) => command.includes(basename));
}
function commandWrapperBelongsToRoot(command, wrapperRoot) {
	if (!wrapperRoot) return true;
	const normalizedCommand = normalizePathLike(command);
	const normalizedRoot = normalizePathLike(wrapperRoot).replace(/\/+$/, "");
	return Array.from(GENERATED_WRAPPER_BASENAMES).some((basename) => normalizedCommand.includes(`${normalizedRoot}/${basename}`));
}
function isOpenClawLeaseAwareAcpxProcessCommand(params) {
	const command = params.command?.trim();
	if (!command) return false;
	const normalized = normalizePathLike(command);
	return commandMentionsGeneratedWrapper(normalized) && commandWrapperBelongsToRoot(normalized, params.wrapperRoot);
}
function commandsReferToSameRootCommand(liveCommand, storedCommand) {
	if (!storedCommand?.trim()) return true;
	return normalizePathLike(liveCommand).trim() === normalizePathLike(storedCommand).trim();
}
function commandOptionEquals(parts, option, expected) {
	if (!expected) return true;
	const index = parts.indexOf(option);
	return index >= 0 && parts[index + 1] === expected;
}
function liveCommandMatchesLeaseIdentity(params) {
	if (!params.expectedLeaseId && !params.expectedGatewayInstanceId) return true;
	const parts = splitCommandParts(params.command ?? "");
	return commandOptionEquals(parts, "--openclaw-acpx-lease-id", params.expectedLeaseId) && commandOptionEquals(parts, "--openclaw-gateway-instance-id", params.expectedGatewayInstanceId);
}
function isOpenClawOwnedAcpxProcessCommand(params) {
	const command = params.command?.trim();
	if (!command) return false;
	const normalized = normalizePathLike(command);
	if (isOpenClawLeaseAwareAcpxProcessCommand({
		command: normalized,
		wrapperRoot: params.wrapperRoot
	})) return true;
	if (commandBelongsToResolvedAcpPackage(normalized)) return true;
	if (!normalized.includes(OPENCLAW_PLUGIN_DEPS_MARKER)) return false;
	return ACP_PACKAGE_MARKERS.some((marker) => normalized.includes(marker));
}
function parseProcessList(stdout) {
	const processes = [];
	for (const line of stdout.split(/\r?\n/)) {
		const match = /^\s*(?<pid>\d+)\s+(?<ppid>\d+)\s+(?<command>.+?)\s*$/.exec(line);
		if (!match?.groups) continue;
		processes.push({
			pid: Number.parseInt(match.groups.pid, 10),
			ppid: Number.parseInt(match.groups.ppid, 10),
			command: match.groups.command
		});
	}
	return processes;
}
async function listPlatformProcesses() {
	if (process.platform === "win32") return [];
	const { stdout } = await execFileAsync("ps", ["-axo", "pid=,ppid=,command="], { maxBuffer: 8 * 1024 * 1024 });
	return parseProcessList(stdout);
}
function collectProcessTree(processes, rootPid) {
	const childrenByParent = /* @__PURE__ */ new Map();
	for (const processInfo of processes) {
		const children = childrenByParent.get(processInfo.ppid) ?? [];
		children.push(processInfo);
		childrenByParent.set(processInfo.ppid, children);
	}
	const root = new Map(processes.map((processInfo) => [processInfo.pid, processInfo])).get(rootPid);
	const collected = [];
	if (root) collected.push(root);
	const queue = [...childrenByParent.get(rootPid) ?? []];
	while (queue.length > 0) {
		const next = queue.shift();
		if (!next || collected.some((processInfo) => processInfo.pid === next.pid)) continue;
		collected.push(next);
		queue.push(...childrenByParent.get(next.pid) ?? []);
	}
	return collected;
}
function uniquePids(processes) {
	return Array.from(new Set(processes.map((processInfo) => processInfo.pid).filter((pid) => Number.isInteger(pid) && pid > 0 && pid !== process.pid)));
}
function isProcessAlive(pid) {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}
async function terminatePids(pids, deps) {
	const killProcess = deps?.killProcess ?? ((pid, signal) => process.kill(pid, signal));
	const sleep = deps?.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
	const terminated = [];
	for (const pid of pids) try {
		killProcess(pid, "SIGTERM");
		terminated.push(pid);
	} catch {}
	if (terminated.length === 0) return terminated;
	await sleep(750);
	for (const pid of terminated) if (deps?.killProcess || isProcessAlive(pid)) try {
		killProcess(pid, "SIGKILL");
	} catch {}
	return terminated;
}
async function cleanupOpenClawOwnedAcpxProcessTree(params) {
	const rootPid = params.rootPid;
	if (!rootPid || rootPid <= 0 || rootPid === process.pid) return {
		inspectedPids: [],
		terminatedPids: [],
		skippedReason: "missing-root"
	};
	let processes = [];
	try {
		processes = await (params.deps?.listProcesses ?? listPlatformProcesses)();
	} catch {
		processes = [];
	}
	const listedTree = collectProcessTree(processes, rootPid);
	if (listedTree.length === 0) return {
		inspectedPids: [],
		terminatedPids: [],
		skippedReason: "unverified-root"
	};
	const rootCommand = listedTree[0]?.command ?? params.rootCommand;
	const liveCommandWasGeneratedWrapper = commandMentionsGeneratedWrapper(normalizePathLike(rootCommand ?? ""));
	const storedCommandWasGeneratedWrapper = commandMentionsGeneratedWrapper(normalizePathLike(params.rootCommand ?? ""));
	if (!liveCommandWasGeneratedWrapper && storedCommandWasGeneratedWrapper) return {
		inspectedPids: listedTree.map((processInfo) => processInfo.pid),
		terminatedPids: [],
		skippedReason: "not-openclaw-owned"
	};
	if (!liveCommandWasGeneratedWrapper && !commandsReferToSameRootCommand(rootCommand ?? "", params.rootCommand)) return {
		inspectedPids: listedTree.map((processInfo) => processInfo.pid),
		terminatedPids: [],
		skippedReason: "not-openclaw-owned"
	};
	if (!isOpenClawOwnedAcpxProcessCommand({
		command: rootCommand,
		wrapperRoot: params.wrapperRoot
	})) return {
		inspectedPids: listedTree.map((processInfo) => processInfo.pid),
		terminatedPids: [],
		skippedReason: "not-openclaw-owned"
	};
	if (!liveCommandMatchesLeaseIdentity({
		command: rootCommand,
		expectedLeaseId: params.expectedLeaseId,
		expectedGatewayInstanceId: params.expectedGatewayInstanceId
	})) return {
		inspectedPids: listedTree.map((processInfo) => processInfo.pid),
		terminatedPids: [],
		skippedReason: "not-openclaw-owned"
	};
	const pids = uniquePids(listedTree.toReversed());
	return {
		inspectedPids: uniquePids(listedTree),
		terminatedPids: await terminatePids(pids, params.deps)
	};
}
async function reapStaleOpenClawOwnedAcpxOrphans(params) {
	if (process.platform === "win32") return {
		inspectedPids: [],
		terminatedPids: [],
		skippedReason: "unsupported-platform"
	};
	let processes;
	try {
		processes = await (params.deps?.listProcesses ?? listPlatformProcesses)();
	} catch {
		return {
			inspectedPids: [],
			terminatedPids: [],
			skippedReason: "process-list-unavailable"
		};
	}
	const orphanTrees = processes.filter((processInfo) => processInfo.ppid === 1 && isOpenClawOwnedAcpxProcessCommand({
		command: processInfo.command,
		wrapperRoot: params.wrapperRoot
	})).map((orphan) => collectProcessTree(processes, orphan.pid));
	return {
		inspectedPids: uniquePids(orphanTrees.flat()),
		terminatedPids: await terminatePids(uniquePids(orphanTrees.flatMap((tree) => tree.toReversed())), params.deps)
	};
}
//#endregion
export { splitCommandParts as a, OPENCLAW_GATEWAY_INSTANCE_ID_ARG as c, hashAcpxProcessCommand as d, withAcpxLeaseEnvironment as f, quoteCommandPart as i, createAcpxProcessLeaseId as l, isOpenClawLeaseAwareAcpxProcessCommand as n, OPENCLAW_ACPX_LEASE_ID_ARG as o, reapStaleOpenClawOwnedAcpxOrphans as r, OPENCLAW_ACPX_LEASE_ID_ENV as s, cleanupOpenClawOwnedAcpxProcessTree as t, createAcpxProcessLeaseStore as u };
