import { expect, it } from "vitest";
import { runNodeScript } from "../../test/helpers/run-node-script.js";
import { resolveRuntimeWorkerUrl } from "../infra/runtime-worker-url.js";
import { agentProcessTestEntrypoints } from "./process-runtime.test-support.js";

it("persists and upgrades durable process records through the native host writer broker", async () => {
  const result = await runNodeScript(
    (workerArgv) => [
      ...workerArgv(resolveRuntimeWorkerUrl(agentProcessTestEntrypoints.durableProcessStore)),
      ...(process.env.OPENCLAW_TEST_DURABLE_UPGRADE_DATABASE
        ? [process.env.OPENCLAW_TEST_DURABLE_UPGRADE_DATABASE]
        : []),
    ],
    process.env,
    undefined,
  );
  expect(result.error, result.stderr).toBeUndefined();
  expect(result.status, [result.stdout, result.stderr].join("\n")).toBe(0);
});
