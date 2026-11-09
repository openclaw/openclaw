import type { QaLabServerHandle } from "./lab-server.types.js";
import { writeQaSuiteArtifacts } from "./suite-artifacts.js";
import type { createQaSuiteProgressController } from "./suite-progress.js";
import type { QaSuiteResult } from "./suite-types.js";

export async function completeQaSuiteRun(
  params: Parameters<typeof writeQaSuiteArtifacts>[0],
  lab: QaLabServerHandle,
  progress: ReturnType<typeof createQaSuiteProgressController>,
  startedScenarioIds: string[],
): Promise<QaSuiteResult> {
  const artifacts = await writeQaSuiteArtifacts(params);
  const generatedAt = params.finishedAt.toISOString();
  lab.setLatestReport({
    outputPath: artifacts.reportPath,
    markdown: artifacts.report,
    generatedAt,
  });
  progress.complete([], generatedAt);
  return {
    outputDir: params.outputDir,
    ...artifacts,
    scenarios: params.scenarios,
    startedScenarioIds,
    watchUrl: lab.baseUrl,
  };
}
