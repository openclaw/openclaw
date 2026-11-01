import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { runNodeScript } from "../../test/helpers/run-node-script.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";

it("loads catalog request boundaries without importing runtime preparation", async () => {
  await withOpenClawTestState(
    { label: "catalog-fingerprint-import", applyEnv: false },
    async (state) => {
      const entry = new URL("./prepared-model-catalog-fingerprints.ts", import.meta.url).href;
      const catalogEntry = new URL("./prepared-model-runtime.scoped-catalog.ts", import.meta.url)
        .href;
      const loader = fileURLToPath(new URL("../../scripts/tsx.mjs", import.meta.url));
      const result = await runNodeScript(
        [
          "--import",
          loader,
          "--input-type=module",
          "--eval",
          `import assert from "node:assert/strict";
import { registerHooks } from "node:module";
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.includes("prepared-model-runtime.facts.") || specifier.includes("prepared-model-runtime.inbound-registry.") || specifier.includes("/harness/model-catalog.")) {
      throw new Error("Catalog fingerprint imported runtime preparation: " + specifier);
    }
    const resolved = nextResolve(specifier, context);
    if (["/agents/workspace", "/agents/auth-profiles", "/agents/model-selection", "/gateway-protocol/src/index"].some(
      (name) => [".ts", ".js"].some((extension) => resolved.url.endsWith(name + extension)),
    )) {
      throw new Error("Catalog imported an unrelated runtime barrel: " + resolved.url + " from " + context.parentURL);
    }
    return resolved;
  },
});
const { fingerprintPreparedModelCatalogPluginContext } = await import(${JSON.stringify(entry)});
assert.equal(typeof fingerprintPreparedModelCatalogPluginContext, "function");
await import(${JSON.stringify(catalogEntry)});
console.log("catalog-fingerprint-cold-import-ok");`,
        ],
        { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, ...state.envVars },
        30_000,
      );
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain("catalog-fingerprint-cold-import-ok");
    },
  );
});
