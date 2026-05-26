import { r as ChannelAccountSnapshot } from "./types.core-BkmTlRzr.js";

//#region src/channels/run-state-machine.d.ts
type RunStateStatusPatch = {
  busy?: boolean;
  activeRuns?: number;
  lastRunActivityAt?: number | null;
};
type RunStateStatusSink = (patch: RunStateStatusPatch) => void;
type RunStateMachineParams = {
  setStatus?: RunStateStatusSink;
  abortSignal?: AbortSignal;
  heartbeatMs?: number;
  now?: () => number;
};
declare function createRunStateMachine(params: RunStateMachineParams): {
  isActive(): boolean;
  onRunStart(): void;
  onRunEnd(): void;
  deactivate: () => void;
};
//#endregion
//#region src/plugin-sdk/channel-lifecycle.core.d.ts
type CloseAwareServer = {
  once: (event: "close", listener: () => void) => unknown;
};
type PassiveAccountLifecycleParams<Handle> = {
  abortSignal?: AbortSignal;
  start: () => Promise<Handle>;
  stop?: (handle: Handle) => void | Promise<void>;
  onStop?: () => void | Promise<void>;
};
type ChannelRunQueueTaskContext = {
  lifecycleSignal?: AbortSignal;
};
type ChannelRunQueue = {
  enqueue: (key: string, task: (context: ChannelRunQueueTaskContext) => Promise<void>) => void;
  deactivate: () => void;
};
type ChannelRunQueueParams = {
  setStatus?: RunStateStatusSink;
  abortSignal?: AbortSignal;
  onError?: (error: unknown) => void;
};
/** Bind a fixed account id into a status writer so lifecycle code can emit partial snapshots. */
declare function createAccountStatusSink(params: {
  accountId: string;
  setStatus: (next: ChannelAccountSnapshot) => void;
}): (patch: Omit<ChannelAccountSnapshot, "accountId">) => void;
/**
 * Serialize channel work per key while keeping lifecycle/busy accounting out of
 * channel-specific message handlers. The queue does not impose run timeouts;
 * callers should rely on session/tool/runtime lifecycle for long-running work.
 */
declare function createChannelRunQueue(params: ChannelRunQueueParams): ChannelRunQueue;
/**
 * Return a promise that resolves when the signal is aborted.
 *
 * If no signal is provided, the promise stays pending forever. When provided,
 * `onAbort` runs once before the promise resolves.
 */
declare function waitUntilAbort(signal?: AbortSignal, onAbort?: () => void | Promise<void>): Promise<void>;
/**
 * Keep a passive account task alive until abort, then run optional cleanup.
 */
declare function runPassiveAccountLifecycle<Handle>(params: PassiveAccountLifecycleParams<Handle>): Promise<void>;
/**
 * Keep a channel/provider task pending until the HTTP server closes.
 *
 * When an abort signal is provided, `onAbort` is invoked once and should
 * trigger server shutdown. The returned promise resolves only after `close`.
 */
declare function keepHttpServerTaskAlive(params: {
  server: CloseAwareServer;
  abortSignal?: AbortSignal;
  onAbort?: () => void | Promise<void>;
}): Promise<void>;
//#endregion
export { createChannelRunQueue as a, waitUntilAbort as c, createAccountStatusSink as i, createRunStateMachine as l, ChannelRunQueueParams as n, keepHttpServerTaskAlive as o, ChannelRunQueueTaskContext as r, runPassiveAccountLifecycle as s, ChannelRunQueue as t };