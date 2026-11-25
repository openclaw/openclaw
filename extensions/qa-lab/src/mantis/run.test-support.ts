import fs from "node:fs/promises";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { vi } from "vitest";
import type { CommandRunner, CrabboxInspect } from "./crabbox-runtime.js";
import type { MantisCommandResult, MantisCommandRunner } from "./run-command.runtime.js";

export async function mockManagedCrabboxBinary() {
  const actual = await vi.importActual<
    typeof import("@openclaw/crabbox-provider/cli-runtime-api.js")
  >("@openclaw/crabbox-provider/cli-runtime-api.js");
  return {
    ...actual,
    ensureManagedCrabboxBinary: vi.fn(async ({ binary }: { binary: string }) => ({
      binary,
      version: "999.0.0",
    })),
  };
}

export function createMantisCommandRunner(
  inspect: CrabboxInspect & { id: string },
  onCommand: (...args: Parameters<CommandRunner>) => Promise<void>,
) {
  const commands: { command: string; args: readonly string[]; env?: NodeJS.ProcessEnv }[] = [];
  const runner = vi.fn<CommandRunner>(async (command, args, options) => {
    commands.push({ command, args, env: options.env });
    await onCommand(command, args, options);
    const stdout =
      command !== "/tmp/crabbox"
        ? ""
        : args[0] === "warmup"
          ? `ready lease ${inspect.id}\n`
          : args[0] === "inspect"
            ? `${JSON.stringify(inspect)}\n`
            : "";
    return { stdout, stderr: "" };
  });
  return { commands, runner };
}

export async function writeMantisArtifacts(outputDir: string, artifacts: Record<string, string>) {
  await fs.mkdir(outputDir, { recursive: true });
  for (const [name, content] of Object.entries(artifacts)) {
    await fs.writeFile(path.join(outputDir, name), content);
  }
}

export function requireArgAfter(args: readonly string[], flag: string): string {
  const index = args.indexOf(flag);
  if (index < 0) {
    throw new Error(`expected ${flag} argument`);
  }
  return expectDefined(args[index + 1], `${flag} argument value`);
}

export type StubCommandResult = MantisCommandResult;

export function successfulCommandResult(stdout = ""): StubCommandResult {
  return { code: 0, killed: false, signal: null, stderr: "", stdout, termination: "exit" };
}

export function failedCommandResult(code = 1): StubCommandResult {
  return { ...successfulCommandResult(), code };
}

export async function mockMantisSetupCommand(
  ...[command, args, execution]: Parameters<MantisCommandRunner>
) {
  if (command === "git" && execution.stage === "worktree-add") {
    await fs.mkdir(String(args[4]), { recursive: true });
  } else if (command === "git" && execution.stage === "worktree-cleanup" && args[1] === "remove") {
    await fs.rm(execution.cwd, { force: true, recursive: true });
  }
  return successfulCommandResult();
}

export function worktreeListOutput(worktreeDir: string): string {
  return `worktree ${worktreeDir}\0HEAD 0000000000000000000000000000000000000000\0detached\0\0`;
}

export async function writeLegacyLaneSummary(params: {
  args: readonly string[];
  scenario: string;
}) {
  const repoRootArg = requireArgAfter(params.args, "--repo-root");
  const outputDirArg = requireArgAfter(params.args, "--output-dir");
  const lane = outputDirArg.endsWith("baseline") ? "baseline" : "candidate";
  const scenario = { id: params.scenario, status: lane === "baseline" ? "fail" : "pass" };
  await writeMantisArtifacts(path.join(repoRootArg, outputDirArg), {
    "discord-qa-summary.json": `${JSON.stringify({ scenarios: [scenario] }, null, 2)}\n`,
  });
}
