import { resolveRuntimeWorkerUrl } from "openclaw/plugin-sdk/process-runtime";
import { expect, it, onTestFinished, vi } from "vitest";
import { createQuickJsTestConfig, runQuickJsExecutor } from "./executor.test-support.js";
import { quickJsWorkerTestEntrypoint } from "./worker-entrypoint.test-support.js";

const fault = vi.hoisted(() => ({ enabled: false, wasmReads: 0 }));
// mock-isolation: Fail one engine asset read; retain actual files, compilation, and workers.
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    readFile: (...args: Parameters<typeof actual.readFile>) => {
      const file = args[0];
      const asset = typeof file === "string" ? file : file instanceof URL ? file.pathname : "";
      if (fault.enabled && asset.endsWith("quickjs.wasm") && ++fault.wasmReads === 1) {
        return Promise.reject(
          Object.assign(new Error("EMFILE: too many open files"), { code: "EMFILE" }),
        );
      }
      return actual.readFile(...args);
    },
  };
});

it("retries failed engine initialization and retains the successful modules", async () => {
  fault.enabled = true;
  onTestFinished(() => {
    fault.enabled = false;
  });
  const input = {
    kind: "exec" as const,
    source: "return 42;",
    config: createQuickJsTestConfig(),
    catalog: [],
  };
  const workerUrl = resolveRuntimeWorkerUrl(quickJsWorkerTestEntrypoint);
  const execute = () => runQuickJsExecutor(input, 5_000, workerUrl);

  await expect(execute()).resolves.toMatchObject({
    status: "failed",
    code: "runtime_unavailable",
    failurePhase: "host",
    bridgeDispatchStarted: false,
    error: expect.stringContaining("EMFILE"),
  });
  for (let attempt = 0; attempt < 2; attempt++) {
    const result = await execute();
    expect(result, JSON.stringify(result)).toMatchObject({
      status: "completed",
      value: { kind: "complete", json: "42" },
    });
  }
  expect(fault.wasmReads).toBe(2);
});
