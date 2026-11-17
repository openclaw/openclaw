import { AsyncLocalStorage } from "node:async_hooks";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { validateToolArguments } from "../../packages/agent-core/src/validation.js";
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

function rejectClosedToolExecutionValidation(): never {
  throw new Error("Tool execution validation scope is closed");
}

/** Keep per-call validation inside the policy wrapper's final execution boundary. */
export async function runWithToolExecutionValidation<T>(
  toolCallId: string,
  validator: ToolExecutionValidator,
  execute: () => Promise<T>,
): Promise<T> {
  const scope = { toolCallId, validate: validator };
  try {
    return await executionValidators.run(scope, execute);
  } finally {
    // Sockets and timers inherit this frame; retire the run closure without bypassing validation.
    scope.validate = rejectClosedToolExecutionValidation;
  }
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

function isToolParameters(
  value: unknown,
): value is Parameters<typeof validateToolArguments>[0]["parameters"] {
  return isRecord(value);
}

/**
 * Coerce model arguments the way the agent loop does for direct calls.
 * Input the schema still rejects is returned as-is for the caller's validator to report.
 */
export function coerceToolExecutionArguments(
  tool: { name: string; description?: string },
  parameters: unknown,
  args: unknown,
): unknown {
  if (!isToolParameters(parameters) || !isRecord(args)) {
    return args;
  }
  try {
    return validateToolArguments(
      { name: tool.name, description: tool.description ?? "", parameters },
      { type: "toolCall", id: tool.name, name: tool.name, arguments: args },
    );
  } catch {
    return args;
  }
}
