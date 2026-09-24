import { AsyncLocalStorage } from "node:async_hooks";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";

type ToolExecutionValidator = (params: unknown) => void | Promise<void>;
type ScopedToolExecutionValidator = {
  toolCallId: string;
  validate: ToolExecutionValidator;
};

// SDK and host chunks must validate through the same per-invocation context.
const executionValidators = resolveGlobalSingleton(
  Symbol.for("openclaw.toolExecutionValidationContext"),
  () => new AsyncLocalStorage<ScopedToolExecutionValidator>(),
);

/** Keep per-call validation inside the policy wrapper's final execution boundary. */
export async function runWithToolExecutionValidation<T>(
  toolCallId: string,
  validator: ToolExecutionValidator,
  execute: () => Promise<T>,
): Promise<T> {
  return await executionValidators.run({ toolCallId, validate: validator }, execute);
}

/** Validate hook-adjusted arguments without leaking a validator into concurrent calls. */
export async function validateToolExecutionParams(
  toolCallId: string,
  params: unknown,
): Promise<void> {
  const scopedValidator = executionValidators.getStore();
  if (scopedValidator?.toolCallId === toolCallId) {
    await scopedValidator.validate(params);
  }
}
