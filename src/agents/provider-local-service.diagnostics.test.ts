import "../test-utils/prepare-compiled-subprocesses.js";
import { afterEach, describe, expect, it } from "vitest";
import type { EmbeddingProviderCreateOptions } from "../plugins/embedding-provider-types.js";
import { openAICompatibleEmbeddingProviderAdapter } from "../plugins/openai-compatible-embedding-provider.js";
import type { AcquireConfiguredProviderLocalService } from "./provider-local-service-target.js";
import {
  createConfiguredProviderLocalServiceAcquirer,
  getManagedProviderLocalServiceDiagnosticsForTest,
} from "./provider-local-service.js";
import { createProviderLocalServiceTestFixture } from "./provider-local-service.test-support.js";

const fixture = createProviderLocalServiceTestFixture();
afterEach(() => fixture.cleanup());

describe("managed service failure diagnostics", () => {
  it("attaches bounded post-readiness stderr to the owning embedding failure", async () => {
    const port = await fixture.claimPort();
    const baseUrl = `http://127.0.0.1:${port}/v1`;
    const secret = "synthetic-local-service-secret";
    const config = {
      models: {
        providers: {
          "tail-fixture": {
            baseUrl,
            apiKey: "synthetic-local",
            models: [],
            localService: {
              command: process.execPath,
              env: { DIAGNOSTIC_SECRET: secret },
              args: [
                "-e",
                `const http=require("node:http");http.createServer((req,res)=>{res.setHeader("content-type","application/json");if(req.url==="/v1/models"){res.end('{"data":[]}');return;}process.stderr.write(Array.from({length:100},(_,i)=>"old-line-"+i).join("\\n")+"\\n"+"x".repeat(9000)+"\\nmissing model /synthetic/missing.gguf "+process.env.DIAGNOSTIC_SECRET+"\\n",()=>{res.writeHead(500);res.end('{"error":{"message":"model failed to load","code":500}}');});}).listen(${port},"127.0.0.1");`,
              ],
              readyTimeoutMs: 5000,
            },
          },
        },
      },
    };
    const options: EmbeddingProviderCreateOptions & {
      acquireLocalService: AcquireConfiguredProviderLocalService;
    } = {
      config,
      provider: "tail-fixture",
      model: "missing-model",
      remote: { apiKey: "synthetic-local" },
      acquireLocalService: createConfiguredProviderLocalServiceAcquirer(() => config),
    };
    const result = await openAICompatibleEmbeddingProviderAdapter.create(options);
    if (!result.provider) {
      throw new Error("Expected embedding provider");
    }
    let failure: unknown;
    try {
      await result.provider.embed("synthetic probe");
    } catch (error) {
      failure = error;
    }
    if (!(failure instanceof Error)) {
      throw new Error("Expected embedding request to fail", { cause: failure });
    }
    const message = failure.message;
    expect(message).toContain("HTTP 500");
    expect(message).toContain("missing model /synthetic/missing.gguf");
    expect(message).not.toContain(secret);
    expect(message).not.toContain("old-line-0");
    expect(Buffer.byteLength(message)).toBeLessThanOrEqual(8 * 1024 + 256);
    // The owner keeps raw output; only the failure crossing the diagnostic boundary is redacted.
    const rawTail = getManagedProviderLocalServiceDiagnosticsForTest()[0]?.stderrTail ?? "";
    expect(rawTail).toContain(secret);
    expect(Buffer.byteLength(rawTail)).toBeLessThanOrEqual(8 * 1024);
  });
});
