import { coerceToFailoverError } from "../../failover-error.js";
import type { EmbeddedRunAttemptResult } from "./types.js";

/** Settle dispatch before projecting its failure under the selected credential owner. */
export async function runEmbeddedAttemptWithErrorContext(params: {
  run: () => Promise<EmbeddedRunAttemptResult>;
  cleanup: () => void;
  getPostCompactionAbortError: () => Error | undefined;
  context: { provider: string; model: string; authOwner?: "host" };
}): Promise<EmbeddedRunAttemptResult> {
  const { context } = params;
  const rawAttempt = await params
    .run()
    .catch((error: unknown): never => {
      const failure = params.getPostCompactionAbortError() ?? error;
      throw context.authOwner ? (coerceToFailoverError(failure, context) ?? failure) : failure;
    })
    .finally(params.cleanup);

  const postCompactionAbortError = params.getPostCompactionAbortError();
  if (postCompactionAbortError) {
    throw postCompactionAbortError;
  }
  if (context.authOwner && rawAttempt.terminal.kind === "failed") {
    rawAttempt.terminal = {
      ...rawAttempt.terminal,
      error: coerceToFailoverError(rawAttempt.terminal.error, context) ?? rawAttempt.terminal.error,
    };
  }
  return rawAttempt;
}
