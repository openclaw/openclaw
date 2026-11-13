import "../../../test-utils/prepare-compiled-subprocesses.js";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expectDefined } from "@openclaw/normalization-core/expect";
import { afterEach, expect, test, vi } from "vitest";
import { withinTest } from "../../../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../../../test/helpers/temp-dir.js";
import { isProcessAlive } from "../../../../test/scripts/live-process-fixture.test-support.js";
import { hasCommandProcessCleanupError } from "../../../process/exec-result.js";
import * as adapters from "../../../process/supervisor/adapters/child.js";
import { createDeferredCore } from "../../../shared/deferred.js";
import { createEventBus } from "../event-bus.js";
import type { ExecResult } from "../exec.js";
import { createExtensionRuntime, loadExtensionFromFactory } from "./loader.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

test.skipIf(process.platform === "win32").for(["normal", "uncertain", "rejected"] as const)(
  "propagates owned-adapter cleanup classification after real cancellation (%s)",
  async (cleanupReport, { signal }) => {
    const launched = createDeferredCore<Awaited<ReturnType<typeof adapters.createChildAdapter>>>();
    const createNativeAdapter = adapters.createChildAdapter;
    const failure = new Error("synthetic native extinction failure");
    let finishNativeCleanup: (() => Promise<unknown>) | undefined;
    vi.spyOn(adapters, "createChildAdapter").mockImplementation(async (params) => {
      const startup = await createNativeAdapter(params);
      const nativeCleanup = expectDefined(
        startup.adapter.waitForExtinction,
        "native extinction",
      ).bind(startup.adapter);
      finishNativeCleanup = nativeCleanup;
      // Real cancellation and extinction still run. Only the adapter's report is
      // injected; native denied-signal behavior belongs to the subreaper tests.
      vi.spyOn(startup.adapter, "waitForExtinction").mockImplementation(async () => {
        const result = await nativeCleanup();
        if (cleanupReport === "rejected") {
          throw failure;
        }
        return cleanupReport === "uncertain"
          ? { status: "uncertain", reason: "job-unavailable" }
          : result;
      });
      launched.resolve(startup);
      return startup;
    });
    const readyPath = join(tempDirs.make("extension-exec-cleanup-"), "ready.json");
    const source = `const { spawn } = require("node:child_process");
const child = spawn(process.execPath, ["-e", 'process.on("SIGTERM", () => {}); process.stdout.write("ready"); setInterval(() => {}, 1000);'], { stdio: ["ignore", "pipe", "ignore"] });
child.stdout.once("data", () => {
  process.stdout.write(child.pid + "\\n");
  require("node:fs").writeFileSync(${JSON.stringify(readyPath)}, JSON.stringify([process.pid, child.pid]));
});
process.on("SIGTERM", () => process.exit(0));`;
    const controller = new AbortController();
    let apiResult: ExecResult | undefined;
    const outcome = loadExtensionFromFactory(
      async (api) => {
        apiResult = await api.exec(process.execPath, ["-e", source], { signal: controller.signal });
      },
      process.cwd(),
      createEventBus(),
      createExtensionRuntime(),
    )
      .then(() => apiResult)
      .catch((error: unknown) => error);
    let startup: Awaited<typeof launched.promise> | undefined;
    try {
      startup = await withinTest(launched.promise, signal);
      await withinTest(startup.ready, signal);
      const [rootPid, childPid]: [number, number] = await vi.waitFor(
        () => JSON.parse(readFileSync(readyPath, "utf8")),
        { timeout: 3_000, interval: 25 },
      );
      expect(isProcessAlive(rootPid)).toBe(true);
      expect(isProcessAlive(childPid)).toBe(true);
      controller.abort();
      const observed = await withinTest(outcome, signal);
      const result = { stdout: `${childPid}\n`, stderr: "", code: 0, killed: true };
      expect(observed).toMatchObject(
        cleanupReport === "normal"
          ? result
          : { code: "ERR_COMMAND_PROCESS_CLEANUP_UNCERTAIN", cause: result },
      );
      expect(hasCommandProcessCleanupError(observed)).toBe(cleanupReport !== "normal");
      expect(isProcessAlive(rootPid)).toBe(false);
      expect(isProcessAlive(childPid)).toBe(false);
    } finally {
      vi.restoreAllMocks();
      controller.abort();
      startup?.adapter.kill("SIGKILL");
      await finishNativeCleanup?.();
      await withinTest(outcome, signal);
    }
  },
);
