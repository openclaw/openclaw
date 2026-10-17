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
const writeJson = (file: string, value: unknown) =>
  fs.writeFile(file, `${JSON.stringify(value, null, 2)}\n`);
const expectMissing = async (file: string) =>
  expect(fs.stat(file)).rejects.toMatchObject({ code: "ENOENT" });
const expectText = async (directory: string, name: string, value: string) =>
  expect(readText(path.join(directory, name))).resolves.toBe(value);
const scenarioId = "discord-status-reactions-tool-only";
const threadScenario = "discord-thread-reply-filepath-attachment";
type LaneFixture = {
  args: readonly string[];
  repoRoot: string;
  outputDir: string;
  lane: string;
  status: "fail" | "pass";
};

function laneRunner(writeEvidence: (fixture: LaneFixture) => Promise<void>) {
  return vi.fn<MantisCommandRunner>(async (command, args, execution) => {
    if (command === "git" && execution.stage === "worktree-add") {
      await fs.mkdir(String(args[4]), { recursive: true });
    } else if (
      command === "git" &&
      execution.stage === "worktree-cleanup" &&
      args[1] === "remove"
    ) {
      await fs.rm(execution.cwd, { force: true, recursive: true });
    } else if (command === "pnpm" && args.includes("openclaw")) {
      const repoRoot = requireArgAfter(args, "--repo-root");
      const outputArg = requireArgAfter(args, "--output-dir");
      const lane = outputArg.endsWith("baseline") ? "baseline" : "candidate";
      const status = lane === "baseline" ? "fail" : "pass";
      const outputDir = path.join(repoRoot, outputArg);
      await fs.mkdir(outputDir, { recursive: true });
      await writeEvidence({ args, repoRoot, outputDir, lane, status });
    }
    return successfulCommandResult();
  });
}

