import assert from "node:assert/strict";
import type { EmbeddingProvider } from "openclaw/plugin-sdk/embedding-providers";
import { describe, expect, it } from "vitest";
import { createManagerIndexFixture } from "./manager-index.test-support.js";

const memoryIndex = await import("./index.js");

describe("memory fallback initialization", () => {
  const fixture = createManagerIndexFixture(memoryIndex);
  const { provider, createConfig, getPersistentManager } = fixture;

  it.each([
    { required: true, failure: "providerCreationFailure" },
    { required: false, failure: "providerCreationFailure" },
    { required: false, failure: "providerNullResult" },
  ] as const)(
    "retries the primary after $failure (required: $required)",
    async ({ required, failure }) => {
      const manager = await getPersistentManager(
        createConfig({
          ...(required ? { provider: "openai" } : {}),
          fallback: "fallback-provider",
        }),
      );
      await manager.sync({ reason: "test" });
      const fields = manager as unknown as { provider: EmbeddingProvider | null };
      assert.ok(fields.provider, "Expected a test embedding provider");
      fields.provider.embed = async () => {
        throw new Error("embedding provider failed");
      };
      provider[failure] = "fallback-provider";
      const callsBeforeSearch = provider.providerCalls.length;
      if (required) {
        await expect(manager.search("alpha")).rejects.toThrow(
          /Memory search unavailable: embedding provider "openai" is configured but unavailable\./,
        );
      } else {
        await expect(manager.search("alpha")).resolves.toBeDefined();
      }
      provider[failure] = null;
      await expect(manager.search("alpha")).resolves.toBeDefined();
      if (!required) {
        expect(fields.provider?.id).toBe("mock");
        if (failure === "providerCreationFailure") {
          expect(
            provider.providerCalls.slice(callsBeforeSearch).map((call) => call.provider),
          ).toEqual(["fallback-provider", "openai"]);
        }
      }
    },
  );
});
