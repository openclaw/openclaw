import { getAiTransportHost } from "@openclaw/ai";
import { expect, it, vi } from "vitest";
import { createEmptyPluginMetadataSnapshot } from "../plugins/plugin-metadata-empty.test-support.js";
import type { PluginMetadataSnapshotOwnerMaps } from "../plugins/plugin-metadata-snapshot.types.js";
import "./ai-transport-runtime-host.js";
import { attachModelProviderLocalServiceReconciler as attachReconciler } from "./provider-local-service-reconcile.js";
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
import { makeProviderModelFixture } from "./test-helpers/provider-model-fixture.js";

const owners: PluginMetadataSnapshotOwnerMaps = {
  ...createEmptyPluginMetadataSnapshot().owners,
  providerEndpoints: [
    { endpointClass: "openai-public", hosts: ["prepared.example"] },
    { endpointClass: "anthropic-public", hosts: ["projected.example"] },
  ],
  providerRequests: new Map([["openai", { family: "prepared-openai-family" }]]),
};

it("keeps prepared metadata for headers, SSRF posture, and projected routes", () => {
  const model = attachModelProviderRequestRouteFacts(
    makeProviderModelFixture<"openai-responses">({
      id: "gpt-5.6-luna",
      provider: "openai",
      api: "openai-responses",
      baseUrl: "https://prepared.example/v1",
    }),
    owners,
  );
  const host = getAiTransportHost();
  const route = { model, provider: model.provider, api: model.api, baseUrl: model.baseUrl };
  const request = { ...route, capability: "llm" as const, transport: "stream" as const };
  const capabilities = host.resolveProviderRequestCapabilities(request);
  const routeFacts = getModelProviderRequestRouteFacts(model);
  const requestPolicy = resolveProviderRequestPolicyConfig({ ...request, routeFacts });

  expect(host.resolveProviderRequestHeaders(route)).toMatchObject({ originator: "openclaw" });
  expect(capabilities).toMatchObject({
    endpointClass: "openai-public",
    knownProviderFamily: "prepared-openai-family",
  });
  expect(requestPolicy.trustConfiguredBaseUrlOrigin).toBe(false);
  const projected = host.inheritManagedTransport(model, {
    ...model,
    baseUrl: "https://projected.example/v1",
  });
  const projectedFacts = getModelProviderRequestRouteFacts(projected);

  expect(projectedFacts?.providerMetadataOwners).toBe(owners);
  expect(projectedFacts).toMatchObject({
    capabilities: { endpointClass: "anthropic-public" },
    providerOwner: "anthropic-public",
  });
});

it("reconciles the current source before fetching with a structured-cloned projection", async () => {
  const baseUrl = "http://127.0.0.1:12345/v1";
  const events: string[] = [];
  const model = makeProviderModelFixture<"openai-completions">({
    id: "local-model",
    provider: "local-projection",
    api: "openai-completions",
    baseUrl,
  });
  const service = { command: process.execPath, healthUrl: `${baseUrl}/health`, idleStopMs: 0 };
  const managed = attachModelProviderLocalService(model, service);
  const source = attachReconciler(managed, async () => {
    throw new Error("Stale source reconciler must not run");
  });
  const cloned = structuredClone(source);
  const currentSource = attachReconciler(source, async (context) => {
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
