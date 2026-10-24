import { afterEach, expect, it } from "vitest";
import { createFixtureLifetime } from "../../../test/helpers/fixture-lifetime.js";
import { runNodeScript } from "../../../test/helpers/run-node-script.js";
import { resolveRuntimeWorkerUrl } from "../../infra/runtime-worker-url.js";
import { agentProcessTestEntrypoints } from "../process-runtime.test-support.js";

const fixture = createFixtureLifetime();
afterEach(() => fixture.cleanup());

it("continues document-heavy sessions after compaction without losing projected document input", async ({
  signal,
}) => {
  // Database admission belongs to the host main process, not a Vitest thread.
  // Keep the real ingestion/compaction/continuation composition in that process.
  const result = await fixture.track(
    runNodeScript(
      (workerArgv) =>
        workerArgv(resolveRuntimeWorkerUrl(agentProcessTestEntrypoints.documentCompaction)),
      process.env,
      undefined,
      {
        signal,
        executable: process.execPath,
        requireProcessTreeExit: process.platform !== "win32",
      },
    ),
  );
  expect(result.error, result.stderr).toBeUndefined();
  expect(result.status, result.stderr).toBe(0);
  expect(result.stdout).toContain("document compaction continuation ok");
});
