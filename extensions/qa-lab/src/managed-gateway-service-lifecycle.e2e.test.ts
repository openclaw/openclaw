// QA Lab owns the real child/provider fixture used by the managed service proof.
import { fileURLToPath } from "node:url";
import { stopQaGatewayFixture } from "openclaw/plugin-sdk/test-env";
import { afterEach, describe, expect, it } from "vitest";
import { createQaGatewayChild } from "./gateway-child.js";
import { startQaProviderServer } from "./providers/server-runtime.js";

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));

async function fetchJson(url: string, label: string): Promise<Record<string, unknown>> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`${label} returned HTTP ${response.status}`);
  }
  const body: unknown = await response.json();
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new Error(`${label} did not return a JSON object`);
  }
  return body as Record<string, unknown>;
}

describe("managed gateway service lifecycle product proof", () => {
  const cleanups: Array<() => Promise<void>> = [];
  afterEach(async () => {
    const errors: unknown[] = [];
    for (const cleanup of cleanups.splice(0).toReversed()) {
      await cleanup().catch((error: unknown) => errors.push(error));
    }
    if (errors.length) {
      throw new AggregateError(errors, "foreground gateway fixture cleanup failed");
    }
  });

  it(
    "runs a foreground gateway with live, ready, and RPC health",
    { timeout: 180_000 },
    async () => {
      const provider = await startQaProviderServer("mock-openai");
      if (!provider) {
        throw new Error("mock OpenAI provider did not start");
      }
      cleanups.push(() => provider.stop());
      const gatewayOwner = createQaGatewayChild();
      cleanups.push(() => stopQaGatewayFixture(gatewayOwner));
      const gateway = await gatewayOwner.start({
        repoRoot,
        useRepoCli: true,
        initializeCurrentRuntimeState: true,
        providerBaseUrl: `${provider.baseUrl}/v1`,
        providerMode: "mock-openai",
        transportBaseUrl: "http://127.0.0.1",
        controlUiEnabled: false,
      });
      expect(gateway.pid).toBeGreaterThan(0);
      await expect(
        fetchJson(`${gateway.baseUrl}/healthz`, "gateway /healthz"),
      ).resolves.toMatchObject({ status: "live" });
      await expect(
        fetchJson(`${gateway.baseUrl}/readyz`, "gateway /readyz"),
      ).resolves.toMatchObject({ ready: true });
      const rpcHealth = await gateway.call("health", {});
      expect(rpcHealth).not.toBeNull();
      expect(Array.isArray(rpcHealth)).toBe(false);
      expect(typeof rpcHealth).toBe("object");
    },
  );
});
