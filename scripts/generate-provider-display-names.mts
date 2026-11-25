#!/usr/bin/env node
// Projects plugin-owned provider names for server and client readers before metadata loads.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { format } from "oxfmt";
import { writeGeneratedOutput } from "./lib/generated-output-utils.mts";

const outputPath = "src/shared/provider-names.generated.ts";

try {
  const args = process.argv.slice(2);
  if (args.some((arg) => arg !== "--check")) {
    throw new Error("Usage: node scripts/generate-provider-display-names.mts [--check]");
  }
  const repoRoot = fileURLToPath(new URL("../", import.meta.url));
  const names = new Map<string, string>();
  for (const dir of readdirSync(new URL("../extensions/", import.meta.url)).toSorted()) {
    const manifestUrl = new URL(`../extensions/${dir}/openclaw.plugin.json`, import.meta.url);
    if (!existsSync(manifestUrl)) {
      continue;
    }
    const manifest = JSON.parse(readFileSync(manifestUrl, "utf8"));
    // Same rule as the Gateway: a plugin names only the provider ids it declares.
    const declared = new Set(
      [
        ...(manifest.providers ?? []),
        ...(manifest.cliBackends ?? []),
        ...Object.keys(manifest.modelCatalog?.providers ?? {}),
        ...(manifest.contracts?.decisionProviders ?? []),
      ].map((id: string) => id.trim().toLowerCase()),
    );
    for (const [rawId, name] of Object.entries(manifest.providerNames ?? {})) {
      const id = rawId.trim().toLowerCase();
      if (declared.has(id) && typeof name === "string" && name.trim() && !names.has(id)) {
        names.set(id, name.trim());
      }
    }
  }
  const sorted = Object.fromEntries(
    [...names].toSorted(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0)),
  );
  // A default-only source module avoids Vite emitting a binding per JSON key.
  const source = `// Generated from plugin manifests by scripts/generate-provider-display-names.mts.\nexport default ${JSON.stringify(sorted, null, 2)};\n`;
  const formatted = await format(outputPath, source);
  if (formatted.errors.length > 0) {
    throw new Error(`Cannot format ${outputPath}: ${JSON.stringify(formatted.errors)}`);
  }
  const check = args.includes("--check");
  const result = writeGeneratedOutput({
    check,
    next: formatted.code,
    outputPath,
    repoRoot,
  });
  if (check && result.changed) {
    throw new Error("Stale bundled provider names; run pnpm providers:names:gen");
  }
  console.log(`[ui-provider-names] ${check ? "checked" : "generated"} ${outputPath}`);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  console.error("[ui-provider-names] FAILED (exit 1)");
  process.exitCode = 1;
}
