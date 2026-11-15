import { parsePermissiveBooleanToken } from "./arg-utils.mts";

/** Compiler stability policy shared by Vitest and standalone CLI fixtures. */
export function resolveNodeCompilerArgs(env: NodeJS.ProcessEnv = process.env): string[] {
  // Node 24 can join a Sparkplug compiler at process.exit while that compiler
  // waits for main-thread GC. Keep baseline compilation on the main thread.
  return [
    ...(parsePermissiveBooleanToken(env.OPENCLAW_VITEST_ENABLE_MAGLEV) === true
      ? []
      : ["--no-maglev"]),
    "--no-concurrent-sparkplug",
  ];
}

export function resolveVitestNodeArgs(env: NodeJS.ProcessEnv = process.env): string[] {
  // Node 24 gates the native browser byte APIs used by UI modules under test.
  return [...resolveNodeCompilerArgs(env), "--js-base-64", "--expose-gc"];
}
