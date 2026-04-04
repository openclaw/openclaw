import { spawnSync } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { renderRootHelpText as renderSourceRootHelpText } from "../src/cli/program/root-help.ts";

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
  for (const dirEntry of readdirSync(extensionsDirOverride, { withFileTypes: true })) {
    if (!dirEntry.isDirectory()) {
      continue;
    }
    const packageJsonPath = path.join(extensionsDirOverride, dirEntry.name, "package.json");
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
    .toSorted((a, b) => (a.order === b.order ? a.label.localeCompare(b.label) : a.order - b.order))
    .map((entry) => entry.id);
}

export async function renderBundledRootHelpText(
  _distDirOverride: string = distDir,
): Promise<string> {
  const bundleName = readdirSync(distDirOverride).find(
    (entry) => entry.startsWith("root-help-") && entry.endsWith(".js"),
  );
  if (!bundleName) {
    throw new Error("No root-help bundle found in dist; cannot write CLI startup metadata.");
  }
  const moduleUrl = pathToFileURL(path.join(distDirOverride, bundleName)).href;
  const inlineModule = [
    `const mod = await import(${JSON.stringify(moduleUrl)});`,
    "if (typeof mod.outputRootHelp !== 'function') {",
    `  throw new Error(${JSON.stringify(`Bundle ${bundleName} does not export outputRootHelp.`)});`,
    "}",
    "await mod.outputRootHelp();",
    "process.exit(0);",
  ].join("\n");
  const result = spawnSync(process.execPath, ["--input-type=module", "--eval", inlineModule], {
    cwd: distDirOverride,
    encoding: "utf8",
    timeout: 30_000,
  });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    const stderr = result.stderr?.trim();
    throw new Error(
      `Failed to render bundled root help from ${bundleName}` +
        (stderr ? `: ${stderr}` : result.signal ? `: terminated by ${result.signal}` : ""),
    );
  }
  return result.stdout ?? "";
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
  const useSourceRootHelp =
    resolvedDistDir === distDir &&
    resolvedOutputPath === outputPath &&
    resolvedExtensionsDir === extensionsDir;
  const rootHelpText = useSourceRootHelp
    ? await renderSourceRootHelpText({ pluginSdkResolution: "src" })
    : await renderBundledRootHelpText(resolvedDistDir);

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
  process.exit(0);
}
