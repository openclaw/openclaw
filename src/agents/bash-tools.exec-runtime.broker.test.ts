import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { createScheduledGatewayRunner } from "../gateway/scheduled-run-gateway-context.js";
import { runWithSpawnBroker } from "../process/spawn-broker/context.js";
import { createSpawnBrokerHost } from "../process/spawn-broker/host.js";
import { supportsSpawnBrokerCommandTransport } from "../process/spawn-broker/pipe.js";
import { getProcessSupervisor } from "../process/supervisor/index.js";
import { runInDetachedAsyncContext } from "../shared/detached-async-context.js";
import { resetProcessRegistryForTests } from "./bash-process-registry.test-support.js";
import { runExecFixture } from "./bash-tools.exec-fixture.test-support.js";
import type { runExecProcess } from "./bash-tools.exec-runtime.js";

vi.mock("node:child_process", async () => {
  const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  const { mockNodeBuiltinModule } = await import("openclaw/plugin-sdk/test-node-mocks");
  const tracked = { ...actual };
  vi.spyOn(tracked, "spawn");
  return mockNodeBuiltinModule(() => Promise.resolve(actual), { spawn: tracked.spawn });
});

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
let home: string;

beforeEach(() => {
  home = tempDirs.make("openclaw-exec-broker-");
  vi.stubEnv("HOME", home);
  vi.stubEnv("SHELL", "/bin/bash");
  vi.stubEnv("OPENCLAW_STATE_DIR", path.join(home, "state"));
});

function exec(command: string, options: Partial<Parameters<typeof runExecProcess>[0]> = {}) {
  return runExecFixture({
    command,
    workdir: home,
    env: { HOME: home, PATH: "/usr/bin:/bin" },
    timeoutSec: 10,
    ...options,
  });
}
async function startBroker(resources: AsyncDisposableStack) {
  const broker = createSpawnBrokerHost();
  resources.defer(() => broker.close());
  await broker.ready();
  vi.mocked(spawn).mockClear();
  return broker;
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  resetProcessRegistryForTests();
});

describe.skipIf(!supportsSpawnBrokerCommandTransport())("exec tool broker transport", () => {
  it("keeps detached scheduled exec on its Gateway broker", async () => {
    await using resources = new AsyncDisposableStack();
    vi.stubEnv("OPENCLAW_SERVICE_MARKER", "");
    const broker = await startBroker(resources);
    const brokerSpawn = vi.spyOn(broker, "spawn");
    let run: Awaited<ReturnType<typeof runExecProcess>> | undefined;
    resources.defer(async () => {
      run?.kill();
      await run?.promise;
    });
    const runScheduled = runWithSpawnBroker(broker, () => createScheduledGatewayRunner());
    const outcome = await runInDetachedAsyncContext(() =>
      runScheduled(async () => {
        const command = "printf scheduled-exec-ok";
        run = await exec(command, { execCommand: command });
        return await run.promise;
      }),
    );
    expect(outcome).toMatchObject({
      status: "completed",
      exitCode: 0,
      aggregated: "scheduled-exec-ok",
    });
    // Linux memory protection places a native process owner between the broker and shell.
    expect(brokerSpawn).toHaveReturnedTimes(1);
    const child = brokerSpawn.mock.results[0]!.value;
    expect(child.pid).toBeGreaterThan(0);
    await child.waitForClose();
    expect(child.exitCode).toBe(0);
    expect(spawn).not.toHaveBeenCalled();
  });

  it("captures and validates shell startup state without forking the Gateway", async () => {
    await using resources = new AsyncDisposableStack();
    vi.stubEnv("OPENCLAW_EXEC_SHELL_SNAPSHOT", "1");
    await fs.writeFile(
      path.join(home, ".bashrc"),
      'printf "%s" "$PPID" > "$HOME/capture-parent"\noc_broker_fn() { printf snapshot-ok; }\n',
    );
    const broker = await startBroker(resources);
    const brokerSpawn = vi.spyOn(broker, "spawn");
    const scopeKey = `exec-broker:${home}`;
    resources.defer(
      getProcessSupervisor().acquireScopeCleanup(scopeKey, {
        processTree: "owned-only",
      }),
    );
    const outcome = await runWithSpawnBroker(broker, async () => {
      const run = await exec('oc_broker_fn; printf ":%s:%s" "$PWD" "$OPENCLAW_SHELL"', {
        env: { HOME: home, PATH: process.env.PATH ?? "/usr/bin:/bin" },
        scopeKey,
      });
      return await run.promise;
    });
    expect(outcome).toMatchObject({
      status: "completed",
      exitCode: 0,
      aggregated: `snapshot-ok:${home}:exec`,
    });
    expect(Number(await fs.readFile(path.join(home, "capture-parent"), "utf8"))).toBe(broker.pid);
    // Capture and validation both precede the supervised command's relay.
    expect(brokerSpawn.mock.calls.filter(([command]) => command === "/bin/bash")).toHaveLength(2);
    expect(spawn).not.toHaveBeenCalled();
  });
});
