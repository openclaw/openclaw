#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const DOC_PATH = "docs/plugins/plugin-inventory.md";
const ROOT = process.cwd();
const EXTENSIONS_DIR = path.join(ROOT, "extensions");

const PROVIDER_DOC_ALIASES = new Map([
  ["amazon-bedrock", "/providers/bedrock"],
  ["amazon-bedrock-mantle", "/providers/bedrock-mantle"],
  ["kimi", "/providers/moonshot"],
  ["perplexity", "/providers/perplexity-provider"],
]);
const PLUGIN_DOC_ALIASES = new Map([
  ["acpx", "/tools/acp-agents-setup"],
  ["brave", "/tools/brave-search"],
  ["browser", "/tools/browser"],
  ["codex", "/plugins/codex-harness"],
  ["document-extract", "/tools/pdf"],
  ["duckduckgo", "/tools/duckduckgo-search"],
  ["exa", "/tools/exa-search"],
  ["firecrawl", "/tools/firecrawl"],
  ["perplexity", "/tools/perplexity-search"],
  ["tavily", "/tools/tavily"],
  ["tokenjuice", "/tools/tokenjuice"],
]);

function readJson(relativePath) {
  return JSON.parse(fs.readFileSync(path.join(ROOT, relativePath), "utf8"));
}

function fileExists(relativePath) {
  return fs.existsSync(path.join(ROOT, relativePath));
}

function collectExcludedPackagedExtensionDirs(rootPackageJson) {
  const excluded = new Set();
  for (const entry of rootPackageJson.files ?? []) {
    if (typeof entry !== "string") {
      continue;
    }
    const match = /^!dist\/extensions\/([^/]+)\/\*\*$/u.exec(entry);
    if (match?.[1]) {
      excluded.add(match[1]);
    }
  }
  return excluded;
}

function normalizeDocPath(value) {
  if (typeof value !== "string" || !value.startsWith("/")) {
    return null;
  }
  return value.replace(/\.mdx?$/u, "");
}

function docLink({ label, href }) {
  return `[${label}](${href})`;
}

function pushUniqueDocLink(values, value) {
  if (
    value &&
    !values.some((existing) => existing.label === value.label && existing.href === value.href)
  ) {
    values.push(value);
  }
}

