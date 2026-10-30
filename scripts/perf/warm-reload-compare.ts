import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { access, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import photon from "@silvia-odwyer/photon-node";
import { stopChild } from "../lib/gateway-bench-child.ts";

type Arm = "base" | "candidate";
type Census = {
  distinctStates: number;
  lastVisualChangeMs: number | null;
  timeline: Array<{ atMs: number; frame: string }>;
};
type ComparisonRun = {
  warm: boolean;
  outputDir: string;
  probe: {
    helloHandledMs: number | null;
    fcpMs: number | null;
    firstPaintedRowsMs: number | null;
    finalRowsDomMs: number | null;
    loafBlockingMs: number;
    cls: number;
  };
  auditedPaint?: { main: { atMs: number }; dashboard: { atMs: number } | null };
  visual: Census & { unmasked: Census; visibleChangeCensus?: Census };
};
type ComparisonResult = { arm: string; route: string; runs: ComparisonRun[] };
type ComparisonPair = {
  pair: number;
  base: ReturnType<typeof metrics>;
  candidate: ReturnType<typeof metrics>;
  deltas: Record<string, number | null>;
  contactSheets: string[];
};
const exec = promisify(execFile);

async function runBuildCommand(command: string, args: string[], cwd: string) {
  const child = spawn(command, args, {
    cwd,
    stdio: "inherit",
    detached: process.platform !== "win32",
  });
  let stopping: ReturnType<typeof stopChild> | undefined;
  const interrupt = () => {
    stopping ??= stopChild(child);
  };
  process.once("SIGINT", interrupt);
  process.once("SIGTERM", interrupt);
  try {
    await new Promise<void>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code, signal) => {
        if (code === 0) {
          resolve();
        } else {
          reject(new Error(`${command} failed (${signal ?? code}); see build output`));
        }
      });
    });
  } finally {
    process.off("SIGINT", interrupt);
    process.off("SIGTERM", interrupt);
    await (stopping ?? stopChild(child));
  }
}

/** Existing UI/full-dist directory, or one pinned ref built in an owned detached checkout. */
export async function prepareWarmReloadBuild(
  input: string,
  options: { directory: string; label: string },
) {
  const inputPath = path.resolve(input);
  let existingDirectory = false;
  try {
    existingDirectory = (await stat(inputPath)).isDirectory();
  } catch (error) {
    if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") {
      throw error;
    }
  }
  let sourceDirectory: string | null = null;
  let revision: string | null = null;
  let uiRoot = inputPath;
  const cleanup = async () => {
    if (sourceDirectory) {
      await exec("git", ["worktree", "remove", "--force", sourceDirectory]);
      sourceDirectory = null;
    }
  };
  try {
    if (existingDirectory) {
      try {
        await access(path.join(uiRoot, "index.html"));
      } catch {
        uiRoot = path.join(uiRoot, "control-ui");
      }
    } else {
      revision = (
        await exec("git", ["rev-parse", "--verify", "--end-of-options", `${input}^{commit}`])
      ).stdout.trim();
      const directory = path.resolve(options.directory);
      if (!directory.startsWith(`${path.resolve(".local")}${path.sep}`)) {
        throw new Error("Comparison source checkouts must be inside this worktree's .local/");
      }
      await mkdir(directory, { recursive: true });
      const checkout = path.join(directory, `${options.label}-source`);
      await exec("git", ["worktree", "add", "--detach", checkout, revision]);
      sourceDirectory = checkout;
      await runBuildCommand("corepack", ["pnpm", "install", "--frozen-lockfile"], checkout);
      await runBuildCommand("corepack", ["pnpm", "build"], checkout);
      uiRoot = path.join(checkout, "dist", "control-ui");
    }
    const index = await readFile(path.join(uiRoot, "index.html"));
    return {
      input,
      uiRoot,
      sourceRef: existingDirectory ? null : input,
      revision,
      uiIndexSha256: createHash("sha256").update(index).digest("hex"),
      cleanup,
    };
  } catch (error) {
    await cleanup();
    throw error;
  }
}

