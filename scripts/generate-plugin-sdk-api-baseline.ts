#!/usr/bin/env node
import path from "node:path";
import { writePluginSdkApiBaselineStatefile } from "../src/plugin-sdk/api-baseline.ts";

const args = new Set(process.argv.slice(2));
const checkOnly = args.has("--check");
const writeMode = args.has("--write");

if (checkOnly === writeMode) {
	console.error("Use exactly one of --check or --write.");
	process.exit(1);
}

const repoRoot = process.cwd();

async function main(): Promise<void> {
	const result = await writePluginSdkApiBaselineStatefile({
		repoRoot,
		check: checkOnly,
	});

	if (checkOnly) {
		if (result.changed) {
			console.error(
				[
					"Plugin SDK API baseline drift detected.",
					`Expected current: ${path.relative(repoRoot, result.jsonPath)}`,
					`Expected current: ${path.relative(repoRoot, result.statefilePath)}`,
					"If this Plugin SDK surface change is intentional, run `pnpm plugin-sdk:api:gen` and commit the updated baseline files.",
					"If not intentional, treat this as API drift and fix the plugin-sdk exports or metadata first.",
				].join("\n"),
			);
			process.exit(1);
		}
		console.log(
			`OK ${path.relative(repoRoot, result.jsonPath)} ${path.relative(repoRoot, result.statefilePath)}`,
		);
		return;
	}
	console.log(
		[
			`Wrote ${path.relative(repoRoot, result.jsonPath)}`,
			`Wrote ${path.relative(repoRoot, result.statefilePath)}`,
		].join("\n"),
	);
}

await main();
