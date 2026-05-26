import { n as RuntimeEnv } from "./runtime-Bxifh4bY.js";
import { i as LivePreviewFinalizerResultKind, n as LivePreviewFinalizerDraft } from "./live-B4yVSHOy.js";

//#region src/channels/draft-preview-finalizer.d.ts
/**
 * @deprecated Use `LivePreviewFinalizerDraft` from `openclaw/plugin-sdk/channel-message`.
 */
type DraftPreviewFinalizerDraft<TId> = LivePreviewFinalizerDraft<TId>;
/**
 * @deprecated Use `LivePreviewFinalizerResult` from `openclaw/plugin-sdk/channel-message`.
 */
type DraftPreviewFinalizerResult = Exclude<LivePreviewFinalizerResultKind, "preview-retained">;
/**
 * @deprecated Use `deliverFinalizableLivePreview` from `openclaw/plugin-sdk/channel-message`.
 */
declare function deliverFinalizableDraftPreview<TPayload, TId, TEdit>(params: {
  kind: "tool" | "block" | "final";
  payload: TPayload;
  draft?: DraftPreviewFinalizerDraft<TId>;
  buildFinalEdit: (payload: TPayload) => TEdit | undefined;
  editFinal: (id: TId, edit: TEdit) => Promise<void>;
  deliverNormally: (payload: TPayload) => Promise<boolean | void>;
  onPreviewFinalized?: (id: TId) => Promise<void> | void;
  onNormalDelivered?: () => Promise<void> | void;
  logPreviewEditFailure?: (error: unknown) => void;
}): Promise<DraftPreviewFinalizerResult>;
//#endregion
//#region src/channels/draft-stream-loop.d.ts
type DraftStreamLoop = {
  update: (text: string) => void;
  flush: () => Promise<void>;
  stop: () => void;
  resetPending: () => void;
  resetThrottleWindow: () => void;
  waitForInFlight: () => Promise<void>;
};
declare function createDraftStreamLoop(params: {
  throttleMs: number;
  isStopped: () => boolean;
  sendOrEditStreamMessage: (text: string) => Promise<void | boolean>;
  onBackgroundFlushError?: (err: unknown) => void;
}): DraftStreamLoop;
//#endregion
//#region src/channels/draft-stream-controls.d.ts
type FinalizableDraftStreamState = {
  stopped: boolean;
  final: boolean;
};
type StopAndClearMessageIdParams<T> = {
  stopForClear: () => Promise<void>;
  readMessageId: () => T | undefined;
  clearMessageId: () => void;
};
type ClearFinalizableDraftMessageParams<T> = StopAndClearMessageIdParams<T> & {
  isValidMessageId: (value: unknown) => value is T;
  deleteMessage: (messageId: T) => Promise<void>;
  onDeleteSuccess?: (messageId: T) => void;
  warn?: (message: string) => void;
  warnPrefix: string;
};
type FinalizableDraftLifecycleParams<T> = Omit<ClearFinalizableDraftMessageParams<T>, "stopForClear"> & {
  throttleMs: number;
  state: FinalizableDraftStreamState;
  sendOrEditStreamMessage: (text: string) => Promise<boolean>;
};
declare function createFinalizableDraftStreamControls(params: {
  throttleMs: number;
  isStopped: () => boolean;
  isFinal: () => boolean;
  markStopped: () => void;
  markFinal: () => void;
  sendOrEditStreamMessage: (text: string) => Promise<boolean>;
}): {
  loop: DraftStreamLoop;
  update: (text: string) => void;
  stop: () => Promise<void>;
  seal: () => Promise<void>;
  discardPending: () => Promise<void>;
  stopForClear: () => Promise<void>;
};
declare function createFinalizableDraftStreamControlsForState(params: {
  throttleMs: number;
  state: FinalizableDraftStreamState;
  sendOrEditStreamMessage: (text: string) => Promise<boolean>;
}): {
  loop: DraftStreamLoop;
  update: (text: string) => void;
  stop: () => Promise<void>;
  seal: () => Promise<void>;
  discardPending: () => Promise<void>;
  stopForClear: () => Promise<void>;
};
declare function takeMessageIdAfterStop<T>(params: StopAndClearMessageIdParams<T>): Promise<T | undefined>;
declare function clearFinalizableDraftMessage<T>(params: ClearFinalizableDraftMessageParams<T>): Promise<void>;
declare function createFinalizableDraftLifecycle<T>(params: FinalizableDraftLifecycleParams<T>): {
  clear: () => Promise<void>;
  loop: DraftStreamLoop;
  update: (text: string) => void;
  stop: () => Promise<void>;
  seal: () => Promise<void>;
  discardPending: () => Promise<void>;
  stopForClear: () => Promise<void>;
};
//#endregion
//#region src/channels/transport/stall-watchdog.d.ts
type StallWatchdogTimeoutMeta = {
  idleMs: number;
  timeoutMs: number;
};
type ArmableStallWatchdog = {
  arm: (atMs?: number) => void;
  touch: (atMs?: number) => void;
  disarm: () => void;
  stop: () => void;
  isArmed: () => boolean;
};
declare function createArmableStallWatchdog(params: {
  label: string;
  timeoutMs: number;
  checkIntervalMs?: number;
  abortSignal?: AbortSignal;
  runtime?: RuntimeEnv;
  onTimeout: (meta: StallWatchdogTimeoutMeta) => void;
}): ArmableStallWatchdog;
//#endregion
export { clearFinalizableDraftMessage as a, createFinalizableDraftStreamControlsForState as c, createDraftStreamLoop as d, DraftPreviewFinalizerDraft as f, FinalizableDraftStreamState as i, takeMessageIdAfterStop as l, deliverFinalizableDraftPreview as m, StallWatchdogTimeoutMeta as n, createFinalizableDraftLifecycle as o, DraftPreviewFinalizerResult as p, createArmableStallWatchdog as r, createFinalizableDraftStreamControls as s, ArmableStallWatchdog as t, DraftStreamLoop as u };