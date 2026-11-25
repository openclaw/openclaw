export type IosScreenshotTooling = {
  xcode: string;
  fastlane: string;
  node: string;
};

export type IosScreenshotProvenance = {
  targetSha: string;
  workflowSha: string;
  runId: string;
  runAttempt: string | number;
  tooling: IosScreenshotTooling;
};

export function collectIosScreenshotEvidence(options: {
  screenshotDirectory: string;
  xcresultDirectory: string;
  outputDirectory: string;
  provenance: IosScreenshotProvenance;
  readXcresult?: (resultPath: string, section: "summary" | "tests") => unknown;
}): Record<string, unknown>;

export function reduceIosScreenshotEvidence(options: {
  inputDirectory: string;
  outputRoot: string;
  expectedProvenance: IosScreenshotProvenance;
}): Record<string, unknown>;
