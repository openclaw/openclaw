import JSON5 from "json5";
import { sortJsonValueKeys } from "./canonical-json.mjs";
import { resolveDevTool } from "./dev-tool.mts";
import { runManagedCommand } from "./managed-child-process.mts";

/** Compare full diagnostic multisets, preserving spans and duplicate findings. */
export function compareLintResults(
  oxlint: { status: number; stdout: string },
  bun: { status: number; stdout: string },
) {
  const diagnostics = (output: string) =>
    JSON5.parse<{ diagnostics: Record<string, unknown>[] }>(output)
      .diagnostics.map(({ url: _url, code, ...diagnostic }) =>
        JSON.stringify(
          sortJsonValueKeys({
            ...diagnostic,
            code:
              typeof code === "string"
                ? code
                    .replace(/^([^()]+)\(([^)]+)\)$/u, "$1/$2")
                    .replace(/^eslint\//u, "")
                    .replace(/^typescript\//u, "@typescript-eslint/")
                    .replace(/^eslint-plugin-/u, "")
                : code,
          }),
        ),
      )
      .toSorted();
  return (
    oxlint.status === bun.status &&
    JSON.stringify(diagnostics(oxlint.stdout)) === JSON.stringify(diagnostics(bun.stdout))
  );
}

export async function checkLintParity(
  args: string[],
  env: NodeJS.ProcessEnv,
  oxlint: { status: number; stdout: string },
  maxBytes: number,
) {
  const bun = resolveDevTool("lint", { ...env, CI: "", OPENCLAW_LINT_TOOL: "bun" });
  let stdout = "";
  let bytes = 0;
  const status = await runManagedCommand({
    bin: bun.command,
    args: [...bun.args, ...args],
    env: { ...bun.env, CI: env.CI },
    requireProcessTreeExit: process.platform !== "win32",
    stdio: ["inherit", "pipe", "inherit"],
    onReady(child) {
      if (!child.stdout) {
        throw new Error("Bun lint JSON report pipe is unavailable");
      }
      child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
        bytes += Buffer.byteLength(chunk);
        if (bytes <= maxBytes) {
          stdout += chunk;
        }
      });
    },
  });
  if (bytes > maxBytes || !compareLintResults(oxlint, { status, stdout })) {
    console.error(`[lint] parity failed\noxlint:\n${oxlint.stdout}\nBun:\n${stdout}`);
    return false;
  }
  return true;
}
