import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createMantisCommandRunner,
  requireArgAfter,
  writeMantisArtifacts,
} from "./run.test-support.js";
import {
  runMantisVisualDriver,
  runMantisVisualTask,
  type MantisVisualDriverOptions,
  type MantisVisualTaskOptions,
} from "./visual-task.runtime.js";

// mock-isolation: Preserve actual module exports and create a fresh managed-binary mock per suite.
vi.mock("@openclaw/crabbox-provider/cli-runtime-api.js", async () =>
  (await import("./run.test-support.js")).mockManagedCrabboxBinary(),
);

async function expectPathMissing(targetPath: string): Promise<void> {
  await expect(fs.stat(targetPath)).rejects.toMatchObject({ code: "ENOENT" });
}

function expectArgsContainSequence(args: readonly string[], expected: readonly string[]): void {
  const startIndex = args.findIndex((_, index) =>
    expected.every((value, offset) => args[index + offset] === value),
  );
  expect(startIndex).toBeGreaterThanOrEqual(0);
}

function recordingRunner(options: { video: boolean; error?: string }) {
  return createMantisCommandRunner(
    { id: "cbx_abc123", provider: "hetzner", slug: "brisk-mantis", state: "active" },
    async (command, args) => {
      if (command === "/tmp/crabbox" && args[0] === "record") {
        const outputDir = requireArgAfter(args, "--output-dir");
        await fs.mkdir(outputDir, { recursive: true });
        if (options.video) {
          const outputPath = requireArgAfter(args, "--output");
          await fs.mkdir(path.dirname(outputPath), { recursive: true });
          await fs.writeFile(outputPath, "mp4");
        }
        await writeMantisArtifacts(outputDir, {
          "visual-task.png": "png",
          "mantis-visual-task-driver-result.json": `${JSON.stringify({
            matched: true,
            status: "pass",
            vision: { mode: "metadata", timeoutMs: 120000 },
          })}\n`,
        });
        if (options.error) {
          throw new Error(options.error);
        }
      }
    },
  );
}

function driverRunner(text?: string) {
  const commands: { args: readonly string[]; command: string }[] = [];
  const envelope = JSON.stringify({ ok: true, outputs: [{ kind: "image.description", text }] });
  const runner = vi.fn(async (command: string, args: readonly string[]) => {
    commands.push({ command, args });
    if (command === "/tmp/crabbox" && args[0] === "screenshot") {
      const outputPath = requireArgAfter(args, "--output");
      await fs.mkdir(path.dirname(outputPath), { recursive: true });
      await fs.writeFile(outputPath, "png");
    }
    return {
      stdout:
        command === "pnpm" && text !== undefined
          ? `\n> openclaw qa mantis visual-driver --vision-prompt '{"visible": boolean}'\n${envelope}\n`
          : "",
      stderr: "",
    };
  });
  return { commands, runner };
}

