/// <reference lib="es2024.promise" />
import { parentPort, type MessagePort, type Transferable } from "node:worker_threads";
import {
  createWorkerTaskControl,
  observeWorkerTaskCancellation,
  withWorkerTaskNativeSectionScope,
  type WorkerTaskControl,
} from "./worker-task-native-sections.js";

type WorkerChannelResponse = { input: unknown; consumed: () => void };
type WorkerConversation = {
  taskId: number;
  responseId: number;
  pending?: PromiseWithResolvers<WorkerChannelResponse>;
  assertCurrent: () => void;
  cancelPending: (error: unknown) => void;
};

/** A conversation never outlives the pool task or crosses worker generations. */
export type WorkerTaskChannel = {
  consumeInput: () => void;
  /** One-way observations do not acknowledge input or participate in request/reply ownership. */
  notify: (value: unknown) => void;
  request: (
    value: unknown,
    transferList?: readonly Transferable[],
  ) => Promise<WorkerChannelResponse>;
};

export type WorkerTaskServerHost<TaskContext> = {
  selectStartupPort?: (message: unknown) => MessagePort | undefined;
  initialize: (port: MessagePort) => void;
  onReady?: () => void;
  onMessage: (sampleMemory: boolean) => void;
  installTaskContext: (context: TaskContext) => void;
  onIdle: () => void;
};

/** Pool dispatch is serial per worker; resource closures and handlers settle before successors. */
export function serveOwnedWorkerTasks<Output, TaskContext>(
  handler: (
    input: unknown,
    channel: WorkerTaskChannel | undefined,
    control: WorkerTaskControl,
  ) => Output | Promise<Output>,
  options: {
    transferList?: (value: Output) => Transferable[];
    closeResource?: (key?: string) => void | Promise<void>;
    encodeResourceError?: (error: unknown) => unknown;
  },
  host: WorkerTaskServerHost<TaskContext>,
): void {
  if (!parentPort) {
    return;
  }
  let port = parentPort;
  let receivedStartup = false;
  host.initialize(port);
  let active: WorkerConversation | undefined;
  let execution = Promise.resolve();
  let resourceClosures = Promise.resolve();
  let cancelledResponse: { taskId: number; responseId: number } | undefined;
  port.on(
    "message",
    function receive(message: {
      input: unknown;
      taskId: number;
      interactive?: boolean;
      responseId?: number;
      nativeSections: SharedArrayBuffer;
      taskContext: TaskContext;
      closeResource?: true;
      key?: string;
      resourcePort?: MessagePort;
      sampleMemory?: boolean;
    }) {
      if (!receivedStartup) {
        receivedStartup = true;
        const taskPort = host.selectStartupPort?.(message);
        if (taskPort) {
          port.off("message", receive);
          port = taskPort;
          host.initialize(port);
          port.on("message", receive);
          host.onReady?.();
          return;
        }
      }
      host.onMessage(message.sampleMemory === true);
      if (message.closeResource && message.resourcePort) {
        const receipt = message.resourcePort;
        const precedingExecution = execution;
        resourceClosures = resourceClosures
          .then(() => precedingExecution)
          .then(async () => {
            if (!options.closeResource) {
              throw new Error("Worker does not own retained resources");
            }
            await options.closeResource(message.key);
            receipt.postMessage({ ok: true }, []);
          })
          .catch((error: unknown) => {
            receipt.postMessage(
              {
                ok: false,
                error: error instanceof Error ? error.message : String(error),
                detail: options.encodeResourceError?.(error),
              },
              [],
            );
          })
          .finally(() => {
            receipt.close();
            if (!active) {
              host.onIdle();
            }
          });
        return;
      }
      if (message.responseId !== undefined) {
        if (
          message.taskId === cancelledResponse?.taskId &&
          message.responseId === cancelledResponse.responseId
        ) {
          return;
        }
        if (
          !active ||
          message.taskId !== active.taskId ||
          message.responseId !== active.responseId ||
          !active.pending
        ) {
          throw new Error("stale worker task response");
        }
        try {
          active.assertCurrent();
        } catch (error) {
          active.cancelPending(error);
          return;
        }
        const pending = active.pending;
        active.pending = undefined;
        let consumed = false;
        const taskId = message.taskId;
        const id = message.responseId;
        pending.resolve({
          input: message.input,
          consumed: () => {
            if (consumed) {
              return;
            }
            consumed = true;
            port.postMessage({ status: "consumed", taskId, id });
          },
        });
        return;
      }
      if (active) {
        throw new Error("overlapping worker tasks");
      }
      const nativeSections = new Int32Array(message.nativeSections);
      const task: WorkerConversation = {
        taskId: message.taskId,
        responseId: 0,
        assertCurrent: () => control.throwIfCancelled(),
        cancelPending: (error) => {
          const pending = task.pending;
          if (!pending) {
            return;
          }
          task.pending = undefined;
          cancelledResponse = { taskId: task.taskId, responseId: task.responseId };
          pending.reject(error);
        },
      };
      const control = createWorkerTaskControl(nativeSections, () => active === task);
      active = task;
      const stopObserving = message.interactive
        ? observeWorkerTaskCancellation(
            nativeSections,
            () => active === task,
            () => task.cancelPending(new Error("worker task cancelled")),
          )
        : undefined;
      const channel: WorkerTaskChannel | undefined = message.interactive
        ? {
            notify: (value) => {
              control.throwIfCancelled();
              port.postMessage({ status: "notification", taskId: task.taskId, value });
            },
            consumeInput: () =>
              port.postMessage({ status: "consumed", taskId: task.taskId, id: 0 }),
            request: (value, transferList) => {
              control.throwIfCancelled();
              if (active !== task || task.pending) {
                throw new Error("closed or busy worker channel");
              }
              const pending = Promise.withResolvers<WorkerChannelResponse>();
              task.pending = pending;
              try {
                const transfers = transferList ? [...transferList] : [];
                control.throwIfCancelled();
                port.postMessage(
                  {
                    status: "request",
                    taskId: task.taskId,
                    id: ++task.responseId,
                    value,
                  },
                  transfers,
                );
              } catch (error) {
                task.pending = undefined;
                pending.reject(error);
              }
              return pending.promise;
            },
          }
        : undefined;
      const precedingClosures = resourceClosures;
      execution = Promise.resolve()
        .then(async () => {
          try {
            await precedingClosures;
            control.throwIfCancelled();
            host.installTaskContext(message.taskContext);
            return await withWorkerTaskNativeSectionScope(
              nativeSections,
              () => active === task,
              () => handler(message.input, channel, control),
            );
          } finally {
            await stopObserving?.();
            active = undefined;
          }
        })
        .then((value) => {
          port.postMessage(
            { status: "ok", value, taskId: task.taskId },
            options.transferList?.(value) ?? [],
          );
        })
        .catch((error: unknown) => {
          port.postMessage({
            status: "failed",
            taskId: task.taskId,
            error: error instanceof Error ? error.message : String(error),
          });
        })
        .finally(() => host.onIdle());
    },
  );
  host.onReady?.();
}
