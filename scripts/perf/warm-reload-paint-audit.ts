import { execFileSync } from "node:child_process";
import { readFile, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

const frameName = z.string().regex(/^frame-\d{5,}\.png$/u);
const routeName = z.enum(["chat", "dashboard"]);
const auditSchema = z.object({
  observations: z.array(
    z.object({
      arm: z.enum(["base", "candidate"]).optional(),
      route: routeName,
      run: z.string().regex(/^(?:cold|warm-\d{2,})$/u),
      inspected: z.literal(true),
      appFrame: frameName,
      mainFrame: frameName,
      dashboardFrame: frameName.optional(),
    }),
  ),
});
const reportSchema = z
  .object({
    results: z.array(
      z
        .object({
          arm: z.string().optional(),
          route: routeName,
          runs: z.array(z.object({ warm: z.boolean() }).passthrough()),
        })
        .passthrough(),
    ),
  })
  .passthrough();
const framesSchema = z.object({
  navigationTimeOrigin: z.number().finite(),
  frames: z.array(z.object({ file: z.string(), epochMs: z.number().finite() })).min(1),
});
const pngSignature = Buffer.from("89504e470d0a1a0a", "hex");

/** Import an explicit pixel audit without changing the original capture or its clock. */
export async function applyWarmReloadPaintAudit(reportPath: string, auditPath: string) {
  const directory = await realpath(path.dirname(path.resolve(reportPath)));
  const report = reportSchema.parse(JSON.parse(await readFile(reportPath, "utf8")));
  const audit = auditSchema.parse(JSON.parse(await readFile(auditPath, "utf8")));
  const observations = new Map<string, (typeof audit.observations)[number]>();
  for (const observation of audit.observations) {
    const key = `${observation.arm ? `${observation.arm}/` : ""}${observation.route}/${observation.run}`;
    if (observations.has(key)) {
      throw new Error(`Duplicate paint observation: ${key}`);
    }
    observations.set(key, observation);
  }
  const covered = new Set<string>();
  for (const result of report.results) {
    let warmIndex = 0;
    for (const run of result.runs) {
      const name = run.warm ? `warm-${String(++warmIndex).padStart(2, "0")}` : "cold";
      const key = `${result.arm && result.arm !== "single" ? `${result.arm}/` : ""}${result.route}/${name}`;
      const observation = observations.get(key);
      if (!observation || covered.has(key)) {
        throw new Error(`Missing or duplicate capture observation: ${key}`);
      }
      covered.add(key);
      const runDirectory = await realpath(path.join(directory, key));
      const relative = path.relative(directory, runDirectory);
      if (relative.startsWith("..") || path.isAbsolute(relative)) {
        throw new Error(`Capture directory escapes report: ${key}`);
      }
      const capture = framesSchema.parse(
        JSON.parse(await readFile(path.join(runDirectory, "frames.json"), "utf8")),
      );
      const names = capture.frames.map((frame) => path.basename(frame.file));
      if (new Set(names).size !== names.length) {
        throw new Error(`Duplicate capture frame: ${key}`);
      }
      async function selected(file: string) {
        const index = names.indexOf(file);
        if (index < 0) {
          throw new Error(`Frame absent from capture: ${key}/${file}`);
        }
        const atMs = capture.frames[index]!.epochMs - capture.navigationTimeOrigin;
        if (atMs < 0) {
          throw new Error(`Selected frame predates navigation: ${key}/${file}`);
        }
        const previous = index > 0 ? capture.frames[index - 1]! : null;
        for (const image of [file, previous ? names[index - 1]! : null]) {
          if (!image) {
            continue;
          }
          const local = await realpath(path.join(runDirectory, image));
          if (path.dirname(local) !== runDirectory) {
            throw new Error(`Frame escapes capture directory: ${key}/${image}`);
          }
          if (!(await readFile(local)).subarray(0, 8).equals(pngSignature)) {
            throw new Error(`Invalid PNG frame: ${key}/${image}`);
          }
        }
        return {
          frame: `${key}/${file}`,
          previousFrame: previous ? `${key}/${names[index - 1]}` : null,
          atMs,
          previousAtMs: previous ? previous.epochMs - capture.navigationTimeOrigin : null,
        };
      }
      if (result.route === "dashboard" && !observation.dashboardFrame) {
        throw new Error(`Dashboard content observation is required: ${key}`);
      }
      run.outputDir = runDirectory;
      run.auditedPaint = {
        inspected: true,
        navigationTimeOrigin: capture.navigationTimeOrigin,
        app: await selected(observation.appFrame),
        main: await selected(observation.mainFrame),
        dashboard: observation.dashboardFrame ? await selected(observation.dashboardFrame) : null,
      };
      for (const prefix of ["App", "Main", "Dashboard"]) {
        const legacy = `first${prefix}CapturedPaintMs`;
        if (legacy in run) {
          run[`first${prefix}CandidateFrameMs`] = run[legacy];
          delete run[legacy];
        }
      }
    }
  }
  if (covered.size !== observations.size) {
    throw new Error("Paint observations must cover exactly the captured reloads");
  }
  report.analysisRevision = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: fileURLToPath(new URL("../../", import.meta.url)),
    encoding: "utf8",
  }).trim();
  report.paintAudit = {
    observationsFile: path.relative(directory, path.resolve(auditPath)),
    inspectedReloads: covered.size,
    method:
      "Visually inspected first visible content in original PNGs, with adjacent previous-frame provenance. App includes shared shell/skeleton and excludes the public reader; main requires non-placeholder transcript content; dashboard requires actual widget content. Semantic firstness is an inspector attestation, not inferred from DOM readiness or verified by this importer. Candidate frame times are not paint upper bounds.",
  };
  report.measurement =
    "Original PNG screencast frames; no guarantee of display-vsync completeness. DOM-correlated candidate frames do not establish paint. Audited paint observations use selected visible pixels and the original navigation clock; adjacent frames remain linked. Compared arms, when present, retain their captured build identities.";
  const output = path.join(directory, "audited-report.json");
  await writeFile(output, JSON.stringify(report, null, 2) + "\n");
  return output;
}
