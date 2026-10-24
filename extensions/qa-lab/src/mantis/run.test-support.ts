// Qa Lab test support builds Mantis command results and lane summaries.
import fs from "node:fs/promises";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { vi } from "vitest";
import type { CommandRunner, CrabboxInspect } from "./crabbox-runtime.js";

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
  const commands: Array<{
    command: string;
    args: readonly string[];
    env?: NodeJS.ProcessEnv;
  }> = [];
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

export type StubCommandResult = {
  code: number | null;
  killed: boolean;
  signal: NodeJS.Signals | null;
  stderr: string;
  stdout: string;
  stdoutTruncatedBytes?: number;
  termination: "exit" | "timeout" | "no-output-timeout" | "signal";
};

export function successfulCommandResult(stdout = ""): StubCommandResult {
  return { code: 0, killed: false, signal: null, stderr: "", stdout, termination: "exit" };
}

export function failedCommandResult(code = 1): StubCommandResult {
  return { code, killed: false, signal: null, stderr: "", stdout: "", termination: "exit" };
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
  const outputDir = path.join(repoRootArg, outputDirArg);
  await fs.mkdir(outputDir, { recursive: true });
  await fs.writeFile(
    path.join(outputDir, "discord-qa-summary.json"),
    `${JSON.stringify(
      { scenarios: [{ id: params.scenario, status: lane === "baseline" ? "fail" : "pass" }] },
      null,
      2,
    )}\n`,
  );
}
