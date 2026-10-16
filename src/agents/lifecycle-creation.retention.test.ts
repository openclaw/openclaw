import { afterEach, expect, it } from "vitest";
import { createFixtureLifetime } from "../../test/helpers/fixture-lifetime.js";
import { runNodeScript } from "../../test/helpers/run-node-script.js";
import { resolveRuntimeWorkerUrl } from "../infra/runtime-worker-url.js";
import { agentProcessTestEntrypoints } from "./process-runtime.test-support.js";

const fixture = createFixtureLifetime();
afterEach(() => fixture.cleanup());

it("collects completed callers while the LLM host and a local provider remain live", async ({
  signal,
}) => {
  const root = fixture.createTempDir("openclaw-lifecycle-retention-");
  const result = await fixture.track(
    runNodeScript(
      (workerArgv) => [
        "--expose-gc",
        ...workerArgv(
          resolveRuntimeWorkerUrl(agentProcessTestEntrypoints.lifecycleCreationRetention),
        ),
        root,
      ],
      { ...process.env, HOME: root, OPENCLAW_STATE_DIR: root, NODE_OPTIONS: "" },
      undefined,
      { signal, requireProcessTreeExit: process.platform !== "win32", maxBuffer: 64 * 1024 },
    ),
  );
  expect(result.error, result.stderr).toBeUndefined();
  expect(result.status, result.stderr).toBe(0);
  expect(result.stdout).toContain('"collected":6,"reused":true');
});
