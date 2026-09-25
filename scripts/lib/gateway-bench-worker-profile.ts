import { writeFileSync } from "node:fs";
import type { Session } from "node:inspector/promises";
import { performance } from "node:perf_hooks";
import type { Worker } from "node:worker_threads";
import {
  GATEWAY_CPU_SAMPLE_INTERVAL_MICROS,
  GATEWAY_HEAP_SAMPLE_INTERVAL,
  type GatewayProfileCommand,
} from "./gateway-bench-profile.ts";

type WorkerTarget = { sessionId: string; inspectorWorkerId: string; threadId?: number };
type WorkerSample = {
  threadId: number;
  cpu?: NodeJS.CpuUsage;
  heap?: Awaited<ReturnType<Worker["getHeapStatistics"]>>;
  error?: string;
};
type WorkerRecording = {
  target: WorkerTarget;
  threadId?: number;
  profilePath: string;
  startedAt: number;
  pending: Promise<void>;
  completed?: boolean;
  error?: string;
};
type Capture = {
  kind: GatewayProfileCommand["kind"];
  profilePath: string;
  recordings: WorkerRecording[];
  samples: Array<{
    at: number;
    memory: NodeJS.MemoryUsage;
    processCpu: NodeJS.CpuUsage;
    mainThreadCpu: NodeJS.CpuUsage;
    workers: WorkerSample[];
  }>;
  polling?: Promise<void>;
  timer?: NodeJS.Timeout;
};
type WorkerReply = {
  id?: number;
  result?: { profile?: unknown };
  error?: { message: string };
};

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Uses the private inspector channel; no worker factory changes or debug listener. */
export class GatewayBenchWorkerProfiler {
  private workers = new Set<Worker>();
  private targets = new Map<string, WorkerTarget>();
  private captures = new Map<GatewayProfileCommand["kind"], Capture>();
  private requests = new Map<
    number,
    {
      sessionId: string;
      resolve: (value: WorkerReply["result"]) => void;
      reject: (error: Error) => void;
    }
  >();
  private sequence = 0;
  private enabled?: Promise<unknown>;
  private inspector: Session;

  constructor(inspector: Session) {
    this.inspector = inspector;
    process.on("worker", (worker) => {
      this.workers.add(worker);
      worker.once("exit", () => this.workers.delete(worker));
    });
    inspector.on(
      "NodeWorker.attachedToWorker",
      ({
        params,
      }: {
        params: { sessionId: string; workerInfo: { workerId: string; title: string } };
      }) => {
        // Node's WorkerStartedRequest prefixes the native ID before any user-supplied name.
        // Its inspector target ID has a separate allocation order.
        const nativeId = /^\[worker ([1-9]\d*)\](?: |$)/.exec(params.workerInfo.title)?.[1];
        const threadId = nativeId === undefined ? undefined : Number(nativeId);
        const target = {
          sessionId: params.sessionId,
          inspectorWorkerId: params.workerInfo.workerId,
          threadId: Number.isSafeInteger(threadId) ? threadId : undefined,
        };
        this.targets.set(target.sessionId, target);
        for (const capture of this.captures.values()) {
          this.record(target, capture);
        }
      },
    );
    inspector.on(
      "NodeWorker.detachedFromWorker",
      ({ params }: { params: { sessionId: string } }) => {
        this.targets.delete(params.sessionId);
        for (const [id, request] of this.requests) {
          if (request.sessionId === params.sessionId) {
            this.requests.delete(id);
            request.reject(new Error("Worker retired during profile capture"));
          }
        }
      },
    );
    inspector.on(
      "NodeWorker.receivedMessageFromWorker",
      ({ params }: { params: { sessionId: string; message: string } }) => {
        const message: WorkerReply = JSON.parse(params.message);
        if (message.id === undefined) {
          return;
        }
        const request = this.requests.get(message.id);
        if (!request || request.sessionId !== params.sessionId) {
          return;
        }
        this.requests.delete(message.id);
        if (message.error) {
          request.reject(new Error(message.error.message));
        } else {
          request.resolve(message.result);
        }
      },
    );
  }

  private async post(target: WorkerTarget, method: string, params: object = {}) {
    if (!this.targets.has(target.sessionId)) {
      throw new Error("Worker retired before profile stop");
    }
    const id = ++this.sequence;
    return await new Promise<WorkerReply["result"]>((resolve, reject) => {
      this.requests.set(id, { sessionId: target.sessionId, resolve, reject });
      void this.inspector
        .post("NodeWorker.sendMessageToWorker", {
          sessionId: target.sessionId,
          message: JSON.stringify({ id, method, params }),
        })
        .catch((error: unknown) => {
          this.requests.delete(id);
          reject(new Error(errorMessage(error)));
        });
    });
  }