describe("mantis visual task runtime", () => {
  let repoRoot: string;
  const outputDir = ".artifacts/qa-e2e/mantis/visual-test";
  const commonOptions = () => ({
    crabboxBin: "/tmp/crabbox",
    env: { PATH: process.env.PATH },
    outputDir,
    repoRoot,
    settleMs: 0,
  });
  const runTask = (options: MantisVisualTaskOptions) =>
    runMantisVisualTask({
      ...commonOptions(),
      visionMode: "metadata",
      ...options,
    });
  const runDriver = (options: MantisVisualDriverOptions) =>
    runMantisVisualDriver({
      ...commonOptions(),
      expectText: "Example Domain",
      leaseId: "cbx_abc123",
      visionMode: "image-describe",
      ...options,
    });

  beforeEach(async () => {
    vi.restoreAllMocks();
    vi.useRealTimers();
    repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), "mantis-visual-task-"));
  });

  afterEach(async () => {
    await fs.rm(repoRoot, { force: true, recursive: true });
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("records a visible browser task and keeps screenshot/video artifacts", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-05-04T12:00:00.000Z"));
    const { commands, runner } = recordingRunner({ video: true });

    const result = await runTask({ commandRunner: runner, duration: "12s", outputDir: undefined });

    expect(result.status).toBe("pass");
    expect(result.outputDir).toBe(
      path.join(repoRoot, ".artifacts/qa-e2e/mantis/visual-task-2026-05-04T12-00-00-000Z"),
    );
    const warmupArgs = commands.find((entry) => entry.args[0] === "warmup")?.args ?? [];
    expectArgsContainSequence(warmupArgs, ["--class", "beast"]);
    expect(commands.map((entry) => [entry.command, entry.args[0]])).toEqual(
      ["warmup", "inspect", "record", "stop"].map((action) => ["/tmp/crabbox", action]),
    );
    const recordArgs = commands.find((entry) => entry.args[0] === "record")?.args ?? [];
    const finalVideoPath = path.join(result.outputDir, "visual-task.mp4");
    expect(requireArgAfter(recordArgs, "--output-dir")).toBe(result.outputDir);
    const stagedVideoPath = requireArgAfter(recordArgs, "--output");
    expectArgsContainSequence(recordArgs, ["--duration", "12s"]);
    expectArgsContainSequence(recordArgs, [
      "--while",
      "--",
      "pnpm",
      "--dir",
      repoRoot,
      "openclaw",
      "qa",
      "mantis",
      "visual-driver",
    ]);
    expect(stagedVideoPath).not.toBe(finalVideoPath);
    expect(path.basename(stagedVideoPath)).toContain(path.basename(finalVideoPath));
    expect(path.basename(stagedVideoPath)).toMatch(/\.part$/);
    await expectPathMissing(stagedVideoPath);
    await expect(fs.readFile(result.screenshotPath ?? "", "utf8")).resolves.toBe("png");
    await expect(fs.readFile(result.videoPath ?? "", "utf8")).resolves.toBe("mp4");
    expect(JSON.parse(await fs.readFile(result.summaryPath, "utf8"))).toMatchObject({
      crabbox: {
        id: "cbx_abc123",
        vncCommand: "/tmp/crabbox vnc --provider hetzner --id cbx_abc123 --open",
      },
      status: "pass",
      visionMode: "metadata",
    });
  });

  it.each([false, true])(
    "preserves available artifacts after recording fails (video=%s)",
    async (video) => {
      const error = video
        ? "crabbox record failed after writing video"
        : "crabbox record failed after driver exit";
      const { commands, runner } = recordingRunner({ video, error });
      const result = await runTask({ commandRunner: runner });
      expect(result.status).toBe("fail");
      const summary = JSON.parse(await fs.readFile(result.summaryPath, "utf8"));
      expect(summary).toMatchObject({
        error,
        recording: { error, required: true },
        status: "fail",
      });
      if (video) {
        expect(result.videoPath).toBe(path.join(repoRoot, outputDir, "visual-task.mp4"));
        await expect(fs.readFile(result.videoPath ?? "", "utf8")).resolves.toBe("mp4");
        const recordArgs = commands.find((entry) => entry.args[0] === "record")?.args ?? [];
        await expectPathMissing(requireArgAfter(recordArgs, "--output"));
        expect(summary.artifacts.videoPath).toBe(result.videoPath);
      } else {
        expect(summary.crabbox).toEqual({
          bin: "/tmp/crabbox",
          createdLease: true,
          id: "cbx_abc123",
          provider: "hetzner",
          slug: "brisk-mantis",
          state: "active",
          vncCommand: "/tmp/crabbox vnc --provider hetzner --id cbx_abc123 --open",
        });
        expect(result.videoPath).toBeUndefined();
        expect(commands.map((entry) => [entry.command, entry.args[0]])).toEqual(
          ["warmup", "inspect", "record"].map((action) => ["/tmp/crabbox", action]),
        );
      }
    },
  );

  it("drives a lease, screenshots it, and verifies image-describe text", async () => {
    const { commands, runner } = driverRunner(
      JSON.stringify({
        evidence: 'The page heading reads "Example Domain".',
        reason: "The expected text is visible as the main heading.",
        visible: true,
      }),
    );

    const result = await runDriver({
      browserUrl: "https://example.net",
      commandRunner: runner,
      visionModel: "openai/gpt-5.4",
      visionPrompt: "Read the page title",
    });

    expect(result.status).toBe("pass");
    expect(commands.map((entry) => [entry.command, entry.args[0], entry.args[1]])).toEqual([
      ["/tmp/crabbox", "desktop", "launch"],
      ["/tmp/crabbox", "screenshot", "--provider"],
      ["pnpm", "--dir", repoRoot],
    ]);
    const launchArgs = commands.find((entry) => entry.args[0] === "desktop")?.args ?? [];
    const launchShellIndex = launchArgs.findIndex((arg) => arg === "--");
    expect(launchArgs.slice(launchShellIndex, launchShellIndex + 3)).toEqual(["--", "sh", "-lc"]);
    expect(launchArgs[launchShellIndex + 3]).toContain("--no-first-run");
    const visionArgs = commands.find((entry) => entry.command === "pnpm")?.args ?? [];
    expectArgsContainSequence(visionArgs, [
      "openclaw",
      "infer",
      "image",
      "describe",
      "--file",
      path.join(repoRoot, outputDir, "visual-task.png"),
    ]);
    expect(requireArgAfter(visionArgs, "--prompt")).toContain("return only valid JSON");
    expect(requireArgAfter(visionArgs, "--model")).toBe("openai/gpt-5.4");
    expect(result.vision.assertion).toMatchObject({
      evidence: 'The page heading reads "Example Domain".',
      matched: true,
      visible: true,
    });
  });

  it("fails image-describe text checks when the model gives negative evidence that quotes the target", async () => {
    const { runner } = driverRunner('The screenshot does not contain "Example Domain".');

    const result = await runDriver({ commandRunner: runner });

    expect(result.matched).toBe(false);
    expect(result.status).toBe("fail");
    expect(result.vision.assertion).toMatchObject({
      matched: false,
      reason: "Image describe did not return a structured visual assertion.",
    });
  });

  it("fails metadata mode when text evidence is requested", async () => {
    const { runner } = driverRunner();

    const result = await runDriver({ commandRunner: runner, visionMode: "metadata" });

    expect(result.matched).toBe(false);
    expect(result.status).toBe("fail");
    expect(result.vision.mode).toBe("metadata");
  });
});
