import { execFileSync } from "node:child_process";
import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const RELEASE_CANDIDATE_SHA = "f773aa06a1a93b36b050f1a3f4b57d3d91311541";
const TEST_PATH = "src/sessions/session-state-events.test.ts";

function readArgument(name) {
  const index = process.argv.indexOf(name);
  if (index === -1 || !process.argv[index + 1]) {
    throw new Error(`missing ${name}`);
  }
  return process.argv[index + 1];
}

function applyFrozenNodeTestCompatibility({ root, targetSha }) {
  if (targetSha !== RELEASE_CANDIDATE_SHA) {
    return false;
  }

  const testFile = resolve(root, TEST_PATH);
  const source = readFileSync(testFile, "utf8");
  const staleImport = `import { setHeartbeatWakeHandler } from "../infra/heartbeat-wake.js";`;
  const repairedImport = `import { requestHeartbeat, setHeartbeatWakeHandler } from "../infra/heartbeat-wake.js";`;
  const staleRoutingTest = `  it("wakes main watchers but only queues notices for nested watchers", async () => {
    vi.useFakeTimers();
    const wakes = vi.fn(async () => ({ status: "ran" as const, durationMs: 1 }));
    disposeHeartbeatWakeHandler = setHeartbeatWakeHandler(wakes);
    // Drain notices queued by earlier tests before checking this watcher's routing.
    await vi.advanceTimersByTimeAsync(21_000);
    wakes.mockClear();
    const database = createDatabaseOptions();
    seedChild(database, nestedWatcher);

    recordSessionStateEvent(eventInput({ watcherSessionKeys: [nestedWatcher] }), database);
    await vi.advanceTimersByTimeAsync(21_000);
    expect(peekSystemEventEntries(nestedWatcher)).toHaveLength(1);
    expect(wakes).not.toHaveBeenCalled();

    seedChild(database, watcher);
    recordSessionStateEvent(eventInput(), database);
    await vi.advanceTimersByTimeAsync(21_000);
    expect(wakes).toHaveBeenCalledWith(
      // intent "immediate" is load-bearing: event-intent wakes defer on heartbeat
      // dueness and would sit on the notice until the next scheduled tick. The
      // wake itself coalesces for SESSION_STATE_WAKE_COALESCE_MS (20s), hence
      // the 21s timer advances in these tests.
      expect.objectContaining({
        source: "session-state",
        sessionKey: watcher,
        intent: "immediate",
      }),
    );
  });`;
  const repairedRoutingTest = `  it.each([false, true])(
    "wakes main watchers but only queues notices for nested watchers (prior clock=%s)",
    async (priorClock) => {
      if (priorClock) {
        vi.useFakeTimers();
        vi.advanceTimersByTime(30_000);
        requestHeartbeat({
          source: "exec-event",
          intent: "event",
          reason: "exec-event",
          coalesceMs: 0,
        });
        vi.useRealTimers();
      }
      vi.useFakeTimers();
      const wakes = vi.fn(async () => ({ status: "ran" as const, durationMs: 1 }));
      disposeHeartbeatWakeHandler = setHeartbeatWakeHandler(wakes);
      // Pending deadlines may belong to a previous fake-clock origin.
      await vi.runAllTimersAsync();
      wakes.mockClear();
      const database = createDatabaseOptions();
      seedChild(database, nestedWatcher);

      recordSessionStateEvent(eventInput({ watcherSessionKeys: [nestedWatcher] }), database);
      await vi.advanceTimersByTimeAsync(21_000);
      expect(peekSystemEventEntries(nestedWatcher)).toHaveLength(1);
      expect(wakes).not.toHaveBeenCalled();

      seedChild(database, watcher);
      recordSessionStateEvent(eventInput(), database);
      await vi.advanceTimersByTimeAsync(21_000);
      expect(wakes).toHaveBeenCalledWith(
        // intent "immediate" is load-bearing: event-intent wakes defer on heartbeat
        // dueness and would sit on the notice until the next scheduled tick. The
        // wake itself coalesces for SESSION_STATE_WAKE_COALESCE_MS (20s), hence
        // the 21s timer advances in these tests.
        expect.objectContaining({
          source: "session-state",
          sessionKey: watcher,
          intent: "immediate",
        }),
      );
    },
  );`;
  const repeatedStaleDrain = `    disposeHeartbeatWakeHandler = setHeartbeatWakeHandler(wakes);\n    await vi.advanceTimersByTimeAsync(21_000);`;
  const repeatedRepairedDrain = `    disposeHeartbeatWakeHandler = setHeartbeatWakeHandler(wakes);\n    await vi.runAllTimersAsync();`;

  const importCount = source.split(staleImport).length - 1;
  const routingTestCount = source.split(staleRoutingTest).length - 1;
  const repeatedCount = source.split(repeatedStaleDrain).length - 1;
  if (importCount !== 1 || routingTestCount !== 1 || repeatedCount !== 3) {
    throw new Error(
      `refusing drifted ${TEST_PATH}: expected one import, one routing test, and three repeated stale drains; found ${importCount}, ${routingTestCount}, and ${repeatedCount}`,
    );
  }

  const repaired = source
    .replace(staleImport, repairedImport)
    .replace(staleRoutingTest, repairedRoutingTest)
    .replaceAll(repeatedStaleDrain, repeatedRepairedDrain);
  writeFileSync(testFile, repaired);
  return true;
}

function main() {
  const root = resolve(readArgument("--root"));
  const targetSha = readArgument("--target-sha");
  const checkoutSha = execFileSync("git", ["-C", root, "rev-parse", "HEAD"], {
    encoding: "utf8",
  }).trim();

  if (checkoutSha !== targetSha) {
    throw new Error(
      `frozen compatibility target ${targetSha} does not match checkout ${checkoutSha}`,
    );
  }
  if (applyFrozenNodeTestCompatibility({ root, targetSha })) {
    console.log(`Applied frozen Node test compatibility for ${targetSha} to ${TEST_PATH}.`);
  } else {
    console.log(`No frozen Node test compatibility required for ${targetSha}.`);
  }
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