  async start(kind: GatewayProfileCommand["kind"], profilePath: string): Promise<void> {
    if (this.captures.has(kind)) {
      throw new Error(`Worker ${kind} profiling already started`);
    }
    // Native Worker.startHeapProfile can crash Node on termination. Inspector targets
    // instead detach cleanly, letting us record incomplete capture without changing retirement.
    this.enabled ??= this.inspector.post("NodeWorker.enable", { waitForDebuggerOnStart: false });
    await this.enabled;
    const capture: Capture = { kind, profilePath, recordings: [], samples: [] };
    this.captures.set(kind, capture);
    for (const target of this.targets.values()) {
      this.record(target, capture);
    }
    await Promise.all(capture.recordings.map((recording) => recording.pending));
    await this.sample(capture);
    capture.timer = setInterval(() => void this.sample(capture), 100);
    capture.timer.unref();
  }

  private record(target: WorkerTarget, capture: Capture): void {
    const recording: WorkerRecording = {
      target,
      threadId: target.threadId,
      profilePath: `${capture.profilePath}.worker-target-${target.inspectorWorkerId}.${capture.kind === "cpu" ? "cpuprofile" : "heapprofile"}`,
      startedAt: performance.now(),
      pending: Promise.resolve(),
    };
    capture.recordings.push(recording);
    recording.pending = (async () => {
      try {
        if (recording.threadId === undefined) {
          throw new Error("Worker native thread identity is unavailable");
        }
        if (capture.kind === "cpu") {
          await this.post(target, "Profiler.enable");
          await this.post(target, "Profiler.setSamplingInterval", {
            interval: GATEWAY_CPU_SAMPLE_INTERVAL_MICROS,
          });
          await this.post(target, "Profiler.start");
        } else {
          await this.post(target, "HeapProfiler.startSampling", {
            samplingInterval: GATEWAY_HEAP_SAMPLE_INTERVAL,
            includeObjectsCollectedByMajorGC: true,
            includeObjectsCollectedByMinorGC: true,
          });
        }
      } catch (error) {
        recording.error = errorMessage(error);
      }
    })();
  }

  private sample(capture: Capture): Promise<void> {
    return (capture.polling ??= (async () => {
      const at = performance.now();
      const memory = process.memoryUsage();
      const processCpu = process.cpuUsage();
      const mainThreadCpu = process.threadCpuUsage();
      const workers = await Promise.all(
        [...this.workers].map(async (worker): Promise<WorkerSample> => {
          const threadId = worker.threadId;
          try {
            const [cpu, heap] = await Promise.all([worker.cpuUsage(), worker.getHeapStatistics()]);
            return { threadId, cpu, heap };
          } catch (error) {
            return { threadId, error: errorMessage(error) };
          }
        }),
      );
      capture.samples.push({ at, memory, processCpu, mainThreadCpu, workers });
    })().finally(() => {
      capture.polling = undefined;
    }));
  }

  async stop(kind: GatewayProfileCommand["kind"]): Promise<void> {
    const capture = this.captures.get(kind);
    if (!capture) {
      return;
    }
    // Close admission before awaiting stop: new workers belong to the next window.
    this.captures.delete(kind);
    clearInterval(capture.timer);
    await capture.polling;
    await this.sample(capture);
    await Promise.all(
      capture.recordings.map(async (recording) => {
        await recording.pending;
        if (recording.error) {
          return;
        }
        try {
          const result = await this.post(
            recording.target,
            kind === "cpu" ? "Profiler.stop" : "HeapProfiler.stopSampling",
          );
          if (!result?.profile) {
            throw new Error("Worker profiler returned no profile");
          }
          writeFileSync(recording.profilePath, JSON.stringify(result?.profile), { mode: 0o600 });
          recording.completed = true;
        } catch (error) {
          recording.error = errorMessage(error);
        }
      }),
    );
    writeFileSync(
      `${capture.profilePath}.workers.json`,
      JSON.stringify({
        kind,
        sampleIntervalMs: 100,
        sampleClock: "performance.now",
        cpuCounters: "cumulative-microseconds",
        workers: capture.recordings.map(({ pending: _pending, target, ...row }) => ({
          inspectorWorkerId: target.inspectorWorkerId,
          ...row,
        })),
        samples: capture.samples,
      }),
      { mode: 0o600 },
    );
  }
}
