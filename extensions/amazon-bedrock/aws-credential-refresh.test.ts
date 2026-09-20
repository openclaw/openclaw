import { writeFile } from "node:fs/promises";
import path from "node:path";
import { BedrockClient } from "@aws-sdk/client-bedrock";
import { BedrockRuntimeClient } from "@aws-sdk/client-bedrock-runtime";
import { defaultProvider } from "@aws-sdk/credential-provider-node";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadBedrockControlPlaneSdk } from "./control-plane.js";
import { createBedrockEmbeddingProvider } from "./embedding-provider.js";
import { streamSimpleBedrock } from "./stream.runtime.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

const model = {
  api: "bedrock-converse-stream" as const,
  provider: "amazon-bedrock",
  id: "amazon.nova-micro-v1:0",
  name: "Nova Micro",
  baseUrl: "https://bedrock-runtime.us-east-1.amazonaws.com",
  reasoning: false,
  input: ["text" as const],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 128000,
  maxTokens: 4096,
};

describe("Bedrock shared credential rotation", () => {
  it.each(["stream", "embeddings", "discovery"] as const)(
    "%s resolves rotated credentials through its own SDK chain",
    async (route) => {
      const dir = tempDirs.make("bedrock-credential-rotation-");
      const credentialsFile = path.join(dir, "credentials");
      const configFile = path.join(dir, "config");
      await writeFile(configFile, "");
      for (const name of [
        "AWS_ACCESS_KEY_ID",
        "AWS_SECRET_ACCESS_KEY",
        "AWS_SESSION_TOKEN",
        "AWS_BEARER_TOKEN_BEDROCK",
        "AWS_BEDROCK_SKIP_AUTH",
      ]) {
        vi.stubEnv(name, undefined);
      }
      vi.stubEnv("AWS_PROFILE", "rotation");
      vi.stubEnv("AWS_SHARED_CREDENTIALS_FILE", credentialsFile);
      vi.stubEnv("AWS_CONFIG_FILE", configFile);
      vi.stubEnv("AWS_EC2_METADATA_DISABLED", "true");
      vi.stubEnv("AWS_REGION", "us-east-1");
      const rotate = (generation: string) =>
        writeFile(
          credentialsFile,
          `[rotation]\naws_access_key_id = TEST_${generation}\naws_secret_access_key = synthetic-secret-${generation}\naws_session_token = synthetic-token-${generation}\n`,
        );
      await rotate("A");
      // Prime the actual SDK's file cache, independently of OpenClaw's refresh helper.
      expect((await defaultProvider()()).accessKeyId).toBe("TEST_A");
      const resolved: string[] = [];
      const pendingCredentials: Promise<void>[] = [];
      const capture = async (client: BedrockClient | BedrockRuntimeClient) => {
        const credentials = await client.config.credentials();
        resolved.push(`${credentials.accessKeyId}/${credentials.sessionToken}`);
      };
      vi.spyOn(BedrockRuntimeClient.prototype, "send").mockImplementation(
        function (this: BedrockRuntimeClient) {
          pendingCredentials.push(capture(this));
          return {
            $metadata: {},
            body: new TextEncoder().encode('{"embedding":[1,0]}'),
            stream: (async function* () {
              yield { messageStop: { stopReason: "end_turn" } };
            })(),
          };
        },
      );
      vi.spyOn(BedrockClient.prototype, "send").mockImplementation(function (this: BedrockClient) {
        pendingCredentials.push(capture(this));
        return { $metadata: {}, modelSummaries: [] };
      });
      const invoke = async () => {
        if (route === "stream") {
          const result = await streamSimpleBedrock(model, {
            messages: [{ role: "user", content: "Hello", timestamp: 0 }],
          }).result();
          expect(result.stopReason).toBe("stop");
        } else if (route === "embeddings") {
          const { provider } = await createBedrockEmbeddingProvider({ config: {}, model: "" });
          await provider.embed("Hello");
        } else {
          const sdk = await loadBedrockControlPlaneSdk();
          const client = sdk.createClient("us-east-1");
          try {
            await client.send(sdk.createListFoundationModelsCommand());
          } finally {
            client.destroy();
          }
        }
      };
      await invoke();
      await Promise.all(pendingCredentials);
      await rotate("B");
      await invoke();
      await Promise.all(pendingCredentials);
      expect(resolved).toEqual(["TEST_A/synthetic-token-A", "TEST_B/synthetic-token-B"]);
    },
  );
});

describe("Bedrock credential resolution cancellation", () => {
  it.each(["before", "during"] as const)(
    "does not send or resolve credentials when cancelled %s the payload callback",
    async (when) => {
      const controller = new AbortController();
      const reason = new Error("cancelled before credential resolution");
      if (when === "before") {
        controller.abort(reason);
      }
      const onPayload = vi.fn(() => controller.abort(reason));
      const send = vi.spyOn(BedrockRuntimeClient.prototype, "send");
      const result = await streamSimpleBedrock(
        model,
        { messages: [{ role: "user", content: "Hello", timestamp: 0 }] },
        { signal: controller.signal, onPayload },
      ).result();
      expect(result.stopReason).toBe("aborted");
      expect(send).not.toHaveBeenCalled();
      expect(onPayload).toHaveBeenCalledTimes(when === "before" ? 0 : 1);
    },
  );
});
