import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { configureFsSafeNative } from "@openclaw/fs-safe/config";
import { closeSkillsWatchers, prepareSandboxFsContext } from "../skills/runtime/refresh.js";
import { createAgentToolsSandboxContext } from "./test-helpers/agent-tools-sandbox-context.js";

assert.ok(process.versions.bun, "native canonicalization must execute in Bun");
const home = await fs.realpath(process.argv[2]!);
const physical = path.join(home, "physical");
const alias = path.join(home, "workspace");
await fs.mkdir(physical);
await fs.symlink(physical, alias, "dir");
const sandbox = createAgentToolsSandboxContext({ workspaceDir: alias });
try {
  for (const mode of ["off", "require", "off"] as const) {
    configureFsSafeNative({ mode });
    const pending = prepareSandboxFsContext(sandbox);
    configureFsSafeNative({ mode: "off" });
    const prepared = await pending;
    // Existing ancestor resolution preserves lexical spelling if required native
    // canonicalization is unavailable; off uses Bun's ordinary realpath fallback.
    assert.equal(
      prepared.mounts.find((mount) => mount.source === "workspace")?.canonicalHostRoot,
      mode === "require" ? alias : physical,
      `native policy ${mode}`,
    );
  }
} finally {
  await closeSkillsWatchers(true);
}
