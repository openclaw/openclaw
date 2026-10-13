import { parseNodeOptionsEnvVar } from "../../src/infra/node-options.ts";
import { isCiLikeEnv } from "./vitest-local-scheduling.mts";

// Loader hooks can change emitted code without changing the source bytes on disk.
const customLoader = /^(?:--(?:import|require|loader|experimental-loader)(?:=|$)|-r)/u;

export function useVitestWorkerCache(env: NodeJS.ProcessEnv, execArgv: string[] = []) {
  const options = parseNodeOptionsEnvVar(env.NODE_OPTIONS);
  return (
    !process.versions.bun &&
    (!isCiLikeEnv(env) || env.OPENCLAW_VITEST_WORKER_CACHE === "1") &&
    !env.NODE_PATH &&
    !env.NAPI_RS_NATIVE_LIBRARY_PATH &&
    !env.NAPI_RS_WASI_FLAVOR &&
    !env.NAPI_RS_FORCE_WASI &&
    options !== null &&
    ![...options, ...execArgv].some((arg) => customLoader.test(arg.replaceAll("_", "-")))
  );
}
