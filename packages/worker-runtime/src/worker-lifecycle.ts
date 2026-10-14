import type { Transferable, Worker } from "node:worker_threads";
import type { RetainedOperation } from "./retained-operation.js";

export type NativeWorkerEvents = {
  started: [];
  message: [unknown];
  messageerror: [Error];
  error: [Error];
  exit: [number | undefined];
  "execution-exit": [number | undefined];
};

/** The native lifetime owner, rather than a submitting task, owns these events. */
export interface WorkerLifecycle {
  readonly threadId: number;
  postMessage(value: unknown, transferList?: readonly Transferable[]): void;
  ref(): unknown;
  unref(): unknown;
  terminate(): Promise<unknown>;
  on(event: "message", listener: (message: unknown) => void): unknown;
  on(event: "error" | "messageerror", listener: (error: Error) => void): unknown;
  once(event: "exit", listener: (code: number | undefined) => void): unknown;
  removeListener(event: "exit", listener: () => void): unknown;
  removeAllListeners(): unknown;
  cpuUsage: Worker["cpuUsage"];
  getHeapStatistics: Worker["getHeapStatistics"];
}

export type RetainedNativeWorker = WorkerLifecycle & {
  readonly started: boolean;
  readonly executionStopped: boolean;
  on(event: "started", listener: () => void): unknown;
  on(event: "execution-exit", listener: (code: number | undefined) => void): unknown;
  service(): void;
  stop(): RetainedOperation<void>;
};
