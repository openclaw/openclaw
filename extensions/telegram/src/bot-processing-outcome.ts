// Telegram plugin module tracks per-update processing outcomes.
import { AsyncLocalStorage } from "node:async_hooks";

export type TelegramMessageProcessingResult =
  | { kind: "completed" }
  | { kind: "skipped" }
  | { kind: "failed-retryable"; error: unknown };

type TelegramUpdateProcessingFrame = {
  result?: TelegramMessageProcessingResult;
};

type TelegramSpooledReplayFrame = {
  deferredWork?: TelegramSpooledReplayDeferredParticipant;
};

export type TelegramSpooledReplayDeferredParticipant = {
  key: string;
  task: Promise<TelegramMessageProcessingResult>;
  settle: (result: TelegramMessageProcessingResult) => void;
};

const telegramUpdateProcessingFrames = new AsyncLocalStorage<TelegramUpdateProcessingFrame>();
const telegramSpooledReplayFrames = new AsyncLocalStorage<TelegramSpooledReplayFrame>();
const telegramSpooledReplayUpdates = new WeakSet<object>();

export class TelegramSpooledReplayProcessingError extends Error {
  override readonly cause: unknown;

  constructor(cause: unknown) {
    super(`telegram spooled update processing failed: ${String(cause)}`);
    this.name = "TelegramSpooledReplayProcessingError";
    this.cause = cause;
  }
}

export async function runWithTelegramUpdateProcessingFrame<T>(
  fn: () => Promise<T>,
): Promise<{ value: T; result?: TelegramMessageProcessingResult }> {
  const frame: TelegramUpdateProcessingFrame = {};
  const value = await telegramUpdateProcessingFrames.run(frame, fn);
  return frame.result ? { value, result: frame.result } : { value };
}

export function recordTelegramMessageProcessingResult(
  result: TelegramMessageProcessingResult,
): void {
  const frame = telegramUpdateProcessingFrames.getStore();
  if (!frame) {
    return;
  }
  if (result.kind === "failed-retryable") {
    frame.result = result;
    return;
  }
  if (!frame.result || frame.result.kind === "skipped") {
    frame.result = result;
  }
}

function createTelegramSpooledReplayParticipant(
  key: string,
): TelegramSpooledReplayDeferredParticipant {
  let settled = false;
  let resolveTask: (result: TelegramMessageProcessingResult) => void = () => {};
  const task = new Promise<TelegramMessageProcessingResult>((resolve) => {
    resolveTask = resolve;
  });
  return {
    key,
    task,
    settle: (result) => {
      if (settled) {
        return;
      }
      settled = true;
      resolveTask(result);
    },
  };
}

export function createTelegramSpooledReplayDeferredParticipant(
  key: string,
): TelegramSpooledReplayDeferredParticipant | null {
  const frame = telegramSpooledReplayFrames.getStore();
  if (!frame) {
    return null;
  }
  const participant = createTelegramSpooledReplayParticipant(key);
  frame.deferredWork = participant;
  return participant;
}

export function getTelegramSpooledReplayDeferredParticipant():
  | TelegramSpooledReplayDeferredParticipant
  | undefined {
  return telegramSpooledReplayFrames.getStore()?.deferredWork;
}

export async function runWithTelegramSpooledReplayUpdate<T>(
  update: object,
  fn: () => Promise<T>,
): Promise<{ value: T; deferredWork?: TelegramSpooledReplayDeferredParticipant }> {
  const frame: TelegramSpooledReplayFrame = {};
  telegramSpooledReplayUpdates.add(update);
  try {
    const value = await telegramSpooledReplayFrames.run(frame, fn);
    return frame.deferredWork ? { value, deferredWork: frame.deferredWork } : { value };
  } finally {
    telegramSpooledReplayUpdates.delete(update);
  }
}

export async function withTelegramSpooledReplayUpdate<T>(
  update: object,
  fn: () => Promise<T>,
): Promise<T> {
  return (await runWithTelegramSpooledReplayUpdate(update, fn)).value;
}

export function isTelegramSpooledReplayUpdate(update: unknown): boolean {
  return (
    telegramSpooledReplayFrames.getStore() !== undefined ||
    (typeof update === "object" && update !== null && telegramSpooledReplayUpdates.has(update))
  );
}
