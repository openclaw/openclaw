import { readProcessMemoryCapacity, type MemoryLimitParams } from "./process-memory.mts";

/** Keep native Go GC slack inside the host budget; Node heap flags do not reach tsgo. */
export function resolveNativeDeclarationCompilerEnv(
  params: MemoryLimitParams & {
    concurrentCompilers?: number;
    capacity?: ReturnType<typeof readProcessMemoryCapacity>;
  } = {},
): NodeJS.ProcessEnv {
  const env = params.env ?? process.env;
  if (env.GOMEMLIMIT !== undefined) {
    return env;
  }
  const concurrentCompilers = params.concurrentCompilers ?? 1;
  if (!Number.isSafeInteger(concurrentCompilers) || concurrentCompilers < 1) {
    throw new Error("Native declaration concurrency must be a positive safe integer");
  }
  const { limitBytes, unresolved } = params.capacity ?? readProcessMemoryCapacity(params);
  if (unresolved || limitBytes === null) {
    return env;
  }
  // Share the Go-managed budget across overlapping compiler children. This is
  // only a soft Go limit; non-Go RSS and the build parent still need headroom.
  const limitMiB = Math.floor((limitBytes * 0.6) / (concurrentCompilers * 1024 * 1024));
  return limitMiB > 0 ? { ...env, GOMEMLIMIT: `${limitMiB}MiB` } : env;
}
