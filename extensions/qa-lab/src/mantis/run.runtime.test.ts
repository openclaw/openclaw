// Qa Lab tests cover run plugin behavior.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { root } from "openclaw/plugin-sdk/security-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { toRepoArtifactPath } from "../cli-paths.js";
import { createQaEvidenceInvocation } from "../evidence-invocation.js";
import { QA_EVIDENCE_FILENAME, buildQaSuiteEvidenceSummary } from "../evidence-summary.js";
import { publishMantisRunOutput } from "./run-artifacts.runtime.js";
import type { MantisCommandRunner } from "./run-command.runtime.js";
import { runMantisBeforeAfter, type MantisBeforeAfterOptions } from "./run.runtime.js";
import {
  failedCommandResult,
  requireArgAfter,
  successfulCommandResult,
  writeLegacyLaneSummary,
  worktreeListOutput,
} from "./run.test-support.js";

const stableFiles = ["comparison.json", "mantis-report.md", "mantis-evidence.json"];
const readText = (file: string) => fs.readFile(file, "utf8");
const readJson = async (file: string): Promise<unknown> => JSON.parse(await readText(file));
const expectMissing = async (file: string) =>
  expect(fs.stat(file)).rejects.toMatchObject({ code: "ENOENT" });

function laneRunner(
  writeEvidence: (args: readonly string[]) => Promise<void>,
  observe?: (...args: Parameters<MantisCommandRunner>) => void,
) {
  return vi.fn<MantisCommandRunner>(async (command, args, execution) => {
    await observe?.(command, args, execution);
    if (command === "git" && execution.stage === "worktree-add") {
      await fs.mkdir(String(args[4]), { recursive: true });
    } else if (
      command === "git" &&
      execution.stage === "worktree-cleanup" &&
      args[1] === "remove"
    ) {
      await fs.rm(execution.cwd, { force: true, recursive: true });
    } else if (command === "pnpm" && args.includes("openclaw")) {
      await writeEvidence(args);
    }
    return successfulCommandResult();
  });
}

async function publicationFixture(outputDir: string, runId: string) {
  const relative = `.mantis-staged-${runId}`;
  const staging = { dir: path.join(outputDir, relative), relative };
  for (const [directory, prefix] of [
    [outputDir, "old"],
    [staging.dir, "new"],
  ] as const) {
    for (const lane of ["baseline", "candidate"]) {
      await fs.mkdir(path.join(directory, lane), { recursive: true });
      await fs.writeFile(path.join(directory, lane, `${prefix}.txt`), `${prefix} ${lane}`);
    }
    for (const name of stableFiles) {
      await fs.writeFile(path.join(directory, name), `${prefix} ${name}`);
    }
  }
  return { staging, outputRoot: await root(outputDir) };
}

