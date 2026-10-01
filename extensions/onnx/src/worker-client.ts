import { spawn, type ChildProcess } from "node:child_process";
import { resolveRuntimeWorkerArgv } from "openclaw/plugin-sdk/process-runtime";
import type { WorkerConfig } from "./config.js";
import type { ClassificationInput, ClassificationResult } from "./models/types.js";
import {
  OnnxWorkerError,
  parseWorkerReply,
  parseWorkerRequest,
  type WorkerReply,
  type WorkerRequest,
} from "./protocol.js";

type Operation = Exclude<WorkerRequest, { kind: "init" }>;
type Task = {
  request: Operation;
  signal: AbortSignal;
  sent: boolean;
  abort: () => void;
  resolve: (reply: WorkerReply) => void;
  reject: (error: unknown) => void;
};
type Worker = {
  child: ChildProcess;
  ready: boolean;
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
  private nextId = 0;
  private closed = false;
  private stopping?: Promise<void>;

  constructor(options: { workerUrl: URL; config: WorkerConfig }) {
    this.workerUrl = new URL(options.workerUrl.href);
    this.config = { ...options.config };
  }

  async classify(
    model: string,
    inputs: ClassificationInput[],
    signal: AbortSignal,
  ): Promise<ClassificationResult[]> {
    const reply = await this.enqueue(
      {
        kind: "classify",
        id: ++this.nextId,
        model,
        inputs: inputs.map((input) => ({ ...input, labels: [...input.labels] })),
      },
      signal,
    );
    if (reply.kind !== "results") {
      throw new OnnxWorkerError("runtime");
    }
    return reply.results;
  }

  async warm(models: string[], signal: AbortSignal): Promise<void> {
    await this.enqueue({ kind: "warm", id: ++this.nextId, models: [...models] }, signal);
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

  private enqueue(request: Operation, signal: AbortSignal): Promise<WorkerReply> {
    signal.throwIfAborted();
    try {
      parseWorkerRequest(request);
    } catch {
      return Promise.reject(new OnnxWorkerError("unsupported-input"));
    }
    if (this.closed || this.queue.length + (this.active ? 1 : 0) >= 4) {
      return Promise.reject(new OnnxWorkerError("runtime"));
    }
    return new Promise((resolve, reject) => {
      const task: Task = {
        request,
        signal,
        sent: false,
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
        this.start();
      } catch {
        this.finish(undefined, new OnnxWorkerError("runtime"));
      }
      return;
    }
    if (this.worker.ready) {
      this.send(this.worker, task.request);
      task.sent = true;
    }
  }

  private start(): void {
    const child = spawn(process.execPath, resolveRuntimeWorkerArgv(this.workerUrl), {
      env: workerEnv(),
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "ignore", "ignore", "ipc"],
    });
    let resolveClosed!: () => void;
    const worker: Worker = {
      child,
      ready: false,
      retiring: false,
      closed: new Promise<void>((resolve) => {
        resolveClosed = resolve;
      }),
      resolveClosed: () => resolveClosed(),
    };
    this.worker = worker;
    child.on("message", (message: unknown) => this.receive(worker, message));
    child.on("error", () => {
      if (this.worker === worker) {
        this.retire(new OnnxWorkerError("runtime"));
      }
    });
    child.once("disconnect", () => {
      if (this.worker === worker) {
        this.retire(new OnnxWorkerError("runtime"));
      }
    });
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

  private receive(worker: Worker, message: unknown): void {
    if (this.worker !== worker || worker.retiring) {
      return;
    }
    let reply: WorkerReply;
    try {
      reply = parseWorkerReply(message);
    } catch {
      this.retire(new OnnxWorkerError("runtime"));
      return;
    }
    const task = this.active;
    if (reply.kind === "ready" && !worker.ready && task) {
      worker.ready = true;
      task.sent = true;
      this.send(worker, task.request);
      return;
    }
    if (!worker.ready || !task?.sent || reply.kind === "ready" || reply.id !== task.request.id) {
      this.retire(new OnnxWorkerError("runtime"));
      return;
    }
    if (reply.kind === "error") {
      this.finish(undefined, new OnnxWorkerError(reply.code));
      return;
    }
    const request = task.request;
    if (
      (reply.kind === "warmed" && request.kind === "warm") ||
      (reply.kind === "results" &&
        request.kind === "classify" &&
        reply.results.length === request.inputs.length &&
        reply.results.every(
          (result, index) =>
            result.logits.length === request.inputs[index]?.labels.length &&
            result.logits.every(Number.isFinite),
        ))
    ) {
      this.finish(reply);
    } else {
      this.retire(new OnnxWorkerError("runtime"));
    }
  }

  private finish(reply?: WorkerReply, failure?: unknown): void {
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
