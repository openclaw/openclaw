/**
 * Side-effect module: points a proof harness at a throwaway state directory
 * before anything resolves `STATE_DIR`.
 *
 * `src/config/paths.ts` resolves the state directory at module evaluation, so
 * this has to be the FIRST import of any harness that reaches code touching the
 * OpenClaw state database — channel-plugin resolution does, through the plugin
 * metadata snapshot. Without it a proof reads (and is refused by) the operator's
 * live `~/.openclaw/state/openclaw.sqlite`, which makes the harness depend on
 * the host's installed schema version rather than on the code under proof.
 *
 * An explicit `OPENCLAW_STATE_DIR` in the environment is honored, so a caller
 * that already isolated the process keeps its own directory.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

if (!process.env.OPENCLAW_STATE_DIR?.trim()) {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-proof-state-"));
  process.env.OPENCLAW_STATE_DIR = stateDir;
  process.env.OPENCLAW_CONFIG_PATH = path.join(stateDir, "openclaw.json");
}
