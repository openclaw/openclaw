#!/usr/bin/env bun
/**
 * Expand the 4 core agents from leadership personas.
 *
 * Generates unified AGENT.md files for Operator1, Neo, Morpheus, Trinity
 * using the expansion engine + leadership persona templates.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { loadPersonaBySlug, expandPersona } from "../src/agents/persona-expansion.js";

const AGENTS_DIR = join(import.meta.dirname, "..", "agents");
const PERSONAS_DIR = join(AGENTS_DIR, "personas");

const CORE_AGENTS = [
  { agentId: "operator1", agentName: "Operator1", persona: "coo" },
  { agentId: "neo", agentName: "Neo", persona: "cto" },
  { agentId: "morpheus", agentName: "Morpheus", persona: "cmo" },
  { agentId: "trinity", agentName: "Trinity", persona: "cfo" },
] as const;

async function main() {
  for (const agent of CORE_AGENTS) {
    console.log(`Expanding ${agent.agentName} from ${agent.persona} persona...`);

    const persona = await loadPersonaBySlug(PERSONAS_DIR, agent.persona);
    if ("error" in persona) {
      console.error(`  ERROR: ${persona.error}`);
      process.exit(1);
    }

    const result = await expandPersona(persona, {
      agentName: agent.agentName,
      agentId: agent.agentId,
    });
    if ("error" in result) {
      console.error(`  ERROR: ${result.error}`);
      process.exit(1);
    }

    // Write unified AGENT.md
    const agentDir = join(AGENTS_DIR, agent.agentId);
    await mkdir(agentDir, { recursive: true });
    await writeFile(join(agentDir, "AGENT.md"), result.agentMd, "utf-8");
    console.log(`  ✓ agents/${agent.agentId}/AGENT.md`);

    // Write workspace files (for reference — actual deployment uses the workspace dir)
    for (const file of result.workspaceFiles) {
      console.log(`  ✓ ${file.name} (${file.content.length} chars)`);
    }
  }

  console.log("\nDone. 4 core agents expanded.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
