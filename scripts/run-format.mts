import { spawnSync } from "node:child_process";
import { resolveDevTool } from "./lib/dev-tool.mts";
import { isCiEnvironment } from "./lib/pinned-bun.mts";

export function compareFormatResults(
  oxfmt: { status: number | null; stdout: string },
  bun: { status: number | null; stdout: string },
) {
  const files = (output: string) => output.trim().split(/\r?\n/u).filter(Boolean).toSorted();
  return (
    oxfmt.status === bun.status &&
    JSON.stringify(files(oxfmt.stdout)) === JSON.stringify(files(bun.stdout))
  );
}

export function main(args = process.argv.slice(2), env = process.env) {
  const parity = isCiEnvironment(env) && args.includes("--check");
  const tool = resolveDevTool("format", parity ? { ...env, OPENCLAW_FORMAT_TOOL: "oxfmt" } : env);
  const run = (selected: ReturnType<typeof resolveDevTool>, flags: string[], capture = false) => {
    const result = spawnSync(selected.command, [...selected.args, ...flags], {
      env: selected.env,
      stdio: capture ? ["inherit", "pipe", "inherit"] : "inherit",
      encoding: "utf8",
    });
    if (result.error) {
      throw result.error;
    }
    return result;
  };
  if (!parity) {
    return run(tool, args).status ?? 1;
  }
  // Use the same pinned cache/stager as local development; CI need not put Bun on PATH.
  const bun = resolveDevTool("format", { ...env, CI: "", OPENCLAW_FORMAT_TOOL: "bun" });
  const flags = args.map((arg) => (arg === "--check" ? "--list-different" : arg));
  const oxResult = run(tool, flags, true);
  const bunResult = run(bun, flags, true);
  if (!compareFormatResults(oxResult, bunResult)) {
    console.error(`[format] parity failed\noxfmt:\n${oxResult.stdout}\nBun:\n${bunResult.stdout}`);
    return 1;
  }
  if (oxResult.stdout) {
    console.error(oxResult.stdout);
  }
  console.error("[format] oxfmt/Bun parity checked on the same file set.");
  return oxResult.status ?? 1;
}

if (import.meta.main) {
  process.exitCode = main();
}
