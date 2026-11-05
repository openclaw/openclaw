import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { runNodeScript } from "../../test/helpers/run-node-script.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";

it("loads the catalog worker without session-event execution", async () => {
  await withOpenClawTestState(
    { label: "catalog-worker-import", applyEnv: false },
    async (state) => {
      const entry = new URL("./prepared-model-catalog.worker.ts", import.meta.url).href;
      const loader = fileURLToPath(new URL("../../scripts/tsx.mjs", import.meta.url));
      const result = await runNodeScript(
        [
          "--import",
          loader,
          "--input-type=module",
          "--eval",
          `import { registerHooks } from "node:module";
registerHooks({
  resolve(specifier, context, nextResolve) {
    const resolved = nextResolve(specifier, context);
    if ([".ts", ".js"].some((extension) => resolved.url.endsWith("/session-event-handoff" + extension))) {
      throw new Error("Catalog imported session-event execution from " + context.parentURL);
    }
    return resolved;
  },
});
await import(${JSON.stringify(entry)});
console.log("catalog-worker-import-ok");`,
        ],
        { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, ...state.envVars },
        30_000,
      );
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain("catalog-worker-import-ok");
    },
  );
});
