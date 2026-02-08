import type { AnyAgentTool } from "./pi-tools.types.js";

function throwAbortError(): never {
  const err = new Error("Aborted");
  err.name = "AbortError";
  throw err;
}

function isAbortSignal(value: unknown): value is AbortSignal {
  return (
    !!value &&
    typeof value === "object" &&
    typeof (value as AbortSignal).aborted === "boolean" &&
    typeof (value as AbortSignal).addEventListener === "function"
  );
}

function combineAbortSignals(a?: AbortSignal, b?: AbortSignal): AbortSignal | undefined {
  if (!a && !b) {
    return undefined;
  }
  if (a && !b) {
    return a;
  }
  if (b && !a) {
    return b;
  }
  if (a?.aborted) {
    return a;
  }
  if (b?.aborted) {
    return b;
  }
  if (typeof AbortSignal.any === "function" && isAbortSignal(a) && isAbortSignal(b)) {
    return AbortSignal.any([a, b]);
  }

  const controller = new AbortController();
  const onAbort = () => controller.abort();
  a?.addEventListener("abort", onAbort, { once: true });
  b?.addEventListener("abort", onAbort, { once: true });
  return controller.signal;
}

export function wrapToolWithAbortSignal(
  tool: AnyAgentTool,
  abortSignal?: AbortSignal,
): AnyAgentTool {
  if (!abortSignal) {
    return tool;
  }
  const execute = tool.execute;
  if (!execute) {
    return tool;
  }
  return {
    ...tool,
    execute: async (toolCallId, params, signal, onUpdate) => {
      let resolvedSignal: AbortSignal | undefined;
      let resolvedOnUpdate = typeof onUpdate === "function" ? onUpdate : undefined;
      if (isAbortSignal(signal)) {
        resolvedSignal = signal;
      } else if (typeof signal === "function" && !resolvedOnUpdate) {
        resolvedOnUpdate = signal;
      }
      const combined = combineAbortSignals(resolvedSignal, abortSignal);
      if (combined?.aborted) {
        throwAbortError();
      }
      return await execute(toolCallId, params, combined, resolvedOnUpdate);
    },
  };
}
