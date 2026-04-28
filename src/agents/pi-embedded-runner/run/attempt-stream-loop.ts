type AbortSignalWithReason = AbortSignal & { reason?: unknown };

type PromptSubmission = {
  prompt: string;
  runtimeContext?: string;
  runtimeOnly?: boolean;
};

type PromptableSession = {
  prompt(prompt: string, options?: { images?: unknown[] }): Promise<unknown>;
};

export function getAttemptAbortReason(signal: AbortSignal): unknown {
  return "reason" in signal ? (signal as AbortSignalWithReason).reason : undefined;
}

export function makeAttemptTimeoutAbortReason(): Error {
  const err = new Error("request timed out");
  err.name = "TimeoutError";
  return err;
}

export function makeAttemptAbortError(signal: AbortSignal): Error {
  const reason = getAttemptAbortReason(signal);
  // If the reason is already an Error, preserve it to keep the original message
  // (for example an LLM idle timeout instead of a generic "aborted").
  if (reason instanceof Error) {
    const err = new Error(reason.message, { cause: reason });
    err.name = "AbortError";
    return err;
  }
  const err = reason ? new Error("aborted", { cause: reason }) : new Error("aborted");
  err.name = "AbortError";
  return err;
}

export function createAttemptAbortable(runAbortController: AbortController) {
  return <T>(promise: Promise<T>): Promise<T> => {
    const signal = runAbortController.signal;
    if (signal.aborted) {
      return Promise.reject(makeAttemptAbortError(signal));
    }
    return new Promise<T>((resolve, reject) => {
      const onAbort = () => {
        signal.removeEventListener("abort", onAbort);
        reject(makeAttemptAbortError(signal));
      };
      signal.addEventListener("abort", onAbort, { once: true });
      promise.then(
        (value) => {
          signal.removeEventListener("abort", onAbort);
          resolve(value);
        },
        (err) => {
          signal.removeEventListener("abort", onAbort);
          reject(err);
        },
      );
    });
  };
}

export async function runEmbeddedAttemptPromptSubmission(params: {
  abortable: <T>(promise: Promise<T>) => Promise<T>;
  applyRuntimeSystemPrompt: (systemPrompt: string) => void;
  buildRuntimeSystemPrompt: (runtimeContext: string) => string | undefined;
  images: unknown[];
  promptSubmission: PromptSubmission;
  queueRuntimeContextForNextTurn: (runtimeContext?: string) => Promise<void>;
  restoreSystemPrompt: () => void;
  session: PromptableSession;
}): Promise<void> {
  const { promptSubmission } = params;
  if (promptSubmission.runtimeOnly) {
    await params.abortable(params.session.prompt(promptSubmission.prompt));
    return;
  }

  const runtimeContext = promptSubmission.runtimeContext?.trim();
  const runtimeSystemPrompt = runtimeContext
    ? params.buildRuntimeSystemPrompt(runtimeContext)
    : undefined;
  if (runtimeSystemPrompt) {
    params.applyRuntimeSystemPrompt(runtimeSystemPrompt);
  }
  try {
    await params.queueRuntimeContextForNextTurn(runtimeContext);

    // Only pass images when there are actually images to pass; some transports
    // don't expect an empty image parameter.
    if (params.images.length > 0) {
      await params.abortable(
        params.session.prompt(promptSubmission.prompt, { images: params.images }),
      );
    } else {
      await params.abortable(params.session.prompt(promptSubmission.prompt));
    }
  } finally {
    if (runtimeSystemPrompt) {
      params.restoreSystemPrompt();
    }
  }
}
