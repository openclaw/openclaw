/**
 * Validates all agent manifests in the agents/ directory.
 * Usage: bun scripts/validate-agents.ts
 */
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import {
  loadAgentFromDir,
  validateTierDependencies,
} from "../src/config/agent-manifest-validation.js";
import type { AgentManifest } from "../src/config/zod-schema.agent-manifest.js";

const AGENTS_DIR = join(import.meta.dirname, "..", "agents");

async function main() {
  const dirs = await readdir(AGENTS_DIR, { withFileTypes: true });
  const agentDirs = dirs.filter((d) => d.isDirectory()).map((d) => d.name);

  console.log(`Found ${agentDirs.length} agent directories\n`);

  const manifests: AgentManifest[] = [];
  let hasErrors = false;

  for (const dir of agentDirs.toSorted()) {
    const result = await loadAgentFromDir(join(AGENTS_DIR, dir));
    if (result.errors.length > 0) {
      console.log(`  ✗ ${dir}`);
      for (const err of result.errors) {
        console.log(`    ${err}`);
      }
      hasErrors = true;
    } else {
      const m = result.manifest!;
      console.log(`  ✓ ${dir} — ${m.name} (Tier ${m.tier}, ${m.role})`);
      manifests.push(m);
    }
  }

  console.log(`\nValidating tier dependencies...`);
  const tierResult = validateTierDependencies(manifests);
  if (tierResult.errors.length > 0) {
    for (const err of tierResult.errors) {
      console.log(`  ✗ ${err}`);
    }
    hasErrors = true;
  } else {
    console.log(`  ✓ All tier dependencies valid`);
  }
  for (const warn of tierResult.warnings) {
    console.log(`  ⚠ ${warn}`);
  }

  console.log(`\nSummary: ${manifests.length} agents validated`);
  console.log(`  Tier 1: ${manifests.filter((a) => a.tier === 1).length}`);
  console.log(`  Tier 2: ${manifests.filter((a) => a.tier === 2).length}`);
  console.log(`  Tier 3: ${manifests.filter((a) => a.tier === 3).length}`);

  if (hasErrors) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
