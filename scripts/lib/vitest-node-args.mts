import { parsePermissiveBooleanToken } from "./arg-utils.mts";

/** Node worker flags are independent of test inventories and watchdog policy. */
export function resolveVitestNodeArgs(env: NodeJS.ProcessEnv = process.env): string[] {
  // Node 24 can join a Sparkplug compiler at process.exit while that compiler
  // waits for main-thread GC. Keep baseline compilation on the main thread.
  return [
    ...(parsePermissiveBooleanToken(env.OPENCLAW_VITEST_ENABLE_MAGLEV) === true
      ? []
      : ["--no-maglev"]),
    "--no-concurrent-sparkplug",
  ];
}
