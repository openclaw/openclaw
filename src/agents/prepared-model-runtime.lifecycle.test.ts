import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { runRetentionNodeScript } from "../../test/helpers/run-node-script.js";
import { agentProcessTestEntrypoints } from "./process-runtime.test-support.js";

it("releases completed run history while retired generation signals remain reachable", async ({
  signal,
}) => {
  const result = await runRetentionNodeScript(
    agentProcessTestEntrypoints.modelGenerationRetention,
    {
      cwd: fileURLToPath(new URL("../../", import.meta.url)),
      signal,
    },
  );
  expect(result.error, result.stderr).toBeUndefined();
  expect(result.status, result.stderr).toBe(0);
  expect(JSON.parse(result.stdout)).toEqual({ generations: 128, retainedBytes: 0 });
});
