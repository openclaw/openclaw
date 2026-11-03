import path from "node:path";
import { fetchWithSsrFGuard } from "openclaw/plugin-sdk/ssrf-runtime";
import type { QaMockProviderServer } from "./providers/index.js";
import type { QaProviderMode } from "./providers/shared/types.js";
import { publishQaSuiteArtifactFiles } from "./suite-artifacts.js";

const QA_MOCK_PROVIDER_REQUESTS_ARTIFACT = path.join("artifacts", "mock-openai-requests.json");

export async function captureQaMockProviderRequests(params: {
  outputDir: string;
  providerMode: QaProviderMode;
  provider?: QaMockProviderServer | null;
}) {
  if (params.providerMode !== "mock-openai" || !params.provider) {
    return;
  }
  const { response, release } = await fetchWithSsrFGuard({
    url: new URL("/debug/requests", params.provider.baseUrl).href,
    maxRedirects: 0,
    timeoutMs: 15_000,
    policy: { allowPrivateNetwork: true },
    auditContext: "qa-lab-mock-provider-request-artifact",
  });
  try {
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
  } finally {
    await release();
  }
}
