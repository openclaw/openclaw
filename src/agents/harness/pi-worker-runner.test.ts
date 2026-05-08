import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import type { RunEmbeddedPiAgentParams } from "../pi-embedded-runner/run/params.js";
import type { PreparedAgentRun } from "../runtime-backend.js";
import { runPreparedAgentInWorker } from "../runtime-worker.js";
import {
  createPiRunWorkerPreparedRunForTest,
  createPiRunWorkerRunner,
  embeddedPiRunResultFromWorkerResult,
} from "./pi-worker-runner.js";

function createParams(overrides: Partial<RunEmbeddedPiAgentParams> = {}): RunEmbeddedPiAgentParams {
  return {
    sessionId: "session-worker-runner",
    sessionKey: "agent:main:thread",
    sessionFile: "sqlite-transcript://main/session-worker-runner.jsonl",
    workspaceDir: "/tmp/workspace",
    prompt: "hello",
    timeoutMs: 1000,
    runId: "run-worker-runner",
    provider: "openai",
    model: "gpt-5.5",
    shouldEmitToolResult: () => true,
    shouldEmitToolOutput: () => false,
    ...overrides,
  } as RunEmbeddedPiAgentParams;
}

function workerEntryDataUrl(): URL {
  return new URL(
    `data:text/javascript,${encodeURIComponent(`
      import { parentPort, workerData } from "node:worker_threads";
      const mod = await import(workerData.backendModuleUrl);
      const backend = mod.default ?? mod.backend;
      const context = {
        filesystem: { scratch: {}, artifacts: {}, workspace: { root: workerData.preparedRun.workspaceDir } },
        emit: (event) => parentPort.postMessage({ type: "event", event }),
        control: { onMessage: () => () => {} },
      };
      try {
        parentPort.postMessage({
          type: "result",
          result: await backend.run(workerData.preparedRun, context),
        });
      } catch (error) {
        parentPort.postMessage({ type: "error", error: error?.stack || error?.message || String(error) });
      }
    `)}`,
  );
}

function backendDataUrl(): string {
  return `data:text/javascript,${encodeURIComponent(`
    export default {
      id: "pi",
      async run(preparedRun, context) {
        context.emit({
          runId: preparedRun.runId,
          sessionKey: preparedRun.sessionKey,
          stream: "final",
          data: { callback: "block_reply", payload: { text: "visible-from-real-worker" } },
        });
        return {
          ok: true,
          text: "done-from-real-worker",
          data: {
            embeddedPiRunResult: {
              payloads: [{ text: "embedded-from-real-worker" }],
              meta: { durationMs: 7 },
            },
          },
        };
      },
    };
  `)}`;
}

describe("PI run worker runner", () => {
  it("runs a prepared high-level PI request through the generic worker runner", async () => {
    let preparedRun: PreparedAgentRun | undefined;
    const runPreparedAgentInWorker = vi.fn(async (run, options) => {
      preparedRun = run;
      expect(options.backendModuleUrl).toBe("file:///tmp/pi-worker-backend.js");
      expect(options.permissionProfile.mode).toBe("off");
      await options.onEvent?.({
        runId: run.runId,
        stream: "final",
        data: { callback: "block_reply", payload: { text: "visible" } },
        sessionKey: run.sessionKey,
      });
      return {
        ok: true,
        text: "done",
        data: {
          embeddedPiRunResult: {
            payloads: [{ text: "done" }],
            meta: { durationMs: 42 },
          },
        },
      };
    });
    const onBlockReply = vi.fn();
    const runPiRunInWorker = createPiRunWorkerRunner({ runPreparedAgentInWorker });

    const result = await runPiRunInWorker(createParams({ onBlockReply }), {
      backendModuleUrl: "file:///tmp/pi-worker-backend.js",
    });

    expect(result).toEqual({
      payloads: [{ text: "done" }],
      meta: { durationMs: 42 },
    });
    expect(preparedRun).toMatchObject({
      runId: "run-worker-runner",
      provider: "openai",
      model: "gpt-5.5",
      deliveryPolicy: { emitToolResult: true, emitToolOutput: false },
    });
    expect(onBlockReply).toHaveBeenCalledWith({ text: "visible" });
  });

  it("throws when the worker result is not ok", async () => {
    const runPiRunInWorker = createPiRunWorkerRunner({
      runPreparedAgentInWorker: vi.fn(async () => ({ ok: false, error: "boom" })),
    });

    await expect(runPiRunInWorker(createParams())).rejects.toThrow("boom");
  });

  it("runs the PI launch request through a real worker thread", async () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-pi-worker-runner-"));
    const previousStateDir = process.env.OPENCLAW_STATE_DIR;
    process.env.OPENCLAW_STATE_DIR = stateDir;
    const onBlockReply = vi.fn();
    try {
      const runPiRunInWorker = createPiRunWorkerRunner({ runPreparedAgentInWorker });

      await expect(
        runPiRunInWorker(createParams({ onBlockReply }), {
          backendModuleUrl: backendDataUrl(),
          workerEntryUrl: workerEntryDataUrl(),
        }),
      ).resolves.toEqual({
        payloads: [{ text: "embedded-from-real-worker" }],
        meta: { durationMs: 7 },
      });
      expect(onBlockReply).toHaveBeenCalledWith({ text: "visible-from-real-worker" });
    } finally {
      closeOpenClawStateDatabaseForTest();
      if (previousStateDir === undefined) {
        delete process.env.OPENCLAW_STATE_DIR;
      } else {
        process.env.OPENCLAW_STATE_DIR = previousStateDir;
      }
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it("falls back to payload text when a backend omits embedded result data", () => {
    expect(embeddedPiRunResultFromWorkerResult({ ok: true, text: "fallback" })).toEqual({
      payloads: [{ text: "fallback" }],
      meta: { durationMs: 0 },
    });
  });

  it("exposes a test helper for inspecting prepared high-level runs", () => {
    expect(createPiRunWorkerPreparedRunForTest(createParams())).toMatchObject({
      runtimeId: "pi",
      runId: "run-worker-runner",
      runParams: {
        provider: "openai",
        model: "gpt-5.5",
      },
    });
  });
});
