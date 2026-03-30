import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

function dedupe(values: string[]): string[] {
	const seen = new Set<string>();
	const out: string[] = [];
	for (const value of values) {
		if (!value || seen.has(value)) {
			continue;
		}
		seen.add(value);
		out.push(value);
	}
	return out;
}

const scriptPath = fileURLToPath(import.meta.url);
const scriptDir = path.dirname(scriptPath);
const rootDir = path.resolve(scriptDir, "..");
const distDir = path.join(rootDir, "dist");
const outputPath = path.join(distDir, "cli-startup-metadata.json");
const extensionsDir = path.join(rootDir, "extensions");
const CORE_CHANNEL_ORDER = [
	"telegram",
	"whatsapp",
	"discord",
	"irc",
	"googlechat",
	"slack",
	"signal",
	"imessage",
] as const;

type ExtensionChannelEntry = {
	id: string;
	order: number;
	label: string;
};

export function readBundledChannelCatalogIds(
	extensionsDirOverride: string = extensionsDir,
): string[] {
	const entries: ExtensionChannelEntry[] = [];
	for (const dirEntry of readdirSync(extensionsDirOverride, {
		withFileTypes: true,
	})) {
		if (!dirEntry.isDirectory()) {
			continue;
		}
		const packageJsonPath = path.join(
			extensionsDirOverride,
			dirEntry.name,
			"package.json",
		);
		try {
			const raw = readFileSync(packageJsonPath, "utf8");
			const parsed = JSON.parse(raw) as {
				openclaw?: {
					channel?: {
						id?: unknown;
						order?: unknown;
						label?: unknown;
					};
				};
			};
			const id = parsed.openclaw?.channel?.id;
			if (typeof id !== "string" || !id.trim()) {
				continue;
			}
			const orderRaw = parsed.openclaw?.channel?.order;
			const labelRaw = parsed.openclaw?.channel?.label;
			entries.push({
				id: id.trim(),
				order: typeof orderRaw === "number" ? orderRaw : 999,
				label: typeof labelRaw === "string" ? labelRaw : id.trim(),
			});
		} catch {
			// Ignore malformed or missing extension package manifests.
		}
	}
	return entries
		.toSorted((a, b) =>
			a.order === b.order ? a.label.localeCompare(b.label) : a.order - b.order,
		)
		.map((entry) => entry.id);
}

async function captureStdout(
	action: () => void | Promise<void>,
): Promise<string> {
	let output = "";
	const originalWrite = process.stdout.write.bind(process.stdout);
	const captureWrite: typeof process.stdout.write = ((
		chunk: string | Uint8Array,
	) => {
		output += String(chunk);
		return true;
	}) as typeof process.stdout.write;
	process.stdout.write = captureWrite;
	try {
		await action();
	} finally {
		process.stdout.write = originalWrite;
	}
	return output;
}

export async function renderBundledRootHelpText(
	distDirOverride: string = distDir,
): Promise<string> {
	const bundleName = readdirSync(distDirOverride).find(
		(entry) => entry.startsWith("root-help-") && entry.endsWith(".js"),
	);
	if (!bundleName) {
		throw new Error(
			"No root-help bundle found in dist; cannot write CLI startup metadata.",
		);
	}
	const moduleUrl = pathToFileURL(path.join(distDirOverride, bundleName)).href;
	const mod = (await import(moduleUrl)) as {
		outputRootHelp?: () => void | Promise<void>;
	};
	if (typeof mod.outputRootHelp !== "function") {
		throw new Error(`Bundle ${bundleName} does not export outputRootHelp.`);
	}

	return captureStdout(async () => {
		await mod.outputRootHelp?.();
	});
}

export async function writeCliStartupMetadata(options?: {
	distDir?: string;
	outputPath?: string;
	extensionsDir?: string;
}): Promise<void> {
	const resolvedDistDir = options?.distDir ?? distDir;
	const resolvedOutputPath = options?.outputPath ?? outputPath;
	const resolvedExtensionsDir = options?.extensionsDir ?? extensionsDir;
	const catalog = readBundledChannelCatalogIds(resolvedExtensionsDir);
	const channelOptions = dedupe([...CORE_CHANNEL_ORDER, ...catalog]);
	const rootHelpText = await renderBundledRootHelpText(resolvedDistDir);

	mkdirSync(resolvedDistDir, { recursive: true });
	writeFileSync(
		resolvedOutputPath,
		`${JSON.stringify(
			{
				generatedBy: "scripts/write-cli-startup-metadata.ts",
				channelOptions,
				rootHelpText,
			},
			null,
			2,
		)}\n`,
		"utf8",
	);
}

if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath) {
	await writeCliStartupMetadata();
}
