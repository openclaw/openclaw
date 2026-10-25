export const managedLabelSpecs: Record<string, { color: string; description: string }>;
export const candidateLabels: Record<
  | "blankTemplate"
  | "lowSignalDocs"
  | "docsDiscoverability"
  | "testOnlyNoBug"
  | "refactorOnly"
  | "needsPrContext"
  | "dirtyCandidate"
  | "riskyInfra"
  | "externalPluginCandidate",
  string
>;
export function hasVerifiedResponseClosure(snapshot: unknown, event: unknown): boolean;
export function classifyPullRequestCandidateLabels(
  pullRequest: unknown,
  files: unknown[],
): string[];
export function runBarnacleAutoResponse(options: {
  github: unknown;
  context: unknown;
  core?: Pick<Console, "info">;
  expectedAppId: number;
}): Promise<void>;
