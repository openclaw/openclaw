// Synthetic Gateway entry for comparing frozen cron delivery owners in one source installation.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeSync } from "node:fs";
import { registerHooks } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { transformSync } from "esbuild";

const stateDir = process.env.OPENCLAW_STATE_DIR;
assert(stateDir, "An isolated team-shape fixture is required");
assert(
  existsSync(path.join(stateDir, "team-shape-summary.json")),
  "Run only against generated team-shape fixtures",
);
const ownerPath = path.join(stateDir, "cron-delivery-owner.ts");
assert(existsSync(ownerPath), "The fixture must contain a frozen cron-delivery-owner.ts");
const ownerUrl = new URL(
  "../../src/cron/isolated-agent/delivery-target-context.ts",
  import.meta.url,
).href;
let ownerLoaded = false;
registerHooks({
  load(url, context, nextLoad) {
    if (url !== ownerUrl) {
      return nextLoad(url, context);
    }
    const source = readFileSync(ownerPath, "utf8");
    const compiled = transformSync(source, { loader: "ts", format: "esm", target: "esnext" }).code;
    ownerLoaded = true;
    writeSync(
      2,
      `CRON_OWNER_SOURCE ${JSON.stringify({ pid: process.pid, sha256: createHash("sha256").update(source).digest("hex") })}\n`,
    );
    // Preserve the canonical URL so every relative dependency comes from the shared installation.
    return { format: "module", source: compiled, shortCircuit: true };
  },
});
process.once("exit", () => {
  if (!ownerLoaded) {
    writeSync(2, "Frozen cron delivery owner was never loaded\n");
    process.exitCode = 1;
  }
});
process.argv[1] = fileURLToPath(new URL("../../src/entry.ts", import.meta.url));
await import("../../src/entry.ts");
