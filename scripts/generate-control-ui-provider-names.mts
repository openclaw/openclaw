#!/usr/bin/env node
// Projects each bundled plugin manifest's `providerNames` into the table the Control UI
// reads before a Gateway catalog has loaded. The manifests own the names.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { writeGeneratedOutput } from "./lib/generated-output-utils.mts";

const outputPath = "ui/src/components/provider-names.generated.json";

try {
  const args = process.argv.slice(2);
  if (args.some((arg) => arg !== "--check")) {
    throw new Error("Usage: node scripts/generate-control-ui-provider-names.mts [--check]");
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
  const check = args.includes("--check");
  const result = writeGeneratedOutput({
    check,
    next: `${JSON.stringify(sorted, null, 2)}\n`,
    outputPath,
    repoRoot,
  });
  if (check && result.changed) {
    throw new Error("Stale Control UI provider names; run pnpm ui:provider-names:gen");
  }
  console.log(`[ui-provider-names] ${check ? "checked" : "generated"} ${outputPath}`);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  console.error("[ui-provider-names] FAILED (exit 1)");
  process.exitCode = 1;
}
