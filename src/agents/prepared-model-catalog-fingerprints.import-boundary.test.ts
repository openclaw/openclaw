import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { runNodeScript } from "../../test/helpers/run-node-script.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";

it("fingerprints catalog requests without importing runtime preparation", async () => {
  await withOpenClawTestState(
    { label: "catalog-fingerprint-import", applyEnv: false },
    async (state) => {
      const entry = new URL("./prepared-model-catalog-fingerprints.ts", import.meta.url).href;
      const loader = fileURLToPath(new URL("../../scripts/tsx.mjs", import.meta.url));
      const result = await runNodeScript(
        [
          "--import",
          loader,
          "--input-type=module",
          "--eval",
          `import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { registerHooks } from "node:module";
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.includes("prepared-model-runtime.facts.") || specifier.includes("prepared-model-runtime.inbound-registry.")) {
      throw new Error("Catalog fingerprint imported runtime preparation: " + specifier);
    }
    return nextResolve(specifier, context);
  },
});
const { fingerprintPreparedModelWorkerRequest } = await import(${JSON.stringify(entry)});
assert.equal(
  fingerprintPreparedModelWorkerRequest({ generationFingerprint: "fixture" }, { kind: "auth-refresh" }),
  createHash("sha256").update('["fixture",{"kind":"auth-refresh"}]').digest("base64url"),
);
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
