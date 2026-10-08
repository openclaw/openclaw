import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export function sourceCustodyStateEnvironment(accountHome) {
  const state = path.join(accountHome, ".openclaw");
  return {
    HOME: accountHome,
    OPENCLAW_STATE_DIR: state,
    OPENCLAW_CONFIG_PATH: path.join(state, "openclaw.json"),
  };
}

// Installer probes can create state even with --no-onboard. Observe and preserve
// it; each COW cell must inherit exactly this baseline before writing its fixture.
export function snapshotSourceCustodyState(root) {
  const entries = [];
  function visit(relative) {
    const file = path.join(root, relative);
    const stat = fs.lstatSync(file, { throwIfNoEntry: false });
    if (!stat) {
      return;
    }
    if (stat.isDirectory()) {
      entries.push({ path: relative, kind: "directory" });
      for (const name of fs.readdirSync(file).toSorted()) {
        visit(path.join(relative, name));
      }
    } else if (stat.isFile()) {
      entries.push({
        path: relative,
        kind: "file",
        sha256: createHash("sha256").update(fs.readFileSync(file)).digest("hex"),
      });
    } else {
      throw new Error("Unexpected installer state entry: " + file);
    }
  }
  visit("");
  return entries;
}
