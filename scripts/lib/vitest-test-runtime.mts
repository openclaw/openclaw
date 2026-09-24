import path from "node:path";
import { resolveVitestBunSourceArgs, resolveVitestNodeArgs } from "./vitest-process-env.mts";

/** Select only the Vitest process; orchestration and preparation retain Node. */
export function resolveVitestTestCommand(args: string[], env: NodeJS.ProcessEnv = process.env) {
  const runtime = env.OPENCLAW_VITEST_RUNTIME?.trim() || "node";
  if (runtime === "node") {
    return { command: process.execPath, args };
  }
  if (runtime !== "bun") {
    throw new Error(`Invalid OPENCLAW_VITEST_RUNTIME: ${runtime}; expected node or bun`);
  }
  const cliIndex = args.findIndex((arg) => path.basename(arg) === "vitest.mjs");
  if (cliIndex < 0) {
    return { command: process.execPath, args };
  }
  const nodeFlags = new Set(resolveVitestNodeArgs({}));
  return {
    command: "bun",
    // Strip V8 flags only before the CLI; test names and filters stay byte-for-byte.
    args: [
      // Workers inherit this resolver without adding aliases to child-process environments.
      ...resolveVitestBunSourceArgs(),
      ...args.slice(0, cliIndex).filter((arg) => !nodeFlags.has(arg)),
      ...args.slice(cliIndex),
    ],
  };
}
