import { describe, expect, it } from "vitest";
import type { PreparedAgentRun } from "./runtime-backend.js";
import { runPreparedAgentInWorker } from "./runtime-worker.js";

function backendDataUrl(source: string): string {
  return `data:text/javascript;charset=utf-8,${encodeURIComponent(source)}`;
}

function workerEntryDataUrl(): URL {
  return new URL(
    backendDataUrl(`
      import { parentPort, workerData } from "node:worker_threads";
      const mod = await import(workerData.backendModuleUrl);
      const backend = mod.backend ?? mod.default;
      const context = {
        filesystem: { scratch: {}, workspace: { root: workerData.preparedRun.workspaceDir } },
        emit(event) {
          parentPort.postMessage({ type: "event", event });
        }
      };
      try {
        parentPort.postMessage({
          type: "result",
          result: await backend.run(workerData.preparedRun, context)
        });
      } catch (error) {
        parentPort.postMessage({
          type: "error",
          error: error instanceof Error ? error.stack || error.message : String(error)
        });
      }
    `),
  );
}

function createPreparedRun(overrides: Partial<PreparedAgentRun> = {}): PreparedAgentRun {
  return {
    runtimeId: "test",
    runId: "run-worker",
    agentId: "main",
    sessionId: "session-worker",
    sessionKey: "agent:main:main",
    sessionFile: "sqlite-transcript://main/session-worker.jsonl",
    workspaceDir: "/tmp/workspace",
    prompt: "hello",
    timeoutMs: 1000,
    filesystemMode: "vfs-scratch",
    deliveryPolicy: { emitToolResult: false, emitToolOutput: false },
    ...overrides,
  };
}

describe("agent runtime worker", () => {
  it("runs a structured prepared run in a worker and forwards events", async () => {
    const events: unknown[] = [];
    const result = await runPreparedAgentInWorker(createPreparedRun(), {
      workerEntryUrl: workerEntryDataUrl(),
      backendModuleUrl: backendDataUrl(`
        export const backend = {
          id: "test",
          async run(preparedRun, context) {
            await context.emit({
              runId: preparedRun.runId,
              stream: "lifecycle",
              data: { phase: "started", prompt: preparedRun.prompt },
              sessionKey: preparedRun.sessionKey
            });
            return { ok: true, text: "done:" + preparedRun.runId };
          }
        };
      `),
      onEvent: (event) => {
        events.push(event);
      },
    });

    expect(result).toEqual({ ok: true, text: "done:run-worker" });
    expect(events).toEqual([
      {
        runId: "run-worker",
        stream: "lifecycle",
        data: { phase: "started", prompt: "hello" },
        sessionKey: "agent:main:main",
      },
    ]);
  });

  it("waits for async event handlers before resolving the worker result", async () => {
    const order: string[] = [];
    const result = await runPreparedAgentInWorker(createPreparedRun(), {
      workerEntryUrl: workerEntryDataUrl(),
      backendModuleUrl: backendDataUrl(`
        export const backend = {
          id: "test",
          async run(preparedRun, context) {
            await context.emit({
              runId: preparedRun.runId,
              stream: "lifecycle",
              data: { phase: "before-result" }
            });
            return { ok: true, text: "done" };
          }
        };
      `),
      onEvent: async () => {
        await new Promise((resolve) => setTimeout(resolve, 25));
        order.push("event");
      },
    });

    order.push("result");
    expect(result).toEqual({ ok: true, text: "done" });
    expect(order).toEqual(["event", "result"]);
  });

  it("serializes async event handlers in worker message order", async () => {
    const order: string[] = [];
    const result = await runPreparedAgentInWorker(createPreparedRun(), {
      workerEntryUrl: workerEntryDataUrl(),
      backendModuleUrl: backendDataUrl(`
        export const backend = {
          id: "test",
          async run(preparedRun, context) {
            await context.emit({
              runId: preparedRun.runId,
              stream: "lifecycle",
              data: { seq: 1 }
            });
            await context.emit({
              runId: preparedRun.runId,
              stream: "lifecycle",
              data: { seq: 2 }
            });
            return { ok: true, text: "done" };
          }
        };
      `),
      onEvent: async (event) => {
        if (event.data.seq === 1) {
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
        order.push(String(event.data.seq));
      },
    });

    expect(result).toEqual({ ok: true, text: "done" });
    expect(order).toEqual(["1", "2"]);
  });

  it("surfaces backend failures", async () => {
    await expect(
      runPreparedAgentInWorker(createPreparedRun(), {
        workerEntryUrl: workerEntryDataUrl(),
        backendModuleUrl: backendDataUrl(`
          export const backend = {
            id: "test",
            async run() {
              throw new Error("boom");
            }
          };
        `),
      }),
    ).rejects.toThrow("boom");
  });

  it("surfaces parent event handler failures before resolving the worker result", async () => {
    await expect(
      runPreparedAgentInWorker(createPreparedRun(), {
        workerEntryUrl: workerEntryDataUrl(),
        backendModuleUrl: backendDataUrl(`
          export const backend = {
            id: "test",
            async run(preparedRun, context) {
              await context.emit({
                runId: preparedRun.runId,
                stream: "lifecycle",
                data: { phase: "before-result" }
              });
              return { ok: true, text: "done" };
            }
          };
        `),
        onEvent: async () => {
          throw new Error("parent event sink failed");
        },
      }),
    ).rejects.toThrow("parent event sink failed");
  });

  it("terminates workers that exceed the prepared run timeout", async () => {
    await expect(
      runPreparedAgentInWorker(createPreparedRun({ timeoutMs: 25 }), {
        workerEntryUrl: workerEntryDataUrl(),
        backendModuleUrl: backendDataUrl(`
          export const backend = {
            id: "test",
            async run() {
              await new Promise((resolve) => setTimeout(resolve, 250));
              return { ok: true, text: "late" };
            }
          };
        `),
      }),
    ).rejects.toThrow("Agent worker timed out after 25ms");
  });

  it("terminates workers when the parent abort signal fires", async () => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 25);

    await expect(
      runPreparedAgentInWorker(createPreparedRun({ timeoutMs: 1000 }), {
        workerEntryUrl: workerEntryDataUrl(),
        signal: controller.signal,
        backendModuleUrl: backendDataUrl(`
          export const backend = {
            id: "test",
            async run() {
              await new Promise((resolve) => setTimeout(resolve, 250));
              return { ok: true, text: "late" };
            }
          };
        `),
      }),
    ).rejects.toThrow("Agent worker aborted");
  });

  it("exposes a parent-to-worker control channel", async () => {
    const result = await runPreparedAgentInWorker(createPreparedRun(), {
      workerEntryUrl: workerEntryDataUrl(),
      backendModuleUrl: backendDataUrl(`
        import { parentPort } from "node:worker_threads";

        export const backend = {
          id: "test",
          async run() {
            const message = await new Promise((resolve) => {
              parentPort.once("message", resolve);
            });
            return { ok: true, text: message.message.text };
          }
        };
      `),
      onControlChannel: (channel) => {
        setTimeout(() => channel.send({ type: "queue_message", text: "steered" }), 0);
      },
    });

    expect(result).toEqual({ ok: true, text: "steered" });
  });
});
