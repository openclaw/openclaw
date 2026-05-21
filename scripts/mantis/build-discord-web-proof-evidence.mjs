#!/usr/bin/env node
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const LANES = [
  { altPrefix: "Baseline", label: "Main", lane: "baseline" },
  { altPrefix: "Candidate", label: "This PR", lane: "candidate" },
];

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (!key.startsWith("--")) throw new Error(`Unexpected argument: ${key}`);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`Missing value for ${key}`);
    args[key.slice(2).replaceAll("-", "_")] = value;
    index += 1;
  }
  return args;
}
function readJson(filePath) {
  return JSON.parse(readFileSync(filePath, "utf8"));
}
function copyArtifact({ outputDir, required = true, source, targetPath }) {
  if (!source || !existsSync(source)) {
    if (required) throw new Error(`Missing required artifact: ${source}`);
    return false;
  }
  const target = path.join(outputDir, targetPath);
  mkdirSync(path.dirname(target), { recursive: true });
  copyFileSync(source, target);
  return true;
}
function resolveSummaryArtifact(lane, key) {
  const value = lane.summary.artifacts?.[key];
  return typeof value === "string" ? path.resolve(lane.repoRoot, value) : undefined;
}
function loadLane({ outputDir, repoRoot, status }) {
  const summaryPath = path.join(outputDir, "discord-web-crabbox-session-summary.json");
  const summary = readJson(summaryPath);
  return { outputDir, repoRoot, status: status || summary.status || "unknown", summary, summaryPath };
}
function copyLaneArtifacts({ lane, laneName, outputDir }) {
  const gif = resolveSummaryArtifact(lane, "previewGifCropped") ?? resolveSummaryArtifact(lane, "previewGif");
  copyArtifact({ outputDir, source: gif, targetPath: `${laneName}/discord-web-proof.gif` });
  copyArtifact({ outputDir, required: false, source: resolveSummaryArtifact(lane, "trimmedVideoCropped") ?? resolveSummaryArtifact(lane, "trimmedVideo"), targetPath: `${laneName}/discord-web-proof.mp4` });
  copyArtifact({ outputDir, required: false, source: resolveSummaryArtifact(lane, "screenshot"), targetPath: `${laneName}/discord-web-proof.png` });
  copyArtifact({ outputDir, source: lane.summaryPath, targetPath: `${laneName}/summary.json` });
  copyArtifact({ outputDir, required: false, source: typeof lane.summary.report === "string" ? path.resolve(lane.repoRoot, lane.summary.report) : undefined, targetPath: `${laneName}/report.md` });
}
function laneStatus(lane) {
  return lane.status === "pass" ? "pass" : "fail";
}
function laneArtifactEntries() {
  return LANES.flatMap(({ altPrefix, label, lane }) => [
    { alt: `${altPrefix} Discord Web proof GIF`, inline: true, kind: "motionPreview", label, lane, path: `${lane}/discord-web-proof.gif`, targetPath: `${lane}/discord-web-proof.gif`, width: 520 },
    { kind: "motionClip", label: `${label} MP4`, lane, path: `${lane}/discord-web-proof.mp4`, required: false, targetPath: `${lane}/discord-web-proof.mp4` },
    { alt: `${altPrefix} Discord Web screenshot`, inline: false, kind: "desktopScreenshot", label: `${label} screenshot`, lane, path: `${lane}/discord-web-proof.png`, required: false, targetPath: `${lane}/discord-web-proof.png` },
    { kind: "metadata", label: `${label} session summary`, lane, path: `${lane}/summary.json`, targetPath: `${lane}/summary.json` },
    { kind: "report", label: `${label} session report`, lane, path: `${lane}/report.md`, required: false, targetPath: `${lane}/report.md` },
  ]);
}
export function buildDiscordWebProofManifest({ baseline, baselineRef, baselineSha, candidate, candidateRef, candidateSha, scenarioLabel }) {
  const baselineStatus = laneStatus(baseline);
  const candidateStatus = laneStatus(candidate);
  return {
    schemaVersion: 1,
    id: "discord-desktop-proof",
    title: "Mantis Discord Desktop Proof",
    summary: "Mantis captured Discord Web before/after GIF evidence with Convex-leased Discord bot credentials and a logged-in viewer profile.",
    scenario: scenarioLabel || "discord-desktop-proof",
    comparison: {
      baseline: { ...(baselineSha ? { sha: baselineSha } : {}), ...(baselineRef ? { ref: baselineRef } : {}), expected: "baseline visual proof captured", status: baselineStatus },
      candidate: { ...(candidateSha ? { sha: candidateSha } : {}), ...(candidateRef ? { ref: candidateRef } : {}), expected: "candidate visual proof captured", status: candidateStatus, fixed: candidateStatus === "pass" },
      pass: baselineStatus === "pass" && candidateStatus === "pass",
    },
    artifacts: laneArtifactEntries(),
  };
}
export function writeDiscordWebProofEvidence(rawArgs = process.argv.slice(2)) {
  const args = parseArgs(rawArgs);
  for (const key of ["baseline_output_dir", "baseline_repo_root", "candidate_output_dir", "candidate_repo_root", "output_dir"]) {
    if (!args[key]) throw new Error(`Missing --${key.replaceAll("_", "-")}.`);
  }
  const outputDir = path.resolve(args.output_dir);
  mkdirSync(outputDir, { recursive: true });
  const baseline = loadLane({ outputDir: path.resolve(args.baseline_output_dir), repoRoot: path.resolve(args.baseline_repo_root), status: args.baseline_status });
  const candidate = loadLane({ outputDir: path.resolve(args.candidate_output_dir), repoRoot: path.resolve(args.candidate_repo_root), status: args.candidate_status });
  copyLaneArtifacts({ lane: baseline, laneName: "baseline", outputDir });
  copyLaneArtifacts({ lane: candidate, laneName: "candidate", outputDir });
  const manifest = buildDiscordWebProofManifest({ baseline, baselineRef: args.baseline_ref, baselineSha: args.baseline_sha, candidate, candidateRef: args.candidate_ref, candidateSha: args.candidate_sha, scenarioLabel: args.scenario_label });
  const manifestPath = path.join(outputDir, "mantis-evidence.json");
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  return { manifest, manifestPath };
}

if (path.resolve(process.argv[1] || "") === fileURLToPath(import.meta.url)) {
  try {
    writeDiscordWebProofEvidence();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
