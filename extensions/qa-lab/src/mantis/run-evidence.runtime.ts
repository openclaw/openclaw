// Qa Lab plugin module renders Mantis comparison evidence.
import path from "node:path";
import type { LaneResult } from "./run-artifacts.runtime.js";

export type MantisScenarioConfig = {
  baselineExpected: string;
  baselineLabel: string;
  baselineScreenshotAlt: string;
  candidateExpected: string;
  candidateLabel: string;
  candidateScreenshotAlt: string;
  defaultBaselineRef: string;
  id: string;
  title: string;
};

export type MantisComparison = {
  baseline: {
    expected: string;
    ref: string;
    reproduced: boolean;
    screenshotPath?: string;
    status: string;
    videoPath?: string;
  };
  candidate: {
    expected: string;
    fixed: boolean;
    ref: string;
    screenshotPath?: string;
    status: string;
    videoPath?: string;
  };
  pass: boolean;
  scenario: string;
  transport: "discord";
};

export function renderReport(params: {
  baseline: LaneResult;
  candidate: LaneResult;
  comparison: MantisComparison;
  outputDir: string;
  scenarioConfig: MantisScenarioConfig;
}) {
  const lines = [
    `# ${params.scenarioConfig.title}`,
    "",
    `Status: ${params.comparison.pass ? "pass" : "fail"}`,
    `Transport: ${params.comparison.transport}`,
    `Scenario: ${params.comparison.scenario}`,
    `Output: ${params.outputDir}`,
    "",
    ...(["baseline", "candidate"] as const).flatMap((lane) => {
      const result = params[lane];
      const comparison = params.comparison[lane];
      return [
        lane === "baseline" ? "## Baseline" : "## Candidate",
        "",
        `- Ref: \`${comparison.ref}\``,
        `- Expected: ${comparison.expected}`,
        `- Status: \`${result.status}\``,
        lane === "baseline"
          ? `- Reproduced: \`${params.comparison.baseline.reproduced}\``
          : `- Fixed: \`${params.comparison.candidate.fixed}\``,
        result.screenshotPath
          ? `- Screenshot: \`${path.join(lane, path.basename(result.screenshotPath))}\``
          : "- Screenshot: missing",
        result.videoPath
          ? `- Video: \`${path.join(lane, path.basename(result.videoPath))}\``
          : "- Video: missing",
        result.scenarioDetails ? `- Details: ${result.scenarioDetails}` : undefined,
        "",
      ];
    }),
  ].filter((line) => line !== undefined);
  return `${lines.join("\n")}\n`;
}

function relativeArtifactPath(outputDir: string, artifactPath: string | undefined) {
  if (!artifactPath) {
    return undefined;
  }
  return path.isAbsolute(artifactPath) ? path.relative(outputDir, artifactPath) : artifactPath;
}

export function buildEvidenceManifest(params: {
  baseline: LaneResult;
  candidate: LaneResult;
  comparison: MantisComparison;
  outputDir: string;
  scenarioConfig: MantisScenarioConfig;
}) {
  const artifacts: {
    alt?: string;
    kind: string;
    label: string;
    lane: "baseline" | "candidate" | "run";
    path: string;
    required?: boolean;
    targetPath: string;
    width?: number;
  }[] = [
    {
      kind: "metadata",
      label: "Comparison JSON",
      lane: "run",
      path: "comparison.json",
      targetPath: "comparison.json",
    },
    {
      kind: "report",
      label: "Mantis report",
      lane: "run",
      path: "mantis-report.md",
      targetPath: "mantis-report.md",
    },
  ];
  for (const lane of ["baseline", "candidate"] as const) {
    const screenshot = relativeArtifactPath(params.outputDir, params[lane].screenshotPath);
    if (screenshot) {
      artifacts.push({
        alt: params.scenarioConfig[`${lane}ScreenshotAlt`],
        kind: "timeline",
        label: params.scenarioConfig[`${lane}Label`],
        lane,
        path: screenshot,
        targetPath: `${lane}.png`,
        width: 420,
      });
    }
  }
  for (const lane of ["baseline", "candidate"] as const) {
    const video = relativeArtifactPath(params.outputDir, params[lane].videoPath);
    if (video) {
      artifacts.push({
        kind: "fullVideo",
        label: lane === "baseline" ? "Baseline MP4" : "Candidate MP4",
        lane,
        path: video,
        targetPath: `${lane}.mp4`,
        required: false,
      });
    }
  }

  return {
    artifacts,
    comparison: params.comparison,
    id: params.comparison.scenario,
    scenario: params.comparison.scenario,
    schemaVersion: 1,
    summary:
      "Mantis ran the before/after scenario, captured baseline and candidate evidence, and compared the expected bug reproduction against the candidate fix.",
    title: params.scenarioConfig.title,
  };
}
