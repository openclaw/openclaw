import { writeFileSync } from "node:fs";
import type { Session } from "node:inspector/promises";
import { performance } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";
import type { Worker } from "node:worker_threads";
import { coerceErrorMessage as errorMessage } from "./error-format.mts";
import {
  GATEWAY_CPU_SAMPLE_INTERVAL_MICROS,
  GATEWAY_HEAP_SAMPLE_INTERVAL,
  type GatewayProfileCommand,
} from "./gateway-bench-profile.ts";

type WorkerTarget = {
  sessionId: string;
  inspectorWorkerId: string;
  title: string;
  threadId?: number;
};
type WorkerSample = {
  threadId: number;
  cpu?: NodeJS.CpuUsage;
  heap?: Awaited<ReturnType<Worker["getHeapStatistics"]>>;
  error?: string;
};
export type GatewayWorkerCpuSnapshot = {
  wallMs: number;
  mainThread: NodeJS.CpuUsage;
  workers: Array<{ threadId: number; cpu?: NodeJS.CpuUsage; error?: string }>;
};

type WorkerRecording = {
  target: WorkerTarget;
  threadId?: number;
  script?: string;
  unregisteredWhileLive?: boolean;
  profilePath: string;
  startedAt: number;
  samplingStartedAt?: number;
  samplingStoppedAt?: number;
  pending: Promise<void>;
  stopping?: Promise<void>;
  completed?: boolean;
  error?: string;
};
type Capture = {
  kind: GatewayProfileCommand["kind"];
  profilePath: string;
  heapOptions: Pick<GatewayProfileCommand, "samplingIntervalBytes" | "includeCollectedObjects">;
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

/** Uses the private inspector channel; no worker factory changes or debug listener. */
export class GatewayBenchWorkerProfiler {
  private workers = new Set<Worker>();
  private targets = new Map<string, WorkerTarget>();
  private activeRecordings = new Map<WorkerRecording, GatewayProfileCommand["kind"]>();
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
  private resolveScript?: (threadId: number) => string | null | undefined;

  constructor(inspector: Session, resolveScript?: (threadId: number) => string | null | undefined) {
    this.inspector = inspector;
    this.resolveScript = resolveScript;
    process.on("worker", (worker) => {
      this.workers.add(worker);
      let owner: object | null = worker;
      while (owner && !Object.hasOwn(owner, "terminate")) {
        owner = Reflect.getPrototypeOf(owner);
      }
      const descriptor = owner && Object.getOwnPropertyDescriptor(owner, "terminate");
      // Never invoke foreign accessors; unpatchable workers' retirements stay incomplete.
      if (descriptor?.writable && typeof descriptor.value === "function") {
        const terminate = worker.terminate.bind(worker);
        Reflect.set(worker, "terminate", async () => {
          const recordings = [...this.activeRecordings].filter(
            ([recording]) => recording.threadId === worker.threadId,
          );
          if (recordings.length > 0) {
            // Export before intentional retirement; an unresponsive worker must still terminate.
            await Promise.race([
              Promise.all(recordings.map(([recording, kind]) => this.finish(kind, recording))),
              delay(5_000, undefined, { ref: false }),
            ]);
          }
          return await terminate();
        });
      }
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
          title: params.workerInfo.title,
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

  async sampleCpu(): Promise<GatewayWorkerCpuSnapshot> {
    const start = performance.now();
    const mainThread = process.threadCpuUsage();
    const workers = await Promise.all(
      [...this.workers].map(async (worker) => {
        const threadId = worker.threadId;
        try {
          return { threadId, cpu: await worker.cpuUsage() };
        } catch (error) {
          return { threadId, error: errorMessage(error) };
        }
      }),
    );
    return {
      wallMs: performance.now() - start,
      mainThread: process.threadCpuUsage(mainThread),
      workers,
    };
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

  async start(
    kind: GatewayProfileCommand["kind"],
    profilePath: string,
    heapOptions: Capture["heapOptions"] = {},
  ): Promise<void> {
    if (this.captures.has(kind)) {
      throw new Error(`Worker ${kind} profiling already started`);
    }
    // Native Worker.startHeapProfile can crash Node on termination; use inspector targets.
    this.enabled ??= this.inspector.post("NodeWorker.enable", { waitForDebuggerOnStart: false });
    await this.enabled;
    const capture: Capture = { kind, profilePath, heapOptions, recordings: [], samples: [] };
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
    this.activeRecordings.set(recording, capture.kind);
    recording.pending = (async () => {
      try {
        if (recording.threadId === undefined) {
          throw new Error("Worker native thread identity is unavailable");
        }
        this.identify(recording);
        if (capture.kind === "cpu") {
          await this.post(target, "Profiler.enable");
          await this.post(target, "Profiler.setSamplingInterval", {
            interval: GATEWAY_CPU_SAMPLE_INTERVAL_MICROS,
          });
          await this.post(target, "Profiler.start");
        } else {
          await this.post(target, "HeapProfiler.startSampling", {
            samplingInterval:
              capture.heapOptions.samplingIntervalBytes ?? GATEWAY_HEAP_SAMPLE_INTERVAL,
            includeObjectsCollectedByMajorGC: capture.heapOptions.includeCollectedObjects ?? true,
            includeObjectsCollectedByMinorGC: capture.heapOptions.includeCollectedObjects ?? true,
          });
        }
        recording.samplingStartedAt = performance.now();
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

  private identify(recording: WorkerRecording): void {
    if (recording.threadId === undefined) {
      return;
    }
    const script = this.resolveScript?.(recording.threadId);
    if (typeof script === "string") {
      recording.script = script;
    } else if (
      script === null &&
      [...this.workers].some((worker) => worker.threadId === recording.threadId)
    ) {
      // Core workers register synchronously and remain registered until native exit.
      recording.unregisteredWhileLive = true;
    }
  }

  private finish(kind: GatewayProfileCommand["kind"], recording: WorkerRecording): Promise<void> {
    return (recording.stopping ??= (async () => {
      await recording.pending;
      if (recording.error) {
        return;
      }
      try {
        this.identify(recording);
        const result = await this.post(
          recording.target,
          kind === "cpu" ? "Profiler.stop" : "HeapProfiler.stopSampling",
        );
        recording.samplingStoppedAt = performance.now();
        if (!result?.profile) {
          throw new Error("Worker profiler returned no profile");
        }
        writeFileSync(recording.profilePath, JSON.stringify(result.profile), { mode: 0o600 });
        recording.completed = true;
      } catch (error) {
        recording.error = errorMessage(error);
      }
    })().finally(() => this.activeRecordings.delete(recording)));
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
    await Promise.all(capture.recordings.map((recording) => this.finish(kind, recording)));
    writeFileSync(
      `${capture.profilePath}.workers.json`,
      JSON.stringify({
        kind,
        ...(kind === "heap"
          ? {
              samplingIntervalBytes:
                capture.heapOptions.samplingIntervalBytes ?? GATEWAY_HEAP_SAMPLE_INTERVAL,
              includeCollectedObjects: capture.heapOptions.includeCollectedObjects ?? true,
            }
          : {}),
        sampleIntervalMs: 100,
        sampleClock: "performance.now",
        cpuCounters: "cumulative-microseconds",
        workers: capture.recordings.map(
          ({ pending: _pending, stopping: _stopping, target, ...row }) => ({
            inspectorWorkerId: target.inspectorWorkerId,
            title: target.title,
            ...row,
          }),
        ),
        samples: capture.samples,
      }),
      { mode: 0o600 },
    );
  }
}