function distribution(values: number[]) {
  if (!values.length) {
    return null;
  }
  const sorted = [...values].toSorted((a, b) => a - b);
  const quantile = (fraction: number) => {
    const index = (sorted.length - 1) * fraction;
    const low = Math.floor(index);
    return sorted[low]! + (sorted[Math.ceil(index)]! - sorted[low]!) * (index - low);
  };
  return { median: quantile(0.5), q1: quantile(0.25), q3: quantile(0.75), samples: values.length };
}

function metrics(run: ComparisonRun): Record<string, number | null> {
  return {
    visibleStates: run.visual.visibleChangeCensus?.distinctStates ?? null,
    visibleStateOccurrences: run.visual.visibleChangeCensus?.timeline.length ?? null,
    pixelStates: run.visual.distinctStates,
    pixelStateOccurrences: run.visual.timeline.length,
    unmaskedPixelStates: run.visual.unmasked.distinctStates,
    unmaskedPixelStateOccurrences: run.visual.unmasked.timeline.length,
    lastVisibleChangeMs: run.visual.visibleChangeCensus?.lastVisualChangeMs ?? null,
    lastPixelChangeMs: run.visual.lastVisualChangeMs,
    helloHandledMs: run.probe.helloHandledMs,
    fcpMs: run.probe.fcpMs,
    auditedMainPaintMs: run.auditedPaint?.main.atMs ?? null,
    auditedDashboardPaintMs: run.auditedPaint?.dashboard?.atMs ?? null,
    firstPaintedRowsMs: run.probe.firstPaintedRowsMs,
    finalRowsDomMs: run.probe.finalRowsDomMs,
    loafBlockingMs: run.probe.loafBlockingMs,
    cls: run.probe.cls,
  };
}

async function comparisonSheets(base: ComparisonRun, candidate: ComparisonRun, directory: string) {
  const census = (run: ComparisonRun) => run.visual.visibleChangeCensus ?? run.visual;
  const timelines = [census(base).timeline, census(candidate).timeline];
  const times = [...new Set(timelines.flatMap((timeline) => timeline.map((entry) => entry.atMs)))];
  times.sort((a, b) => a - b);
  const files: string[] = [];
  const labelHeight = 44;
  for (let start = 0; start < times.length; start += 3) {
    const rows = times.slice(start, start + 3);
    let sheet: photon.PhotonImage | undefined;
    try {
      for (const [row, atMs] of rows.entries()) {
        for (const [column, run] of [base, candidate].entries()) {
          const state = timelines[column]!.findLast((entry) => entry.atMs <= atMs);
          if (!state) {
            continue;
          }
          const image = photon.PhotonImage.new_from_byteslice(
            await readFile(path.join(run.outputDir, state.frame)),
          );
          try {
            const width = image.get_width();
            const height = image.get_height();
            if (!sheet) {
              const data = new Uint8Array(width * 2 * (height + labelHeight) * rows.length * 4);
              for (let offset = 0; offset < data.length; offset += 4) {
                data.set([35, 38, 43, 255], offset);
              }
              sheet = new photon.PhotonImage(data, width * 2, (height + labelHeight) * rows.length);
            }
            if (
              sheet.get_width() !== width * 2 ||
              sheet.get_height() !== (height + labelHeight) * rows.length
            ) {
              throw new Error("Comparison frame viewport dimensions differ");
            }
            photon.watermark(
              sheet,
              image,
              BigInt(column * width),
              BigInt(row * (height + labelHeight) + labelHeight),
            );
            photon.draw_text(
              sheet,
              `${column === 0 ? "BASE" : "CANDIDATE"} | ${atMs.toFixed(1)} ms | representative ${state.atMs.toFixed(1)} ms`,
              column * width + 8,
              row * (height + labelHeight) + 8,
              20,
            );
          } finally {
            image.free();
          }
        }
      }
      if (sheet) {
        const file = `${String(files.length + 1).padStart(2, "0")}.png`;
        await writeFile(path.join(directory, file), sheet.get_bytes());
        files.push(file);
      }
    } finally {
      sheet?.free();
    }
  }
  return files;
}

