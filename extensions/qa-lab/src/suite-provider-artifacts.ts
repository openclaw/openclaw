import path from "node:path";
import type { QaMockProviderServer } from "./providers/index.js";
import type { QaProviderMode } from "./providers/shared/types.js";
import { publishQaSuiteArtifactFiles } from "./suite-artifacts.js";

export const QA_MOCK_PROVIDER_REQUESTS_ARTIFACT = path.join(
  "artifacts",
  "mock-openai-requests.json",
);

export async function captureQaMockProviderRequests(params: {
  outputDir: string;
  providerMode: QaProviderMode;
  provider?: QaMockProviderServer | null;
}) {
  if (params.providerMode !== "mock-openai" || !params.provider) {
    return;
  }
  const response = await fetch(new URL("/debug/requests", params.provider.baseUrl));
  if (!response.ok) {
    throw new Error(`QA mock request capture failed with HTTP ${response.status}`);
  }
  const requests: unknown = await response.json();
  if (!Array.isArray(requests)) {
    throw new Error("QA mock request capture returned a non-array payload");
  }
  const filePath = path.join(params.outputDir, QA_MOCK_PROVIDER_REQUESTS_ARTIFACT);
  await publishQaSuiteArtifactFiles({
    outputDir: path.dirname(filePath),
    files: [{ filePath, content: `${JSON.stringify(requests, null, 2)}\n` }],
  });
}
