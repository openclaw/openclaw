import { c as normalizeOptionalString, s as normalizeOptionalLowercaseString } from "./string-coerce-DyL154ka.js";
import { i as isPathInside } from "./path-BlG8lhgR.js";
import { r as openRootFile } from "./root-file-jRMCpJW4.js";
import { p as resolveUserPath } from "./utils-sBTEdeml.js";
import "./path-guards-CBe_wA_B.js";
import { t as DEFAULT_AGENT_WORKSPACE_DIR } from "./workspace-default--mMaLHGD.js";
import "./boundary-file-read-CBe_wA_B.js";
import { n as defaultRuntime } from "./runtime-yzlkhCoS.js";
import { i as getRuntimeConfig } from "./io-DoswVvYe.js";
import { c as splitSandboxBindSpec, s as resolveSandboxHostPathViaExistingAncestor } from "./network-mode-BsO8g-R7.js";
import "./config-B6Oplu5W.js";
import { a as resolveSandboxPath, i as resolveSandboxInputPath } from "./sandbox-paths-BTYunIeX.js";
import { _ as SANDBOX_AGENT_WORKSPACE_MOUNT, x as SANDBOX_BROWSER_SECURITY_HASH_EPOCH, y as SANDBOX_BROWSER_IMAGE_CONTRACT_EPOCH } from "./constants-By80hBjs.js";
import { n as isToolAllowed } from "./tool-policy-BY51AUO-.js";
import { i as resolveSandboxConfigForAgent, r as resolveSandboxBrowserDockerCreateConfig } from "./config-CcQ2HijN.js";
import { n as resolveSandboxRuntimeStatus } from "./runtime-status-BtoDvmSR.js";
import { c as DEFAULT_USER_FILENAME, i as DEFAULT_IDENTITY_FILENAME, l as ensureAgentWorkspace, n as DEFAULT_BOOTSTRAP_FILENAME, o as DEFAULT_SOUL_FILENAME, r as DEFAULT_HEARTBEAT_FILENAME, s as DEFAULT_TOOLS_FILENAME, t as DEFAULT_AGENTS_FILENAME } from "./workspace-DTx8zuCN.js";
import { f as isSameSsrFPolicy } from "./ssrf-DdDeGa5L.js";
import { a as DEFAULT_OPENCLAW_BROWSER_COLOR, d as ensureBrowserControlAuth, f as resolveBrowserControlAuth, l as resolveBrowserConfig, n as DEFAULT_BROWSER_ACTION_TIMEOUT_MS, s as DEFAULT_OPENCLAW_BROWSER_PROFILE_NAME, u as resolveProfile } from "./browser-profiles-CgiHzERh.js";
import { C as readBrowserRegistry, D as updateBrowserRegistry, E as removeRegistryEntry, O as updateRegistry, T as removeBrowserRegistryEntry, _ as resolveSandboxAgentId, a as execDocker, b as slugifySessionKey, c as isDockerDaemonUnavailable, g as appendWorkspaceMountArgs, k as computeSandboxBrowserConfigHash, l as readDockerContainerEnvVar, m as resolveDockerEnvPolicyEpoch, n as dockerContainerState, p as readDockerPort, s as formatDockerDaemonUnavailableError, t as buildSandboxCreateArgs, u as readDockerContainerLabel, v as resolveSandboxScopeKey, w as readRegistry, y as resolveSandboxWorkspaceDir } from "./docker-DfzYD6UD.js";
import { n as validateNetworkMode } from "./validate-sandbox-security-DkSeOpz8.js";
import { D as buildPinnedWritePlan, E as buildPinnedRenamePlan, O as dockerSandboxBackendManager, T as buildPinnedRemovePlan, a as getSandboxBackendManager, b as relativePathEscapesContainerRoot, k as runDockerSandboxShellCommand, n as startBrowserBridgeServer, r as stopBrowserBridgeServer, s as requireSandboxBackendFactory, t as BROWSER_BRIDGES, v as isPathInsideContainerRoot, w as buildPinnedMkdirpPlan, y as normalizeContainerPath } from "./browser-bridges-C2EBvFK4.js";
import fs from "node:fs";
import path from "node:path";
import fs$1 from "node:fs/promises";
import os from "node:os";
import crypto from "node:crypto";
//#region src/config/port-defaults.ts
function isValidPort(port) {
	return Number.isFinite(port) && port > 0 && port <= 65535;
}
function clampPort(port, fallback) {
	return isValidPort(port) ? port : fallback;
}
function derivePort(base, offset, fallback) {
	return clampPort(base + offset, fallback);
}
const DEFAULT_BROWSER_CDP_PORT_RANGE_START = 18800;
const DEFAULT_BROWSER_CDP_PORT_RANGE_END = 18899;
const DEFAULT_BROWSER_CDP_PORT_RANGE_SPAN = DEFAULT_BROWSER_CDP_PORT_RANGE_END - DEFAULT_BROWSER_CDP_PORT_RANGE_START;
function deriveDefaultBrowserCdpPortRange(browserControlPort) {
	const start = derivePort(browserControlPort, 9, DEFAULT_BROWSER_CDP_PORT_RANGE_START);
	const end = start + DEFAULT_BROWSER_CDP_PORT_RANGE_SPAN;
	if (end <= 65535) return {
		start,
		end
	};
	return {
		start: DEFAULT_BROWSER_CDP_PORT_RANGE_START,
		end: DEFAULT_BROWSER_CDP_PORT_RANGE_END
	};
}
//#endregion
//#region src/agents/sandbox/novnc-auth.ts
const NOVNC_PASSWORD_ENV_KEY = "OPENCLAW_BROWSER_NOVNC_PASSWORD";
const NOVNC_TOKEN_TTL_MS = 60 * 1e3;
const NOVNC_PASSWORD_LENGTH = 8;
const NOVNC_PASSWORD_ALPHABET = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";
const NO_VNC_OBSERVER_TOKENS = /* @__PURE__ */ new Map();
function pruneExpiredNoVncObserverTokens(now) {
	for (const [token, entry] of NO_VNC_OBSERVER_TOKENS) if (entry.expiresAt <= now) NO_VNC_OBSERVER_TOKENS.delete(token);
}
function isNoVncEnabled(params) {
	return params.enableNoVnc && !params.headless;
}
function generateNoVncPassword() {
	let out = "";
	for (let i = 0; i < NOVNC_PASSWORD_LENGTH; i += 1) out += NOVNC_PASSWORD_ALPHABET[crypto.randomInt(0, 62)];
	return out;
}
function issueNoVncObserverToken(params) {
	const now = params.nowMs ?? Date.now();
	pruneExpiredNoVncObserverTokens(now);
	const token = crypto.randomBytes(24).toString("hex");
	NO_VNC_OBSERVER_TOKENS.set(token, {
		noVncPort: params.noVncPort,
		password: normalizeOptionalString(params.password),
		expiresAt: now + Math.max(1, params.ttlMs ?? NOVNC_TOKEN_TTL_MS)
	});
	return token;
}
function consumeNoVncObserverToken(token, nowMs) {
	const now = nowMs ?? Date.now();
	pruneExpiredNoVncObserverTokens(now);
	const normalized = token.trim();
	if (!normalized) return null;
	const entry = NO_VNC_OBSERVER_TOKENS.get(normalized);
	if (!entry) return null;
	NO_VNC_OBSERVER_TOKENS.delete(normalized);
	if (entry.expiresAt <= now) return null;
	return {
		noVncPort: entry.noVncPort,
		password: entry.password
	};
}
function buildNoVncObserverTokenUrl(baseUrl, token) {
	return `${baseUrl}/sandbox/novnc?${new URLSearchParams({ token }).toString()}`;
}
//#endregion
//#region src/agents/sandbox/browser.ts
const HOT_BROWSER_WINDOW_MS = 300 * 1e3;
const CDP_SOURCE_RANGE_ENV_KEY = "OPENCLAW_BROWSER_CDP_SOURCE_RANGE";
const CDP_AUTH_TOKEN_ENV_KEY = "OPENCLAW_BROWSER_CDP_AUTH_TOKEN";
const SANDBOX_BROWSER_IMAGE_CONTRACT_LABEL = "org.openclaw.sandbox-browser.contract";
function buildSandboxCdpAuthHeader(token) {
	return `Basic ${Buffer.from(`openclaw:${token}`).toString("base64")}`;
}
function buildSandboxCdpUrl(params) {
	const url = new URL(`http://127.0.0.1:${params.cdpPort}`);
	url.username = "openclaw";
	url.password = params.authToken;
	return url.toString().replace(/\/$/, "");
}
async function waitForSandboxCdp(params) {
	const deadline = Date.now() + Math.max(0, params.timeoutMs);
	const url = `http://127.0.0.1:${params.cdpPort}/json/version`;
	while (Date.now() < deadline) {
		try {
			const ctrl = new AbortController();
			const t = setTimeout(ctrl.abort.bind(ctrl), 1e3);
			try {
				if ((await fetch(url, {
					headers: { Authorization: buildSandboxCdpAuthHeader(params.authToken) },
					signal: ctrl.signal
				})).ok) return true;
			} finally {
				clearTimeout(t);
			}
		} catch {}
		const remainingMs = deadline - Date.now();
		if (remainingMs <= 0) break;
		await new Promise((r) => setTimeout(r, Math.min(150, remainingMs)));
	}
	return false;
}
function buildSandboxBrowserResolvedConfig(params) {
	const cdpHost = "127.0.0.1";
	const cdpPortRange = deriveDefaultBrowserCdpPortRange(params.controlPort);
	return {
		enabled: true,
		evaluateEnabled: params.evaluateEnabled,
		controlPort: params.controlPort,
		cdpProtocol: "http",
		cdpHost,
		cdpIsLoopback: true,
		cdpPortRangeStart: cdpPortRange.start,
		cdpPortRangeEnd: cdpPortRange.end,
		remoteCdpTimeoutMs: 1500,
		remoteCdpHandshakeTimeoutMs: 3e3,
		localLaunchTimeoutMs: 15e3,
		localCdpReadyTimeoutMs: 8e3,
		actionTimeoutMs: DEFAULT_BROWSER_ACTION_TIMEOUT_MS,
		color: DEFAULT_OPENCLAW_BROWSER_COLOR,
		executablePath: void 0,
		headless: params.headless,
		noSandbox: false,
		attachOnly: true,
		defaultProfile: DEFAULT_OPENCLAW_BROWSER_PROFILE_NAME,
		extraArgs: [],
		tabCleanup: {
			enabled: true,
			idleMinutes: 120,
			maxTabsPerSession: 8,
			sweepMinutes: 5
		},
		profiles: { [DEFAULT_OPENCLAW_BROWSER_PROFILE_NAME]: {
			cdpPort: params.cdpPort,
			cdpUrl: buildSandboxCdpUrl({
				cdpPort: params.cdpPort,
				authToken: params.cdpAuthToken
			}),
			color: DEFAULT_OPENCLAW_BROWSER_COLOR
		} },
		ssrfPolicy: params.ssrfPolicy
	};
}
async function ensureSandboxBrowserImage(image) {
	const result = await execDocker([
		"image",
		"inspect",
		"-f",
		`{{ index .Config.Labels "${SANDBOX_BROWSER_IMAGE_CONTRACT_LABEL}" }}`,
		image
	], { allowFailure: true });
	if (result.code === 0) {
		const contract = result.stdout.trim();
		if (contract === "2026-05-12-cdp-relay-auth") return;
		throw new Error(`Sandbox browser image ${image} is stale or incompatible (contract=${contract && contract !== "<no value>" ? contract : "missing"}, expected=${SANDBOX_BROWSER_IMAGE_CONTRACT_EPOCH}). Rebuild it with scripts/sandbox-browser-setup.sh.`);
	}
	const stderr = result.stderr.trim();
	if (isDockerDaemonUnavailable(stderr)) throw new Error(formatDockerDaemonUnavailableError(stderr));
	throw new Error(`Sandbox browser image not found: ${image}. Build it with scripts/sandbox-browser-setup.sh.`);
}
async function ensureDockerNetwork(network, opts) {
	validateNetworkMode(network, { allowContainerNamespaceJoin: opts?.allowContainerNamespaceJoin === true });
	const normalized = normalizeOptionalLowercaseString(network) ?? "";
	if (!normalized || normalized === "bridge" || normalized === "none") return;
	if ((await execDocker([
		"network",
		"inspect",
		network
	], { allowFailure: true })).code === 0) return;
	await execDocker([
		"network",
		"create",
		"--driver",
		"bridge",
		network
	]);
}
async function ensureSandboxBrowser(params) {
	if (!params.cfg.browser.enabled) return null;
	if (!isToolAllowed(params.cfg.tools, "browser")) return null;
	const slug = params.cfg.scope === "shared" ? "shared" : slugifySessionKey(params.scopeKey);
	const containerName = `${params.cfg.browser.containerPrefix}${slug}`.slice(0, 63);
	const state = await dockerContainerState(containerName);
	const browserImage = params.cfg.browser.image ?? "openclaw-sandbox-browser:bookworm-slim";
	const cdpSourceRange = normalizeOptionalString(params.cfg.browser.cdpSourceRange);
	const browserDockerCfg = resolveSandboxBrowserDockerCreateConfig({
		docker: params.cfg.docker,
		browser: {
			...params.cfg.browser,
			image: browserImage
		}
	});
	const expectedHash = computeSandboxBrowserConfigHash({
		docker: browserDockerCfg,
		dockerEnvPolicyEpoch: resolveDockerEnvPolicyEpoch(browserDockerCfg.env),
		browser: {
			cdpPort: params.cfg.browser.cdpPort,
			vncPort: params.cfg.browser.vncPort,
			noVncPort: params.cfg.browser.noVncPort,
			headless: params.cfg.browser.headless,
			enableNoVnc: params.cfg.browser.enableNoVnc,
			autoStartTimeoutMs: params.cfg.browser.autoStartTimeoutMs,
			cdpSourceRange
		},
		securityEpoch: SANDBOX_BROWSER_SECURITY_HASH_EPOCH,
		workspaceAccess: params.cfg.workspaceAccess,
		workspaceDir: params.workspaceDir,
		agentWorkspaceDir: params.agentWorkspaceDir,
		mountFormatVersion: 2
	});
	const now = Date.now();
	let hasContainer = state.exists;
	let running = state.running;
	let currentHash = null;
	let hashMismatch = false;
	const noVncEnabled = isNoVncEnabled(params.cfg.browser);
	let noVncPassword;
	let cdpAuthToken;
	if (hasContainer) {
		if (noVncEnabled) noVncPassword = await readDockerContainerEnvVar(containerName, "OPENCLAW_BROWSER_NOVNC_PASSWORD") ?? void 0;
		cdpAuthToken = await readDockerContainerEnvVar(containerName, CDP_AUTH_TOKEN_ENV_KEY) ?? void 0;
		if (!cdpAuthToken) {
			defaultRuntime.log(`Removing stale sandbox browser container ${containerName} because it lacks the current CDP relay auth contract; it will be recreated.`);
			await execDocker([
				"rm",
				"-f",
				containerName
			], { allowFailure: true });
			hasContainer = false;
			running = false;
		}
	}
	if (hasContainer) {
		const registryEntry = (await readBrowserRegistry()).entries.find((entry) => entry.containerName === containerName);
		currentHash = await readDockerContainerLabel(containerName, "openclaw.configHash");
		hashMismatch = !currentHash || currentHash !== expectedHash;
		if (!currentHash) {
			currentHash = registryEntry?.configHash ?? null;
			hashMismatch = !currentHash || currentHash !== expectedHash;
		}
		if (hashMismatch) {
			const lastUsedAtMs = registryEntry?.lastUsedAtMs;
			if (running && (typeof lastUsedAtMs !== "number" || now - lastUsedAtMs < HOT_BROWSER_WINDOW_MS)) {
				const hint = (() => {
					if (params.cfg.scope === "session") return `openclaw sandbox recreate --browser --session ${params.scopeKey}`;
					if (params.cfg.scope === "agent") return `openclaw sandbox recreate --browser --agent ${resolveSandboxAgentId(params.scopeKey) ?? "main"}`;
					return "openclaw sandbox recreate --browser --all";
				})();
				defaultRuntime.log(`Sandbox browser config changed for ${containerName} (recently used). Recreate to apply: ${hint}`);
			} else {
				await execDocker([
					"rm",
					"-f",
					containerName
				], { allowFailure: true });
				hasContainer = false;
				running = false;
			}
		}
	}
	if (!hasContainer) {
		if (noVncEnabled) noVncPassword = generateNoVncPassword();
		cdpAuthToken = crypto.randomBytes(24).toString("hex");
		await ensureDockerNetwork(browserDockerCfg.network, { allowContainerNamespaceJoin: browserDockerCfg.dangerouslyAllowContainerNamespaceJoin === true });
		await ensureSandboxBrowserImage(browserImage);
		const args = buildSandboxCreateArgs({
			name: containerName,
			cfg: browserDockerCfg,
			scopeKey: params.scopeKey,
			labels: {
				"openclaw.sandboxBrowser": "1",
				"openclaw.browserConfigEpoch": SANDBOX_BROWSER_SECURITY_HASH_EPOCH
			},
			configHash: expectedHash,
			includeBinds: false,
			bindSourceRoots: [params.workspaceDir, params.agentWorkspaceDir]
		});
		appendWorkspaceMountArgs({
			args,
			workspaceDir: params.workspaceDir,
			agentWorkspaceDir: params.agentWorkspaceDir,
			workdir: params.cfg.docker.workdir,
			workspaceAccess: params.cfg.workspaceAccess
		});
		if (browserDockerCfg.binds?.length) for (const bind of browserDockerCfg.binds) args.push("-v", bind);
		args.push("-p", `127.0.0.1::${params.cfg.browser.cdpPort}`);
		if (noVncEnabled) args.push("-p", `127.0.0.1::${params.cfg.browser.noVncPort}`);
		args.push("-e", `OPENCLAW_BROWSER_HEADLESS=${params.cfg.browser.headless ? "1" : "0"}`);
		args.push("-e", `OPENCLAW_BROWSER_ENABLE_NOVNC=${params.cfg.browser.enableNoVnc ? "1" : "0"}`);
		args.push("-e", `OPENCLAW_BROWSER_CDP_PORT=${params.cfg.browser.cdpPort}`);
		args.push("-e", `${CDP_AUTH_TOKEN_ENV_KEY}=${cdpAuthToken}`);
		args.push("-e", `OPENCLAW_BROWSER_AUTO_START_TIMEOUT_MS=${params.cfg.browser.autoStartTimeoutMs}`);
		if (cdpSourceRange) args.push("-e", `${CDP_SOURCE_RANGE_ENV_KEY}=${cdpSourceRange}`);
		args.push("-e", `OPENCLAW_BROWSER_VNC_PORT=${params.cfg.browser.vncPort}`);
		args.push("-e", `OPENCLAW_BROWSER_NOVNC_PORT=${params.cfg.browser.noVncPort}`);
		args.push("-e", "OPENCLAW_BROWSER_NO_SANDBOX=1");
		if (noVncEnabled && noVncPassword) args.push("-e", `${NOVNC_PASSWORD_ENV_KEY}=${noVncPassword}`);
		args.push(browserImage);
		await execDocker(args);
		await execDocker(["start", containerName]);
	} else if (!running) await execDocker(["start", containerName]);
	const mappedCdp = await readDockerPort(containerName, params.cfg.browser.cdpPort);
	if (!mappedCdp) throw new Error(`Failed to resolve CDP port mapping for ${containerName}.`);
	if (!cdpAuthToken) throw new Error(`Failed to resolve CDP relay auth for ${containerName}.`);
	const cdpUrl = buildSandboxCdpUrl({
		cdpPort: mappedCdp,
		authToken: cdpAuthToken
	});
	const mappedNoVnc = noVncEnabled ? await readDockerPort(containerName, params.cfg.browser.noVncPort) : null;
	if (noVncEnabled && !noVncPassword) noVncPassword = await readDockerContainerEnvVar(containerName, "OPENCLAW_BROWSER_NOVNC_PASSWORD") ?? void 0;
	const existing = BROWSER_BRIDGES.get(params.scopeKey);
	const existingProfile = existing ? resolveProfile(existing.bridge.state.resolved, DEFAULT_OPENCLAW_BROWSER_PROFILE_NAME) : null;
	const desiredEvaluateEnabled = params.evaluateEnabled ?? true;
	let desiredAuthToken = normalizeOptionalString(params.bridgeAuth?.token);
	let desiredAuthPassword = normalizeOptionalString(params.bridgeAuth?.password);
	if (!desiredAuthToken && !desiredAuthPassword) {
		desiredAuthToken = existing?.authToken;
		desiredAuthPassword = existing?.authPassword;
		if (!desiredAuthToken && !desiredAuthPassword) desiredAuthToken = crypto.randomBytes(24).toString("hex");
	}
	const shouldReuse = existing && existing.containerName === containerName && existingProfile?.cdpPort === mappedCdp && existingProfile?.cdpUrl === cdpUrl;
	const policyMatches = !existing || isSameSsrFPolicy(existing.bridge.state.resolved.ssrfPolicy, params.ssrfPolicy);
	const authMatches = !existing || existing.authToken === desiredAuthToken && existing.authPassword === desiredAuthPassword;
	const evaluateMatches = !existing || existing.bridge.state.resolved.evaluateEnabled === desiredEvaluateEnabled;
	if (existing && !shouldReuse) {
		await stopBrowserBridgeServer(existing.bridge.server).catch(() => void 0);
		BROWSER_BRIDGES.delete(params.scopeKey);
	}
	if (existing && shouldReuse && (!policyMatches || !authMatches || !evaluateMatches)) {
		await stopBrowserBridgeServer(existing.bridge.server).catch(() => void 0);
		BROWSER_BRIDGES.delete(params.scopeKey);
	}
	const bridge = (() => {
		if (shouldReuse && policyMatches && authMatches && evaluateMatches && existing) return existing.bridge;
		return null;
	})();
	const ensureBridge = async () => {
		if (bridge) return bridge;
		const onEnsureAttachTarget = params.cfg.browser.autoStart ? async () => {
			const currentState = await dockerContainerState(containerName);
			if (currentState.exists && !currentState.running) await execDocker(["start", containerName]);
			if (!await waitForSandboxCdp({
				cdpPort: mappedCdp,
				authToken: cdpAuthToken,
				timeoutMs: params.cfg.browser.autoStartTimeoutMs
			})) {
				await execDocker([
					"rm",
					"-f",
					containerName
				], { allowFailure: true });
				throw new Error(`Sandbox browser CDP did not become reachable on 127.0.0.1:${mappedCdp} within ${params.cfg.browser.autoStartTimeoutMs}ms. The hung container has been forcefully removed.`);
			}
		} : void 0;
		return await startBrowserBridgeServer({
			resolved: buildSandboxBrowserResolvedConfig({
				controlPort: 0,
				cdpPort: mappedCdp,
				cdpAuthToken,
				headless: params.cfg.browser.headless,
				evaluateEnabled: desiredEvaluateEnabled,
				ssrfPolicy: params.ssrfPolicy
			}),
			authToken: desiredAuthToken,
			authPassword: desiredAuthPassword,
			onEnsureAttachTarget,
			resolveSandboxNoVncToken: consumeNoVncObserverToken
		});
	};
	const resolvedBridge = await ensureBridge();
	if (!shouldReuse || !policyMatches || !authMatches || !evaluateMatches) BROWSER_BRIDGES.set(params.scopeKey, {
		bridge: resolvedBridge,
		containerName,
		authToken: desiredAuthToken,
		authPassword: desiredAuthPassword
	});
	await updateBrowserRegistry({
		containerName,
		sessionKey: params.scopeKey,
		createdAtMs: now,
		lastUsedAtMs: now,
		image: browserImage,
		configHash: hashMismatch && running ? currentHash ?? void 0 : expectedHash,
		cdpPort: mappedCdp,
		noVncPort: mappedNoVnc ?? void 0
	});
	const noVncUrl = mappedNoVnc && noVncEnabled ? (() => {
		const token = issueNoVncObserverToken({
			noVncPort: mappedNoVnc,
			password: noVncPassword
		});
		return buildNoVncObserverTokenUrl(resolvedBridge.baseUrl, token);
	})() : void 0;
	return {
		bridgeUrl: resolvedBridge.baseUrl,
		noVncUrl,
		containerName
	};
}
//#endregion
//#region src/agents/sandbox/fs-bridge-path-safety.ts
var SandboxFsPathGuard = class {
	constructor(params) {
		this.mountsByContainer = params.mountsByContainer;
		this.runCommand = params.runCommand;
	}
	async assertPathChecks(checks) {
		for (const check of checks) await this.assertPathSafety(check.target, check.options);
	}
	async assertPathSafety(target, options) {
		const guarded = await this.openBoundaryWithinRequiredMount(target, options.action, {
			aliasPolicy: options.aliasPolicy,
			allowedType: options.allowedType
		});
		await this.assertGuardedPathSafety(target, options, guarded);
	}
	async openReadableFile(target) {
		const opened = await this.openBoundaryWithinRequiredMount(target, "read files");
		if (!opened.ok) throw opened.error instanceof Error ? opened.error : /* @__PURE__ */ new Error(`Sandbox boundary checks failed; cannot read files: ${target.containerPath}`);
		return opened;
	}
	resolveRequiredMount(containerPath, action) {
		const lexicalMount = this.resolveMountByContainerPath(containerPath);
		if (!lexicalMount) throw new Error(`Sandbox path escapes allowed mounts; cannot ${action}: ${containerPath}`);
		return lexicalMount;
	}
	finalizePinnedEntry(params) {
		const relativeParentPath = path.posix.relative(params.mount.containerRoot, params.parentPath);
		if (relativePathEscapesContainerRoot(relativeParentPath)) throw new Error(`Sandbox path escapes allowed mounts; cannot ${params.action}: ${params.targetPath}`);
		return {
			mountRootPath: params.mount.containerRoot,
			relativeParentPath: relativeParentPath === "." ? "" : relativeParentPath,
			basename: params.basename
		};
	}
	async assertGuardedPathSafety(target, options, guarded) {
		if (!guarded.ok) {
			if (guarded.reason !== "path") {
				if (!(options.allowedType === "directory" && this.pathIsExistingDirectory(target.hostPath))) throw guarded.error instanceof Error ? guarded.error : /* @__PURE__ */ new Error(`Sandbox boundary checks failed; cannot ${options.action}: ${target.containerPath}`);
			}
		} else fs.closeSync(guarded.fd);
		const canonicalContainerPath = await this.resolveCanonicalContainerPath({
			containerPath: target.containerPath,
			allowFinalSymlinkForUnlink: options.aliasPolicy?.allowFinalSymlinkForUnlink === true
		});
		const canonicalMount = this.resolveRequiredMount(canonicalContainerPath, options.action);
		if (options.requireWritable && !canonicalMount.writable) throw new Error(`Sandbox path is read-only; cannot ${options.action}: ${target.containerPath}`);
	}
	async openBoundaryWithinRequiredMount(target, action, options) {
		const lexicalMount = this.resolveRequiredMount(target.containerPath, action);
		return await openRootFile({
			absolutePath: target.hostPath,
			rootPath: lexicalMount.hostRoot,
			boundaryLabel: "sandbox mount root",
			aliasPolicy: options?.aliasPolicy,
			allowedType: options?.allowedType
		});
	}
	resolvePinnedEntry(target, action) {
		const basename = path.posix.basename(target.containerPath);
		if (!basename || basename === "." || basename === "/") throw new Error(`Invalid sandbox entry target: ${target.containerPath}`);
		const parentPath = normalizeContainerPath(path.posix.dirname(target.containerPath));
		const mount = this.resolveRequiredMount(parentPath, action);
		return this.finalizePinnedEntry({
			mount,
			parentPath,
			basename,
			targetPath: target.containerPath,
			action
		});
	}
	async resolveAnchoredSandboxEntry(target, action) {
		const basename = path.posix.basename(target.containerPath);
		if (!basename || basename === "." || basename === "/") throw new Error(`Invalid sandbox entry target: ${target.containerPath}`);
		const parentPath = normalizeContainerPath(path.posix.dirname(target.containerPath));
		const canonicalParentPath = await this.resolveCanonicalContainerPath({
			containerPath: parentPath,
			allowFinalSymlinkForUnlink: false
		});
		this.resolveRequiredMount(canonicalParentPath, action);
		return {
			canonicalParentPath,
			basename
		};
	}
	async resolveAnchoredPinnedEntry(target, action) {
		const anchoredTarget = await this.resolveAnchoredSandboxEntry(target, action);
		const mount = this.resolveRequiredMount(anchoredTarget.canonicalParentPath, action);
		return this.finalizePinnedEntry({
			mount,
			parentPath: anchoredTarget.canonicalParentPath,
			basename: anchoredTarget.basename,
			targetPath: target.containerPath,
			action
		});
	}
	resolvePinnedDirectoryEntry(target, action) {
		const mount = this.resolveRequiredMount(target.containerPath, action);
		const relativePath = path.posix.relative(mount.containerRoot, target.containerPath);
		if (relativePathEscapesContainerRoot(relativePath)) throw new Error(`Sandbox path escapes allowed mounts; cannot ${action}: ${target.containerPath}`);
		return {
			mountRootPath: mount.containerRoot,
			relativePath: relativePath === "." ? "" : relativePath
		};
	}
	pathIsExistingDirectory(hostPath) {
		try {
			return fs.statSync(hostPath).isDirectory();
		} catch {
			return false;
		}
	}
	resolveMountByContainerPath(containerPath) {
		const normalized = normalizeContainerPath(containerPath);
		for (const mount of this.mountsByContainer) if (isPathInsideContainerRoot(normalizeContainerPath(mount.containerRoot), normalized)) return mount;
		return null;
	}
	async resolveCanonicalContainerPath(params) {
		const script = [
			"set -eu",
			"target=\"$1\"",
			"allow_final=\"$2\"",
			"suffix=\"\"",
			"probe=\"$target\"",
			"if [ \"$allow_final\" = \"1\" ] && [ -L \"$target\" ]; then probe=$(dirname -- \"$target\"); fi",
			"cursor=\"$probe\"",
			"while [ ! -e \"$cursor\" ] && [ ! -L \"$cursor\" ]; do",
			"  parent=$(dirname -- \"$cursor\")",
			"  if [ \"$parent\" = \"$cursor\" ]; then break; fi",
			"  base=$(basename -- \"$cursor\")",
			"  suffix=\"/$base$suffix\"",
			"  cursor=\"$parent\"",
			"done",
			"canonical=$(readlink -f -- \"$cursor\")",
			"printf \"%s%s\\n\" \"$canonical\" \"$suffix\""
		].join("\n");
		const canonical = (await this.runCommand(script, { args: [params.containerPath, params.allowFinalSymlinkForUnlink ? "1" : "0"] })).stdout.toString("utf8").trim();
		if (!canonical.startsWith("/")) throw new Error(`Failed to resolve canonical sandbox path: ${params.containerPath}`);
		return normalizeContainerPath(canonical);
	}
};
//#endregion
//#region src/agents/sandbox/fs-bridge-shell-command-plans.ts
function buildStatPlan(target, anchoredTarget) {
	return {
		checks: [{
			target,
			options: { action: "stat files" }
		}],
		script: "set -eu\ncd -- \"$1\"\nstat -c \"%F|%s|%Y\" -- \"$2\"",
		args: [anchoredTarget.canonicalParentPath, anchoredTarget.basename],
		allowFailure: true
	};
}
//#endregion
//#region src/agents/sandbox/fs-paths.ts
function parseSandboxBindMount(spec) {
	const trimmed = spec.trim();
	if (!trimmed) return null;
	const parsed = splitSandboxBindSpec(trimmed);
	if (!parsed) return null;
	const hostToken = parsed.host.trim();
	const containerToken = parsed.container.trim();
	if (!hostToken || !containerToken || !path.posix.isAbsolute(containerToken)) return null;
	const optionsToken = normalizeOptionalLowercaseString(parsed.options) ?? "";
	const writable = !(optionsToken ? optionsToken.split(",").map((entry) => entry.trim()).filter(Boolean) : []).includes("ro");
	return {
		hostRoot: path.resolve(hostToken),
		containerRoot: normalizeContainerPath(containerToken),
		writable
	};
}
function buildSandboxFsMounts(sandbox) {
	const mounts = [{
		hostRoot: path.resolve(sandbox.workspaceDir),
		containerRoot: normalizeContainerPath(sandbox.containerWorkdir),
		writable: sandbox.workspaceAccess === "rw",
		source: "workspace"
	}];
	if (sandbox.workspaceAccess !== "none" && path.resolve(sandbox.agentWorkspaceDir) !== path.resolve(sandbox.workspaceDir)) mounts.push({
		hostRoot: path.resolve(sandbox.agentWorkspaceDir),
		containerRoot: SANDBOX_AGENT_WORKSPACE_MOUNT,
		writable: sandbox.workspaceAccess === "rw",
		source: "agent"
	});
	for (const bind of sandbox.docker.binds ?? []) {
		const parsed = parseSandboxBindMount(bind);
		if (!parsed) continue;
		mounts.push({
			hostRoot: parsed.hostRoot,
			containerRoot: parsed.containerRoot,
			writable: parsed.writable,
			source: "bind"
		});
	}
	return dedupeMounts(mounts);
}
function resolveWritableSandboxBindHostRoots(binds) {
	const parsedBinds = parseSandboxBindMounts(binds);
	const readonlyRoots = parsedBinds.filter((bind) => !bind.writable).map((bind) => bind.hostRoot);
	const roots = [];
	const seen = /* @__PURE__ */ new Set();
	for (const parsed of parsedBinds) {
		if (!parsed.writable || seen.has(parsed.hostRoot) || readonlyRoots.some((root) => isHostPathWithinOrEqual(parsed.hostRoot, root))) continue;
		seen.add(parsed.hostRoot);
		roots.push(parsed.hostRoot);
	}
	return roots;
}
function hasSandboxBindContainerPathAliases(binds) {
	for (const parsed of parseSandboxBindMounts(binds)) if (parsed.hostRoot !== parsed.containerRoot) return true;
	return false;
}
function hasSandboxBindReadonlyHostShadows(binds) {
	const parsedBinds = parseSandboxBindMounts(binds);
	const writableRoots = parsedBinds.filter((bind) => bind.writable).map((bind) => bind.hostRoot);
	const readonlyRoots = parsedBinds.filter((bind) => !bind.writable).map((bind) => bind.hostRoot);
	return writableRoots.some((writableRoot) => readonlyRoots.some((readonlyRoot) => isHostPathWithinOrEqual(writableRoot, readonlyRoot)));
}
function parseSandboxBindMounts(binds) {
	const parsed = [];
	for (const bind of binds ?? []) {
		const mount = parseSandboxBindMount(bind);
		if (mount) parsed.push(mount);
	}
	return parsed;
}
function resolveSandboxFsPathWithMounts(params) {
	const mountsByContainer = [...params.mounts].toSorted(compareMountsByContainerPath);
	const mountsByHost = [...params.mounts].toSorted(compareMountsByHostPath);
	const input = params.filePath;
	const inputPosix = normalizePosixInput(input);
	if (path.posix.isAbsolute(inputPosix)) {
		const containerMount = findMountByContainerPath(mountsByContainer, inputPosix);
		if (containerMount) {
			const rel = path.posix.relative(containerMount.containerRoot, inputPosix);
			return {
				hostPath: rel ? path.resolve(containerMount.hostRoot, ...toHostSegments(rel)) : containerMount.hostRoot,
				containerPath: rel ? path.posix.join(containerMount.containerRoot, rel) : containerMount.containerRoot,
				relativePath: toDisplayRelative({
					containerPath: rel ? path.posix.join(containerMount.containerRoot, rel) : containerMount.containerRoot,
					defaultContainerRoot: params.defaultContainerRoot
				}),
				writable: containerMount.writable
			};
		}
	}
	const hostResolved = resolveSandboxInputPath(input, params.cwd);
	const hostMount = findMountByHostPath(mountsByHost, hostResolved);
	if (hostMount) {
		const relHost = path.relative(hostMount.hostRoot, hostResolved);
		const relPosix = relHost ? relHost.split(path.sep).join(path.posix.sep) : "";
		const containerPath = relPosix ? path.posix.join(hostMount.containerRoot, relPosix) : hostMount.containerRoot;
		return {
			hostPath: hostResolved,
			containerPath,
			relativePath: toDisplayRelative({
				containerPath,
				defaultContainerRoot: params.defaultContainerRoot
			}),
			writable: hostMount.writable
		};
	}
	const escapeMessage = formatSandboxRootEscapeMessage({
		input,
		defaultWorkspaceRoot: params.defaultWorkspaceRoot,
		defaultContainerRoot: params.defaultContainerRoot
	});
	try {
		resolveSandboxPath({
			filePath: input,
			cwd: params.cwd,
			root: params.defaultWorkspaceRoot
		});
	} catch {
		throw new Error(escapeMessage);
	}
	throw new Error(escapeMessage);
}
function formatSandboxRootEscapeMessage(params) {
	const containerRoot = normalizeContainerPath(params.defaultContainerRoot);
	return `Path escapes sandbox root (${shortenHomePath(path.resolve(params.defaultWorkspaceRoot))}; container root ${containerRoot}): ${params.input}. Use a path under ${containerRoot}/ instead.`;
}
function shortenHomePath(value) {
	const home = os.homedir();
	if (value === home || value.startsWith(`${home}${path.sep}`)) return `~${value.slice(home.length)}`;
	return value;
}
function compareMountsByContainerPath(a, b) {
	const byLength = b.containerRoot.length - a.containerRoot.length;
	if (byLength !== 0) return byLength;
	return mountSourcePriority(b.source) - mountSourcePriority(a.source);
}
function compareMountsByHostPath(a, b) {
	const byLength = b.hostRoot.length - a.hostRoot.length;
	if (byLength !== 0) return byLength;
	return mountSourcePriority(b.source) - mountSourcePriority(a.source);
}
function mountSourcePriority(source) {
	if (source === "bind") return 2;
	if (source === "agent") return 1;
	return 0;
}
function dedupeMounts(mounts) {
	const seen = /* @__PURE__ */ new Set();
	const deduped = [];
	for (const mount of mounts) {
		const key = `${mount.hostRoot}=>${mount.containerRoot}`;
		if (seen.has(key)) continue;
		seen.add(key);
		deduped.push(mount);
	}
	return deduped;
}
function findMountByContainerPath(mounts, target) {
	for (const mount of mounts) if (isPathInsideContainerRoot(mount.containerRoot, target)) return mount;
	return null;
}
function findMountByHostPath(mounts, target) {
	for (const mount of mounts) if (isPathInsideHost(mount.hostRoot, target)) return mount;
	return null;
}
function isPathInsideHost(root, target) {
	const canonicalRoot = resolveSandboxHostPathViaExistingAncestor(path.resolve(root));
	const resolvedTarget = path.resolve(target);
	const canonicalTargetParent = resolveSandboxHostPathViaExistingAncestor(path.dirname(resolvedTarget));
	return isPathInside(canonicalRoot, path.resolve(canonicalTargetParent, path.basename(resolvedTarget)));
}
function isHostPathWithinOrEqual(root, target) {
	const relative = path.relative(path.resolve(root), path.resolve(target));
	return relative === "" || !relative.startsWith("..") && !path.isAbsolute(relative);
}
function toHostSegments(relativePosix) {
	return relativePosix.split("/").filter(Boolean);
}
function toDisplayRelative(params) {
	const rel = path.posix.relative(params.defaultContainerRoot, params.containerPath);
	if (!rel) return "";
	if (!relativePathEscapesContainerRoot(rel)) return rel;
	return params.containerPath;
}
function normalizePosixInput(value) {
	return value.replace(/\\/g, "/").trim();
}
//#endregion
//#region src/agents/sandbox/fs-bridge.ts
function createSandboxFsBridge(params) {
	return new SandboxFsBridgeImpl(params.sandbox);
}
var SandboxFsBridgeImpl = class {
	constructor(sandbox) {
		this.sandbox = sandbox;
		this.mounts = buildSandboxFsMounts(sandbox);
		const mountsByContainer = [...this.mounts].toSorted((a, b) => b.containerRoot.length - a.containerRoot.length);
		this.pathGuard = new SandboxFsPathGuard({
			mountsByContainer,
			runCommand: (script, options) => this.runCommand(script, options)
		});
	}
	resolvePath(params) {
		const target = this.resolveResolvedPath(params);
		return {
			hostPath: target.hostPath,
			relativePath: target.relativePath,
			containerPath: target.containerPath
		};
	}
	async readFile(params) {
		const target = this.resolveResolvedPath(params);
		return this.readPinnedFile(target);
	}
	async writeFile(params) {
		const target = this.resolveResolvedPath(params);
		this.ensureWriteAccess(target, "write files");
		const writeCheck = {
			target,
			options: {
				action: "write files",
				requireWritable: true
			}
		};
		await this.pathGuard.assertPathSafety(target, writeCheck.options);
		const buffer = Buffer.isBuffer(params.data) ? params.data : Buffer.from(params.data, params.encoding ?? "utf8");
		const pinnedWriteTarget = await this.pathGuard.resolveAnchoredPinnedEntry(target, "write files");
		await this.runCheckedCommand({
			...buildPinnedWritePlan({
				check: writeCheck,
				pinned: pinnedWriteTarget,
				mkdir: params.mkdir !== false
			}),
			stdin: buffer,
			signal: params.signal
		});
	}
	async mkdirp(params) {
		const target = this.resolveResolvedPath(params);
		this.ensureWriteAccess(target, "create directories");
		const mkdirCheck = {
			target,
			options: {
				action: "create directories",
				requireWritable: true,
				allowedType: "directory"
			}
		};
		await this.runCheckedCommand({
			...buildPinnedMkdirpPlan({
				check: mkdirCheck,
				pinned: this.pathGuard.resolvePinnedDirectoryEntry(target, "create directories")
			}),
			signal: params.signal
		});
	}
	async remove(params) {
		const target = this.resolveResolvedPath(params);
		this.ensureWriteAccess(target, "remove files");
		const removeCheck = {
			target,
			options: {
				action: "remove files",
				requireWritable: true
			}
		};
		await this.runCheckedCommand({
			...buildPinnedRemovePlan({
				check: removeCheck,
				pinned: this.pathGuard.resolvePinnedEntry(target, "remove files"),
				recursive: params.recursive,
				force: params.force
			}),
			signal: params.signal
		});
	}
	async rename(params) {
		const from = this.resolveResolvedPath({
			filePath: params.from,
			cwd: params.cwd
		});
		const to = this.resolveResolvedPath({
			filePath: params.to,
			cwd: params.cwd
		});
		this.ensureWriteAccess(from, "rename files");
		this.ensureWriteAccess(to, "rename files");
		const fromCheck = {
			target: from,
			options: {
				action: "rename files",
				requireWritable: true
			}
		};
		const toCheck = {
			target: to,
			options: {
				action: "rename files",
				requireWritable: true
			}
		};
		await this.runCheckedCommand({
			...buildPinnedRenamePlan({
				fromCheck,
				toCheck,
				from: this.pathGuard.resolvePinnedEntry(from, "rename files"),
				to: this.pathGuard.resolvePinnedEntry(to, "rename files")
			}),
			signal: params.signal
		});
	}
	async stat(params) {
		const target = this.resolveResolvedPath(params);
		const anchoredTarget = await this.pathGuard.resolveAnchoredSandboxEntry(target, "stat files");
		const result = await this.runPlannedCommand(buildStatPlan(target, anchoredTarget), params.signal);
		if (result.code !== 0) {
			const stderr = result.stderr.toString("utf8");
			if (stderr.includes("No such file or directory")) return null;
			const message = stderr.trim() || `stat failed with code ${result.code}`;
			throw new Error(`stat failed for ${target.containerPath}: ${message}`);
		}
		const [typeRaw, sizeRaw, mtimeRaw] = result.stdout.toString("utf8").trim().split("|");
		const size = Number.parseInt(sizeRaw ?? "0", 10);
		const mtime = Number.parseInt(mtimeRaw ?? "0", 10) * 1e3;
		return {
			type: coerceStatType(typeRaw),
			size: Number.isFinite(size) ? size : 0,
			mtimeMs: Number.isFinite(mtime) ? mtime : 0
		};
	}
	async runCommand(script, options = {}) {
		const backend = this.sandbox.backend;
		if (backend) return await backend.runShellCommand({
			script,
			args: options.args,
			stdin: options.stdin,
			allowFailure: options.allowFailure,
			signal: options.signal
		});
		return await runDockerSandboxShellCommand({
			containerName: this.sandbox.containerName,
			script,
			args: options.args,
			stdin: options.stdin,
			allowFailure: options.allowFailure,
			signal: options.signal
		});
	}
	async readPinnedFile(target) {
		const opened = await this.pathGuard.openReadableFile(target);
		try {
			return fs.readFileSync(opened.fd);
		} finally {
			fs.closeSync(opened.fd);
		}
	}
	async runCheckedCommand(plan) {
		await this.pathGuard.assertPathChecks(plan.checks);
		if (plan.recheckBeforeCommand) await this.pathGuard.assertPathChecks(plan.checks);
		return await this.runCommand(plan.script, {
			args: plan.args,
			stdin: plan.stdin,
			allowFailure: plan.allowFailure,
			signal: plan.signal
		});
	}
	async runPlannedCommand(plan, signal) {
		return await this.runCheckedCommand({
			...plan,
			signal
		});
	}
	ensureWriteAccess(target, action) {
		if (!allowsWrites(this.sandbox.workspaceAccess) || !target.writable) throw new Error(`Sandbox path is read-only; cannot ${action}: ${target.containerPath}`);
	}
	resolveResolvedPath(params) {
		return resolveSandboxFsPathWithMounts({
			filePath: params.filePath,
			cwd: params.cwd ?? this.sandbox.workspaceDir,
			defaultWorkspaceRoot: this.sandbox.workspaceDir,
			defaultContainerRoot: this.sandbox.containerWorkdir,
			mounts: this.mounts
		});
	}
};
function allowsWrites(access) {
	return access === "rw";
}
function coerceStatType(typeRaw) {
	if (!typeRaw) return "other";
	const normalized = normalizeOptionalLowercaseString(typeRaw) ?? "";
	if (normalized.includes("directory")) return "directory";
	if (normalized.includes("file")) return "file";
	return "other";
}
//#endregion
//#region src/agents/sandbox/workspace.ts
async function ensureSandboxWorkspace(workspaceDir, seedFrom, skipBootstrap, skipOptionalBootstrapFiles) {
	await fs$1.mkdir(workspaceDir, { recursive: true });
	if (seedFrom) {
		const seed = resolveUserPath(seedFrom);
		const files = [
			DEFAULT_AGENTS_FILENAME,
			DEFAULT_SOUL_FILENAME,
			DEFAULT_TOOLS_FILENAME,
			DEFAULT_IDENTITY_FILENAME,
			DEFAULT_USER_FILENAME,
			DEFAULT_BOOTSTRAP_FILENAME,
			DEFAULT_HEARTBEAT_FILENAME
		];
		for (const name of files) {
			const src = path.join(seed, name);
			const dest = path.join(workspaceDir, name);
			try {
				await fs$1.access(dest);
			} catch {
				try {
					const opened = await openRootFile({
						absolutePath: src,
						rootPath: seed,
						boundaryLabel: "sandbox seed workspace"
					});
					if (!opened.ok) continue;
					try {
						const content = fs.readFileSync(opened.fd, "utf-8");
						await fs$1.writeFile(dest, content, {
							encoding: "utf-8",
							flag: "wx"
						});
					} finally {
						fs.closeSync(opened.fd);
					}
				} catch {}
			}
		}
	}
	await ensureAgentWorkspace({
		dir: workspaceDir,
		ensureBootstrapFiles: !skipBootstrap,
		skipOptionalBootstrapFiles
	});
}
//#endregion
//#region src/agents/sandbox/context.ts
async function ensureSandboxWorkspaceLayout(params) {
	const { cfg, rawSessionKey } = params;
	const agentWorkspaceDir = resolveUserPath(params.workspaceDir?.trim() || DEFAULT_AGENT_WORKSPACE_DIR);
	const workspaceRoot = resolveUserPath(cfg.workspaceRoot);
	const scopeKey = resolveSandboxScopeKey(cfg.scope, rawSessionKey);
	const sandboxWorkspaceDir = cfg.scope === "shared" ? workspaceRoot : resolveSandboxWorkspaceDir(workspaceRoot, scopeKey);
	const workspaceDir = cfg.workspaceAccess === "rw" ? agentWorkspaceDir : sandboxWorkspaceDir;
	if (workspaceDir === sandboxWorkspaceDir) {
		await ensureSandboxWorkspace(sandboxWorkspaceDir, agentWorkspaceDir, params.config?.agents?.defaults?.skipBootstrap, params.config?.agents?.defaults?.skipOptionalBootstrapFiles);
		if (cfg.workspaceAccess !== "rw") try {
			const [{ getRemoteSkillEligibility }, { canExecRequestNode }, { syncSkillsToWorkspace }] = await Promise.all([
				import("./skills-remote-ClBE0VUH.js"),
				import("./exec-defaults-BZ68hu5R.js"),
				import("./skills-Bcm7ote3.js")
			]);
			await syncSkillsToWorkspace({
				sourceWorkspaceDir: agentWorkspaceDir,
				targetWorkspaceDir: sandboxWorkspaceDir,
				config: params.config,
				agentId: params.agentId,
				eligibility: { remote: getRemoteSkillEligibility({ advertiseExecNode: canExecRequestNode({
					cfg: params.config,
					sessionKey: rawSessionKey,
					agentId: params.agentId
				}) }) }
			});
		} catch (error) {
			const message = error instanceof Error ? error.message : JSON.stringify(error);
			defaultRuntime.error?.(`Sandbox skill sync failed: ${message}`);
		}
	} else await fs$1.mkdir(workspaceDir, { recursive: true });
	return {
		agentWorkspaceDir,
		scopeKey,
		sandboxWorkspaceDir,
		workspaceDir
	};
}
async function resolveSandboxDockerUser(params) {
	if (params.docker.user?.trim()) return params.docker;
	const stat = params.stat ?? ((workspaceDir) => fs$1.stat(workspaceDir));
	try {
		const workspaceStat = await stat(params.workspaceDir);
		const uid = Number.isInteger(workspaceStat.uid) ? workspaceStat.uid : null;
		const gid = Number.isInteger(workspaceStat.gid) ? workspaceStat.gid : null;
		if (uid === null || gid === null || uid < 0 || gid < 0) return params.docker;
		return {
			...params.docker,
			user: `${uid}:${gid}`
		};
	} catch {
		return params.docker;
	}
}
function resolveSandboxSession(params) {
	const rawSessionKey = params.sessionKey?.trim();
	if (!rawSessionKey) return null;
	const runtime = resolveSandboxRuntimeStatus({
		cfg: params.config,
		sessionKey: rawSessionKey
	});
	if (!runtime.sandboxed) return null;
	return {
		rawSessionKey,
		runtime,
		cfg: resolveSandboxConfigForAgent(params.config, runtime.agentId)
	};
}
async function resolveSandboxContext(params) {
	const resolved = resolveSandboxSession(params);
	if (!resolved) return null;
	const { rawSessionKey, cfg, runtime } = resolved;
	if (cfg.prune.idleHours !== 0 || cfg.prune.maxAgeDays !== 0) await (await import("./prune-CmcIgbHt.js")).maybePruneSandboxes(cfg);
	const { agentWorkspaceDir, scopeKey, workspaceDir } = await ensureSandboxWorkspaceLayout({
		cfg,
		agentId: runtime.agentId,
		rawSessionKey,
		config: params.config,
		workspaceDir: params.workspaceDir
	});
	const docker = await resolveSandboxDockerUser({
		docker: cfg.docker,
		workspaceDir
	});
	const resolvedCfg = docker === cfg.docker ? cfg : {
		...cfg,
		docker
	};
	const backend = await requireSandboxBackendFactory(resolvedCfg.backend)({
		sessionKey: rawSessionKey,
		scopeKey,
		workspaceDir,
		agentWorkspaceDir,
		cfg: resolvedCfg
	});
	await updateRegistry({
		containerName: backend.runtimeId,
		backendId: backend.id,
		runtimeLabel: backend.runtimeLabel,
		sessionKey: scopeKey,
		createdAtMs: Date.now(),
		lastUsedAtMs: Date.now(),
		image: backend.configLabel ?? resolvedCfg.docker.image,
		configLabelKind: backend.configLabelKind ?? "Image"
	});
	const resolvedBrowserConfig = resolvedCfg.browser.enabled ? resolveBrowserConfig(params.config?.browser, params.config) : void 0;
	const evaluateEnabled = resolvedBrowserConfig?.evaluateEnabled ?? true;
	const bridgeAuth = cfg.browser.enabled ? await (async () => {
		const cfgForAuth = params.config ?? (await import("./config/config.js")).getRuntimeConfig();
		let browserAuth = resolveBrowserControlAuth(cfgForAuth);
		try {
			browserAuth = (await ensureBrowserControlAuth({ cfg: cfgForAuth })).auth;
		} catch (error) {
			const message = error instanceof Error ? error.message : JSON.stringify(error);
			defaultRuntime.error?.(`Sandbox browser auth ensure failed: ${message}`);
		}
		return browserAuth;
	})() : void 0;
	if (resolvedCfg.browser.enabled && backend.capabilities?.browser !== true) throw new Error(`Sandbox backend "${resolvedCfg.backend}" does not support browser sandboxes yet.`);
	const browser = resolvedCfg.browser.enabled && backend.capabilities?.browser === true ? await ensureSandboxBrowser({
		scopeKey,
		workspaceDir,
		agentWorkspaceDir,
		cfg: resolvedCfg,
		evaluateEnabled,
		bridgeAuth,
		ssrfPolicy: resolvedBrowserConfig?.ssrfPolicy
	}) : null;
	const sandboxContext = {
		enabled: true,
		backendId: backend.id,
		sessionKey: rawSessionKey,
		workspaceDir,
		agentWorkspaceDir,
		workspaceAccess: resolvedCfg.workspaceAccess,
		runtimeId: backend.runtimeId,
		runtimeLabel: backend.runtimeLabel,
		containerName: backend.runtimeId,
		containerWorkdir: backend.workdir,
		docker: resolvedCfg.docker,
		tools: resolvedCfg.tools,
		browserAllowHostControl: resolvedCfg.browser.allowHostControl,
		browser: browser ?? void 0,
		backend
	};
	sandboxContext.fsBridge = backend.createFsBridge?.({ sandbox: sandboxContext }) ?? createSandboxFsBridge({ sandbox: sandboxContext });
	return sandboxContext;
}
async function ensureSandboxWorkspaceForSession(params) {
	const resolved = resolveSandboxSession(params);
	if (!resolved) return null;
	const { rawSessionKey, cfg, runtime } = resolved;
	const { workspaceDir } = await ensureSandboxWorkspaceLayout({
		cfg,
		agentId: runtime.agentId,
		rawSessionKey,
		config: params.config,
		workspaceDir: params.workspaceDir
	});
	return {
		workspaceDir,
		containerWorkdir: cfg.docker.workdir
	};
}
//#endregion
//#region src/agents/sandbox/manage.ts
function toBrowserDockerRuntimeEntry(entry) {
	return {
		...entry,
		backendId: "docker",
		runtimeLabel: entry.containerName,
		configLabelKind: "BrowserImage"
	};
}
async function listSandboxContainers() {
	const config = getRuntimeConfig();
	const registry = await readRegistry();
	const results = [];
	for (const entry of registry.entries) {
		const manager = getSandboxBackendManager(entry.backendId ?? "docker");
		if (!manager) {
			results.push({
				...entry,
				running: false,
				imageMatch: true
			});
			continue;
		}
		const agentId = resolveSandboxAgentId(entry.sessionKey);
		const runtime = await manager.describeRuntime({
			entry,
			config,
			agentId
		});
		results.push({
			...entry,
			image: runtime.actualConfigLabel ?? entry.image,
			running: runtime.running,
			imageMatch: runtime.configLabelMatch
		});
	}
	return results;
}
async function listSandboxBrowsers() {
	const config = getRuntimeConfig();
	const registry = await readBrowserRegistry();
	const results = [];
	for (const entry of registry.entries) {
		const agentId = resolveSandboxAgentId(entry.sessionKey);
		const runtime = await dockerSandboxBackendManager.describeRuntime({
			entry: toBrowserDockerRuntimeEntry(entry),
			config,
			agentId
		});
		results.push({
			...entry,
			image: runtime.actualConfigLabel ?? entry.image,
			running: runtime.running,
			imageMatch: runtime.configLabelMatch
		});
	}
	return results;
}
async function removeSandboxContainer(containerName) {
	const config = getRuntimeConfig();
	const entry = (await readRegistry()).entries.find((item) => item.containerName === containerName);
	if (entry) await getSandboxBackendManager(entry.backendId ?? "docker")?.removeRuntime({
		entry,
		config,
		agentId: resolveSandboxAgentId(entry.sessionKey)
	});
	await removeRegistryEntry(containerName);
}
async function removeSandboxBrowserContainer(containerName) {
	const config = getRuntimeConfig();
	const entry = (await readBrowserRegistry()).entries.find((item) => item.containerName === containerName);
	if (entry) await dockerSandboxBackendManager.removeRuntime({
		entry: toBrowserDockerRuntimeEntry(entry),
		config
	});
	await removeBrowserRegistryEntry(containerName);
	for (const [sessionKey, bridge] of BROWSER_BRIDGES.entries()) if (bridge.containerName === containerName) {
		await stopBrowserBridgeServer(bridge.bridge.server).catch(() => void 0);
		BROWSER_BRIDGES.delete(sessionKey);
	}
}
//#endregion
export { ensureSandboxWorkspaceForSession as a, hasSandboxBindReadonlyHostShadows as c, removeSandboxContainer as i, resolveWritableSandboxBindHostRoots as l, listSandboxContainers as n, resolveSandboxContext as o, removeSandboxBrowserContainer as r, hasSandboxBindContainerPathAliases as s, listSandboxBrowsers as t };
