import { expect, it } from "vitest";
import { runNodeScript } from "../../test/helpers/run-node-script.js";
import { resolveRuntimeWorkerUrl } from "../infra/runtime-worker-url.js";
import { agentProcessTestEntrypoints } from "./process-runtime.test-support.js";

it.skipIf(process.platform === "win32")(
  "launches and adopts durable session processes through the host writer broker",
  async () => {
    const result = await runNodeScript(
      (workerArgv) =>
        workerArgv(resolveRuntimeWorkerUrl(agentProcessTestEntrypoints.durableProcesses)),
      { ...process.env, NODE_ENV: "test" },
      undefined,
    );
    expect(result.error, result.stderr).toBeUndefined();
    expect(result.status, [result.stdout, result.stderr].join("\n")).toBe(0);
  },
);
