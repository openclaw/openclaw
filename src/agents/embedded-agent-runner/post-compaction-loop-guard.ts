import { createSubsystemLogger } from "../../logging/subsystem.js";

/**
 * Detects identical tool-call loops immediately after automatic compaction.
 *
 * The guard only observes a small post-compaction window; if compaction failed to break an
 * identical args/result loop, the runner aborts before spending unbounded tokens.
 */
const log = createSubsystemLogger("agents/post-compaction-guard");

const DEFAULT_WINDOW_SIZE = 3;

// Bounded recent-call tail kept across the whole run so arming can snapshot what the
// model was doing right before compaction. Without it, re-reads of summarized content
// inside the post-compaction window leave no recorded fact at all.
const BASELINE_WINDOW_SIZE = 16;

type PostCompactionGuardObservation = {
  toolName: string;
  argsHash: string;
  resultHash: string;
};

type PostCompactionGuardVerdict =
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

type PostCompactionLoopGuard = {
  armPostCompaction: () => void;
  observe: (call: PostCompactionGuardObservation) => PostCompactionGuardVerdict;
};

const observationSignature = (call: PostCompactionGuardObservation): string =>
  `${call.toolName}\0${call.argsHash}`;

/** Creates a stateful post-compaction loop detector for one embedded run. */
export function createPostCompactionLoopGuard(options?: {
  enabled?: boolean;
}): PostCompactionLoopGuard {
  const enabled = options?.enabled ?? true;
  const recentCalls: PostCompactionGuardObservation[] = [];
  let remainingAttempts = 0;
  let history: PostCompactionGuardObservation[] = [];
  let baselineSignatures: Set<string> | undefined;
  let windowObserved = 0;
  let windowRepeats = 0;
  let repeatTools = new Set<string>();

  const armPostCompaction = (): void => {
    // Snapshot the pre-compaction call tail before the new window starts. A re-arm
    // mid-window replaces the unclosed window's counts; compaction success implies
    // the prior attempt ended, so that loss is accepted.
    baselineSignatures =
      enabled && recentCalls.length > 0
        ? new Set(recentCalls.map(observationSignature))
        : undefined;
    remainingAttempts = DEFAULT_WINDOW_SIZE;
    history = [];
    windowObserved = 0;
    windowRepeats = 0;
    repeatTools = new Set<string>();
    if (enabled) {
      log.info(`post-compaction guard armed for ${DEFAULT_WINDOW_SIZE} attempts`);
    }
  };

  const logWindowSummary = (): void => {
    const tools = [...repeatTools].toSorted().join(",");
    log.info(
      `post-compaction window closed: toolCalls=${windowObserved} ` +
        `preCompactionRepeats=${windowRepeats}${tools ? ` tools=${tools}` : ""}`,
    );
  };

  const observe = (call: PostCompactionGuardObservation): PostCompactionGuardVerdict => {
    if (!enabled) {
      return { shouldAbort: false, armed: false, remainingAttempts: 0 };
    }
    recentCalls.push(call);
    if (recentCalls.length > BASELINE_WINDOW_SIZE) {
      recentCalls.shift();
    }
    if (remainingAttempts <= 0) {
      return { shouldAbort: false, armed: false, remainingAttempts: 0 };
    }
    remainingAttempts -= 1;
    windowObserved += 1;
    if (baselineSignatures?.has(observationSignature(call))) {
      windowRepeats += 1;
      repeatTools.add(call.toolName);
    }
    history.push(call);
    const armedAfter = remainingAttempts > 0;

    // Compare full tool name + args + result. Repeated args alone can be legitimate polling;
    // identical results after compaction prove the compression did not change the loop.
    const matches = history.filter(
      (entry) =>
        entry.toolName === call.toolName &&
        entry.argsHash === call.argsHash &&
        entry.resultHash === call.resultHash,
    );

    if (matches.length >= DEFAULT_WINDOW_SIZE) {
      log.error(
        `post-compaction loop persisted: tool=${call.toolName} repeated ${matches.length} times with identical args+result post-compaction`,
      );
      return {
        shouldAbort: true,
        armed: armedAfter,
        remainingAttempts,
        detector: "compaction_loop_persisted",
        count: matches.length,
        toolName: call.toolName,
        message: `CRITICAL: tool ${call.toolName} repeated ${matches.length} times with identical arguments and identical results within ${DEFAULT_WINDOW_SIZE} attempts after auto-compaction. The compaction did not break the loop. Aborting to prevent runaway resource use.`,
      };
    }

    if (!armedAfter) {
      logWindowSummary();
      baselineSignatures = undefined;
      windowObserved = 0;
      windowRepeats = 0;
      repeatTools = new Set<string>();
    }

    return { shouldAbort: false, armed: armedAfter, remainingAttempts };
  };

  return { armPostCompaction, observe };
}

/** Error raised when the post-compaction loop guard aborts a run. */
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
    return new PostCompactionLoopPersistedError(verdict.message, verdict);
  }
}
