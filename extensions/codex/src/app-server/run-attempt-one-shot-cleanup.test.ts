import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs/promises";
import path from "node:path";
import { embeddedAgentLog } from "openclaw/plugin-sdk/agent-harness-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readAttemptTerminal } from "./attempt-terminal.test-helper.js";
import { CodexAppServerClient } from "./client.js";
import {
  createNativeRunParams as createParams,
  runCodexAppServerAttempt,
  setupRunAttemptTestHooks,
  tempDir,
  threadStartResult,
  turnStartResult,
} from "./run-attempt-test-harness.js";
import { testCodexAppServerBindingStore } from "./session-binding.test-helpers.js";
import * as sharedClientModule from "./shared-client.js";
import {
  resetSharedCodexAppServerClientForTests,
  retainSharedCodexAppServerClientIfCurrent,
} from "./shared-client.js";
import { createClientHarness, waitForHarnessRequest } from "./test-support.js";
import * as processSnapshot from "./transport-process-snapshot.js";
import { CODEX_APP_SERVER_VERSION } from "./version.js";

const readTaskProcessSnapshot = processSnapshot.readCodexAppServerProcessSnapshot;

async function stopTaskOwnedProcess(pid: number): Promise<void> {
  try {
    process.kill(pid, "SIGKILL");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") {
      throw error;
    }
  }
  await expect
    .poll(
      async () => {
        const rows = await readTaskProcessSnapshot(Date.now() + 2_000, [pid]);
        return rows.some((row) => row.pid === pid && !row.state.startsWith("Z"));
      },
      { timeout: 2_000 },
    )
    .toBe(false);
}

setupRunAttemptTestHooks();

