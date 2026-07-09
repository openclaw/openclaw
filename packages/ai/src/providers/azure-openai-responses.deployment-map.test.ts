// Provider-path proof for issue #102936: drives the real Azure OpenAI Responses stream
// against a loopback server and asserts that the deployment name resolved from
// AZURE_OPENAI_DEPLOYMENT_NAME_MAP is what actually lands in the outgoing request `model`
// field — the value Azure uses to route to a deployment (a mismatch is the reported 404).
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { configureAiTransportHost } from "../host.js";
import type { Context, Model } from "../types.js";
import { streamSimpleAzureOpenAIResponses } from "./azure-openai-responses.js";

const context = {
  messages: [{ role: "user", content: "hello", timestamp: 1 }],
} satisfies Context;

function makeAzureModel(id: string, baseUrl: string): Model<"azure-openai-responses"> {
  return {
    id,
    name: id,
    provider: "azure",
    api: "azure-openai-responses",
    baseUrl,
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 200_000,
    maxTokens: 4_096,
  } satisfies Model<"azure-openai-responses">;
}

// Starts a loopback server that captures the first request body and returns a
// non-retryable error so exactly one request is emitted per stream.
async function withCapturedModel(
  deploymentMap: string,
  run: (baseUrl: string) => Promise<void>,
): Promise<string | undefined> {
  let capturedModel: string | undefined;
  const server: Server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => {
      body += chunk;
    });
    request.on("end", () => {
      try {
        capturedModel = JSON.parse(body).model;
      } catch {
        capturedModel = undefined;
      }
      response.writeHead(400, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { message: "captured" } }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const previousMap = process.env.AZURE_OPENAI_DEPLOYMENT_NAME_MAP;
  process.env.AZURE_OPENAI_DEPLOYMENT_NAME_MAP = deploymentMap;
  configureAiTransportHost({
    buildModelFetch: () => (input, init) => globalThis.fetch(input, init),
  });
  try {
    const address = server.address() as AddressInfo;
    await run(`http://127.0.0.1:${address.port}/openai/v1`);
  } finally {
    configureAiTransportHost({});
    if (previousMap === undefined) {
      delete process.env.AZURE_OPENAI_DEPLOYMENT_NAME_MAP;
    } else {
      process.env.AZURE_OPENAI_DEPLOYMENT_NAME_MAP = previousMap;
    }
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  return capturedModel;
}

async function drive(baseUrl: string, modelId: string): Promise<void> {
  await streamSimpleAzureOpenAIResponses(makeAzureModel(modelId, baseUrl), context, {
    apiKey: "test-key",
  }).result();
}

describe("azure-openai-responses deployment-map (provider path)", () => {
  afterEach(() => {
    configureAiTransportHost({});
  });

  it("sends the case-insensitively resolved deployment name on the wire", async () => {
    const captured = await withCapturedModel("gpt-4o=deployment-gpt-4o", (baseUrl) =>
      drive(baseUrl, "GPT-4o"),
    );
    expect(captured).toBe("deployment-gpt-4o");
  });

  it("keeps the exact-case deployment mapping on the wire (no regression)", async () => {
    const captured = await withCapturedModel("GPT-4o=prod-a,gpt-4o=prod-b", (baseUrl) =>
      drive(baseUrl, "GPT-4o"),
    );
    expect(captured).toBe("prod-a");
  });
});
