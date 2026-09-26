import { randomUUID } from "node:crypto";
import { embeddedAgentLog, formatErrorMessage } from "openclaw/plugin-sdk/agent-harness-runtime";
import { createAgentHarnessCommandTask } from "openclaw/plugin-sdk/agent-harness-task-runtime";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { protectCodexAppServerLiveThread } from "./client-runtime.js";
import { isCodexNotificationForTurn } from "./notification-correlation.js";
import { isJsonObject, type CodexAppServerRequestResult } from "./protocol.js";
import type { CodexAttemptResources } from "./run-attempt-resources.js";
import { retainSharedCodexAppServerClientIfCurrent } from "./shared-client.js";
import { isSameCodexAppServerThreadOwner } from "./thread-ownership.js";
import { waitForPromiseOrAbort } from "./timeout.js";

type CommandTask = Awaited<ReturnType<typeof createAgentHarnessCommandTask>>;
type Terminal = Parameters<CommandTask["finish"]>[0];
type Inventory = CodexAppServerRequestResult<"thread/backgroundTerminals/list">["data"];
type Entry = {
  processId?: string;
  task?: CommandTask;
  terminal?: Terminal;
  settlement?: Promise<void>;
  cancellationAttempt?: Promise<void>;
  done: ReturnType<typeof createDeferred<void>>;
  cancellation: "idle" | "pending" | "confirmed";
  nativeCompletion?: { exitCode: number | undefined };
};

