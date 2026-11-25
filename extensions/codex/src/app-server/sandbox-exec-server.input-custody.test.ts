import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { useIsolatedStateGuard } from "openclaw/plugin-sdk/test-env";
import { awaitGateBeforeSettlement, withinTest } from "openclaw/plugin-sdk/test-fixtures";
import { expect, it, vi } from "vitest";
import { createSessionExecServer } from "./sandbox-exec-server-session.test-support.js";
import { createSandboxContext } from "./sandbox-exec-server.test-helpers.js";
import { startProcess, terminateProcess, writeProcess } from "./sandbox-exec-server/processes.js";
import type { ManagedProcess } from "./sandbox-exec-server/types.js";

useIsolatedStateGuard();

it("preserves real process input order and refuses retirement during deferred preparation", async ({
  signal,
}) => {
  let current = true;
  let hold: ReturnType<typeof createDeferred<void>> | undefined;
  let entered: ReturnType<typeof createDeferred<void>> | undefined;
  const sandbox = createSandboxContext({
    buildExecSpec: async () => ({
      argv: [
        process.execPath,
        "-e",
        "process.stdin.on('data', chunk => process.stdout.write(chunk));",
      ],
      env: process.env,
      stdinMode: "pipe-open",
      prepareCurrent: async () => {
        const pending = hold;
        hold = undefined;
        entered?.resolve();
        await pending?.promise;
      },
      assertCurrent: () => {
        if (!current) {
          throw new Error("original workspace retired");
        }
      },
    }),
  });
  const server = createSessionExecServer(sandbox);
  const processes = new Map<string, ManagedProcess>();
  const params = {
    processId: "input-custody",
    argv: ["synthetic"],
    cwd: "file:///workspace",
    pipeStdin: true,
  };
  await startProcess(server, processes, vi.fn(), params);
  const child = processes.get(params.processId)?.child;
  if (!child || !("process" in child)) {
    throw new Error("Expected the owned pipe child");
  }
  let output = "";
  const received = createDeferred<void>();
  child.process.stdout.on("data", (chunk: Buffer) => {
    output += chunk.toString();
    if (output.length >= "firstsecond".length) {
      received.resolve();
    }
  });
  const write = (chunk: string) =>
    writeProcess(processes, {
      processId: params.processId,
      chunk: Buffer.from(chunk).toString("base64"),
    });
  const firstGate = createDeferred<void>();
  const retirement = createDeferred<void>();
  hold = firstGate;
  entered = createDeferred<void>();
  try {
    const first = write("first");
    await withinTest(
      awaitGateBeforeSettlement(entered.promise, first, "first input preparation"),
      signal,
    );
    const second = write("second");
    firstGate.resolve();
    await expect(Promise.all([first, second])).resolves.toEqual([
      { status: "accepted" },
      { status: "accepted" },
    ]);
    await withinTest(received.promise, signal);
    expect(output).toBe("firstsecond");
    hold = retirement;
    entered = createDeferred<void>();
    const refused = write("forbidden");
    await withinTest(
      awaitGateBeforeSettlement(entered.promise, refused, "retired input preparation"),
      signal,
    );
    const queued = write("also forbidden");
    current = false;
    retirement.resolve();
    await expect(refused).rejects.toThrow("original workspace retired");
    await expect(queued).rejects.toThrow("original workspace retired");
  } finally {
    firstGate.resolve();
    retirement.resolve();
    hold?.resolve();
    await terminateProcess(processes, params);
  }
  expect(output).toBe("firstsecond");
  expect(server.children.size).toBe(0);
});
