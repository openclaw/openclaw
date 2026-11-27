import { hasNodeStartupHooks } from "../../node-runtime-env.mjs";
import { isCiLikeEnv } from "./vitest-local-scheduling.mts";

export function useVitestWorkerCache(env: NodeJS.ProcessEnv, execArgv: string[] = []) {
  return (
    !process.versions.bun &&
    (!isCiLikeEnv(env) || env.OPENCLAW_VITEST_WORKER_CACHE === "1") &&
    !env.NODE_PATH &&
    !env.NAPI_RS_NATIVE_LIBRARY_PATH &&
    !env.NAPI_RS_WASI_FLAVOR &&
    !env.NAPI_RS_FORCE_WASI &&
    !hasNodeStartupHooks(execArgv, env.NODE_OPTIONS)
  );
}
