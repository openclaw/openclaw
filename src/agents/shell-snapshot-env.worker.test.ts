import { spawnSync } from "node:child_process";
import { expect, it } from "vitest";
import { resolveRuntimeProcessEntrypointUrl } from "../infra/runtime-process-url.js";
import { resolveRuntimeWorkerArgv } from "../infra/runtime-worker-url.js";

it("captures only replayable shell environment through the declared entry", () => {
  const result = spawnSync(
    process.execPath,
    resolveRuntimeWorkerArgv(resolveRuntimeProcessEntrypointUrl("shellSnapshotEnvironment")),
    {
      env: {
        PATH: "/synthetic/path with spaces",
        PNPM_HOME: "/synthetic/pnpm's home",
        HOME: "/synthetic/private-home",
        SHELL: "/bin/bash",
        OPENAI_API_KEY: "synthetic-secret",
        VIRTUAL_ENV: "/synthetic/virtual",
      },
      encoding: "utf8",
      timeout: 5_000,
    },
  );
  expect(result.error).toBeUndefined();
  expect(result.status, result.stderr).toBe(0);
  expect(result.stdout).toBe(
    JSON.stringify({ PATH: "/synthetic/path with spaces", PNPM_HOME: "/synthetic/pnpm's home" }),
  );
});
