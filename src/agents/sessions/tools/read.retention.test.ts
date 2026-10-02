import { fileURLToPath } from "node:url";
import { beforeAll, expect, it } from "vitest";
import { runNodeScript } from "../../../../test/helpers/run-node-script.js";
import {
  resolveRuntimeWorkerArgv,
  resolveRuntimeWorkerUrl,
} from "../../../infra/runtime-worker-url.js";
import { resolveTestNodeExecPath } from "../../../test-utils/node-process.js";
import { agentProcessTestEntrypoints } from "../../process-runtime.test-support.js";

type Observation = {
  mode: string;
  resultCount: number;
  heapUsedIncrease: number;
  externalIncrease: number;
};

let observations: Observation[] = [];

beforeAll(async () => {
  const result = await runNodeScript(
    [
      "--expose-gc",
      ...resolveRuntimeWorkerArgv(
        resolveRuntimeWorkerUrl(agentProcessTestEntrypoints.readRetention),
        resolveTestNodeExecPath(),
      ),
      "all",
    ],
    { ...process.env, NODE_OPTIONS: "", TSX_DISABLE_CACHE: "1" },
    60_000,
    {
      cwd: fileURLToPath(new URL("../../../../", import.meta.url)),
      maxBuffer: 64 * 1024,
      requireProcessTreeExit: process.platform !== "win32",
    },
  );
  expect(result.error, result.stderr).toBeUndefined();
  expect(result.status, result.stderr).toBe(0);
  observations = JSON.parse(result.stdout) as Observation[];
}, 70_000);

it.for(["line", "range", "cursor", "eof"])(
  "owns both output channels for a partial-file %s page",
  { timeout: 30_000 },
  async (mode) => {
    const observed = observations.find((entry) => entry.mode === mode);
    expect(observed).toBeDefined();
    if (!observed) {
      return;
    }
    expect(observed.resultCount).toBe(8);
    // Small retained pages must not retain eight multi-megabyte decoded sources.
    expect(observed.heapUsedIncrease).toBeLessThan(1024 * 1024);
    expect(observed.externalIncrease).toBeLessThan(1024 * 1024);
  },
);