/** Task projection retains native custody; it never becomes a second process registry. */
export function prepareCodexNativeCommandTasks(
  resources: CodexAttemptResources,
  turnId: string,
  pending: ReadonlyMap<string, string | null>,
) {
  const { connection } = resources.prompt.context.runtime;
  const { params, bindingStore, bindingIdentity, appServer } = connection;
  const scope = params.agentHarnessTaskRuntimeScope;
  if (!scope) {
    return undefined;
  }
  const source = params.hostCapabilities.retainSourceAuthority?.();
  if (!source) {
    return undefined;
  }
  const { client, thread } = resources.state;
  const custody = resources.nativeProcessAuthority;
  const agentId = params.agentId;
  const requestTimeoutMs = appServer.requestTimeoutMs;
  const entries = new Map<string, Entry>(
    [...pending.keys()].map((itemId) => [
      itemId,
      {
        done: createDeferred<void>(),
        cancellation: "idle",
      },
    ]),
  );
  let admitting = true;
  let closed = false;
  let released = false;
  const releaseClient = retainSharedCodexAppServerClientIfCurrent(client);
  const releaseThread = protectCodexAppServerLiveThread(client, thread.threadId);
  const assertCurrent = () => {
    source.assertCurrent();
    if (
      closed ||
      released ||
      !isSameCodexAppServerThreadOwner(bindingStore.read(bindingIdentity), thread)
    ) {
      throw new Error("Native command no longer belongs to this source");
    }
  };
  const releaseIfFinished = () => {
    if (released || admitting || entries.size > 0) {
      return;
    }
    released = true;
    unwatch();
    unwatchClose();
    source.signal?.removeEventListener("abort", sourceEnded);
    releaseThread();
    releaseClient?.();
    source.release();
  };
  const settle = async (itemId: string) => {
    const entry = entries.get(itemId);
    if (!entry?.task || !entry.terminal || entry.cancellation === "pending") {
      return;
    }
    const terminal =
      entry.nativeCompletion &&
      entry.cancellation === "confirmed" &&
      entry.terminal.status === "failed" &&
      // Codex uses -1 when no exit result is available; Stop can acknowledge an already-exited process.
      (entry.nativeCompletion.exitCode === undefined || entry.nativeCompletion.exitCode === -1)
        ? {
            ...entry.terminal,
            status: "cancelled" as const,
            error: "Stop confirmed; native exit result unavailable.",
            terminalSummary: "Command stopped",
          }
        : entry.terminal;
    await (entry.settlement ??= entry.task
      .finish(terminal)
      .then(() => {
        entries.delete(itemId);
        entry.done.resolve();
        releaseIfFinished();
      })
      .catch((error: unknown) => {
        // Leave unconfirmed durable outcomes to canonical task recovery, not a live run claim.
        entry.task?.release();
        entries.delete(itemId);
        entry.done.resolve();
        releaseIfFinished();
        throw error;
      }));
  };
  const ownerEnded = async () => {
    closed = true;
    await Promise.all(
      [...entries].map(async ([itemId, entry]) => {
        entry.terminal ??= {
          status: "failed",
          endedAt: Date.now(),
          error: "Native command owner closed before its outcome was collected.",
          terminalSummary: "Command outcome unknown",
        };
        await settle(itemId);
      }),
    );
  };
  const report = (error: unknown) =>
    embeddedAgentLog.warn("Native command task settlement failed", {
      error: formatErrorMessage(error),
    });
  const sourceEnded = () => {
    void ownerEnded().catch(report);
  };
  const unwatchClose = client.addCloseHandler(sourceEnded);
  const unwatch = client.addNotificationHandler(async (notification) => {
    if (
      notification.method !== "item/completed" ||
      !isCodexNotificationForTurn(notification.params, thread.threadId, turnId) ||
      !isJsonObject(notification.params)
    ) {
      return;
    }
    const item = notification.params.item;
    if (!isJsonObject(item) || item.type !== "commandExecution" || typeof item.id !== "string") {
      return;
    }
    const entry = entries.get(item.id);
    if (
      !entry ||
      entry.nativeCompletion ||
      entry.settlement ||
      (entry.processId && typeof item.processId === "string" && item.processId !== entry.processId)
    ) {
      return;
    }
    const exitCode = typeof item.exitCode === "number" ? item.exitCode : undefined;
    const succeeded = item.status === "completed" && exitCode === 0;
    entry.nativeCompletion = { exitCode };
    // A collected native result supersedes an owner-close placeholder until settlement starts.
    entry.terminal = {
      status: succeeded ? "succeeded" : "failed",
      endedAt: Date.now(),
      terminalSummary: succeeded ? "Command completed" : "Command failed",
      ...(succeeded ? { clearError: true } : { error: "Native command failed." }),
      ...(exitCode !== undefined ? { detail: { exitCode } } : {}),
    };
    await settle(item.id);
  });
  source.signal?.addEventListener("abort", sourceEnded, { once: true });
  return {
    async retain(inventory: Inventory, retained: ReadonlyMap<string, string>) {
      try {
        for (const [itemId, entry] of entries) {
          const processId = retained.get(itemId);
          const command = inventory.find(
            (item) => item.itemId === itemId && item.processId === processId,
          );
          if (!command || entry.terminal) {
            entries.delete(itemId);
            continue;
          }
          assertCurrent();
          entry.processId = command.processId;
          entry.task = await createAgentHarnessCommandTask({
            scope,
            runId: `codex-command:${randomUUID()}`,
            taskKind: "codex-command",
            command: command.command,
            agentId,
            startedAt: Date.now(),
            assertCurrent,
            cancel: async (_reason, assertTaskCurrent) => {
              assertCurrent();
              assertTaskCurrent();
              return (entry.cancellationAttempt ??= (async () => {
                const options = {
                  timeoutMs: requestTimeoutMs,
                  signal: AbortSignal.timeout(requestTimeoutMs),
                };
                if (!entry.terminal) {
                  if (
                    custody?.ownsCurrentCommand(client, {
                      threadId: thread.threadId,
                      turnId,
                      itemId,
                    })
                  ) {
                    entry.cancellation = "pending";
                    try {
                      entry.cancellation = (await custody.cancelCommand(client, {
                        threadId: thread.threadId,
                        turnId,
                        itemId,
                      }))
                        ? "confirmed"
                        : "idle";
                    } catch (error) {
                      entry.cancellation = "idle";
                      throw error;
                    } finally {
                      await settle(itemId);
                    }
                  } else {
                    const live = await client.request(
                      "thread/backgroundTerminals/list",
                      { threadId: thread.threadId },
                      options,
                    );
                    assertCurrent();
                    assertTaskCurrent();
                    if (!entry.terminal) {
                      if (
                        !live.data.some(
                          (item) => item.itemId === itemId && item.processId === entry.processId,
                        )
                      ) {
                        throw new Error("Native command identity is no longer current");
                      }
                      entry.cancellation = "pending";
                      // The native API controls thread-owned handles, never OS PIDs. It has no expected-item CAS.
                      try {
                        const response = await client.request(
                          "thread/backgroundTerminals/terminate",
                          { threadId: thread.threadId, processId: command.processId },
                          options,
                        );
                        entry.cancellation = response.terminated ? "confirmed" : "idle";
                        if (!response.terminated) {
                          throw new Error("Native command termination was not confirmed");
                        }
                      } catch (error) {
                        entry.cancellation = "idle";
                        throw error;
                      } finally {
                        await settle(itemId);
                      }
                    }
                  }
                }
                await settle(itemId);
                if (!(await waitForPromiseOrAbort(entry.done.promise, options.signal))) {
                  options.signal.throwIfAborted();
                }
              })().finally(() => {
                entry.cancellationAttempt = undefined;
              }));
            },
          });
          await settle(itemId);
        }
      } finally {
        admitting = false;
        for (const [itemId, entry] of entries) {
          if (!entry.task) {
            entries.delete(itemId);
          }
        }
        releaseIfFinished();
      }
    },
    async closeAdmission() {
      admitting = false;
      for (const [itemId, entry] of entries) {
        if (!entry.task) {
          entries.delete(itemId);
        }
      }
      releaseIfFinished();
    },
  };
}
