import { AsyncLocalStorage } from "node:async_hooks";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";

type ToolExecutionValidator = (params: unknown) => void | Promise<void>;
export type ToolSourceAdmission = (admit: () => void) => Promise<void>;
type ScopedToolExecutionValidator = {
  toolCallId: string;
  validate?: ToolExecutionValidator;
  withCurrent?: ToolSourceAdmission;
};

// SDK and host chunks must validate through the same per-invocation context.
const executionValidators = resolveGlobalSingleton(
  Symbol.for("openclaw.toolExecutionValidationContext"),
  () => new AsyncLocalStorage<ScopedToolExecutionValidator>(),
);

/** Keep per-call validation inside the policy wrapper's final execution boundary. */
export async function runWithToolExecutionValidation<T>(
  toolCallId: string,
  validator: ToolExecutionValidator | undefined,
  execute: () => Promise<T>,
  withCurrent?: ToolSourceAdmission,
): Promise<T> {
  const parent = executionValidators.getStore();
  const sourceCheck =
    withCurrent ?? (parent?.toolCallId === toolCallId ? parent.withCurrent : undefined);
  return await executionValidators.run(
    { toolCallId, validate: validator, withCurrent: sourceCheck },
    execute,
  );
}

/** Validate hook-adjusted arguments without leaking a validator into concurrent calls. */
export async function validateToolExecutionParams(
  toolCallId: string,
  params: unknown,
): Promise<void> {
  const scopedValidator = executionValidators.getStore();
  if (scopedValidator?.toolCallId === toolCallId) {
    await scopedValidator.validate?.(params);
  }
}

/** Admit one invocation under a fresh owner read without lending the tool the reader's storage privileges. */
export function startWithToolExecutionAuthority<T>(
  toolCallId: string,
  start: () => Promise<T>,
): Promise<T> {
  const scope = executionValidators.getStore();
  const withCurrent = scope?.toolCallId === toolCallId ? scope.withCurrent : undefined;
  if (!withCurrent) {
    return start();
  }
  // The tool keeps its caller's policy context. Its own database work queues as
  // a separate operation, even when an approval or provider resolves immediately.
  const startAsCaller = AsyncLocalStorage.bind(start);
  return new Promise((resolve, reject) => {
    // Start in the same callback that verified the owner. The worker consumer
    // returns void, releasing its admission before any tool I/O has to finish.
    void withCurrent(() => {
      resolve(startAsCaller());
    }).catch(reject);
  });
}
