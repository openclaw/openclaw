import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs/promises";
import path from "node:path";
import { setTimeout as waitForProcessTick } from "node:timers/promises";
import { embeddedAgentLog } from "openclaw/plugin-sdk/agent-harness-runtime";
import { isPidAlive } from "openclaw/plugin-sdk/process-runtime";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "openclaw/plugin-sdk/runtime-config-snapshot";
import { awaitGateBeforeSettlement, withinTest } from "openclaw/plugin-sdk/test-fixtures";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readAttemptTerminal } from "./attempt-terminal.test-helper.js";
import { CodexAppServerClient } from "./client.js";
import { setCodexTestToolFactory } from "./host-capability.test-support.js";
import {
  flattenCodexDynamicToolFunctions,
  isJsonObject,
  type CodexDynamicToolSpec,
} from "./protocol.js";
import {
  createCodexRuntimePlanFixture,
  createNativeRunParams as createParams,
  createRuntimeDynamicTool,
  runCodexAppServerAttempt,
  setCodexTestModelSupportsTools,
  setupRunAttemptTestHooks,
  tempDir,
  threadStartResult,
  turnStartResult,
} from "./run-attempt-test-harness.js";
import { testCodexAppServerBindingStore } from "./session-binding.test-helpers.js";
import {
  retainSharedCodexAppServerClientIfCurrent,
  retireSharedCodexAppServerClientIfCurrent,
} from "./shared-client.js";
import { resetSharedCodexAppServerClientForTests } from "./shared-client.test-support.js";
import {
  createInferenceReadyClientHarness,
  createCodexInferenceReadResponses,
  waitForHarnessRequest,
} from "./test-support.js";
import * as processSnapshot from "./transport-process-snapshot.js";
import { CODEX_APP_SERVER_VERSION } from "./version.js";

// The deliberately retired root cannot report reaping its detached descendants.
// Observe those foreign PIDs only until the owning test is aborted.
async function waitForTaskOwnedProcessExit(pid: number, signal: AbortSignal): Promise<void> {
  try {
    while (isPidAlive(pid)) {
      await waitForProcessTick(10, undefined, { signal });
    }
  } catch (error) {
    throw new Error(`Task-owned descendant ${pid} did not exit`, { cause: error });
  }
}

async function stopTaskOwnedProcess(pid: number, signal: AbortSignal): Promise<void> {
  try {
    process.kill(pid, "SIGKILL");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") {
      throw error;
    }
  }
  await waitForTaskOwnedProcessExit(pid, signal);
}

function runOneShot(client: CodexAppServerClient, abortSignal?: AbortSignal) {
  vi.spyOn(CodexAppServerClient, "start").mockResolvedValueOnce(client);
  const params = createParams(path.join(tempDir, "session.jsonl"), path.join(tempDir, "workspace"));
  setRuntimeConfigSnapshot(params.config ?? {});
  params.oneShotCliRun = true;
  params.cleanupBundleMcpOnRunEnd = true;
  if (abortSignal) {
    params.abortSignal = abortSignal;
  }
  return runCodexAppServerAttempt(params, { bindingStore: testCodexAppServerBindingStore });
}

setupRunAttemptTestHooks();

const responses = () => ({
  initialize: { userAgent: `openclaw/${CODEX_APP_SERVER_VERSION} (macOS; test)` },
  "thread/start": threadStartResult(),
  "turn/start": turnStartResult(),
});

function respondingHarness(results: Record<string, unknown> = responses()) {
  return createInferenceReadyClientHarness({
    onWrite: (line, send) => {
      const request = JSON.parse(line) as { id?: number; method: string };
      if (request.id !== undefined) {
        send({ id: request.id, result: results[request.method] ?? {} });
      }
    },
  });
}

function completeTurn(harness: ReturnType<typeof createInferenceReadyClientHarness>) {
  harness.send({
    method: "turn/completed",
    params: { threadId: "thread-1", turn: { id: "turn-1", status: "completed", items: [] } },
  });
}

async function replyTo(
  harness: ReturnType<typeof createInferenceReadyClientHarness>,
  method: string,
  result: unknown,
) {
  const request = await waitForHarnessRequest(harness, method);
  harness.send({ id: request.id, result });
}

