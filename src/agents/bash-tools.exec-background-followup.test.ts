import "../test-utils/prepare-compiled-subprocesses.js";
import fs from "node:fs/promises";
import path from "node:path";
import { Worker } from "node:worker_threads";
import { expectDefined } from "@openclaw/normalization-core/expect";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { afterAll, afterEach, beforeAll, beforeEach, expect, test, vi } from "vitest";
import { withinTest } from "../../test/helpers/promise.js";
import * as sessionEvents from "../auto-reply/reply/session-event-handoff.js";
import { setRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import { replaceSessionEntry } from "../config/sessions/session-accessor.js";
import * as sessionReads from "../config/sessions/session-entry-read-runtime.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resetSystemEventsForTest } from "../infra/system-events.js";
import { openOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import { waitForExecScope } from "./bash-process-registry.js";
import { resetProcessRegistryForTests } from "./bash-process-registry.test-support.js";
import { createExecTool } from "./bash-tools.exec-run.js";
import { createProcessTool } from "./bash-tools.process.js";
import type { RunEmbeddedAgentParams } from "./embedded-agent-runner/run/params.js";
import { runEmbeddedAgent } from "./embedded-agent.js";

// mock-isolation: Keep model inference outside the real process and session-event ownership fixture.
vi.mock("./embedded-agent-runner/run.js", () => ({ runEmbeddedAgent: vi.fn() }));
const model = vi.mocked(runEmbeddedAgent);
await Promise.all([
  import("../auto-reply/dispatch.js"),
  import("../auto-reply/reply/get-reply-from-config.runtime.js").then((runtime) =>
    runtime.prewarmConfigDrivenReplyRuntime(),
  ),
]);

let state: OpenClawTestState;
let config: OpenClawConfig;
const receipts: sessionEvents.SessionEventReceipt[] = [];
const enqueue = sessionEvents.enqueueSessionEventForHost;

beforeAll(async () => {
  state = await createOpenClawTestState({
    label: "exec-followup",
    env: { OPENCLAW_TEST_FAST: "0" },
  });
  config = {
    agents: {
      entries: { main: { workspace: state.workspaceDir } },
      defaults: {
        workspace: state.workspaceDir,
        skipBootstrap: true,
        model: { primary: "mock-openai/gpt-5.6-luna" },
        models: { "mock-openai/gpt-5.6-luna": { agentRuntime: { id: "openclaw" } } },
      },
    },
    plugins: { enabled: false },
    skills: { load: { watch: false } },
  };
  setRuntimeConfigSnapshot(config);
  await state.writeConfig(config);
  openOpenClawStateDatabase();
});

beforeEach(() => {
  model.mockReset().mockImplementation(async (params: RunEmbeddedAgentParams) => {
    await expectDefined(params.preparedRunAdmission, "real completion admission").admit(
      "gateway",
      params.runId,
    );
    params.onExecutionPhase?.({ phase: "model_call_started" });
    await params.onExecutionStarted?.();
    await params.onAgentEvent?.({ stream: "lifecycle", data: { phase: "start" } });
    return { payloads: [{ text: "NO_REPLY" }], meta: { durationMs: 1 } };
  });
  vi.spyOn(sessionEvents, "enqueueSessionEventForHost").mockImplementation((text, options) => {
    const receipt = enqueue(text, options);
    receipts.push(receipt);
    return receipt;
  });
});

afterEach(async () => {
  for (const receipt of receipts) {
    receipt.cancel();
  }
  await Promise.all(receipts.map((receipt) => receipt.settled));
  receipts.length = 0;
  vi.restoreAllMocks();
  resetProcessRegistryForTests();
  resetSystemEventsForTest();
});

afterAll(async () => {
  await state?.cleanup();
});

async function seedOrigin(sessionKey: string, spawnedBy?: string) {
  await replaceSessionEntry(
    { agentId: "main", sessionKey },
    {
      sessionId: sessionKey.replaceAll(":", "-"),
      lifecycleRevision: "original",
      updatedAt: Date.now(),
      sessionStartedAt: Date.now(),
      permissionMode: "full",
      ...(spawnedBy ? { spawnedBy, spawnDepth: 1 } : {}),
    },
  );
}

function nodeCommand(source: string): string {
  const quote = (value: string) =>
    `'${value.replaceAll("'", process.platform === "win32" ? "''" : "'\\''")}'`;
  const command = `${quote(process.execPath)} -e ${quote(source)}`;
  return process.platform === "win32" ? `& ${command}` : command;
}

async function completion(signal: AbortSignal) {
  const receipt = expectDefined(receipts.at(-1), "ordinary completion receipt");
  expect(await withinTest(receipt.accepted, signal)).toEqual({ ok: true });
  expect(await withinTest(receipt.settled, signal)).toMatchObject({
    status: "completed",
    executionStarted: true,
  });
}

test("does not advertise detached continuation when process is unavailable", async () => {
  const exec = createExecTool({
    host: "gateway",
    security: "full",
    ask: "off",
    processToolAvailabilityRef: { value: false },
    notifyOnExit: false,
  });
  const result = await exec.execute("followup-foreground", {
    command: nodeCommand('process.stdout.write("FOREGROUND_COMPLETE")'),
    background: true,
  });
  expect(result.details).toMatchObject({ status: "completed", aggregated: "FOREGROUND_COMPLETE" });
  expect(result.details).not.toHaveProperty("followUp");
});

test("starts and notifies when identity enrichment fails, then resolves child identity again", async ({
  signal,
}) => {
  const sessionKey = "agent:main:dashboard:notification-possible";
  await seedOrigin(sessionKey);
  vi.spyOn(sessionReads, "readSessionEntriesFromStoreInWorker").mockRejectedValueOnce(
    new Error("session worker unavailable"),
  );
  const exec = createExecTool({
    config,
    host: "gateway",
    security: "full",
    ask: "off",
    sessionKey,
    scopeKey: sessionKey,
    notifyOnExit: true,
    allowBackground: true,
  });
  const processTool = createProcessTool({ scopeKey: sessionKey });
  for (const recovered of [false, true]) {
    if (recovered) {
      await seedOrigin(sessionKey, "agent:main:main");
    }
    const started = await exec.execute("notification-possible", {
      command: nodeCommand('process.stdout.write("EXEC_STARTED"); process.exitCode = 1'),
      background: true,
    });
    expect(started.details.status).toBe("running");
    if (started.details.status !== "running") {
      throw new Error("Expected a background process");
    }
    await withinTest(waitForExecScope(sessionKey), signal);
    if (!recovered) {
      await completion(signal);
    }
    expect(receipts).toHaveLength(1);
    expect(model).toHaveBeenCalledOnce();
    const result = await processTool.execute("collect", {
      action: "poll",
      sessionId: started.details.sessionId,
    });
    expect(result.details).toMatchObject({
      status: "completed",
      aggregated: "EXEC_STARTED",
      exitCode: 1,
    });
  }
});

test("reports manual collection after real destination capture fails, then recovers on the same tool", async ({
  signal,
}) => {
  const sessionKey = "agent:main:exec-capture-failure";
  await seedOrigin(sessionKey);
  let faults = 0;
  const failRead = (value: unknown) => {
    if (
      !isRecord(value) ||
      !isRecord(value.input) ||
      value.input.kind !== "session-entry-read" ||
      !isRecord(value.input.scope) ||
      value.input.scope.sessionKey !== sessionKey ||
      faults
    ) {
      return;
    }
    faults++;
    throw new Error("session worker transport unavailable");
  };
  // oxlint-disable-next-line typescript/unbound-method -- Called below with the real Worker receiver.
  const threadPost = Worker.prototype.postMessage;
  vi.spyOn(Worker.prototype, "postMessage").mockImplementation(function (
    this: Worker,
    value,
    transferList,
  ) {
    failRead(value);
    threadPost.call(this, value, transferList);
  });
  const exec = createExecTool({
    config,
    host: "gateway",
    security: "full",
    ask: "off",
    agentId: "main",
    sessionKey,
    scopeKey: sessionKey,
    notifyOnExit: true,
    notifyOnExitEmptySuccess: true,
    allowBackground: true,
  });
  const processTool = createProcessTool({ scopeKey: sessionKey });
  for (const recovered of [false, true]) {
    const release = path.join(state.workspaceDir, `release-${recovered}`);
    const child = `const fs = require("node:fs"); const release = ${JSON.stringify(release)}; const watcher = fs.watch(${JSON.stringify(state.workspaceDir)}, () => { if (fs.existsSync(release)) { watcher.close(); process.stdout.write("EXEC_COLLECTED"); } }); if (fs.existsSync(release)) { watcher.close(); process.stdout.write("EXEC_COLLECTED"); }`;
    try {
      const started = await exec.execute("capture-failure", {
        command: nodeCommand(child),
        background: true,
      });
      expect(faults).toBe(1);
      expect(started.details.status).toBe("running");
      if (started.details.status !== "running") {
        throw new Error("Expected a background process");
      }
      const followUp = expectDefined(started.details.followUp, "background continuation guidance");
      expect(followUp).toContain(
        recovered ? "wake this conversation automatically" : "poll with a timeout",
      );
      if (!recovered) {
        expect(followUp).not.toContain("wake this conversation automatically");
      }
      expect(started.content).toContainEqual({
        type: "text",
        text: expect.stringContaining(followUp),
      });
      for (const action of ["list", "poll", "log"] as const) {
        const running = await processTool.execute("inspect", {
          action,
          sessionId: started.details.sessionId,
        });
        if (!recovered) {
          const expected = {
            sessionId: started.details.sessionId,
            followUp: expect.stringContaining("before ending the turn"),
          };
          expect(running.details).toMatchObject(
            action === "list" ? { sessions: [expected] } : expected,
          );
        }
      }
      await fs.writeFile(release, "release");
      await withinTest(waitForExecScope(sessionKey), signal);
      if (recovered) {
        await completion(signal);
      }
      expect(receipts).toHaveLength(recovered ? 1 : 0);
      expect(model).toHaveBeenCalledTimes(recovered ? 1 : 0);
      const collected = await processTool.execute("collect", {
        action: "poll",
        sessionId: started.details.sessionId,
      });
      expect(collected.details).toMatchObject({
        status: "completed",
        aggregated: "EXEC_COLLECTED",
        exitCode: 0,
      });
    } finally {
      await fs.writeFile(release, "release");
      await withinTest(waitForExecScope(sessionKey), signal);
    }
  }
});