describe("mantis before/after runtime", () => {
  let repoRoot: string;
  const run = (options: MantisBeforeAfterOptions) =>
    runMantisBeforeAfter({
      baseline: "baseline-ref",
      candidate: "candidate-ref",
      repoRoot,
      now: () => new Date("2026-05-03T12:00:00.000Z"),
      skipBuild: true,
      skipInstall: true,
      ...options,
    });

  beforeEach(async () => {
    repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), "mantis-before-after-"));
  });

  afterEach(async () => {
    await fs.rm(repoRoot, { force: true, recursive: true });
  });

  it.each(["repo-root-token-outside-lane"] as const)(
    "runs baseline and candidate worktrees and writes stable comparison artifacts (%s)",
    async () => {
      const outputDir = path.join(repoRoot, ".artifacts", "qa-e2e", "mantis", "test-run");
      await fs.mkdir(outputDir, { recursive: true });
      await fs.writeFile(path.join(outputDir, "error.txt"), "stale failure", "utf8");
      await fs.writeFile(path.join(outputDir, "unrelated.txt"), "preserve me", "utf8");
      const commands: { args: readonly string[]; command: string; stage: string }[] = [];
      const runner = laneRunner(
        async (args) => {
          const repoRootArg = requireArgAfter(args, "--repo-root");
          const outputDirArg = requireArgAfter(args, "--output-dir");
          const lane = outputDirArg.endsWith("baseline") ? "baseline" : "candidate";
          const laneOutputDir = path.join(repoRootArg, outputDirArg);
          await fs.mkdir(laneOutputDir, { recursive: true });
          const artifactDir = path.join(repoRootArg, ".artifacts", "capture");
          await fs.mkdir(artifactDir, { recursive: true });
          const screenshotPath = path.join(artifactDir, `${lane}-timeline.png`);
          const videoPath = path.join(artifactDir, `${lane}-timeline.mp4`);
          const evidencePath = (artifactPath: string) =>
            toRepoArtifactPath(repoRootArg, artifactPath);
          await fs.writeFile(screenshotPath, `${lane} screenshot`);
          await fs.writeFile(videoPath, `${lane} video`);
          const title = "Discord explicit status reactions run in tool-only reply mode";
          const summary = buildQaSuiteEvidenceSummary({
            artifactPaths: [
              { kind: "summary", path: QA_EVIDENCE_FILENAME },
              { kind: "report", path: "discord-qa-report.md" },
              { kind: "screenshot", path: evidencePath(screenshotPath) },
              { kind: "video", path: evidencePath(videoPath) },
            ],
            channelDriver: "live",
            channelId: "discord",
            scenarioDefinitions: [
              {
                id: "discord-status-reactions-tool-only",
                title,
              },
            ],
            generatedAt: "2026-05-03T12:00:00.000Z",
            primaryModel: "openai/gpt-5.4",
            providerMode: "live-frontier",
            scenarioResults: [
              {
                details:
                  lane === "baseline"
                    ? "reaction timeline missing thinking/done"
                    : "reaction timeline matched queued -> thinking -> done",
                name: title,
                status: lane === "baseline" ? "fail" : "pass",
              },
            ],
          });
          await fs.writeFile(
            path.join(laneOutputDir, QA_EVIDENCE_FILENAME),
            `${JSON.stringify(summary, null, 2)}\n`,
          );
        },
        (command, args, execution) => {
          commands.push({ command, args, stage: execution.stage });
        },
      );

      const result = await run({
        baseline: "--lock",
        candidate: "--force",
        commandRunner: runner,
        outputDir: ".artifacts/qa-e2e/mantis/test-run",
      });

      expect(result.status).toBe("pass");
      expect(commands).toHaveLength(8);
      expect(commands.map((entry) => entry.stage)).toEqual([
        "worktree-add",
        "qa",
        "worktree-cleanup",
        "worktree-cleanup",
        "worktree-add",
        "qa",
        "worktree-cleanup",
        "worktree-cleanup",
      ]);
      const baselineWorktreeDir = String(commands[0]?.args[4]);
      const candidateWorktreeDir = String(commands[4]?.args[4]);
      expect(path.dirname(baselineWorktreeDir)).toBe(`${outputDir}.worktrees`);
      expect(path.basename(baselineWorktreeDir)).toMatch(/^baseline-/u);
      expect(path.dirname(candidateWorktreeDir)).toBe(`${outputDir}.worktrees`);
      expect(path.basename(candidateWorktreeDir)).toMatch(/^candidate-/u);
      for (const [index, directory, ref] of [
        [0, baselineWorktreeDir, "--lock"],
        [4, candidateWorktreeDir, "--force"],
      ] as const) {
        expect(commands[index]).toMatchObject({
          command: "git",
          args: ["worktree", "add", "--detach", "--", directory, ref],
        });
        expect(commands[index + 1]?.command).toBe("pnpm");
        expect(commands[index + 1]?.args.slice(0, 4)).toEqual([
          "--dir",
          directory,
          "openclaw",
          "qa",
        ]);
        expect(commands[index + 2]).toMatchObject({
          command: "git",
          args: ["worktree", "remove", "--force", "--", "."],
        });
        expect(commands[index + 3]?.args).toEqual(["worktree", "list", "--porcelain", "-z"]);
      }

      expect(await readJson(result.comparisonPath)).toMatchObject({
        baseline: { reproduced: true, status: "fail" },
        candidate: { fixed: true, status: "pass" },
        pass: true,
      });
      for (const lane of ["baseline", "candidate"]) {
        await expect(readText(path.join(result.outputDir, lane, `${lane}.png`))).resolves.toBe(
          `${lane} screenshot`,
        );
        await expect(readText(path.join(result.outputDir, lane, `${lane}.mp4`))).resolves.toBe(
          `${lane} video`,
        );
      }
      await expectMissing(path.join(result.outputDir, "error.txt"));
      await expect(fs.readFile(path.join(result.outputDir, "unrelated.txt"), "utf8")).resolves.toBe(
        "preserve me",
      );
      expect(
        (await fs.readdir(result.outputDir)).filter(
          (entry) => entry.startsWith(".mantis-staged-") || entry.startsWith(".mantis-previous-"),
        ),
      ).toEqual([]);
      await expectMissing(baselineWorktreeDir);
      await expectMissing(candidateWorktreeDir);
    },
  );

  it("rejects the repo root as an output container before preparing worktrees", async () => {
    const runner = vi.fn();
    await expect(
      runMantisBeforeAfter({
        commandRunner: runner,
        outputDir: ".",
        repoRoot,
      }),
    ).rejects.toThrow("--output-dir must stay within the repo root.");
    expect(runner).not.toHaveBeenCalled();
  });

  it("supports the Discord thread filePath attachment Mantis scenario", async () => {
    const runner = laneRunner(async (args) => {
      const repoRootArg = requireArgAfter(args, "--repo-root");
      const outputDirArg = requireArgAfter(args, "--output-dir");
      const lane = outputDirArg.endsWith("baseline") ? "baseline" : "candidate";
      const outputDir = path.join(repoRootArg, outputDirArg);
      await fs.mkdir(outputDir, { recursive: true });
      const screenshotPath = path.join(outputDir, `${lane}-thread-attachment.png`);
      await fs.writeFile(screenshotPath, `${lane} attachment screenshot`);
      await fs.writeFile(
        path.join(outputDir, "discord-qa-summary.json"),
        `${JSON.stringify(
          {
            scenarios: [
              {
                artifactPaths: { screenshot: screenshotPath },
                details:
                  lane === "baseline"
                    ? "thread reply omitted mantis-thread-report.md"
                    : "thread reply attached mantis-thread-report.md",
                id: "discord-thread-reply-filepath-attachment",
                status: lane === "baseline" ? "fail" : "pass",
              },
            ],
          },
          null,
          2,
        )}\n`,
      );
    });

    const result = await run({
      baseline: "bug-sha",
      candidate: "fix-sha",
      commandRunner: runner,
      outputDir: ".artifacts/qa-e2e/mantis/thread-run",
      scenario: "discord-thread-reply-filepath-attachment",
    });

    expect(result.status).toBe("pass");
    expect(await readJson(result.comparisonPath)).toMatchObject({
      baseline: { expected: "thread reply omits filePath attachment", reproduced: true },
      candidate: { expected: "thread reply includes filePath attachment", fixed: true },
      pass: true,
    });
    const manifest = JSON.parse(await fs.readFile(result.manifestPath, "utf8")) as {
      artifacts: { alt?: string; label: string }[];
      title: string;
    };
    expect(manifest.title).toBe("Mantis Discord Thread Attachment QA");
    const baselineArtifact = manifest.artifacts.find(
      (artifact) => artifact.label === "Baseline missing filePath attachment",
    );
    expect(baselineArtifact?.alt).toBe("Baseline Discord thread reply without filePath attachment");
    const candidateArtifact = manifest.artifacts.find(
      (artifact) => artifact.label === "Candidate includes filePath attachment",
    );
    expect(candidateArtifact?.alt).toBe("Candidate Discord thread reply with filePath attachment");
  });

  it("normalizes command timeout overrides per stage", async () => {
    const executions: { stage: string; timeoutMs: number }[] = [];
    const runner = laneRunner(
      async (args) => {
        await writeLegacyLaneSummary({ args, scenario: "discord-status-reactions-tool-only" });
      },
      (_command, _args, execution) => {
        executions.push({ stage: execution.stage, timeoutMs: execution.timeoutMs });
      },
    );

    await run({
      baseline: "bug-sha",
      candidate: "fix-sha",
      commandRunner: runner,
      commandTimeouts: {
        "worktree-add": 111,
        install: 222,
        build: 0,
        qa: 444,
        "worktree-cleanup": -1,
      },
      outputDir: ".artifacts/qa-e2e/mantis/override-deadlines",
      skipBuild: false,
      skipInstall: false,
    });

    expect(executions.slice(0, 6)).toEqual([
      { stage: "worktree-add", timeoutMs: 111 },
      { stage: "install", timeoutMs: 222 },
      { stage: "build", timeoutMs: 1_800_000 },
      { stage: "qa", timeoutMs: 444 },
      { stage: "worktree-cleanup", timeoutMs: expect.any(Number) },
      { stage: "worktree-cleanup", timeoutMs: expect.any(Number) },
    ]);
    for (const execution of executions.filter((entry) => entry.stage === "worktree-cleanup")) {
      expect(execution.timeoutMs).toBeGreaterThan(0);
      expect(execution.timeoutMs).toBeLessThanOrEqual(120_000);
    }
  });

  it("does not prepare or dispatch a worktree when already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const runner = vi.fn(async () => successfulCommandResult());
    const outputDir = path.join(repoRoot, ".artifacts", "qa-e2e", "mantis", "pre-aborted");

    await expect(
      run({
        commandRunner: runner,
        outputDir: ".artifacts/qa-e2e/mantis/pre-aborted",
        signal: controller.signal,
      }),
    ).rejects.toThrow("baseline worktree-add aborted");
    expect(runner).not.toHaveBeenCalled();
    await expect(fs.readdir(`${outputDir}.worktrees`)).resolves.toEqual([]);
  });

  it.each(["mantis-evidence.json"])(
    "restores prior evidence when publication is interrupted at %s",
    async (abortAt) => {
      const outputDir = path.join(repoRoot, ".artifacts", "publication-abort");
      const { staging, outputRoot } = await publicationFixture(outputDir, "abort");
      await fs.writeFile(path.join(outputDir, "error.txt"), "prior failure");
      const controller = new AbortController();
      const reason = new Error("publication interrupted");
      await expect(
        publishMantisRunOutput({
          outputRoot: {
            exists: outputRoot.exists.bind(outputRoot),
            mkdir: outputRoot.mkdir.bind(outputRoot),
            stat: outputRoot.stat.bind(outputRoot),
            async move(from, to, options) {
              await outputRoot.move(from, to, options);
              if (from === `${staging.relative}/${abortAt}`) {
                controller.abort(reason);
              }
            },
            remove: outputRoot.remove.bind(outputRoot),
          },
          runId: "abort",
          signal: controller.signal,
          staging,
        }),
      ).rejects.toBe(reason);
      for (const lane of ["baseline", "candidate"]) {
        await expect(fs.readFile(path.join(outputDir, lane, "old.txt"), "utf8")).resolves.toBe(
          `old ${lane}`,
        );
        await expectMissing(path.join(outputDir, lane, "new.txt"));
      }
      for (const name of stableFiles) {
        await expect(fs.readFile(path.join(outputDir, name), "utf8")).resolves.toBe(`old ${name}`);
      }
      await expect(fs.readFile(path.join(outputDir, "error.txt"), "utf8")).resolves.toBe(
        "prior failure",
      );
    },
  );

  it("rolls the complete stable artifact set back when publication fails", async () => {
    const outputDir = path.join(repoRoot, ".artifacts", "qa-e2e", "mantis", "rollback");
    const externalDir = path.join(repoRoot, "operator-artifacts");
    await fs.mkdir(externalDir);
    await fs.writeFile(path.join(externalDir, "keep.txt"), "external artifact");
    const { staging, outputRoot } = await publicationFixture(outputDir, "test");
    await fs.symlink(
      externalDir,
      path.join(staging.dir, "baseline", "external"),
      process.platform === "win32" ? "junction" : "dir",
    );
    const publicationError = new Error("candidate publication failed");
    const restorationError = new Error("baseline restoration failed");

    await expect(
      publishMantisRunOutput({
        outputRoot: {
          exists: outputRoot.exists.bind(outputRoot),
          mkdir: outputRoot.mkdir.bind(outputRoot),
          move: vi.fn(async (from, to, options) => {
            if (from === `${staging.relative}/candidate` && to === "candidate") {
              throw publicationError;
            }
            if (from === `.mantis-previous-test/baseline` && to === "baseline") {
              throw restorationError;
            }
            await outputRoot.move(from, to, options);
          }),
          remove: outputRoot.remove.bind(outputRoot),
          stat: outputRoot.stat.bind(outputRoot),
        },
        runId: "test",
        staging,
      }),
    ).rejects.toSatisfy((error) => {
      expect(error).toBeInstanceOf(AggregateError);
      expect((error as AggregateError).errors).toEqual(
        expect.arrayContaining([publicationError, restorationError]),
      );
      expect((error as Error).message).toContain(".mantis-previous-*");
      return true;
    });

    await expect(fs.readFile(path.join(outputDir, "candidate", "old.txt"), "utf8")).resolves.toBe(
      "old candidate",
    );
    for (const fileName of stableFiles) {
      await expect(fs.readFile(path.join(outputDir, fileName), "utf8")).resolves.toBe(
        `old ${fileName}`,
      );
    }
    expect(
      (await fs.readdir(outputDir)).filter((entry) => entry.startsWith(".mantis-staged-")),
    ).toEqual([]);
    await expect(
      fs.readFile(path.join(outputDir, ".mantis-previous-test", "baseline", "old.txt"), "utf8"),
    ).resolves.toBe("old baseline");
    await expect(fs.readFile(path.join(externalDir, "keep.txt"), "utf8")).resolves.toBe(
      "external artifact",
    );
  });

  it("retains the owned worktree and writes diagnostics when cleanup fails", async () => {
    const outputDir = path.join(repoRoot, ".artifacts", "qa-e2e", "mantis", "cleanup-failure");
    let baselineWorktreeDir = "";
    const runner = vi.fn(async (command: string, args: readonly string[], execution) => {
      if (command === "git" && execution.stage === "worktree-add") {
        baselineWorktreeDir = String(args[4]);
        await fs.mkdir(baselineWorktreeDir, { recursive: true });
        return successfulCommandResult();
      }
      if (command === "pnpm" && execution.stage === "qa") {
        await writeLegacyLaneSummary({ args, scenario: "discord-status-reactions-tool-only" });
        return successfulCommandResult();
      }
      if (command === "git" && execution.stage === "worktree-cleanup") {
        if (args[1] === "remove") {
          return failedCommandResult();
        }
        return successfulCommandResult(worktreeListOutput(baselineWorktreeDir));
      }
      throw new Error(`unexpected ${execution.stage} command`);
    });

    await expect(
      run({
        commandRunner: runner,
        outputDir: ".artifacts/qa-e2e/mantis/cleanup-failure",
      }),
    ).rejects.toThrow("baseline worktree cleanup left registered path");

    await expect(fs.readFile(path.join(outputDir, "error.txt"), "utf8")).resolves.toContain(
      "baseline worktree cleanup left registered path",
    );
    await expect(fs.stat(baselineWorktreeDir)).resolves.toBeDefined();
  });

  it("keeps workload failure first when cleanup also fails", async () => {
    const workloadError = new Error("workload failed");
    const cleanupError = new Error("cleanup failed");
    const runner = vi.fn(async (_command: string, _args: readonly string[], execution) => {
      if (execution.stage === "worktree-add") {
        throw workloadError;
      }
      throw cleanupError;
    });

    const result = await run({
      commandRunner: runner,
      outputDir: ".artifacts/qa-e2e/mantis/aggregate-failure",
    }).then(
      () => ({ status: "fulfilled" as const }),
      (error: unknown) => ({ error, status: "rejected" as const }),
    );

    expect(result.status).toBe("rejected");
    if (result.status === "rejected") {
      expect(result.error).toBeInstanceOf(AggregateError);
      const aggregate = result.error as AggregateError;
      const errorPath = path.join(repoRoot, ".artifacts/qa-e2e/mantis/aggregate-failure/error.txt");
      expect(aggregate.message).toContain("Mantis lane failed and worktree cleanup failed");
      expect(aggregate.message).toContain(errorPath);
      expect(aggregate.cause).toBeInstanceOf(Error);
      expect((aggregate.cause as Error).message).toContain("baseline worktree-add failed to run");
      expect(aggregate.errors).toHaveLength(2);
      expect(aggregate.errors[0]).toBe(aggregate.cause);
      expect(aggregate.errors[1]).toBeInstanceOf(Error);
      expect((aggregate.errors[1] as Error).message).toContain(
        "baseline worktree cleanup could not verify complete registration state",
      );
    }
  });

  it.each(["unresolved first", "different first owner", "malformed existing file"])(
    "does not promote a later pass or legacy fallback for %s",
    async (caseName) => {
      const scenarioId = "discord-status-reactions-tool-only";
      const runner = laneRunner(async (args) => {
        const laneRoot = requireArgAfter(args, "--repo-root");
        const outputArg = requireArgAfter(args, "--output-dir");
        const outputDir = path.join(laneRoot, outputArg);
        await fs.mkdir(outputDir, { recursive: true });
        const invocation = createQaEvidenceInvocation({
          scenarios: [
            {
              id: caseName === "different first owner" ? "another-scenario" : scenarioId,
              execution: { kind: "script" },
            },
            { id: scenarioId, execution: { kind: "script" } },
          ],
          channel: "discord",
          launch: {
            source: { ref: null, integrity: null },
            runtime: { id: null, version: null },
            package: null,
            protocol: null,
            accountRef: null,
            proofClass: null,
          },
        });
        const first = invocation.begin(0);
        const status = outputArg.endsWith("baseline") ? "fail" : "pass";
        if (caseName !== "unresolved first" || status === "fail") {
          invocation.complete(first, {
            status,
            entries: [
              {
                test: { kind: "script", id: scenarioId, title: "First" },
                coverage: [],
                result: { status },
              },
            ],
          });
          invocation.select(0, first);
        }
        const later = invocation.begin(1);
        invocation.complete(later, {
          status: "pass",
          entries: [
            {
              test: { kind: "script", id: scenarioId, title: "Later" },
              coverage: [],
              result: { status: "pass" },
            },
          ],
        });
        invocation.select(1, later);
        const evidence = invocation.snapshot({ generatedAt: "2026-09-13T00:00:00.000Z" });
        if (caseName === "malformed existing file") {
          const entry = evidence.entries[0];
          if (!entry) {
            throw new Error("Expected an evidence entry for malformed-file fixture");
          }
          entry.binding.occurrenceId = "absent";
        }
        await fs.writeFile(path.join(outputDir, QA_EVIDENCE_FILENAME), JSON.stringify(evidence));
        await fs.writeFile(
          path.join(outputDir, "discord-qa-summary.json"),
          JSON.stringify({
            scenarios: [{ id: scenarioId, status: "pass" }],
          }),
        );
      });
      const resultPromise = run({
        commandRunner: runner,
        outputDir: ".artifacts/mantis-occurrences",
        baseline: undefined,
        candidate: undefined,
      });
      if (caseName === "malformed existing file") {
        await expect(resultPromise).rejects.toThrow();
      } else {
        const result = await resultPromise;
        expect(result.status).toBe("fail");
        const comparison = JSON.parse(await fs.readFile(result.comparisonPath, "utf8"));
        expect(comparison.candidate.status).toBe("unknown");
        expect(comparison.candidate.fixed).toBe(false);
      }
    },
  );
});