/** Summarize matching warm samples; DOM candidates are never substituted for audited paint. */
export async function createWarmReloadComparison(results: ComparisonResult[], directory: string) {
  if (results.some((result) => result.arm !== "base" && result.arm !== "candidate")) {
    throw new Error("Comparison accepts only base and candidate arms");
  }
  const routes = [...new Set(results.map((result) => result.route))];
  const comparisons = [];
  for (const route of routes) {
    const result = (arm: Arm) =>
      results.filter((entry) => entry.arm === arm && entry.route === route);
    const base = result("base");
    const candidate = result("candidate");
    if (base.length !== 1 || candidate.length !== 1) {
      throw new Error(`Comparison requires exactly one base and candidate result for ${route}`);
    }
    const warm = [base[0]!, candidate[0]!].map((entry) => entry.runs.filter((run) => run.warm));
    if (!warm[0]!.length || warm[0]!.length !== warm[1]!.length) {
      throw new Error(`Comparison warm sample counts must match and be nonzero for ${route}`);
    }
    const pairs: ComparisonPair[] = [];
    for (let index = 0; index < warm[0]!.length; index++) {
      const first = warm[0]![index]!;
      const second = warm[1]![index]!;
      const a = metrics(first);
      const b = metrics(second);
      const deltas = Object.fromEntries(
        Object.entries(a).map(([key, value]) => {
          const other = b[key];
          return [
            key,
            typeof value !== "number" || typeof other !== "number" ? null : other - value,
          ];
        }),
      );
      const relative = path.join(
        "comparison-sheets",
        route,
        `warm-${String(index + 1).padStart(2, "0")}`,
      );
      await mkdir(path.join(directory, relative), { recursive: true });
      const sheets = await comparisonSheets(first, second, path.join(directory, relative));
      pairs.push({
        pair: index + 1,
        base: a,
        candidate: b,
        deltas,
        contactSheets: sheets.map((file) => path.join(relative, file)),
      });
    }
    const summary = Object.fromEntries(
      Object.keys(pairs[0]!.base).map((key) => {
        const select = (arm: "base" | "candidate" | "deltas") =>
          pairs.flatMap((pair) => {
            const value = pair[arm][key];
            return typeof value === "number" && Number.isFinite(value) ? [value] : [];
          });
        const deltas = select("deltas");
        return [
          key,
          {
            base: distribution(select("base")),
            candidate: distribution(select("candidate")),
            pairedDelta: distribution(deltas),
            candidateBetterPairs: deltas.filter((value) => value < 0).length,
            candidateWorsePairs: deltas.filter((value) => value > 0).length,
          },
        ];
      }),
    );
    comparisons.push({ route, pairs, summary });
  }
  const report = {
    method:
      "Warm samples paired by interleaved run index; deltas are candidate minus base. Lower is better. Cold captures remain in report.json. Side-by-side rows align representative visual states at common timestamps, holding the last accepted representative; they are not new sampled frames. Missing audited paint stays null.",
    comparisons,
  };
  await writeFile(path.join(directory, "comparison.json"), `${JSON.stringify(report, null, 2)}\n`);
  const format = (value: ReturnType<typeof distribution>) =>
    value
      ? `${value.median.toFixed(2)} [${value.q1.toFixed(2)}, ${value.q3.toFixed(2)}]`
      : "unavailable";
  const markdown = ["# Warm reload comparison", "", report.method, ""];
  for (const comparison of comparisons) {
    markdown.push(
      `## ${comparison.route}`,
      "",
      "| Metric | Base median [Q1, Q3] | Candidate median [Q1, Q3] | Paired delta | Better / worse |",
      "| --- | --- | --- | --- | --- | ",
    );
    for (const [key, value] of Object.entries(comparison.summary)) {
      markdown.push(
        `| ${key} | ${format(value.base)} | ${format(value.candidate)} | ${format(value.pairedDelta)} | ${value.candidateBetterPairs} / ${value.candidateWorsePairs} |`,
      );
    }
    markdown.push(
      "",
      "Per-pair deltas and all side-by-side sheet paths: [comparison.json](comparison.json).",
      "",
    );
  }
  await writeFile(path.join(directory, "comparison.md"), `${markdown.join("\n")}\n`);
  return report;
}
