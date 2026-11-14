import fs from "node:fs";
import path from "node:path";
// Verifies package transports consume the route generation prepared on the model.
import {
  configureAiTransportHost,
  getAiTransportHost,
  getDefaultAiTransportHost,
} from "@openclaw/ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { createPluginModuleLoader } from "../plugins/loader-module-runtime.js";
import type { PluginMetadataSnapshotOwnerMaps } from "../plugins/plugin-metadata-snapshot.types.js";
import { attachModelProviderLocalServiceReconciler } from "./provider-local-service-reconcile.js";
import "./ai-transport-runtime-host.js";
import {
  attachModelProviderLocalService,
  ensureModelProviderLocalService,
  stopManagedProviderLocalServices,
} from "./provider-local-service.js";
import {
  attachModelProviderRequestRouteFacts,
  getModelProviderRequestRouteFacts,
  resolveProviderRequestPolicyConfig,
} from "./provider-request-config.js";
import { buildGuardedModelFetch } from "./provider-transport-fetch.js";
import { makeProviderModelFixture } from "./test-helpers/provider-model-fixture.js";

const temp = useAutoCleanupTempDirTracker(afterEach);

function buildOwners(): PluginMetadataSnapshotOwnerMaps {
  const empty = new Map<string, readonly string[]>();
  return {
    channels: empty,
    channelConfigs: empty,
    providers: empty,
    modelCatalogProviders: empty,
    cliBackends: empty,
    setupProviders: empty,
    commandAliases: empty,
    contracts: empty,
    providerAuthContributions: [],
    modelIdNormalizationPolicies: new Map(),
    providerEndpoints: [
      { endpointClass: "openai-public", hosts: ["prepared.example"] },
      { endpointClass: "anthropic-public", hosts: ["projected.example"] },
    ],
    providerRequests: new Map([["openai", { family: "prepared-openai-family" }]]),
  };
}

