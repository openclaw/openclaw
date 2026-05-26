import { t as resolveOpenClawPackageRoot } from "./openclaw-root-CNp1Ofdk.js";
import { r as runCommandWithTimeout } from "./exec-D4bhAbbv.js";
import { t as note } from "./note-Dg2Luaaq.js";
import { a as resolveControlUiDistIndexPathForRoot, r as resolveControlUiDistIndexHealth } from "./control-ui-assets-W5GRTbBr.js";
import path from "node:path";
import fs from "node:fs/promises";
//#region src/commands/doctor-ui.ts
async function maybeRepairUiProtocolFreshness(_runtime, prompter) {
	const root = await resolveOpenClawPackageRoot({
		moduleUrl: import.meta.url,
		argv1: process.argv[1],
		cwd: process.cwd()
	});
	if (!root) return;
	const schemaPath = path.join(root, "src/gateway/protocol/schema.ts");
	const uiIndexPath = (await resolveControlUiDistIndexHealth({
		root,
		argv1: process.argv[1]
	})).indexPath ?? resolveControlUiDistIndexPathForRoot(root);
	try {
		const [schemaStats, uiStats] = await Promise.all([fs.stat(schemaPath).catch(() => null), fs.stat(uiIndexPath).catch(() => null)]);
		if (schemaStats && !uiStats) {
			note(["- Control UI assets are missing.", "- Run: pnpm ui:build"].join("\n"), "UI");
			const uiSourcesPath = path.join(root, "ui/package.json");
			if (!await fs.stat(uiSourcesPath).catch(() => null)) {
				note("Skipping UI build: ui/ sources not present.", "UI");
				return;
			}
			if (await prompter.confirmAutoFix({
				message: "Build Control UI assets now?",
				initialValue: true
			})) {
				note("Building Control UI assets... (this may take a moment)", "UI");
				const uiScriptPath = path.join(root, "scripts/ui.js");
				const buildResult = await runCommandWithTimeout([
					process.execPath,
					uiScriptPath,
					"build"
				], {
					cwd: root,
					timeoutMs: 12e4,
					env: {
						...process.env,
						FORCE_COLOR: "1"
					}
				});
				if (buildResult.code === 0) note("UI build complete.", "UI");
				else note([`UI build failed (exit ${buildResult.code ?? "unknown"}).`, buildResult.stderr.trim() ? buildResult.stderr.trim() : null].filter(Boolean).join("\n"), "UI");
			}
			return;
		}
		if (!schemaStats || !uiStats) return;
		if (schemaStats.mtime > uiStats.mtime) {
			const gitLog = await runCommandWithTimeout([
				"git",
				"-C",
				root,
				"log",
				`--since=${uiStats.mtime.toISOString()}`,
				"--format=%h %s",
				"src/gateway/protocol/schema.ts"
			], { timeoutMs: 5e3 }).catch(() => null);
			if (gitLog && gitLog.code === 0 && gitLog.stdout.trim()) {
				note(`UI assets are older than the protocol schema.\nFunctional changes since last build:\n${gitLog.stdout.trim().split("\n").map((l) => `- ${l}`).join("\n")}`, "UI Freshness");
				if (await prompter.confirmAggressiveAutoFix({
					message: "Rebuild UI now? (Detected protocol mismatch requiring update)",
					initialValue: true
				})) {
					const uiSourcesPath = path.join(root, "ui/package.json");
					if (!await fs.stat(uiSourcesPath).catch(() => null)) {
						note("Skipping UI rebuild: ui/ sources not present.", "UI");
						return;
					}
					note("Rebuilding stale UI assets... (this may take a moment)", "UI");
					const uiScriptPath = path.join(root, "scripts/ui.js");
					const buildResult = await runCommandWithTimeout([
						process.execPath,
						uiScriptPath,
						"build"
					], {
						cwd: root,
						timeoutMs: 12e4,
						env: {
							...process.env,
							FORCE_COLOR: "1"
						}
					});
					if (buildResult.code === 0) note("UI rebuild complete.", "UI");
					else note([`UI rebuild failed (exit ${buildResult.code ?? "unknown"}).`, buildResult.stderr.trim() ? buildResult.stderr.trim() : null].filter(Boolean).join("\n"), "UI");
				}
			}
		}
	} catch {}
}
//#endregion
export { maybeRepairUiProtocolFreshness };