describe("Codex one-shot cleanup receipts", () => {
  beforeEach(() => {
    resetSharedCodexAppServerClientForTests();
  });

  afterEach(() => {
    resetSharedCodexAppServerClientForTests();
  });

  it.each(["completed", "cancelled"] as const)(
    "records native terminal termination uncertainty after a %s one-shot turn",
    async (completion) => {
      let terminalTerminated = false;
      const results: Record<string, unknown> = {
        initialize: { userAgent: `openclaw/${CODEX_APP_SERVER_VERSION} (macOS; test)` },
        "thread/start": threadStartResult(),
        "turn/start": turnStartResult(),
      };
      const harness = createClientHarness({
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
              params: { threadId: "thread-1", turn: { id: "turn-1", status: "interrupted" } },
            });
          }
        },
      });
      vi.spyOn(CodexAppServerClient, "start").mockResolvedValueOnce(harness.client);
      const warning = vi.spyOn(embeddedAgentLog, "warn");
      const abort = new AbortController();
      const params = createParams(
        path.join(tempDir, "native-terminal-cleanup-session.jsonl"),
        path.join(tempDir, "native-terminal-cleanup-workspace"),
      );
      params.oneShotCliRun = true;
      params.cleanupBundleMcpOnRunEnd = true;
      params.abortSignal = abort.signal;
      const run = runCodexAppServerAttempt(params, {
        bindingStore: testCodexAppServerBindingStore,
      });
      try {
        await waitForHarnessRequest(harness, "turn/start");
        await new Promise<void>((resolve) => {
          setImmediate(resolve);
        });
        if (completion === "cancelled") {
          const failure = expect(run).rejects.toThrow("Codex background-terminal cleanup");
          abort.abort("cancelled");
          await failure;
        } else {
          harness.send({
            method: "turn/completed",
            params: { threadId: "thread-1", turn: { id: "turn-1", status: "completed" } },
          });
          expect(readAttemptTerminal(await run)).toMatchObject({ aborted: false, timedOut: false });
        }
        expect(terminalTerminated).toBe(true);
        const step =
          completion === "cancelled" ? "codex-abort-cleanup" : "codex-one-shot-terminals";
        expect(warning).toHaveBeenCalledWith(
          expect.stringContaining(`step=${step} error=Codex background-terminal cleanup`),
        );
      } finally {
        harness.client.close();
        await run.catch(() => undefined);
      }
    },
  );

  it.each(["active lease", "pending acquire", "missing entry"] as const)(
    "records uncertain one-shot cleanup when shared retirement is refused: %s",
    async (reason) => {
      const harness = createClientHarness();
      vi.spyOn(CodexAppServerClient, "start").mockResolvedValueOnce(harness.client);
      const close = vi.spyOn(harness.client, "close");
      const closeAndWait = vi.spyOn(harness.client, "closeAndWait");
      const warning = vi.spyOn(embeddedAgentLog, "warn");
      const params = createParams(
        path.join(tempDir, "retained-cleanup-session.jsonl"),
        path.join(tempDir, "retained-cleanup-workspace"),
      );
      params.oneShotCliRun = true;
      params.cleanupBundleMcpOnRunEnd = true;
      let releasePeer: (() => void) | undefined;
      const run = runCodexAppServerAttempt(params, {
        bindingStore: testCodexAppServerBindingStore,
      });
      try {
        const initialize = await waitForHarnessRequest(harness, "initialize");
        harness.send({
          id: initialize.id,
          result: { userAgent: `openclaw/${CODEX_APP_SERVER_VERSION} (macOS; test)` },
        });
        const thread = await waitForHarnessRequest(harness, "thread/start");
        harness.send({ id: thread.id, result: threadStartResult() });
        const turn = await waitForHarnessRequest(harness, "turn/start");
        harness.send({ id: turn.id, result: turnStartResult() });
        if (reason === "pending acquire") {
          // Shared-client tests own the pending-startup race. This refusal is
          // its contract with attempt cleanup, which must preserve that owner.
          vi.spyOn(
            sharedClientModule,
            "clearSharedCodexAppServerClientIfCurrentAndUnclaimed",
          ).mockReturnValue({
            found: true,
            closed: false,
            activeLeases: 0,
            pendingAcquires: 1,
          });
        } else {
          releasePeer = retainSharedCodexAppServerClientIfCurrent(harness.client);
          expect(releasePeer).toBeTypeOf("function");
          if (reason === "missing entry") {
            expect(
              sharedClientModule.retireSharedCodexAppServerClientIfCurrent(harness.client),
            ).toMatchObject({ closed: false });
          }
        }
        harness.send({
          method: "turn/completed",
          params: { threadId: "thread-1", turn: { id: "turn-1", status: "completed" } },
        });
        const terminals = await waitForHarnessRequest(harness, "thread/backgroundTerminals/list");
        harness.send({ id: terminals.id, result: { data: [], nextCursor: null } });
        const unsubscribe = await waitForHarnessRequest(harness, "thread/unsubscribe");
        harness.send({ id: unsubscribe.id, result: {} });
        expect(readAttemptTerminal(await run)).toMatchObject({ aborted: false, timedOut: false });
        expect(warning).toHaveBeenCalledWith(
          expect.stringMatching(/agent cleanup failed:.*step=codex-shared-client-release/),
        );
        expect(close).not.toHaveBeenCalled();
        expect(closeAndWait).not.toHaveBeenCalled();
        expect(harness.stdinDestroyed).toBe(false);
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

  it.skipIf(process.platform === "win32").each(["confirmed", "unknown", "forced", "signalled"])(
    "records one-shot cleanup accurately after %s app-server shutdown",
    async (shutdown) => {
      const rootPath = path.join(tempDir, "cleanup-root.mjs");
      const descendantPath = path.join(tempDir, "cleanup-descendant.mjs");
      const descendantPidPath = path.join(tempDir, "cleanup-descendant.pid");
      const turnStartedPath = path.join(tempDir, "cleanup-turn-started");
      await fs.writeFile(descendantPath, "setInterval(() => {}, 1_000);\n");
      await fs.writeFile(
        rootPath,
        `
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
const [descendantPath, descendantPidPath, turnStartedPath] = process.argv.slice(2);
const descendant = spawn(process.execPath, [descendantPath], { detached: true, stdio: "ignore" });
descendant.unref();
writeFileSync(descendantPidPath, String(descendant.pid));
const results = ${JSON.stringify({
          initialize: { userAgent: `openclaw/${CODEX_APP_SERVER_VERSION} (macOS; test)` },
          "config/read": { config: {}, origins: {}, layers: [] },
          "configRequirements/read": { requirements: null },
          "thread/start": threadStartResult(),
          "turn/start": turnStartResult(),
          "thread/backgroundTerminals/list": { data: [], nextCursor: null },
        })};
const send = (message) => process.stdout.write(JSON.stringify(message) + "\\n");
createInterface({ input: process.stdin }).on("line", (line) => {
  const request = JSON.parse(line);
  if (request.method === "test/complete") {
    send({ method: "turn/completed", params: { threadId: "thread-1", turn: { id: "turn-1", status: "completed" } } });
  } else if (request.id !== undefined) {
    send({ id: request.id, result: results[request.method] ?? {} });
    if (request.method === "turn/start") writeFileSync(turnStartedPath, "started");
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
      const child = spawn(
        process.execPath,
        [rootPath, descendantPath, descendantPidPath, turnStartedPath],
        { detached: true, stdio: ["pipe", "pipe", "pipe"] },
      );
      const exited = once(child, "exit");
      const client = CodexAppServerClient.fromTransportForTests(child);
      vi.spyOn(CodexAppServerClient, "start").mockResolvedValueOnce(client);
      if (shutdown === "unknown") {
        vi.spyOn(processSnapshot, "readCodexAppServerProcessSnapshot").mockRejectedValue(
          new processSnapshot.ProcessInspectionError("unavailable"),
        );
      }
      const warning = vi.spyOn(embeddedAgentLog, "warn");
      const params = createParams(
        path.join(tempDir, "cleanup-session.jsonl"),
        path.join(tempDir, "cleanup-workspace"),
      );
      params.oneShotCliRun = true;
      params.cleanupBundleMcpOnRunEnd = true;
      const run = runCodexAppServerAttempt(params, {
        bindingStore: testCodexAppServerBindingStore,
      });
      try {
        await expect
          .poll(() => fs.readFile(turnStartedPath, "utf8").catch(() => ""))
          .toBe("started");
        child.stdin.write(`${JSON.stringify({ method: "test/complete" })}\n`);
        expect(readAttemptTerminal(await run)).toMatchObject({ aborted: false, timedOut: false });
        await exited;
        const descendantPid = Number(await fs.readFile(descendantPidPath, "utf8"));
        const signalled = shutdown === "forced" || shutdown === "signalled";
        expect(child.exitCode).toBe(signalled ? null : 0);
        expect(child.signalCode).toBe(signalled ? "SIGKILL" : null);
        if (shutdown === "unknown") {
          expect(process.kill(descendantPid, 0)).toBe(true);
        } else {
          const snapshot = await processSnapshot.readCodexAppServerProcessSnapshot(
            Date.now() + 2_000,
            [descendantPid],
          );
          expect(
            snapshot.some((row) => row.pid === descendantPid && !row.state.startsWith("Z")),
          ).toBe(false);
        }
        // This is the cleanup guard that also records the one-shot recovery
        // receipt; a clean root exit must not bypass its failure path.
        if (shutdown === "confirmed") {
          expect(warning).not.toHaveBeenCalled();
        } else {
          expect(warning).toHaveBeenCalledWith(
            expect.stringMatching(/agent cleanup failed:.*step=codex-shared-client-release/),
          );
        }
      } finally {
        client.close();
        child.kill("SIGKILL");
        await exited;
        await run.catch(() => undefined);
        const descendantPid = Number(await fs.readFile(descendantPidPath, "utf8").catch(() => ""));
        if (descendantPid) {
          await stopTaskOwnedProcess(descendantPid);
        }
      }
    },
  );
});
