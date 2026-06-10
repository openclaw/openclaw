import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "../..");

// Dynamic import of the production code to avoid static resolution issues
const { resolveAgentWorkspaceDir } = await import(
  path.join(repoRoot, "src/agents/agent-scope-config.ts")
);

async function main() {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-repro-91760-"));

  // Test 1: agents.defaults.workspace set, non-default agent should get hyphenated path
  const cfgWithDefaultWorkspace = {
    agents: {
      defaults: { workspace: path.join(tmpDir, "workspace") },
      list: [{ id: "main" }, { id: "chef", default: true }],
    },
  };

  const mainWorkspace = resolveAgentWorkspaceDir(cfgWithDefaultWorkspace, "main");
  const chefWorkspace = resolveAgentWorkspaceDir(cfgWithDefaultWorkspace, "chef");

  // Expected: main (non-default) gets workspace-main, chef (default) gets workspace directly
  const expectedMain = path.join(tmpDir, "workspace-main");
  const expectedChef = path.join(tmpDir, "workspace");

  console.log("=== Reproduction for issue #91760 ===");
  console.log(`tmpDir: ${tmpDir}`);
  console.log(`main workspace resolved: ${mainWorkspace}`);
  console.log(`chef workspace resolved: ${chefWorkspace}`);
  console.log(`expected main: ${expectedMain}`);
  console.log(`expected chef: ${expectedChef}`);

  let pass = true;

  if (mainWorkspace !== expectedMain) {
    console.error(`FAIL: main workspace mismatch. Got ${mainWorkspace}, expected ${expectedMain}`);
    pass = false;
  } else {
    console.log("PASS: main workspace uses hyphenated fallback");
  }

  if (chefWorkspace !== expectedChef) {
    console.error(`FAIL: chef workspace mismatch. Got ${chefWorkspace}, expected ${expectedChef}`);
    pass = false;
  } else {
    console.log("PASS: default agent uses fallback directly");
  }

  // Test 2: Without agents.defaults.workspace, fallback uses stateDir/workspace-<id>
  const cfgNoDefault = {
    agents: {
      list: [{ id: "main" }, { id: "chef", default: true }],
    },
  };

  const mainNoDefault = resolveAgentWorkspaceDir(cfgNoDefault, "main", {
    ...process.env,
    OPENCLAW_STATE_DIR: tmpDir,
  });
  const expectedNoDefault = path.join(tmpDir, "workspace-main");

  console.log(`main workspace (no default): ${mainNoDefault}`);
  console.log(`expected (no default): ${expectedNoDefault}`);

  if (mainNoDefault !== expectedNoDefault) {
    console.error(`FAIL: no-default workspace mismatch. Got ${mainNoDefault}, expected ${expectedNoDefault}`);
    pass = false;
  } else {
    console.log("PASS: no-default fallback still uses hyphenated stateDir path");
  }

  // Cleanup
  await fs.rm(tmpDir, { recursive: true, force: true });

  if (!pass) {
    console.error("\nOVERALL: FAIL");
    process.exitCode = 1;
  } else {
    console.log("\nOVERALL: PASS — resolveAgentWorkspaceDir correctly uses hyphenated fallback.");
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
