import { c as normalizeOptionalString } from "./string-coerce-DyL154ka.js";
import { g as shortenHomePath } from "./utils-sBTEdeml.js";
import { n as defaultRuntime } from "./runtime-yzlkhCoS.js";
import { t as danger } from "./globals-YU5FjfZK.js";
import { i as getRuntimeConfig } from "./io-DoswVvYe.js";
import "./string-coerce-runtime-BAEEbdFW.js";
import "./core-api-B5Vt3O83.js";
import { t as callBrowserRequest } from "./browser-cli-shared-BiWbz8Jo.js";
import fs from "node:fs/promises";
//#region extensions/browser/src/cli/browser-cli-inspect.ts
function registerBrowserInspectCommands(browser, parentOpts) {
	browser.command("screenshot").description("Capture a screenshot (MEDIA:<path>)").argument("[targetId]", "CDP target id (or unique prefix)").option("--full-page", "Capture full scrollable page", false).option("--ref <ref>", "ARIA ref from ai snapshot").option("--element <selector>", "CSS selector for element screenshot").option("--labels", "Overlay role refs on the screenshot", false).option("--type <png|jpeg>", "Output type (default: png)", "png").action(async (targetId, opts, cmd) => {
		const parent = parentOpts(cmd);
		const profile = parent?.browserProfile;
		try {
			const result = await callBrowserRequest(parent, {
				method: "POST",
				path: "/screenshot",
				query: profile ? { profile } : void 0,
				body: {
					targetId: normalizeOptionalString(targetId),
					fullPage: Boolean(opts.fullPage),
					ref: normalizeOptionalString(opts.ref),
					element: normalizeOptionalString(opts.element),
					labels: Boolean(opts.labels),
					type: opts.type === "jpeg" ? "jpeg" : "png"
				}
			}, { timeoutMs: 2e4 });
			if (parent?.json) {
				defaultRuntime.writeJson(result);
				return;
			}
			defaultRuntime.log(`MEDIA:${shortenHomePath(result.path)}`);
		} catch (err) {
			defaultRuntime.error(danger(String(err)));
			defaultRuntime.exit(1);
		}
	});
	browser.command("snapshot").description("Capture a snapshot (default: ai; aria is the accessibility tree)").option("--format <aria|ai>", "Snapshot format (default: ai)", "ai").option("--target-id <id>", "CDP target id (or unique prefix)").option("--limit <n>", "Max nodes (default: 500/800)", (v) => Number(v)).option("--mode <efficient>", "Snapshot preset (efficient)").option("--efficient", "Use the efficient snapshot preset", false).option("--interactive", "Role snapshot: interactive elements only", false).option("--compact", "Role snapshot: compact output", false).option("--depth <n>", "Role snapshot: max depth", (v) => Number(v)).option("--selector <sel>", "Role snapshot: scope to CSS selector").option("--frame <sel>", "Role snapshot: scope to an iframe selector").option("--labels", "Include viewport label overlay screenshot", false).option("--urls", "Append discovered link URLs to AI snapshots", false).option("--out <path>", "Write snapshot to a file").action(async (opts, cmd) => {
		const parent = parentOpts(cmd);
		const profile = parent?.browserProfile;
		const format = opts.format === "aria" ? "aria" : "ai";
		const configMode = !(typeof cmd.getOptionValueSource === "function" && cmd.getOptionValueSource("format") === "cli") && format === "ai" && getRuntimeConfig().browser?.snapshotDefaults?.mode === "efficient" ? "efficient" : void 0;
		const mode = opts.efficient === true || opts.mode === "efficient" ? "efficient" : configMode;
		try {
			const result = await callBrowserRequest(parent, {
				method: "GET",
				path: "/snapshot",
				query: {
					format,
					targetId: normalizeOptionalString(opts.targetId),
					limit: Number.isFinite(opts.limit) ? opts.limit : void 0,
					interactive: opts.interactive ? true : void 0,
					compact: opts.compact ? true : void 0,
					depth: Number.isFinite(opts.depth) ? opts.depth : void 0,
					selector: normalizeOptionalString(opts.selector),
					frame: normalizeOptionalString(opts.frame),
					labels: opts.labels ? true : void 0,
					urls: opts.urls ? true : void 0,
					mode,
					profile
				}
			}, { timeoutMs: 2e4 });
			if (opts.out) {
				if (result.format === "ai") await fs.writeFile(opts.out, result.snapshot, "utf8");
				else {
					const payload = JSON.stringify(result, null, 2);
					await fs.writeFile(opts.out, payload, "utf8");
				}
				if (parent?.json) defaultRuntime.writeJson({
					ok: true,
					out: opts.out,
					...result.format === "ai" && result.imagePath ? { imagePath: result.imagePath } : {}
				});
				else {
					defaultRuntime.log(shortenHomePath(opts.out));
					if (result.format === "ai" && result.imagePath) defaultRuntime.log(`MEDIA:${shortenHomePath(result.imagePath)}`);
				}
				return;
			}
			if (parent?.json) {
				defaultRuntime.writeJson(result);
				return;
			}
			if (result.format === "ai") {
				defaultRuntime.log(result.snapshot);
				if (result.imagePath) defaultRuntime.log(`MEDIA:${shortenHomePath(result.imagePath)}`);
				return;
			}
			const nodes = "nodes" in result ? result.nodes : [];
			defaultRuntime.log(nodes.map((n) => {
				const indent = "  ".repeat(Math.min(20, n.depth));
				const name = n.name ? ` "${n.name}"` : "";
				const value = n.value ? ` = "${n.value}"` : "";
				return `${indent}- ${n.role}${name}${value}`;
			}).join("\n"));
		} catch (err) {
			defaultRuntime.error(danger(String(err)));
			defaultRuntime.exit(1);
		}
	});
}
//#endregion
export { registerBrowserInspectCommands };
