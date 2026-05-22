import { a as normalizeLowercaseStringOrEmpty, c as normalizeOptionalString } from "./string-coerce-Bje8XVt9.js";
import { T as isValueToken, w as consumeRootOptionToken } from "./argv-DLAsQBp6.js";
import { o as resolveRequiredHomeDir } from "./home-dir-g5LU3LmA.js";
import { t as resolveCliArgvInvocation } from "./argv-invocation-BqQrcVeY.js";
import { t as isValidProfileName } from "./profile-utils-7b3ZHGpe.js";
import path from "node:path";
import os from "node:os";
import { spawnSync } from "node:child_process";
import { isIP } from "node:net";
//#region src/cli/root-option-forward.ts
function forwardConsumedCliRootOption(args, index, out) {
	const consumedRootOption = consumeRootOptionToken(args, index);
	if (consumedRootOption <= 0) return 0;
	for (let offset = 0; offset < consumedRootOption; offset += 1) {
		const token = args[index + offset];
		if (token !== void 0) out.push(token);
	}
	return consumedRootOption;
}
//#endregion
//#region src/cli/root-option-scan.ts
function scanCliRootOptions(argv, visit) {
	if (argv.length < 2) return {
		ok: true,
		argv
	};
	const out = argv.slice(0, 2);
	const args = argv.slice(2);
	for (let i = 0; i < args.length; i += 1) {
		const arg = args[i];
		if (arg === void 0) continue;
		if (arg === "--") {
			out.push(arg, ...args.slice(i + 1));
			break;
		}
		const visited = visit({
			arg,
			args,
			index: i,
			out
		});
		if (visited.kind === "error") return {
			ok: false,
			error: visited.error
		};
		if (visited.kind === "handled") {
			if (visited.consumedNext) i += 1;
			continue;
		}
		const consumedRootOption = forwardConsumedCliRootOption(args, i, out);
		if (consumedRootOption > 0) {
			i += consumedRootOption - 1;
			continue;
		}
		out.push(arg);
	}
	return {
		ok: true,
		argv: out
	};
}
//#endregion
//#region src/cli/root-option-value.ts
function takeCliRootOptionValue(raw, next) {
	if (raw.includes("=")) {
		const [, value] = raw.split("=", 2);
		return {
			value: (value ?? "").trim() || null,
			consumedNext: false
		};
	}
	const consumedNext = isValueToken(next);
	return {
		value: (consumedNext ? next.trim() : "") || null,
		consumedNext
	};
}
//#endregion
//#region src/cli/container-target.ts
const CONTAINER_ALLOW_LOOPBACK_PROXY_URL_ENV = "OPENCLAW_CONTAINER_ALLOW_LOOPBACK_PROXY_URL";
function parseCliContainerArgs(argv) {
	let container = null;
	const scanned = scanCliRootOptions(argv, ({ arg, args, index }) => {
		if (arg === "--container" || arg.startsWith("--container=")) {
			const next = args[index + 1];
			const { value, consumedNext } = takeCliRootOptionValue(arg, next);
			if (!value) return {
				kind: "error",
				error: "--container requires a value"
			};
			container = value;
			return {
				kind: "handled",
				consumedNext
			};
		}
		return { kind: "pass" };
	});
	if (!scanned.ok) return scanned;
	return {
		ok: true,
		container,
		argv: scanned.argv
	};
}
function resolveCliContainerTarget(argv, env = process.env) {
	const parsed = parseCliContainerArgs(argv);
	if (!parsed.ok) throw new Error(parsed.error);
	return parsed.container ?? normalizeOptionalString(env.OPENCLAW_CONTAINER) ?? null;
}
function isContainerRunning(params) {
	const result = params.deps.spawnSync(params.exec.command, [
		...params.exec.argsPrefix,
		"inspect",
		"--format",
		"{{.State.Running}}",
		params.containerName
	], params.exec.command === "sudo" ? {
		encoding: "utf8",
		stdio: [
			"inherit",
			"pipe",
			"inherit"
		]
	} : { encoding: "utf8" });
	return result.status === 0 && result.stdout.trim() === "true";
}
function candidateContainerRuntimes() {
	return [{
		runtime: "podman",
		command: "podman",
		argsPrefix: []
	}, {
		runtime: "docker",
		command: "docker",
		argsPrefix: []
	}];
}
function resolveRunningContainer(params) {
	const matches = [];
	const candidates = candidateContainerRuntimes();
	for (const exec of candidates) if (isContainerRunning({
		exec,
		containerName: params.containerName,
		deps: params.deps
	})) {
		matches.push({
			...exec,
			containerName: params.containerName
		});
		if (exec.runtime === "docker") break;
	}
	if (matches.length === 0) return null;
	if (matches.length > 1) {
		const runtimes = matches.map((match) => match.runtime).join(", ");
		throw new Error(`Container "${params.containerName}" is running under multiple runtimes (${runtimes}); use a unique container name.`);
	}
	return matches[0];
}
function buildContainerExecArgs(params) {
	const envFlag = params.exec.runtime === "docker" ? "-e" : "--env";
	const proxyUrl = normalizeOptionalString(params.env.OPENCLAW_PROXY_URL);
	if (proxyUrl) assertContainerProxyUrlIsReachable(proxyUrl, params.env);
	const proxyEnvArgs = proxyUrl ? [envFlag, `OPENCLAW_PROXY_URL=${proxyUrl}`] : [];
	const interactiveFlags = ["-i", ...params.stdinIsTTY && params.stdoutIsTTY ? ["-t"] : []];
	return [
		...params.exec.argsPrefix,
		"exec",
		...interactiveFlags,
		envFlag,
		`OPENCLAW_CONTAINER_HINT=${params.containerName}`,
		envFlag,
		"OPENCLAW_CLI_CONTAINER_BYPASS=1",
		...proxyEnvArgs,
		params.containerName,
		"openclaw",
		...params.argv
	];
}
function assertContainerProxyUrlIsReachable(proxyUrl, env) {
	if (env[CONTAINER_ALLOW_LOOPBACK_PROXY_URL_ENV] === "1") return;
	let parsed;
	try {
		parsed = new URL(proxyUrl);
	} catch {
		return;
	}
	if (!isLoopbackProxyHostname(parsed.hostname)) return;
	throw new Error(`OPENCLAW_PROXY_URL=${redactProxyUrlForMessage(proxyUrl)} is loopback; 127.0.0.1 inside a container points at the container, not the host. Use a container-reachable proxy address, or set ${CONTAINER_ALLOW_LOOPBACK_PROXY_URL_ENV}=1 if this is intentional.`);
}
function isLoopbackProxyHostname(hostname) {
	const normalizedHostname = hostname.toLowerCase().replace(/\.+$/, "");
	if (normalizedHostname === "localhost") return true;
	if (isIP(normalizedHostname) === 4) return normalizedHostname.split(".", 1)[0] === "127";
	const ipv6Hostname = normalizedHostname.replace(/^\[|\]$/g, "");
	if (isIP(ipv6Hostname) !== 6) return false;
	if (ipv6Hostname === "::1" || ipv6Hostname === "0:0:0:0:0:0:0:1") return true;
	const mapped = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(ipv6Hostname);
	if (!mapped) return false;
	const high = Number.parseInt(mapped[1], 16);
	return Number.isInteger(high) && high >= 32512 && high <= 32767;
}
function redactProxyUrlForMessage(raw) {
	try {
		const url = new URL(raw);
		if (url.username || url.password) {
			url.username = "redacted";
			url.password = url.password ? "redacted" : "";
		}
		url.search = "";
		url.hash = "";
		return url.toString();
	} catch {
		return "<invalid URL>";
	}
}
function buildContainerExecEnv(env) {
	const next = { ...env };
	delete next.OPENCLAW_PROFILE;
	delete next.OPENCLAW_GATEWAY_PORT;
	delete next.OPENCLAW_GATEWAY_URL;
	delete next.OPENCLAW_GATEWAY_TOKEN;
	delete next.OPENCLAW_GATEWAY_PASSWORD;
	next.OPENCLAW_CONTAINER = "";
	return next;
}
function isBlockedContainerCommand(argv) {
	if (resolveCliArgvInvocation([
		"node",
		"openclaw",
		...argv
	]).primary === "update") return true;
	for (let i = 0; i < argv.length; i += 1) {
		const arg = argv[i];
		if (!arg || arg === "--") return false;
		if (arg === "--update") return true;
		const consumedRootOption = consumeRootOptionToken(argv, i);
		if (consumedRootOption > 0) {
			i += consumedRootOption - 1;
			continue;
		}
		if (!arg.startsWith("-")) return false;
	}
	return false;
}
function maybeRunCliInContainer(argv, deps) {
	const resolvedDeps = {
		env: deps?.env ?? process.env,
		spawnSync: deps?.spawnSync ?? spawnSync,
		stdinIsTTY: deps?.stdinIsTTY ?? process.stdin.isTTY,
		stdoutIsTTY: deps?.stdoutIsTTY ?? process.stdout.isTTY
	};
	if (resolvedDeps.env.OPENCLAW_CLI_CONTAINER_BYPASS === "1") return {
		handled: false,
		argv
	};
	const parsed = parseCliContainerArgs(argv);
	if (!parsed.ok) throw new Error(parsed.error);
	const containerName = resolveCliContainerTarget(argv, resolvedDeps.env);
	if (!containerName) return {
		handled: false,
		argv: parsed.argv
	};
	if (isBlockedContainerCommand(parsed.argv.slice(2))) throw new Error("openclaw update is not supported with --container; rebuild or restart the container image instead.");
	const runningContainer = resolveRunningContainer({
		containerName,
		env: resolvedDeps.env,
		deps: resolvedDeps
	});
	if (!runningContainer) throw new Error(`No running container matched "${containerName}" under podman or docker.`);
	const result = resolvedDeps.spawnSync(runningContainer.command, buildContainerExecArgs({
		exec: runningContainer,
		containerName: runningContainer.containerName,
		argv: parsed.argv.slice(2),
		env: resolvedDeps.env,
		stdinIsTTY: resolvedDeps.stdinIsTTY,
		stdoutIsTTY: resolvedDeps.stdoutIsTTY
	}), {
		stdio: "inherit",
		env: buildContainerExecEnv(resolvedDeps.env)
	});
	return {
		handled: true,
		exitCode: typeof result.status === "number" ? result.status : 1
	};
}
//#endregion
//#region src/cli/profile.ts
function isCommandLocalProfileOption(out) {
	const [primary, secondary] = resolveCliArgvInvocation(out).commandPath;
	return primary === "qa" && secondary === "matrix";
}
function parseCliProfileArgs(argv) {
	let profile = null;
	let sawDev = false;
	const scanned = scanCliRootOptions(argv, ({ arg, args, index, out }) => {
		if (arg === "--dev") {
			if (resolveCliArgvInvocation(out).primary === "gateway") {
				out.push(arg);
				return { kind: "handled" };
			}
			if (profile && profile !== "dev") return {
				kind: "error",
				error: "Cannot combine --dev with --profile"
			};
			sawDev = true;
			profile = "dev";
			return { kind: "handled" };
		}
		if (arg === "--profile" || arg.startsWith("--profile=")) {
			if (isCommandLocalProfileOption(out)) {
				out.push(arg);
				if (arg === "--profile" && isValueToken(args[index + 1])) {
					out.push(args[index + 1]);
					return {
						kind: "handled",
						consumedNext: true
					};
				}
				return { kind: "handled" };
			}
			if (sawDev) return {
				kind: "error",
				error: "Cannot combine --dev with --profile"
			};
			const next = args[index + 1];
			const { value, consumedNext } = takeCliRootOptionValue(arg, next);
			if (!value) return {
				kind: "error",
				error: "--profile requires a value"
			};
			if (!isValidProfileName(value)) return {
				kind: "error",
				error: "Invalid --profile (use letters, numbers, \"_\", \"-\" only)"
			};
			profile = value;
			return {
				kind: "handled",
				consumedNext
			};
		}
		return { kind: "pass" };
	});
	if (!scanned.ok) return scanned;
	return {
		ok: true,
		profile,
		argv: scanned.argv
	};
}
function resolveProfileStateDir(profile, env, homedir) {
	const suffix = normalizeLowercaseStringOrEmpty(profile) === "default" ? "" : `-${profile}`;
	return path.join(resolveRequiredHomeDir(env, homedir), `.openclaw${suffix}`);
}
function applyCliProfileEnv(params) {
	const env = params.env ?? process.env;
	const homedir = params.homedir ?? os.homedir;
	const profile = params.profile.trim();
	if (!profile) return;
	env.OPENCLAW_PROFILE = profile;
	const existingStateDir = normalizeOptionalString(env.OPENCLAW_STATE_DIR);
	const stateDir = existingStateDir || resolveProfileStateDir(profile, env, homedir);
	if (!existingStateDir) env.OPENCLAW_STATE_DIR = stateDir;
	if (!normalizeOptionalString(env.OPENCLAW_CONFIG_PATH)) env.OPENCLAW_CONFIG_PATH = path.join(stateDir, "openclaw.json");
	if (profile === "dev" && !env.OPENCLAW_GATEWAY_PORT?.trim()) env.OPENCLAW_GATEWAY_PORT = "19001";
}
//#endregion
export { resolveCliContainerTarget as a, parseCliContainerArgs as i, parseCliProfileArgs as n, maybeRunCliInContainer as r, applyCliProfileEnv as t };
