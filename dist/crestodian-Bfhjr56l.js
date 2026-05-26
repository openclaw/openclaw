import { n as defaultRuntime, r as writeRuntimeJson } from "./runtime-DDH_zqCr.js";
import { r as withProgress } from "./progress-Cw6xZlhJ.js";
import { i as isPersistentCrestodianOperation, n as executeCrestodianOperation } from "./operations-BYUMdBy8.js";
import { r as loadCrestodianOverview, t as formatCrestodianOverview } from "./overview-Con_Lx_i.js";
import { r as resolveCrestodianOperation } from "./dialogue-KCTB1H-E.js";
import { stdin, stdout } from "node:process";
//#region src/crestodian/crestodian.ts
function crestodianCommandDepsFromOptions(opts) {
	if (!opts.deps && !opts.formatOverview && !opts.loadOverview) return;
	return {
		...opts.deps,
		...opts.formatOverview ? { formatOverview: opts.formatOverview } : {},
		...opts.loadOverview ? { loadOverview: opts.loadOverview } : {}
	};
}
async function runOneShot(input, runtime, opts) {
	const operation = await resolveCrestodianOperation(input, runtime, opts);
	await executeCrestodianOperation(operation, runtime, {
		approved: opts.yes === true || !isPersistentCrestodianOperation(operation),
		deps: crestodianCommandDepsFromOptions(opts)
	});
}
async function runCrestodian(opts = {}, runtime = defaultRuntime) {
	if (opts.json) {
		writeRuntimeJson(runtime, await (opts.loadOverview ?? loadCrestodianOverview)());
		return;
	}
	if (opts.message?.trim()) {
		const overview = await withProgress({
			label: "Loading Crestodian overview…",
			indeterminate: true,
			delayMs: 0,
			fallback: "none"
		}, async () => await (opts.loadOverview ?? loadCrestodianOverview)());
		runtime.log((opts.formatOverview ?? formatCrestodianOverview)(overview));
		runtime.log("");
		await runOneShot(opts.message, runtime, opts);
		return;
	}
	const interactive = opts.interactive ?? true;
	const input = opts.input ?? stdin;
	const output = opts.output ?? stdout;
	const inputIsTty = input.isTTY === true;
	const outputIsTty = output.isTTY === true;
	if (!interactive || !inputIsTty || !outputIsTty) {
		runtime.error("Crestodian needs an interactive TTY. Use --message for one command.");
		runtime.exit(1);
		return;
	}
	const runInteractiveTui = opts.runInteractiveTui ?? (await import("./tui-backend-xkSbA7eU.js")).runCrestodianTui;
	opts.onReady?.();
	await runInteractiveTui(opts, runtime);
}
//#endregion
export { runCrestodian as t };
