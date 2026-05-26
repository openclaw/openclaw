import { t as formatCliCommand } from "./command-format-OwPqnbXG.js";
import { g as shortenHomePath } from "./utils-CKsuXgDI.js";
import { i as runExec, r as runCommandWithTimeout } from "./exec-DusmGtXL.js";
import { d as DEFAULT_SANDBOX_IMAGE, r as DEFAULT_SANDBOX_BROWSER_IMAGE } from "./constants-DtcAqz4S.js";
import { s as resolveSandboxScope } from "./config-BNHBQmxW.js";
import { b as inspectLegacySandboxRegistryFiles, c as isDockerDaemonUnavailable, x as migrateLegacySandboxRegistryFiles } from "./docker-ixkwd21t.js";
import "./sandbox-DIHI_0fY.js";
import { t as note } from "./note-Bg5THHEx.js";
import fs from "node:fs";
import path from "node:path";
//#region src/commands/doctor-sandbox.ts
function resolveSandboxScript(scriptRel) {
	const candidates = /* @__PURE__ */ new Set();
	candidates.add(process.cwd());
	const argv1 = process.argv[1];
	if (argv1) {
		const normalized = path.resolve(argv1);
		candidates.add(path.resolve(path.dirname(normalized), ".."));
		candidates.add(path.resolve(path.dirname(normalized)));
	}
	for (const root of candidates) {
		const scriptPath = path.join(root, scriptRel);
		if (fs.existsSync(scriptPath)) return {
			scriptPath,
			cwd: root
		};
	}
	return null;
}
async function runSandboxScript(scriptRel, runtime) {
	const script = resolveSandboxScript(scriptRel);
	if (!script) {
		note(`Unable to locate ${scriptRel}. Run it from the repo root.`, "Sandbox");
		return false;
	}
	runtime.log(`Running ${scriptRel}...`);
	const result = await runCommandWithTimeout(["bash", script.scriptPath], {
		timeoutMs: 1200 * 1e3,
		cwd: script.cwd
	});
	if (result.code !== 0) {
		runtime.error(`Failed running ${scriptRel}: ${result.stderr.trim() || result.stdout.trim() || "unknown error"}`);
		return false;
	}
	runtime.log(`Completed ${scriptRel}.`);
	return true;
}
async function isDockerAvailable() {
	try {
		await runExec("docker", [
			"version",
			"--format",
			"{{.Server.Version}}"
		], { timeoutMs: 5e3 });
		return true;
	} catch {
		return false;
	}
}
async function dockerImageExists(image) {
	try {
		await runExec("docker", [
			"image",
			"inspect",
			image
		], { timeoutMs: 5e3 });
		return true;
	} catch (error) {
		const stderr = error?.stderr || error?.message || "";
		if (stderr.includes("No such image")) return false;
		if (isDockerDaemonUnavailable(stderr)) return false;
		throw error;
	}
}
function resolveSandboxDockerImage(cfg) {
	const image = cfg.agents?.defaults?.sandbox?.docker?.image?.trim();
	return image ? image : DEFAULT_SANDBOX_IMAGE;
}
function resolveSandboxBackend(cfg) {
	return cfg.agents?.defaults?.sandbox?.backend?.trim() || "docker";
}
function resolveSandboxBrowserImage(cfg) {
	const image = cfg.agents?.defaults?.sandbox?.browser?.image?.trim();
	return image ? image : DEFAULT_SANDBOX_BROWSER_IMAGE;
}
function updateSandboxDockerImage(cfg, image) {
	return {
		...cfg,
		agents: {
			...cfg.agents,
			defaults: {
				...cfg.agents?.defaults,
				sandbox: {
					...cfg.agents?.defaults?.sandbox,
					docker: {
						...cfg.agents?.defaults?.sandbox?.docker,
						image
					}
				}
			}
		}
	};
}
function updateSandboxBrowserImage(cfg, image) {
	return {
		...cfg,
		agents: {
			...cfg.agents,
			defaults: {
				...cfg.agents?.defaults,
				sandbox: {
					...cfg.agents?.defaults?.sandbox,
					browser: {
						...cfg.agents?.defaults?.sandbox?.browser,
						image
					}
				}
			}
		}
	};
}
async function handleMissingSandboxImage(params, runtime, prompter) {
	if (await dockerImageExists(params.image)) return;
	const buildHint = params.buildScript ? `Build it with ${params.buildScript}.` : "Build or pull it first.";
	note(`Sandbox ${params.kind} image missing: ${params.image}. ${buildHint}`, "Sandbox");
	let built = false;
	if (params.buildScript) {
		if (await prompter.confirmRuntimeRepair({
			message: `Build ${params.kind} sandbox image now?`,
			initialValue: true
		})) built = await runSandboxScript(params.buildScript, runtime);
	}
	if (built) return;
}
async function maybeRepairSandboxImages(cfg, runtime, prompter) {
	const sandbox = cfg.agents?.defaults?.sandbox;
	const mode = sandbox?.mode ?? "off";
	if (!sandbox || mode === "off") return cfg;
	const backend = resolveSandboxBackend(cfg);
	if (backend !== "docker") {
		if (sandbox.browser?.enabled) note(`Sandbox backend "${backend}" selected. Docker browser health checks are skipped; browser sandbox currently requires the docker backend.`, "Sandbox");
		return cfg;
	}
	if (!await isDockerAvailable()) {
		note([
			`Sandbox mode is enabled (mode: "${mode}") but Docker is not available.`,
			"Docker is required for sandbox mode to function.",
			"Isolated sessions (cron jobs, sub-agents) will fail without Docker.",
			"",
			"Options:",
			"- Install Docker and restart the gateway",
			"- Disable sandbox mode: openclaw config set agents.defaults.sandbox.mode off"
		].join("\n"), "Sandbox");
		return cfg;
	}
	let next = cfg;
	const changes = [];
	const dockerImage = resolveSandboxDockerImage(cfg);
	await handleMissingSandboxImage({
		kind: "base",
		image: dockerImage,
		buildScript: dockerImage === "openclaw-sandbox-common:bookworm-slim" ? "scripts/sandbox-common-setup.sh" : dockerImage === "openclaw-sandbox:bookworm-slim" ? "scripts/sandbox-setup.sh" : void 0,
		updateConfig: (image) => {
			next = updateSandboxDockerImage(next, image);
			changes.push(`Updated agents.defaults.sandbox.docker.image → ${image}`);
		}
	}, runtime, prompter);
	if (sandbox.browser?.enabled) await handleMissingSandboxImage({
		kind: "browser",
		image: resolveSandboxBrowserImage(cfg),
		buildScript: "scripts/sandbox-browser-setup.sh",
		updateConfig: (image) => {
			next = updateSandboxBrowserImage(next, image);
			changes.push(`Updated agents.defaults.sandbox.browser.image → ${image}`);
		}
	}, runtime, prompter);
	if (changes.length > 0) note(changes.join("\n"), "Doctor changes");
	return next;
}
function formatLegacyRegistryInspectionLine(file) {
	const status = file.valid ? `${file.entries} entr${file.entries === 1 ? "y" : "ies"}` : "invalid";
	return `- ${file.kind}: ${shortenHomePath(file.registryPath)} (${status})`;
}
function formatLegacyRegistryMigrationLine(result) {
	const file = shortenHomePath(result.registryPath);
	if (result.status === "migrated") return `- Migrated ${result.kind} registry from ${file} into ${result.entries} shard${result.entries === 1 ? "" : "s"}.`;
	if (result.status === "removed-empty") return `- Removed empty legacy ${result.kind} registry ${file}.`;
	if (result.status === "quarantined-invalid") {
		const quarantine = result.quarantinePath ? ` to ${shortenHomePath(result.quarantinePath)}` : "";
		return `- Quarantined invalid legacy ${result.kind} registry ${file}${quarantine}.`;
	}
	return "";
}
async function maybeRepairSandboxRegistryFiles(prompter) {
	const legacyFiles = (await inspectLegacySandboxRegistryFiles()).filter((file) => file.exists);
	if (legacyFiles.length === 0) return;
	if (!prompter.shouldRepair) {
		note([
			"Legacy sandbox registry files detected.",
			...legacyFiles.map(formatLegacyRegistryInspectionLine),
			`Run ${formatCliCommand("openclaw doctor --fix")} to migrate them to sharded registry files.`
		].join("\n"), "Sandbox");
		return;
	}
	const results = (await migrateLegacySandboxRegistryFiles()).filter((result) => result.status !== "missing").map(formatLegacyRegistryMigrationLine).filter((line) => line.length > 0);
	if (results.length > 0) note(results.join("\n"), "Doctor changes");
}
function noteSandboxScopeWarnings(cfg) {
	const globalSandbox = cfg.agents?.defaults?.sandbox;
	const agents = Array.isArray(cfg.agents?.list) ? cfg.agents.list : [];
	const warnings = [];
	for (const agent of agents) {
		const agentId = agent.id;
		const agentSandbox = agent.sandbox;
		if (!agentSandbox) continue;
		if (resolveSandboxScope({ scope: agentSandbox.scope ?? globalSandbox?.scope }) !== "shared") continue;
		const overrides = [];
		if (agentSandbox.docker && Object.keys(agentSandbox.docker).length > 0) overrides.push("docker");
		if (agentSandbox.browser && Object.keys(agentSandbox.browser).length > 0) overrides.push("browser");
		if (agentSandbox.prune && Object.keys(agentSandbox.prune).length > 0) overrides.push("prune");
		if (overrides.length === 0) continue;
		warnings.push([`- agents.list (id "${agentId}") sandbox ${overrides.join("/")} overrides ignored.`, `  scope resolves to "shared".`].join("\n"));
	}
	if (warnings.length > 0) note(warnings.join("\n"), "Sandbox");
}
//#endregion
export { maybeRepairSandboxImages, maybeRepairSandboxRegistryFiles, noteSandboxScopeWarnings };
