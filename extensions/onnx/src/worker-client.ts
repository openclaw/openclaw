import type { ChildProcess } from "node:child_process";
import { createDeferred } from "openclaw/plugin-sdk/concurrency-runtime";
import {
  resolveRuntimeWorkerArgv,
  spawnOomScoreAdjusted as spawn,
} from "openclaw/plugin-sdk/process-runtime";
import { Guard } from "typebox/guard";
import type { WorkerConfig } from "./config.js";
import type { ClassificationInput, ClassificationResult } from "./models/types.js";
import { OnnxWorkerError, type WorkerReply, type WorkerRequest } from "./protocol.js";

type Operation = Exclude<WorkerRequest, { kind: "init" }>;
type OperationReply = Exclude<WorkerReply, { kind: "error" }>;
type Task = {
  request: Operation;
  signal: AbortSignal;
  abort: () => void;
  resolve: (reply: OperationReply) => void;
  reject: (error: unknown) => void;
};
type Worker = {
  child: ChildProcess;
  retiring: boolean;
  failure?: unknown;
  closed: Promise<void>;
  resolveClosed: () => void;
};

function workerEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of ["SystemRoot", "SYSTEMROOT", "WINDIR", "TEMP", "TMP", "TMPDIR"]) {
    if (process.env[key]) {
      env[key] = process.env[key];
    }
  }
  return env;
}

/** One warm, OS-killable inference process; native work retains its slot until close. */
export class InferenceWorkerClient {
  private readonly workerUrl: URL;
  private readonly config: WorkerConfig;
  private readonly queue: Task[] = [];
  private active?: Task;
  private worker?: Worker;
  private closed = false;
  private stopping?: Promise<void>;

  constructor(options: { workerUrl: URL; config: WorkerConfig }) {
    this.workerUrl = options.workerUrl;
    this.config = options.config;
  }

  async classify(
    model: string,
    inputs: ClassificationInput[],
    signal: AbortSignal,
  ): Promise<ClassificationResult[]> {
    signal.throwIfAborted();
    if (
      !model.length ||
      !Guard.IsMaxLength(model, 128) ||
      inputs.length < 1 ||
      inputs.length > 32
    ) {
      throw new OnnxWorkerError("unsupported-input");
    }
    let bytes = 0;
    for (const input of inputs) {
      bytes += Buffer.byteLength(JSON.stringify(input));
      if (
        !Guard.IsMaxLength(input.text, 262144) ||
        input.labels.length < 2 ||
        input.labels.length > 64 ||
        input.labels.some((label) => !label.length || !Guard.IsMaxLength(label, 16384)) ||
        !input.task.length ||
        !Guard.IsMaxLength(input.task, 1024) ||
        !Guard.IsMaxLength(input.instructions ?? "", 16384) ||
        Object.values(input.descriptions ?? {}).some((value) => !Guard.IsMaxLength(value, 16384)) ||
        bytes > 1024 * 1024
      ) {
        throw new OnnxWorkerError("unsupported-input");
      }
    }
    const reply = await this.enqueue(
      {
        kind: "classify",
        model,
        inputs,
      },
      signal,
    );
    return reply.results;
  }

  async warm(models: string[], signal: AbortSignal): Promise<void> {
    await this.enqueue({ kind: "warm", models }, signal);
  }

  stop(): Promise<void> {
    if (this.stopping) {
      return this.stopping;
    }
    this.closed = true;
    for (const task of this.queue.splice(0)) {
      task.signal.removeEventListener("abort", task.abort);
      task.reject(new OnnxWorkerError("runtime"));
    }
    const worker = this.worker;
    this.retire(new OnnxWorkerError("runtime"));
    this.stopping = worker?.closed ?? Promise.resolve();
    return this.stopping;
  }

