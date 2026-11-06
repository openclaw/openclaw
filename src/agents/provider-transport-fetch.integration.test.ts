import { createServer } from "node:http";
import type { Model } from "openclaw/plugin-sdk/llm";
import { afterEach, describe, expect, it } from "vitest";
import * as httpFixtures from "../../test/helpers/gateway-integration-fixtures.js";
import { redactSensitiveText } from "../logging/redact.js";
import { resetSecretRedactionRegistryForTest } from "../logging/secret-redaction-registry.test-support.js";
import { mintSecretSentinel } from "../secrets/sentinel.js";
import { buildGuardedModelFetch } from "./provider-transport-fetch.js";

describe("guarded model fetch secret sentinel integration", () => {
  afterEach(() => {
    resetSecretRedactionRegistryForTest();
  });

  it("injects URL and header credentials only at local HTTP egress and redacts the resolved value", async () => {
    let receivedAuthorization: string | undefined;
    let receivedUrl: string | undefined;
    const server = createServer((request, response) => {
      receivedAuthorization = request.headers.authorization;
      receivedUrl = request.url;
      response.writeHead(200, { "content-type": "application/json" });
      response.end('{"ok":true}');
    });
    const origin = await httpFixtures.listenLoopback(server);

    try {
      const baseUrl = `${origin}/v1`;
      const model = {
        id: "integration-model",
        provider: "sentinel-integration",
        api: "openai-responses",
        baseUrl,
      } as unknown as Model<"openai-responses">;
      const secret = "integration-provider-secret";
      const sentinel = mintSecretSentinel(secret, { label: "model-auth:integration" });
      const querySentinel = mintSecretSentinel("query&scope=two+#%", {
        label: "model-auth:integration-query",
      });

      const response = await buildGuardedModelFetch(model)(
        `${baseUrl}/responses?key=${querySentinel}`,
        {
          method: "POST",
          headers: { Authorization: `Bearer ${sentinel}` },
          body: "{}",
        },
      );
      await response.text();

      expect(receivedAuthorization).toBe(`Bearer ${secret}`);
      expect(receivedUrl).toBe("/v1/responses?key=query%26scope%3Dtwo%2B%23%25");
      expect(redactSensitiveText(`upstream used ${secret}`, { mode: "off" })).toBe(
        "upstream used integr…cret",
      );
    } finally {
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    }
  });
});