function expectSuccessfulRun(result: Awaited<ReturnType<typeof runCodexAppServerAttempt>>) {
  expect(readAttemptTerminal(result)).toMatchObject({ aborted: false, timedOut: false });
}

function expectReleaseWarning(warning: unknown) {
  expect(warning).toHaveBeenCalledWith(
    expect.stringMatching(/agent cleanup failed:.*step=codex-shared-client-release/),
  );
}

describe("Codex one-shot cleanup receipts", () => {
  beforeEach(() => {
    resetSharedCodexAppServerClientForTests();
  });

  afterEach(() => {
    resetSharedCodexAppServerClientForTests();
    clearRuntimeConfigSnapshot();
  });

  it("reuses the shared process across background turns that release their MCP resources", async () => {
    const harness = respondingHarness();
    const start = vi.spyOn(CodexAppServerClient, "start").mockResolvedValue(harness.client);
    for (let index = 0; index < 2; index++) {
      const params = createParams(
        path.join(tempDir, `background-${index}.jsonl`),
        path.join(tempDir, "workspace"),
      );
      params.cleanupBundleMcpOnRunEnd = true;
      setRuntimeConfigSnapshot(params.config ?? {});
      const run = runCodexAppServerAttempt(params, {
        bindingStore: testCodexAppServerBindingStore,
      });
      try {
        await run.waitForTurnAccepted();
        completeTurn(harness);
        expectSuccessfulRun(await run);
        expect(harness.client.getCloseError()).toBeUndefined();
      } finally {
        await run.catch(() => undefined);
      }
    }
    expect(start).toHaveBeenCalledOnce();
    expect(
      harness.writes.filter((line) => JSON.parse(line).method === "thread/unsubscribe"),
    ).toHaveLength(2);
  });

  it("uses host-owned tools for strict one-shot Codex runs", async () => {
    const harness = respondingHarness({
      ...responses(),
      "configRequirements/read": { requirements: null },
      "thread/backgroundTerminals/list": { data: [], nextCursor: null },
    });
    const params = createParams(
      path.join(tempDir, "session.jsonl"),
      path.join(tempDir, "workspace"),
    );
    params.oneShotCliRun = true;
    params.cleanupBundleMcpOnRunEnd = true;
    params.disableTools = false;
    params.runtimePlan = createCodexRuntimePlanFixture();
    setCodexTestModelSupportsTools(params, true);
    setCodexTestToolFactory(params, () =>
      ["exec", "process", "message"].map(createRuntimeDynamicTool),
    );
    setRuntimeConfigSnapshot({});
    vi.spyOn(CodexAppServerClient, "start").mockResolvedValueOnce(harness.client);
    const run = runCodexAppServerAttempt(params, { bindingStore: testCodexAppServerBindingStore });
    try {
      await run.waitForTurnAccepted();
      const start = await waitForHarnessRequest(harness, "thread/start");
      expect(start.params).toMatchObject({ config: { "features.code_mode": false } });
      const { dynamicTools } = start.params as { dynamicTools: CodexDynamicToolSpec[] };
      expect(
        flattenCodexDynamicToolFunctions(dynamicTools)
          .map((tool) => tool.name)
          .toSorted(),
      ).toEqual(["exec", "message", "process"]);
      await waitForHarnessRequest(harness, "turn/start");
      completeTurn(harness);
      expectSuccessfulRun(await run);
    } finally {
      harness.client.close();
      await run.catch(() => undefined);
    }
  });

  it.each(["completed", "cancelled"] as const)(
    "preserves a %s one-shot outcome while native terminal cleanup remains uncertain",
    async (completion) => {
      // Cold startup must not consume the unrelated attempt deadline in this cleanup fixture.
      vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
      let terminalTerminated = false;
      const results: Record<string, unknown> = responses();
      const harness = createInferenceReadyClientHarness({
        onWrite: (line, send) => {
          const request = JSON.parse(line) as { id?: number; method: string };
          if (request.id === undefined) {
            return;
          }
          let result = results[request.method] ?? {};
          if (request.method === "thread/backgroundTerminals/list") {
            result = { data: terminalTerminated ? [] : [{ processId: "10" }], nextCursor: null };
          } else if (request.method === "thread/backgroundTerminals/terminate") {
            terminalTerminated = true;
            result = { terminated: true };
          }
          send({ id: request.id, result });
          if (request.method === "turn/interrupt") {
            send({
              method: "turn/completed",
              params: {
                threadId: "thread-1",
                turn: { id: "turn-1", status: "interrupted", items: [] },
              },
            });
          }
        },
      });
      const warning = vi.spyOn(embeddedAgentLog, "warn");
      const abort = new AbortController();
      const run = runOneShot(harness.client, abort.signal);
      try {
        await run.waitForTurnAccepted();
        if (completion === "cancelled") {
          abort.abort("cancelled");
          expect(readAttemptTerminal(await run)).toMatchObject({ aborted: true, timedOut: false });
        } else {
          completeTurn(harness);
          expectSuccessfulRun(await run);
        }
        expect(terminalTerminated).toBe(true);
        const step =
          completion === "cancelled" ? "codex-shared-client-release" : "codex-one-shot-terminals";
        expect(warning).toHaveBeenCalledWith(expect.stringContaining(`step=${step} error=Codex`));
      } finally {
        harness.client.close();
        await run.catch(() => undefined);
      }
    },
  );

  it.each(["active lease", "missing entry"] as const)(
    "records uncertain one-shot cleanup when shared retirement is refused: %s",
    async (reason) => {
      const harness = createInferenceReadyClientHarness();
      const warning = vi.spyOn(embeddedAgentLog, "warn");
      let releasePeer: (() => void) | undefined;
      const run = runOneShot(harness.client);
      try {
        for (const [method, result] of Object.entries(responses())) {
          await replyTo(harness, method, result);
        }
        releasePeer = retainSharedCodexAppServerClientIfCurrent(harness.client);
        if (reason === "missing entry") {
          retireSharedCodexAppServerClientIfCurrent(harness.client);
        }
        completeTurn(harness);
        await replyTo(harness, "thread/backgroundTerminals/list", { data: [], nextCursor: null });
        await replyTo(harness, "thread/unsubscribe", {});
        expectSuccessfulRun(await run);
        expectReleaseWarning(warning);
        const requestStart = harness.writes.length;
        const peerRead = harness.client.request("thread/read", {
          threadId: "thread-peer",
          includeTurns: false,
        });
        const read = await waitForHarnessRequest(harness, "thread/read", requestStart);
        const result = threadStartResult("thread-peer");
        harness.send({ id: read.id, result });
        await expect(peerRead).resolves.toEqual(result);
      } finally {
        releasePeer?.();
        harness.client.close();
        await run.catch(() => undefined);
      }
    },
  );

  it
    .skipIf(process.platform === "win32")
    .for(["confirmed", "unknown", "forced", "signalled", "retired-command"])(
    "records one-shot cleanup accurately after %s app-server shutdown",
    async (shutdown, { signal }) => {
      const rootPath = path.join(tempDir, "cleanup-root.mjs");
      const descendantPath = path.join(tempDir, "cleanup-descendant.mjs");
      const descendantPidPath = path.join(tempDir, "cleanup-descendant.pid");
      await fs.writeFile(descendantPath, "setInterval(() => {}, 1_000);\n");
      const launcherPath = path.join(tempDir, "cleanup-launcher.mjs");
      await fs.writeFile(
        launcherPath,
        `
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
const child = spawn(process.execPath, [process.argv[2]], { detached: true, stdio: "ignore" });
child.unref();
writeFileSync(process.argv[3], String(child.pid));
`,
      );
      await fs.writeFile(
        rootPath,
        `
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
const [descendantPath, descendantPidPath] = process.argv.slice(2);
const descendant = spawn(process.execPath, ${shutdown === "retired-command" ? `[${JSON.stringify(launcherPath)}, descendantPath, descendantPidPath]` : "[descendantPath]"}, { detached: true, stdio: "ignore" });
${shutdown === "retired-command" ? 'await new Promise(resolve => descendant.once("exit", resolve));' : "writeFileSync(descendantPidPath, String(descendant.pid));"}
descendant.unref();
const results = ${JSON.stringify({
          ...responses(),
          ...createCodexInferenceReadResponses(),
          "configRequirements/read": { requirements: null },
          "thread/backgroundTerminals/list": { data: [], nextCursor: null },
        })};
const send = (message) => process.stdout.write(JSON.stringify(message) + "\\n");
createInterface({ input: process.stdin }).on("line", (line) => {
  const request = JSON.parse(line);
  if (request.method === "test/complete") {
    ${shutdown !== "forced" ? 'send({ method: "item/completed", params: { threadId: "thread-1", turnId: "turn-1", item: { type: "commandExecution", id: "fixture-command", command: "fixture", cwd: process.cwd(), status: "completed", exitCode: 0, aggregatedOutput: "" } } });' : ""}
    send({ method: "turn/completed", params: { threadId: "thread-1", turn: { id: "turn-1", status: "completed", items: [] } } });
  } else if (request.id !== undefined) {
    send({ id: request.id, result: results[request.method] ?? {} });
    if (request.method === "turn/start") {
      send({ method: "turn/started", params: { threadId: "thread-1", turn: results["turn/start"].turn } });
    }
  }
});
process.stdin.on("end", () => ${
          shutdown === "forced"
            ? "setInterval(() => {}, 1_000)"
            : shutdown === "signalled"
              ? 'process.kill(process.pid, "SIGKILL")'
              : "process.exit(0)"
        });
`,
      );
      const child = spawn(process.execPath, [rootPath, descendantPath, descendantPidPath], {
        detached: true,
        stdio: ["pipe", "pipe", "pipe"],
      });
      const exited = once(child, "exit");
      const client = CodexAppServerClient.fromTransportForTests(child);
      if (shutdown === "unknown") {
        vi.spyOn(processSnapshot, "readCodexAppServerProcessSnapshot").mockRejectedValue(
          new processSnapshot.ProcessInspectionError("unavailable"),
        );
      }
      const turnStarted = Promise.withResolvers<void>();
      const removeTurnStartedHandler = client.addNotificationHandler((notification) => {
        if (
          notification.method === "turn/started" &&
          isJsonObject(notification.params) &&
          notification.params.threadId === "thread-1" &&
          isJsonObject(notification.params.turn) &&
          notification.params.turn.id === "turn-1" &&
          notification.params.turn.status === "inProgress"
        ) {
          turnStarted.resolve();
        }
      });
      const warning = vi.spyOn(embeddedAgentLog, "warn");
      const run = runOneShot(client);
      try {
        await withinTest(
          awaitGateBeforeSettlement(
            turnStarted.promise,
            run,
            "Codex attempt settled before the fixture emitted turn/started",
          ),
          signal,
        );
        client.notify("test/complete");
        expectSuccessfulRun(await withinTest(run, signal));
        await withinTest(exited, signal);
        const descendantPid = Number(await fs.readFile(descendantPidPath, "utf8"));
        const signalled = shutdown === "forced" || shutdown === "signalled";
        expect(child.exitCode).toBe(signalled ? null : 0);
        expect(child.signalCode).toBe(signalled ? "SIGKILL" : null);
        const retained = shutdown === "unknown" || shutdown === "retired-command";
        if (!retained) {
          await waitForTaskOwnedProcessExit(descendantPid, signal);
        }
        expect(isPidAlive(descendantPid)).toBe(retained);
        // Confirmed termination is sufficient for host-tool-only turns. Native
        // commands can have reparented descendants even after a clean root exit.
        if (shutdown === "forced") {
          expect(warning).toHaveBeenCalledWith(
            "Codex app-server required forced shutdown; process cleanup confirmed",
          );
          expect(warning).not.toHaveBeenCalledWith(expect.stringMatching(/agent cleanup failed:/));
        } else {
          expectReleaseWarning(warning);
        }
      } finally {
        removeTurnStartedHandler();
        client.close();
        child.kill("SIGKILL");
        await exited;
        await run.catch(() => undefined);
        const descendantPid = Number(await fs.readFile(descendantPidPath, "utf8").catch(() => ""));
        if (descendantPid) {
          await stopTaskOwnedProcess(descendantPid, signal);
        }
      }
    },
  );
});