  private enqueue(
    request: Extract<Operation, { kind: "classify" }>,
    signal: AbortSignal,
  ): Promise<Extract<OperationReply, { kind: "results" }>>;
  private enqueue(
    request: Extract<Operation, { kind: "warm" }>,
    signal: AbortSignal,
  ): Promise<Extract<OperationReply, { kind: "warmed" }>>;
  private enqueue(request: Operation, signal: AbortSignal): Promise<OperationReply> {
    signal.throwIfAborted();
    if (this.closed || this.queue.length + (this.active ? 1 : 0) >= 4) {
      return Promise.reject(new OnnxWorkerError("runtime"));
    }
    return new Promise((resolve, reject) => {
      const task: Task = {
        request,
        signal,
        resolve,
        reject,
        abort: () => this.cancel(task),
      };
      this.queue.push(task);
      signal.addEventListener("abort", task.abort, { once: true });
      if (signal.aborted) {
        this.cancel(task);
      } else {
        this.dispatch();
      }
    });
  }

  private cancel(task: Task): void {
    if (this.active === task) {
      this.retire(task.signal.reason);
      return;
    }
    const index = this.queue.indexOf(task);
    if (index !== -1) {
      this.queue.splice(index, 1);
      task.signal.removeEventListener("abort", task.abort);
      task.reject(task.signal.reason);
    }
  }

  private dispatch(): void {
    if (this.closed || this.active || this.worker?.retiring) {
      return;
    }
    const task = this.queue.shift();
    if (!task) {
      return;
    }
    this.active = task;
    if (!this.worker) {
      try {
        this.start(task.request);
      } catch {
        this.finish(undefined, new OnnxWorkerError("runtime"));
      }
      return;
    }
    this.send(this.worker, task.request);
  }

  private start(request: Operation): void {
    const child = spawn(process.execPath, resolveRuntimeWorkerArgv(this.workerUrl), {
      env: workerEnv(),
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "ignore", "ignore", "ipc"],
    });
    const { promise: closed, resolve: resolveClosed } = createDeferred();
    const worker: Worker = {
      child,
      retiring: false,
      closed,
      resolveClosed,
    };
    this.worker = worker;
    child.on("message", (reply: WorkerReply) => this.receive(worker, reply));
    const onFailure = () => {
      if (this.worker === worker) {
        this.retire(new OnnxWorkerError("runtime"));
      }
    };
    child.on("error", onFailure);
    child.once("disconnect", onFailure);
    child.once("close", () => {
      if (this.worker === worker) {
        this.worker = undefined;
        const task = this.active;
        if (task) {
          this.finish(
            undefined,
            task.signal.aborted
              ? task.signal.reason
              : (worker.failure ?? new OnnxWorkerError("runtime")),
          );
        } else {
          this.dispatch();
        }
      }
      worker.resolveClosed();
    });
    this.send(worker, { kind: "init", config: this.config });
    this.send(worker, request);
  }

  private send(worker: Worker, request: WorkerRequest): void {
    try {
      worker.child.send(request, (error) => {
        if (error && this.worker === worker) {
          this.retire(new OnnxWorkerError("runtime"));
        }
      });
    } catch {
      if (this.worker === worker) {
        this.retire(new OnnxWorkerError("runtime"));
      }
    }
  }

  private receive(worker: Worker, reply: WorkerReply): void {
    if (this.worker !== worker || worker.retiring) {
      return;
    }
    if (reply.kind === "error") {
      this.finish(undefined, new OnnxWorkerError(reply.code));
      return;
    }
    this.finish(reply);
  }

  private finish(reply?: OperationReply, failure?: unknown): void {
    const task = this.active;
    if (!task) {
      return;
    }
    this.active = undefined;
    task.signal.removeEventListener("abort", task.abort);
    if (reply) {
      task.resolve(reply);
    } else {
      task.reject(failure);
    }
    this.dispatch();
  }

  private retire(failure: unknown): void {
    const worker = this.worker;
    if (!worker || worker.retiring) {
      return;
    }
    worker.retiring = true;
    worker.failure = failure;
    // The worker owns no descendants. Native inference cannot service a graceful stop.
    worker.child.kill("SIGKILL");
  }
}
