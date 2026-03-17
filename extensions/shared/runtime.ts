import { createLoggerBackedRuntime } from "openclaw/plugin-sdk/runtime";

export function resolveLoggerBackedRuntime<TRuntime>(
  runtime: TRuntime | undefined,
  logger: Parameters<typeof createLoggerBackedRuntime>[0]["logger"],
): TRuntime {
  return (
    runtime ??
    (createLoggerBackedRuntime({
      logger,
      exitError: () => new Error("Runtime exit not available"),
    }) as TRuntime)
  );
}