describe("AI transport prepared provider routes", () => {
  it("retains guarded defaults and configured observers across native SDK loading", async () => {
    const originalHost = getDefaultAiTransportHost();
    expect(originalHost.buildModelFetch).toBe(buildGuardedModelFetch);
    const requests: unknown[] = [];
    const fetchObserver = vi.fn<typeof fetch>(async (input, init) => {
      requests.push(await new Request(input, init).json());
      return new Response(
        `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: "observed" }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`,
        { headers: { "content-type": "text/event-stream" } },
      );
    });
    const buildModelFetch = () => fetchObserver;
    configureAiTransportHost({ ...originalHost, buildModelFetch });
    const model = attachModelProviderRequestRouteFacts(
      makeProviderModelFixture<"openai-completions">({
        id: "prepared-model",
        provider: "openai",
        api: "openai-completions",
        baseUrl: "https://prepared.example/v1",
      }),
      buildOwners(),
    );
    try {
      const plugin = path.join(temp.make("native-fetch-observer-"), "index.cjs");
      fs.writeFileSync(plugin, `module.exports = require("openclaw/plugin-sdk/llm");`);
      const load = createPluginModuleLoader({ tryNative: true, pluginSdkResolution: "src" });
      const sdk = load(plugin) as typeof import("../plugin-sdk/llm.js");
      // Check before invoking the fetch port: a regression must never send a real request.
      expect(getDefaultAiTransportHost().buildModelFetch).toBe(buildModelFetch);
      const response = await sdk.complete(
        model,
        { messages: [{ role: "user", content: "observer fixture", timestamp: 0 }] },
        { apiKey: "synthetic-observer-key" },
      );
      expect(response).toMatchObject({
        stopReason: "stop",
        content: [{ type: "text", text: "observed" }],
      });
      expect(requests).toMatchObject([{ model: "prepared-model", stream: true }]);
      expect(fetchObserver).toHaveBeenCalledTimes(1);
      expect(
        getDefaultAiTransportHost().resolveProviderRequestCapabilities({
          model,
          provider: model.provider,
          api: model.api,
          baseUrl: model.baseUrl,
          capability: "llm",
          transport: "stream",
        }),
      ).toMatchObject({
        endpointClass: "openai-public",
        knownProviderFamily: "prepared-openai-family",
      });
    } finally {
      configureAiTransportHost(originalHost);
    }
  });

  it("keeps headers, capabilities, and SSRF posture on the prepared metadata generation", () => {
    const model = attachModelProviderRequestRouteFacts(
      makeProviderModelFixture<"openai-responses">({
        id: "gpt-5.6-luna",
        provider: "openai",
        api: "openai-responses",
        baseUrl: "https://prepared.example/v1",
      }),
      buildOwners(),
    );
    const host = getAiTransportHost();
    const headers = host.resolveProviderRequestHeaders({
      model,
      provider: model.provider,
      api: model.api,
      baseUrl: model.baseUrl,
    });
    const capabilities = host.resolveProviderRequestCapabilities({
      model,
      provider: model.provider,
      api: model.api,
      baseUrl: model.baseUrl,
      capability: "llm",
      transport: "stream",
    });
    const requestPolicy = resolveProviderRequestPolicyConfig({
      provider: model.provider,
      api: model.api,
      baseUrl: model.baseUrl,
      routeFacts: getModelProviderRequestRouteFacts(model),
      capability: "llm",
      transport: "stream",
    });

    expect(headers).toMatchObject({ originator: "openclaw" });
    expect(capabilities).toMatchObject({
      endpointClass: "openai-public",
      knownProviderFamily: "prepared-openai-family",
    });
    expect(requestPolicy.trustConfiguredBaseUrlOrigin).toBe(false);
  });

  it("re-resolves projected transport routes against the same metadata generation", () => {
    const owners = buildOwners();
    const source = attachModelProviderRequestRouteFacts(
      makeProviderModelFixture<"openai-responses">({
        id: "gpt-5.6-luna",
        provider: "openai",
        api: "openai-responses",
        baseUrl: "https://prepared.example/v1",
      }),
      owners,
    );
    const projected = getAiTransportHost().inheritManagedTransport(source, {
      ...source,
      baseUrl: "https://projected.example/v1",
    });
    const routeFacts = getModelProviderRequestRouteFacts(projected);

    expect(routeFacts?.providerMetadataOwners).toBe(owners);
    expect(routeFacts?.capabilities.endpointClass).toBe("anthropic-public");
    expect(routeFacts?.providerOwner).toBe("anthropic-public");
  });

  it("reconciles the current source before fetching with a structured-cloned projection", async () => {
    const baseUrl = "http://127.0.0.1:12345/v1";
    const events: string[] = [];
    const source = attachModelProviderLocalServiceReconciler(
      attachModelProviderLocalService(
        makeProviderModelFixture<"openai-completions">({
          id: "local-model",
          provider: "local-projection",
          api: "openai-completions",
          baseUrl,
        }),
        {
          command: process.execPath,
          healthUrl: `${baseUrl}/health`,
          idleStopMs: 0,
        },
      ),
      async () => {
        throw new Error("Stale source reconciler must not run");
      },
    );
    const cloned = structuredClone(source);
    const currentSource = attachModelProviderLocalServiceReconciler(source, async (context) => {
      expect(context.baseUrl).toBe(baseUrl);
      await Promise.resolve();
      events.push("current reconcile");
    });
    const projected = getAiTransportHost().inheritManagedTransport(currentSource, cloned);
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url === `${baseUrl}/health`) {
        return new Response("healthy");
      }
      expect(url).toBe(`${baseUrl}/chat/completions`);
      events.push("model fetch");
      return Response.json({ content: "ready" });
    });

    try {
      const lease = await ensureModelProviderLocalService(projected);
      try {
        expect(lease).toBeDefined();
        const response = await fetch(`${projected.baseUrl}/chat/completions`);
        expect(await response.json()).toEqual({ content: "ready" });
        expect(events).toEqual(["current reconcile", "model fetch"]);
      } finally {
        lease?.release();
      }
    } finally {
      await stopManagedProviderLocalServices();
      fetchSpy.mockRestore();
    }
  });
});
