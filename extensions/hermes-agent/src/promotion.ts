import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { relative, resolve } from "node:path";

export type HermesPromotionStage = "staging" | "promoted" | "rolled_back";
export type HermesPromotionCommandRunner = (
  argv: string[],
  options: { cwd: string; timeoutMs: number },
) => Promise<{ code: number }>;

export type HermesPromotionResult = {
  trace_id: string;
  from: HermesPromotionStage;
  to: HermesPromotionStage;
  validation_commands: string[];
  validation_passed: boolean;
  rollback_required: boolean;
  created_at: string;
};

export async function runHermesPromotionGate(params: {
  repoRoot: string;
  traceId: string;
  validationCommands: string[];
  commandRunner?: HermesPromotionCommandRunner;
  timeoutMs?: number;
  outputDir?: string;
}): Promise<{ path: string; result: HermesPromotionResult }> {
  const timeoutMs = Math.max(5_000, params.timeoutMs ?? 120_000);
  const validationCommands = params.validationCommands.map((cmd) => cmd.trim()).filter(Boolean);
  if (validationCommands.length === 0) {
    throw new Error("Hermes promotion gate requires at least one validation command");
  }

  let validationPassed = true;
  const commandRunner = params.commandRunner ?? runHermesCommandWithTimeout;
  for (const command of validationCommands) {
    const exec = await commandRunner(["powershell", "-NoProfile", "-Command", command], {
      cwd: params.repoRoot,
      timeoutMs,
    });
    if (exec.code !== 0) {
      validationPassed = false;
      break;
    }
  }

  const now = new Date();
  const result: HermesPromotionResult = {
    trace_id: params.traceId,
    from: "staging",
    to: validationPassed ? "promoted" : "rolled_back",
    validation_commands: validationCommands,
    validation_passed: validationPassed,
    rollback_required: !validationPassed,
    created_at: now.toISOString(),
  };

  const outputDir = ensureInsideWorkspace(
    params.repoRoot,
    params.outputDir ?? "reports/hermes-agent/state",
  );
  await mkdir(outputDir, { recursive: true });
  const filePath = resolve(outputDir, `${params.traceId}-promotion.json`);
  await writeFile(filePath, `${JSON.stringify(result, null, 2)}\n`, "utf8");
  return { path: filePath, result };
}

function runHermesCommandWithTimeout(
  argv: string[],
  options: { cwd: string; timeoutMs: number },
): Promise<{ code: number }> {
  return new Promise((resolveResult) => {
    const child = spawn(argv[0] ?? "", argv.slice(1), {
      cwd: options.cwd,
      stdio: "ignore",
      windowsHide: true,
    });
    let settled = false;
    const timeout = setTimeout(() => {
      if (settled) {
        return;
      }
      child.kill("SIGKILL");
    }, options.timeoutMs);

    child.on("error", () => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      resolveResult({ code: 1 });
    });
    child.on("close", (code, signal) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      resolveResult({ code: code ?? (signal ? 1 : 0) });
    });
  });
}

function ensureInsideWorkspace(repoRoot: string, outputDir: string): string {
  const resolvedRoot = resolve(repoRoot);
  const resolvedOutput = resolve(resolvedRoot, outputDir);
  const relativePath = relative(resolvedRoot, resolvedOutput);
  if (relativePath === "" || (!relativePath.startsWith("..") && !relativePath.includes(":"))) {
    return resolvedOutput;
  }
  throw new Error(`Hermes output directory must stay inside the workspace: ${outputDir}`);
}
