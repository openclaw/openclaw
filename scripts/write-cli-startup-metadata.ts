import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

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

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
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

function readBundledChannelCatalogIds(): string[] {
  const entries: ExtensionChannelEntry[] = [];
  for (const dirEntry of readdirSync(extensionsDir, { withFileTypes: true })) {
    if (!dirEntry.isDirectory()) {
      continue;
    }
    const packageJsonPath = path.join(extensionsDir, dirEntry.name, "package.json");
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

const catalog = readBundledChannelCatalogIds();
const channelOptions = dedupe([...CORE_CHANNEL_ORDER, ...catalog]);

mkdirSync(distDir, { recursive: true });
writeFileSync(
  outputPath,
  `${JSON.stringify(
    {
      generatedBy: "scripts/write-cli-startup-metadata.ts",
      channelOptions,
    },
    null,
    2,
  )}\n`,
  "utf8",
);
