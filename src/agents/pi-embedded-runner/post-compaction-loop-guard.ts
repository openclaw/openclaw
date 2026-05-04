import type { ToolLoopPostCompactionGuardConfig } from "../../config/types.tools.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";

const log = createSubsystemLogger("agents/post-compaction-guard");

const DEFAULT_WINDOW_SIZE = 3;

export type PostCompactionGuardObservation = {
  toolName: string;
  argsHash: string;
  resultHash: string;
};

export type PostCompactionGuardVerdict =
  | { shouldAbort: false; armed: boolean; remainingAttempts: number }
  | {
      shouldAbort: true;
      armed: boolean;
      remainingAttempts: number;
      detector: "compaction_loop_persisted";
      count: number;
      toolName: string;
      message: string;
    };

export type PostCompactionLoopGuard = {
  armPostCompaction: () => void;
  observe: (call: PostCompactionGuardObservation) => PostCompactionGuardVerdict;
  snapshot: () => { armed: boolean; remainingAttempts: number };
};

export type PostCompactionGuardScope = {
  sessionKey?: string;
  sessionId?: string;
  runId?: string;
};

type GuardState = {
  enabled: boolean;
  windowSize: number;
  remainingAttempts: number;
  history: PostCompactionGuardObservation[];
};

const activeGuards = new Map<string, PostCompactionLoopGuard>();

function asPositiveInt(value: number | undefined, fallback: number): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    return fallback;
  }
  return value;
}

export function createPostCompactionLoopGuard(
  config?: ToolLoopPostCompactionGuardConfig,
): PostCompactionLoopGuard {
  const state: GuardState = {
    enabled: config?.enabled ?? true,
    windowSize: asPositiveInt(config?.windowSize, DEFAULT_WINDOW_SIZE),
    remainingAttempts: 0,
    history: [],
  };

  const armPostCompaction = (): void => {
    state.remainingAttempts = state.windowSize;
    state.history = [];
    if (state.enabled) {
      log.info(`post-compaction guard armed for ${state.windowSize} attempts`);
    }
  };

  const observe = (call: PostCompactionGuardObservation): PostCompactionGuardVerdict => {
    if (!state.enabled) {
      return { shouldAbort: false, armed: false, remainingAttempts: 0 };
    }
    if (state.remainingAttempts <= 0) {
      return { shouldAbort: false, armed: false, remainingAttempts: 0 };
    }
    state.remainingAttempts -= 1;
    state.history.push(call);
    const armedAfter = state.remainingAttempts > 0;

    const matches = state.history.filter(
      (entry) =>
        entry.toolName === call.toolName &&
        entry.argsHash === call.argsHash &&
        entry.resultHash === call.resultHash,
    );

    if (matches.length >= state.windowSize) {
      log.error(
        `post-compaction loop persisted: tool=${call.toolName} repeated ${matches.length} times with identical args+result post-compaction`,
      );
      return {
        shouldAbort: true,
        armed: armedAfter,
        remainingAttempts: state.remainingAttempts,
        detector: "compaction_loop_persisted",
        count: matches.length,
        toolName: call.toolName,
        message: `CRITICAL: tool ${call.toolName} repeated ${matches.length} times with identical arguments and identical results within ${state.windowSize} attempts after auto-compaction. The compaction did not break the loop. Aborting to prevent runaway resource use.`,
      };
    }

    return { shouldAbort: false, armed: armedAfter, remainingAttempts: state.remainingAttempts };
  };

  const snapshot = () => ({
    armed: state.remainingAttempts > 0,
    remainingAttempts: state.remainingAttempts,
  });

  return { armPostCompaction, observe, snapshot };
}

function normalizeScopePart(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function scopeKeys(scope: PostCompactionGuardScope): string[] {
  const runId = normalizeScopePart(scope.runId);
  const keys: string[] = [];
  for (const [kind, id] of [
    ["sessionKey", normalizeScopePart(scope.sessionKey)],
    ["sessionId", normalizeScopePart(scope.sessionId)],
  ] as const) {
    if (!id) {
      continue;
    }
    keys.push(runId ? `${kind}:${id}:run:${runId}` : `${kind}:${id}`);
  }
  return keys;
}

export function registerPostCompactionLoopGuard(
  scope: PostCompactionGuardScope,
  guard: PostCompactionLoopGuard,
): () => void {
  const keys = scopeKeys(scope);
  for (const key of keys) {
    activeGuards.set(key, guard);
  }
  return () => {
    for (const key of keys) {
      if (activeGuards.get(key) === guard) {
        activeGuards.delete(key);
      }
    }
  };
}

export function observePostCompactionLoopGuard(
  scope: PostCompactionGuardScope,
  call: PostCompactionGuardObservation,
): PostCompactionGuardVerdict | undefined {
  for (const key of scopeKeys(scope)) {
    const guard = activeGuards.get(key);
    if (guard) {
      return guard.observe(call);
    }
  }
  return undefined;
}

export class PostCompactionLoopPersistedError extends Error {
  readonly detector: "compaction_loop_persisted";
  readonly count: number;
  readonly toolName: string;

  constructor(
    message: string,
    details: {
      detector: "compaction_loop_persisted";
      count: number;
      toolName: string;
    },
  ) {
    super(message);
    this.name = "PostCompactionLoopPersistedError";
    this.detector = details.detector;
    this.count = details.count;
    this.toolName = details.toolName;
  }

  static fromVerdict(
    verdict: Extract<PostCompactionGuardVerdict, { shouldAbort: true }>,
  ): PostCompactionLoopPersistedError {
    return new PostCompactionLoopPersistedError(verdict.message, {
      detector: verdict.detector,
      count: verdict.count,
      toolName: verdict.toolName,
    });
  }
}
