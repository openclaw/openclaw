import path from "node:path";
import { resolveRepoToolBinPath } from "./local-check-runtime.mts";
import { isCiEnvironment, pinnedBunEnv, resolvePinnedBun } from "./pinned-bun.mts";

const DEFAULT_FORMAT_TOOL: "oxfmt" | "bun" = "bun";
// Flip only after the pinned fork includes b39aa848 and lint parity passes.
const DEFAULT_LINT_TOOL: "oxlint" | "bun" = "oxlint";

export function resolveDevTool(
  kind: "format" | "lint",
  env: NodeJS.ProcessEnv = process.env,
  deps = { resolvePinnedBun, notice: console.error },
) {
  const fallback = kind === "format" ? "oxfmt" : "oxlint";
  const name = kind === "format" ? "OPENCLAW_FORMAT_TOOL" : "OPENCLAW_LINT_TOOL";
  const override = env[name]?.trim();
  if (override && override !== "bun" && override !== fallback) {
    throw new Error(`${name} must be bun or ${fallback}`);
  }
  const selected =
    override ||
    (isCiEnvironment(env) ? fallback : kind === "format" ? DEFAULT_FORMAT_TOOL : DEFAULT_LINT_TOOL);
  if (selected === "bun") {
    const result = deps.resolvePinnedBun(env);
    if (result.command) {
      return {
        command: result.command,
        args: [kind === "format" ? "fmt" : "lint"],
        env: {
          ...env,
          ...pinnedBunEnv(result.command, env),
          // Bun otherwise resolves the repository's lint script recursively.
          ...(kind === "lint" ? { npm_lifecycle_event: "lint" } : {}),
        },
      };
    }
    if (override) {
      throw new Error(`${name}=bun: ${result.reason}`);
    }
    deps.notice(`[openclaw] ${result.reason}; using ${fallback}.`);
  }
  const bin = resolveRepoToolBinPath(fallback);
  return kind === "format"
    ? { command: process.execPath, args: [path.resolve(bin, "../../oxfmt/bin/oxfmt")], env }
    : { command: bin, args: [], env };
}
