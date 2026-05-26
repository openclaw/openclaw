import { t as formatDocsLink } from "../../links-CM5vg8_V.js";
import { r as theme } from "../../theme-D58JpUfy.js";
import { t as formatHelpExamples } from "../../help-format-DXVAk021.js";
import "../../memory-core-host-runtime-cli-Bh4w9lk4.js";
import { t as DEFAULT_PROMOTION_MIN_SCORE } from "../../short-term-promotion-BpCbM_k1.js";
//#region extensions/memory-core/src/cli.ts
let memoryCliRuntimePromise = null;
async function loadMemoryCliRuntime() {
	memoryCliRuntimePromise ??= import("../../cli.runtime-BAhWIY60.js");
	return await memoryCliRuntimePromise;
}
async function runMemoryStatus(opts) {
	await (await loadMemoryCliRuntime()).runMemoryStatus(opts);
}
async function runMemoryIndex(opts) {
	await (await loadMemoryCliRuntime()).runMemoryIndex(opts);
}
async function runMemorySearch(queryArg, opts) {
	await (await loadMemoryCliRuntime()).runMemorySearch(queryArg, opts);
}
async function runMemoryPromote(opts) {
	await (await loadMemoryCliRuntime()).runMemoryPromote(opts);
}
async function runMemoryPromoteExplain(selectorArg, opts) {
	await (await loadMemoryCliRuntime()).runMemoryPromoteExplain(selectorArg, opts);
}
async function runMemoryRemHarness(opts) {
	await (await loadMemoryCliRuntime()).runMemoryRemHarness(opts);
}
async function runMemoryRemBackfill(opts) {
	await (await loadMemoryCliRuntime()).runMemoryRemBackfill(opts);
}
function registerMemoryCli(program) {
	const memory = program.command("memory").description("Search, inspect, and reindex memory files").addHelpText("after", () => `\n${theme.heading("Examples:")}\n${formatHelpExamples([
		["openclaw memory status", "Show index and provider status."],
		["openclaw memory status --fix", "Repair stale recall locks and normalize promotion metadata."],
		["openclaw memory status --deep", "Probe embedding provider readiness."],
		["openclaw memory index --force", "Force a full reindex."],
		["openclaw memory search \"meeting notes\"", "Quick search using positional query."],
		["openclaw memory search --query \"deployment\" --max-results 20", "Limit results for focused troubleshooting."],
		[`openclaw memory promote --limit 10 --min-score ${DEFAULT_PROMOTION_MIN_SCORE}`, "Review weighted short-term candidates for long-term memory."],
		["openclaw memory promote --apply", "Append top-ranked short-term candidates into MEMORY.md."],
		["openclaw memory promote-explain \"router vlan\"", "Explain why a specific candidate would or would not promote."],
		["openclaw memory rem-harness --json", "Preview REM reflections, candidate truths, and deep promotion output."],
		["openclaw memory rem-backfill --path ./memory", "Write grounded historical REM entries into DREAMS.md for UI review."],
		["openclaw memory rem-backfill --path ./memory --stage-short-term", "Also seed durable grounded candidates into the live short-term promotion store."],
		["openclaw memory status --json", "Output machine-readable JSON (good for scripts)."]
	])}\n\n${theme.muted("Docs:")} ${formatDocsLink("/cli/memory", "docs.openclaw.ai/cli/memory")}\n`);
	memory.command("status").description("Show memory search index status").option("--agent <id>", "Agent id (default: default agent)").option("--json", "Print JSON").option("--deep", "Probe embedding provider availability").option("--index", "Reindex if dirty (implies --deep)").option("--fix", "Repair stale recall locks and normalize promotion metadata").option("--verbose", "Verbose logging", false).action(async (opts) => {
		await runMemoryStatus(opts);
	});
	memory.command("index").description("Reindex memory files").option("--agent <id>", "Agent id (default: default agent)").option("--force", "Force full reindex", false).option("--verbose", "Verbose logging", false).action(async (opts) => {
		await runMemoryIndex(opts);
	});
	memory.command("search").description("Search memory files").argument("[query]", "Search query").option("--query <text>", "Search query (alternative to positional argument)").option("--agent <id>", "Agent id (default: default agent)").option("--max-results <n>", "Max results", (value) => Number(value)).option("--min-score <n>", "Minimum score", (value) => Number(value)).option("--json", "Print JSON").action(async (queryArg, opts) => {
		await runMemorySearch(queryArg, opts);
	});
	memory.command("promote").description("Rank short-term recalls and optionally append top entries to MEMORY.md").option("--agent <id>", "Agent id (default: default agent)").option("--limit <n>", "Max candidates", (value) => Number(value)).option("--min-score <n>", `Minimum weighted score (default: ${DEFAULT_PROMOTION_MIN_SCORE})`, (value) => Number(value)).option("--min-recall-count <n>", `Minimum recall count (default: 3)`, (value) => Number(value)).option("--min-unique-queries <n>", `Minimum distinct query count (default: 2)`, (value) => Number(value)).option("--apply", "Append selected candidates to MEMORY.md", false).option("--include-promoted", "Include already promoted candidates", false).option("--json", "Print JSON").action(async (opts) => {
		await runMemoryPromote(opts);
	});
	memory.command("promote-explain").description("Explain a specific promotion candidate and its score breakdown").argument("<selector>", "Candidate key, path fragment, or snippet fragment").option("--agent <id>", "Agent id (default: default agent)").option("--include-promoted", "Include already promoted candidates", false).option("--json", "Print JSON").action(async (selectorArg, opts) => {
		await runMemoryPromoteExplain(selectorArg, opts);
	});
	memory.command("rem-harness").description("Preview REM reflections, candidate truths, and deep promotions without writing").option("--agent <id>", "Agent id (default: default agent)").option("--path <file-or-dir>", "Seed the harness from historical daily memory file(s)").option("--grounded", "Also render a grounded day-level REM preview").option("--include-promoted", "Include already promoted deep candidates", false).option("--json", "Print JSON").action(async (opts) => {
		await runMemoryRemHarness(opts);
	});
	memory.command("rem-backfill").description("Write grounded historical REM summaries into DREAMS.md for UI review").option("--agent <id>", "Agent id (default: default agent)").option("--path <file-or-dir>", "Historical daily memory file(s) or directory").option("--rollback", "Remove previously written grounded REM backfill entries", false).option("--stage-short-term", "Also seed grounded durable candidates into the short-term promotion store", false).option("--rollback-short-term", "Remove previously seeded grounded short-term candidates", false).option("--json", "Print JSON").action(async (opts) => {
		await runMemoryRemBackfill(opts);
	});
	memory.action(() => {
		memory.outputHelp();
		process.exitCode = 0;
	});
}
//#endregion
export { registerMemoryCli };
