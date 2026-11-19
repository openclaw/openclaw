import fs from "node:fs/promises";
import path from "node:path";
import { replaceFileAtomic } from "openclaw/plugin-sdk/security-runtime";
import { fetchWithSsrFGuard } from "openclaw/plugin-sdk/ssrf-runtime";
import type { QaMockProviderServer } from "./providers/index.js";
import type { QaProviderMode } from "./providers/shared/types.js";

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
    if (!response.body) {
      throw new Error("QA mock request capture returned no response body");
    }
    const filePath = path.join(params.outputDir, QA_MOCK_PROVIDER_REQUESTS_ARTIFACT);
    const outputDir = path.dirname(filePath);
    await fs.mkdir(outputDir, { recursive: true });
    const dirMode = (await fs.stat(outputDir)).mode & 0o7777;
    const reader = response.body.getReader();
    async function* chunks() {
      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          return;
        }
        yield value;
      }
    }
    try {
      await replaceFileAtomic({
        filePath,
        content: "",
        dirMode,
        mode: 0o600,
        preserveExistingMode: true,
        tempPrefix: `${path.basename(filePath)}.qa-artifact`,
        syncParentDir: true,
        throwOnCleanupError: true,
        beforeRename: async ({ tempPath }) => {
          // Fill the owned staging file before publication. The provider owns
          // JSON serialization; never buffer/re-serialize the whole log here.
          const file = await fs.open(tempPath, "r+");
          try {
            await file.writeFile(chunks());
            await file.sync();
          } finally {
            await file.close();
          }
        },
      });
    } finally {
      reader.releaseLock();
    }
  } finally {
    await release();
  }
}