type PublicationRoot = Parameters<typeof publishMantisRunOutput>[0]["outputRoot"];
function bindPublicationRoot(
  outputRoot: PublicationRoot,
  move: PublicationRoot["move"],
): PublicationRoot {
  return {
    exists: outputRoot.exists.bind(outputRoot),
    mkdir: outputRoot.mkdir.bind(outputRoot),
    stat: outputRoot.stat.bind(outputRoot),
    remove: outputRoot.remove.bind(outputRoot),
    move,
  };
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
  const artifactDir = (name: string) => path.join(repoRoot, ".artifacts/qa-e2e/mantis", name);

  beforeEach(async () => {
    repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), "mantis-before-after-"));
  });

  afterEach(() => fs.rm(repoRoot, { force: true, recursive: true }));

  it("runs both worktrees and writes stable comparison artifacts outside lane roots", async () => {
    const outputDir = artifactDir("test-run");
    await fs.mkdir(outputDir, { recursive: true });
    await fs.writeFile(path.join(outputDir, "error.txt"), "stale failure", "utf8");
    await fs.writeFile(path.join(outputDir, "unrelated.txt"), "preserve me", "utf8");
    const runner = laneRunner(
      async ({ repoRoot: repoRootArg, outputDir: laneOutputDir, lane, status }) => {
        const captureDir = path.join(repoRootArg, ".artifacts", "capture");
        await fs.mkdir(captureDir, { recursive: true });
        const screenshotPath = path.join(captureDir, `${lane}-timeline.png`);
        const videoPath = path.join(captureDir, `${lane}-timeline.mp4`);
        await fs.writeFile(screenshotPath, `${lane} screenshot`);
        await fs.writeFile(videoPath, `${lane} video`);
        const title = "Discord explicit status reactions run in tool-only reply mode";
        const summary = buildQaSuiteEvidenceSummary({
          artifactPaths: [
            { kind: "summary", path: QA_EVIDENCE_FILENAME },
            { kind: "report", path: "discord-qa-report.md" },
            { kind: "screenshot", path: toRepoArtifactPath(repoRootArg, screenshotPath) },
            { kind: "video", path: toRepoArtifactPath(repoRootArg, videoPath) },
          ],
          channelId: "discord",
          scenarioDefinitions: [{ id: scenarioId, title }],
          generatedAt: "2026-05-03T12:00:00.000Z",
          primaryModel: "openai/gpt-5.4",
          providerMode: "live-frontier",
          scenarioResults: [{ details: `${lane} timeline`, name: title, status }],
        });
        await writeJson(path.join(laneOutputDir, QA_EVIDENCE_FILENAME), summary);
      },
    );

    const result = await run({
      baseline: "--lock",
      candidate: "--force",
      commandRunner: runner,
      outputDir: ".artifacts/qa-e2e/mantis/test-run",
    });

    expect(result.status).toBe("pass");
    const commands = runner.mock.calls;
    expect(commands).toHaveLength(8);
    const baselineWorktreeDir = String(commands[0]?.[1][4]);
    const candidateWorktreeDir = String(commands[4]?.[1][4]);
    for (const [index, directory, ref, lane] of [
      [0, baselineWorktreeDir, "--lock", "baseline"],
      [4, candidateWorktreeDir, "--force", "candidate"],
    ] as const) {
      expect(path.dirname(directory)).toBe(`${outputDir}.worktrees`);
      expect(path.basename(directory)).toMatch(new RegExp(`^${lane}-`, "u"));
      const laneCommands = commands
        .slice(index, index + 4)
        .map(([command, args, { stage }], position) => ({
          command,
          stage,
          args: position === 1 ? args.slice(0, 4) : args,
        }));
      expect(laneCommands).toMatchObject([
        {
          stage: "worktree-add",
          command: "git",
          args: ["worktree", "add", "--detach", "--", directory, ref],
        },
        { stage: "qa", command: "pnpm", args: ["--dir", directory, "openclaw", "qa"] },
        {
          stage: "worktree-cleanup",
          command: "git",
          args: ["worktree", "remove", "--force", "--", "."],
        },
        { stage: "worktree-cleanup", args: ["worktree", "list", "--porcelain", "-z"] },
      ]);
    }

    expect(await readJson(result.comparisonPath)).toMatchObject({
      baseline: { reproduced: true, status: "fail" },
      candidate: { fixed: true, status: "pass" },
      pass: true,
    });
    for (const lane of ["baseline", "candidate"]) {
      const directory = path.join(result.outputDir, lane);
      await expectText(directory, `${lane}.png`, `${lane} screenshot`);
      await expectText(directory, `${lane}.mp4`, `${lane} video`);
    }
    await expectMissing(path.join(result.outputDir, "error.txt"));
    await expectText(result.outputDir, "unrelated.txt", "preserve me");
    expect(
      (await fs.readdir(result.outputDir)).filter(
        (entry) => entry.startsWith(".mantis-staged-") || entry.startsWith(".mantis-previous-"),
      ),
    ).toEqual([]);
    await expectMissing(baselineWorktreeDir);
    await expectMissing(candidateWorktreeDir);
  });

  it("rejects the repo root as an output container before preparing worktrees", async () => {
    const runner = vi.fn();
    await expect(
      runMantisBeforeAfter({ commandRunner: runner, outputDir: ".", repoRoot }),
    ).rejects.toThrow("--output-dir must stay within the repo root.");
    expect(runner).not.toHaveBeenCalled();
  });

  it("supports the Discord thread filePath attachment Mantis scenario", async () => {
    const runner = laneRunner(async ({ outputDir, lane, status }) => {
      const screenshotPath = path.join(outputDir, `${lane}-thread-attachment.png`);
      await fs.writeFile(screenshotPath, `${lane} attachment screenshot`);
      await writeJson(path.join(outputDir, "discord-qa-summary.json"), {
        scenarios: [
          {
            artifactPaths: { screenshot: screenshotPath },
            details: `${lane} thread reply`,
            id: threadScenario,
            status,
          },
        ],
      });
    });

    const result = await run({
      commandRunner: runner,
      outputDir: ".artifacts/qa-e2e/mantis/thread-run",
      scenario: threadScenario,
    });

    expect(result.status).toBe("pass");
    expect(await readJson(result.comparisonPath)).toMatchObject({
      baseline: { expected: "thread reply omits filePath attachment", reproduced: true },
      candidate: { expected: "thread reply includes filePath attachment", fixed: true },
      pass: true,
    });
    const manifest: { title: string; artifacts: { label: string; alt?: string }[] } = JSON.parse(
      await readText(result.manifestPath),
    );
    expect(manifest.title).toBe("Mantis Discord Thread Attachment QA");
    for (const [label, alt] of [
      [
        "Baseline missing filePath attachment",
        "Baseline Discord thread reply without filePath attachment",
      ],
      [
        "Candidate includes filePath attachment",
        "Candidate Discord thread reply with filePath attachment",
      ],
    ]) {
      expect(manifest.artifacts.find((artifact) => artifact.label === label)?.alt).toBe(alt);
    }
  });

  it("normalizes command timeout overrides per stage", async () => {
    const runner = laneRunner(({ args }) => writeLegacyLaneSummary({ args, scenario: scenarioId }));

    await run({
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

    const executions = runner.mock.calls.map((call) => call[2]);
    expect(executions.slice(0, 6)).toMatchObject([
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
    const outputDir = artifactDir("pre-aborted");

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

  it("restores prior evidence when manifest publication is interrupted", async () => {
    const outputDir = path.join(repoRoot, ".artifacts", "publication-abort");
    const { staging, outputRoot } = await publicationFixture(outputDir, "abort");
    await fs.writeFile(path.join(outputDir, "error.txt"), "prior failure");
    const controller = new AbortController();
    const reason = new Error("publication interrupted");
    await expect(
      publishMantisRunOutput({
        outputRoot: bindPublicationRoot(outputRoot, async (from, to, options) => {
          await outputRoot.move(from, to, options);
          if (from === `${staging.relative}/mantis-evidence.json`) {
            controller.abort(reason);
          }
        }),
        runId: "abort",
        signal: controller.signal,
        staging,
      }),
    ).rejects.toBe(reason);
    for (const lane of ["baseline", "candidate"]) {
      await expectText(path.join(outputDir, lane), "old.txt", `old ${lane}`);
      await expectMissing(path.join(outputDir, lane, "new.txt"));
    }
    for (const name of stableFiles) {
      await expectText(outputDir, name, `old ${name}`);
    }
    await expectText(outputDir, "error.txt", "prior failure");
  });

  it("rolls the complete stable artifact set back when publication fails", async () => {
    const outputDir = artifactDir("rollback");
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
        outputRoot: bindPublicationRoot(outputRoot, async (from, to, options) => {
          if (from === `${staging.relative}/candidate` && to === "candidate") {
            throw publicationError;
          }
          if (from === `.mantis-previous-test/baseline` && to === "baseline") {
            throw restorationError;
          }
          await outputRoot.move(from, to, options);
        }),
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

    await expectText(path.join(outputDir, "candidate"), "old.txt", "old candidate");
    for (const fileName of stableFiles) {
      await expectText(outputDir, fileName, `old ${fileName}`);
    }
    expect(
      (await fs.readdir(outputDir)).filter((entry) => entry.startsWith(".mantis-staged-")),
    ).toEqual([]);
    await expectText(
      path.join(outputDir, ".mantis-previous-test", "baseline"),
      "old.txt",
      "old baseline",
    );
    await expectText(externalDir, "keep.txt", "external artifact");
  });

  it("retains the owned worktree and writes diagnostics when cleanup fails", async () => {
    const outputDir = artifactDir("cleanup-failure");
    let baselineWorktreeDir = "";
    const runner = vi.fn(async (command: string, args: readonly string[], execution) => {
      if (command === "git" && execution.stage === "worktree-add") {
        baselineWorktreeDir = String(args[4]);
        await fs.mkdir(baselineWorktreeDir, { recursive: true });
        return successfulCommandResult();
      }
      if (command === "pnpm" && execution.stage === "qa") {
        await writeLegacyLaneSummary({ args, scenario: scenarioId });
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

    await expect(run({ commandRunner: runner, outputDir })).rejects.toThrow(
      "baseline worktree cleanup left registered path",
    );

    await expect(fs.readFile(path.join(outputDir, "error.txt"), "utf8")).resolves.toContain(
      "baseline worktree cleanup left registered path",
    );
    await expect(fs.stat(baselineWorktreeDir)).resolves.toBeDefined();
  });

  it("keeps workload failure first when cleanup also fails", async () => {
    const workloadError = new Error("workload failed");
    const cleanupError = new Error("cleanup failed");
    const runner = vi
      .fn<MantisCommandRunner>()
      .mockRejectedValue(cleanupError)
      .mockRejectedValueOnce(workloadError);

    await expect(
      run({ commandRunner: runner, outputDir: ".artifacts/qa-e2e/mantis/aggregate-failure" }),
    ).rejects.toSatisfy((error: unknown) => {
      expect(error).toBeInstanceOf(AggregateError);
      if (!(error instanceof AggregateError)) {
        return false;
      }
      const errorPath = path.join(artifactDir("aggregate-failure"), "error.txt");
      expect(error.message).toContain("Mantis lane failed and worktree cleanup failed");
      expect(error.message).toContain(errorPath);
      expect(error.cause).toEqual(expect.any(Error));
      expect(error.cause).toMatchObject({
        message: expect.stringContaining("baseline worktree-add failed to run"),
      });
      expect(error.errors[0]).toBe(error.cause);
      expect(error.errors).toEqual([error.cause, expect.any(Error)]);
      expect(error.errors[1]).toMatchObject({
        message: expect.stringContaining(
          "baseline worktree cleanup could not verify complete registration state",
        ),
      });
      return true;
    });
  });

  it.each(["unresolved first", "different first owner", "malformed existing file"])(
    "does not promote a later pass or legacy fallback for %s",
    async (caseName) => {
      const runner = laneRunner(async ({ outputDir, status }) => {
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
        const makeEntry = (title: string, outcome: "fail" | "pass") => ({
          test: { kind: "script" as const, id: scenarioId, title },
          coverage: [],
          result: { status: outcome },
        });
        const complete = (index: number, id: string, title: string, outcome: "fail" | "pass") => {
          invocation.complete(id, { status: outcome, entries: [makeEntry(title, outcome)] });
          invocation.select(index, id);
        };
        const first = invocation.begin(0);
        if (caseName !== "unresolved first" || status === "fail") {
          complete(0, first, "First", status);
        }
        const later = invocation.begin(1);
        complete(1, later, "Later", "pass");
        const evidence = invocation.snapshot({ generatedAt: "2026-09-13T00:00:00.000Z" });
        if (caseName === "malformed existing file") {
          const entry = evidence.entries[0];
          if (!entry) {
            throw new Error("Expected an evidence entry for malformed-file fixture");
          }
          entry.binding.occurrenceId = "absent";
        }
        await writeJson(path.join(outputDir, QA_EVIDENCE_FILENAME), evidence);
        await writeJson(path.join(outputDir, "discord-qa-summary.json"), {
          scenarios: [{ id: scenarioId, status: "pass" }],
        });
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
        expect(await readJson(result.comparisonPath)).toMatchObject({
          candidate: { status: "unknown", fixed: false },
        });
      }
    },
  );
});
