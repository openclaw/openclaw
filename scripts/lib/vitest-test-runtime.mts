import path from "node:path";
import { resolveTestBunSourceArgs } from "../../src/test-utils/bun-process.ts";
import { DEFAULT_VITEST_TEST_TIMEOUT_MS } from "../../test/vitest/vitest.timeouts.ts";
import { pinnedBunEnv, requirePinnedBun } from "./pinned-bun.mts";
import { resolveRepoRoot } from "./repo-root.mjs";
import { resolveTestRuntime } from "./test-runtime.mts";
import { resolveVitestNodeArgs } from "./vitest-process-env.mts";

type VitestTestCommand = {
  command: string;
  args: string[];
  envOverrides?: Readonly<Record<string, string>>;
};

// The pinned Bun fork generates bytecode during Vitest's cache flush at teardown.
// Its separate transpiler cache still reuses module transforms.
const bunTestEnvOverrides = { NODE_DISABLE_COMPILE_CACHE: "1" } as const;

export function resolveNativeBunTestCommand(
  files: string[],
  repoRoot = resolveRepoRoot(import.meta.url),
  env: NodeJS.ProcessEnv = process.env,
): VitestTestCommand {
  const command = requirePinnedBun(env);
  return {
    command,
    envOverrides: { ...bunTestEnvOverrides, ...pinnedBunEnv(command, env) },
    args: [
      "test",
      "--no-env-file",
      ...resolveTestBunSourceArgs(repoRoot),
      "--preload",
      path.join(repoRoot, "test/setup.env.ts"),
      "--timeout",
      String(DEFAULT_VITEST_TEST_TIMEOUT_MS),
      ...files,
    ],
  };
}

/** Select only the Vitest process; orchestration and preparation retain Node. */
export function resolveVitestTestCommand(
  args: string[],
  env: NodeJS.ProcessEnv = process.env,
): VitestTestCommand {
  if (resolveTestRuntime(env) === "node") {
    return { command: process.execPath, args };
  }
  const cliIndex = args.findIndex((arg) => path.basename(arg) === "vitest.mjs");
  if (cliIndex < 0) {
    return { command: process.execPath, args };
  }
  const nodeFlags = new Set(resolveVitestNodeArgs({}));
  const command = requirePinnedBun(env);
  return {
    command,
    envOverrides: { ...bunTestEnvOverrides, ...pinnedBunEnv(command, env) },
    // Strip V8 flags only before the CLI; test names and filters stay byte-for-byte.
    args: [
      // Workers inherit this resolver without adding aliases to child-process environments.
      ...resolveTestBunSourceArgs(resolveRepoRoot(import.meta.url)),
      ...args.slice(0, cliIndex).filter((arg) => !nodeFlags.has(arg)),
      ...args.slice(cliIndex),
    ],
  };
}