function resolveDocs({ dirName, manifest, packageJson }) {
  const links = [];
  const pluginAlias = PLUGIN_DOC_ALIASES.get(manifest.id) ?? PLUGIN_DOC_ALIASES.get(dirName);
  if (pluginAlias) {
    pushUniqueDocLink(links, { href: pluginAlias, label: manifest.id ?? dirName });
  }

  const channelDoc = normalizeDocPath(packageJson.openclaw?.channel?.docsPath);
  if (channelDoc) {
    pushUniqueDocLink(links, {
      href: channelDoc,
      label: channelDoc.replace(/^\/channels\//u, ""),
    });
  }

  for (const channel of manifest.channels ?? []) {
    if (typeof channel !== "string") {
      continue;
    }
    const relativePath = `docs/channels/${channel}.md`;
    if (fileExists(relativePath)) {
      pushUniqueDocLink(links, { href: `/channels/${channel}`, label: channel });
    }
  }

  for (const provider of manifest.providers ?? []) {
    if (typeof provider !== "string") {
      continue;
    }
    const alias = PROVIDER_DOC_ALIASES.get(provider);
    if (alias) {
      pushUniqueDocLink(links, { href: alias, label: provider });
      continue;
    }
    const relativePath = `docs/providers/${provider}.md`;
    if (fileExists(relativePath)) {
      pushUniqueDocLink(links, { href: `/providers/${provider}`, label: provider });
    }
  }

  for (const candidate of [manifest.id, dirName]) {
    if (typeof candidate !== "string") {
      continue;
    }
    if (fileExists(`docs/channels/${candidate}.md`)) {
      pushUniqueDocLink(links, { href: `/channels/${candidate}`, label: candidate });
    }
    if (fileExists(`docs/providers/${candidate}.md`)) {
      pushUniqueDocLink(links, { href: `/providers/${candidate}`, label: candidate });
    }
    if (fileExists(`docs/plugins/${candidate}.md`)) {
      pushUniqueDocLink(links, { href: `/plugins/${candidate}`, label: candidate });
    }
  }

  return links;
}

function resolveSurface(manifest) {
  const parts = [];
  if (Array.isArray(manifest.channels) && manifest.channels.length > 0) {
    parts.push(`channels: ${manifest.channels.join(", ")}`);
  }
  if (Array.isArray(manifest.providers) && manifest.providers.length > 0) {
    parts.push(`providers: ${manifest.providers.join(", ")}`);
  }
  const contracts = Object.keys(manifest.contracts ?? {}).toSorted((left, right) =>
    left.localeCompare(right),
  );
  if (contracts.length > 0) {
    parts.push(`contracts: ${contracts.join(", ")}`);
  }
  if (Array.isArray(manifest.skills) && manifest.skills.length > 0) {
    parts.push("skills");
  }
  if (parts.length === 0) {
    return "plugin";
  }
  return parts.join("; ");
}

function resolveInstall(packageJson, status) {
  if (status === "source") {
    return "source checkout only";
  }
  if (status === "core") {
    return "included in OpenClaw";
  }
  const install = packageJson.openclaw?.install;
  const release = packageJson.openclaw?.release;
  if (release?.publishToClawHub === true && release?.publishToNpm === true) {
    return install?.npmSpec ? `ClawHub + npm: \`${install.npmSpec}\`` : "ClawHub + npm";
  }
  if (release?.publishToClawHub === true) {
    return install?.npmSpec ? `ClawHub: \`${install.npmSpec}\`` : "ClawHub";
  }
  if (release?.publishToNpm === true || typeof install?.npmSpec === "string") {
    return `npm: \`${install.npmSpec}\``;
  }
  return "installable plugin";
}

function resolveStatus({ dirName, packageJson, excludedDirs }) {
  const release = packageJson.openclaw?.release;
  const hasInstallSpec = typeof packageJson.openclaw?.install?.npmSpec === "string";
  const excluded =
    excludedDirs.has(dirName) || packageJson.openclaw?.bundle?.includeInCore === false;
  if (!excluded) {
    return "core";
  }
  if (release?.publishToClawHub === true || release?.publishToNpm === true || hasInstallSpec) {
    return "external";
  }
  return "source";
}

function escapeCell(value) {
  return String(value).replaceAll("\n", " ").replaceAll("|", "\\|");
}

function renderTable(records) {
  const rows = [
    ["Plugin", "Package", "Surface", "Install"],
    ...records.map((record) => [
      record.docs.length > 0
        ? docLink({ href: record.docs[0].href, label: escapeCell(record.id) })
        : escapeCell(record.id),
      `\`${escapeCell(record.packageName)}\``,
      escapeCell(record.surface),
      escapeCell(record.install),
    ]),
  ];
  const widths = rows[0].map((_, index) => Math.max(...rows.map((row) => row[index].length), 3));
  const lines = [];
  lines.push(formatTableRow(rows[0], widths));
  lines.push(
    formatTableRow(
      widths.map((width) => "-".repeat(width)),
      widths,
    ),
  );
  for (const row of rows.slice(1)) {
    lines.push(formatTableRow(row, widths));
  }
  return lines.join("\n");
}

function formatTableRow(row, widths) {
  return `| ${row.map((cell, index) => cell.padEnd(widths[index])).join(" | ")} |`;
}

function collectPluginRecords() {
  const rootPackageJson = readJson("package.json");
  const excludedDirs = collectExcludedPackagedExtensionDirs(rootPackageJson);
  const records = [];

  for (const dirName of fs
    .readdirSync(EXTENSIONS_DIR)
    .toSorted((left, right) => left.localeCompare(right))) {
    const packagePath = path.join(EXTENSIONS_DIR, dirName, "package.json");
    const manifestPath = path.join(EXTENSIONS_DIR, dirName, "openclaw.plugin.json");
    if (!fs.existsSync(packagePath) || !fs.existsSync(manifestPath)) {
      continue;
    }
    const packageJson = JSON.parse(fs.readFileSync(packagePath, "utf8"));
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    const id = typeof manifest.id === "string" && manifest.id ? manifest.id : dirName;
    const status = resolveStatus({ dirName, packageJson, excludedDirs });
    records.push({
      docs: resolveDocs({ dirName, manifest, packageJson }),
      id,
      install: resolveInstall(packageJson, status),
      packageName: packageJson.name ?? "-",
      status,
      surface: resolveSurface(manifest),
    });
  }

  return records.toSorted((left, right) => left.id.localeCompare(right.id));
}

function renderDocument() {
  const records = collectPluginRecords();
  const groups = {
    core: records.filter((record) => record.status === "core"),
    external: records.filter((record) => record.status === "external"),
    source: records.filter((record) => record.status === "source"),
  };

  return `---
summary: "Generated inventory of OpenClaw plugins shipped in core, published externally, or kept source-only"
read_when:
  - You are deciding whether a plugin ships in the core npm package or installs separately
  - You are updating bundled plugin package metadata or release automation
  - You need the canonical internal vs external plugin list
title: "Plugin inventory"
---

# Plugin inventory

This page is generated from \`extensions/*/package.json\`, \`openclaw.plugin.json\`,
and the root npm package \`files\` exclusions. Regenerate it with:

\`\`\`bash
pnpm plugins:inventory:gen
\`\`\`

## Definitions

- **Core npm package:** built into the \`openclaw\` npm package and available without a separate plugin install.
- **Official external package:** OpenClaw-maintained plugin omitted from the core npm package and installed through ClawHub and/or npm.
- **Source checkout only:** repo-local plugin omitted from published npm artifacts and not advertised as an installable package.

Source checkouts are different from npm installs: after \`pnpm install\`, bundled
plugins load from \`extensions/<id>\` so local edits and package-local workspace
dependencies are available.

## Core npm package

${renderTable(groups.core)}

## Official external packages

${renderTable(groups.external)}

## Source checkout only

${renderTable(groups.source)}
`;
}

function main(argv = process.argv.slice(2)) {
  const write = argv.includes("--write");
  const check = argv.includes("--check");
  if (write === check) {
    console.error("usage: node scripts/generate-plugin-inventory-doc.mjs --write|--check");
    process.exit(2);
  }

  const next = renderDocument();
  const docPath = path.join(ROOT, DOC_PATH);
  if (write) {
    fs.writeFileSync(docPath, next, "utf8");
    return;
  }

  const current = fs.existsSync(docPath) ? fs.readFileSync(docPath, "utf8") : "";
  if (current !== next) {
    console.error(`${DOC_PATH} is stale. Run \`pnpm plugins:inventory:gen\`.`);
    process.exit(1);
  }
}

main();
