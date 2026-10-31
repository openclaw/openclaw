import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { AuthStorage, ModelRegistry } from "openclaw/plugin-sdk/agent-sessions";
import { registerSingleProviderPlugin } from "openclaw/plugin-sdk/plugin-test-runtime";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { afterEach, expect, it, vi } from "vitest";
import { runSingleProviderCatalog } from "../test-support/provider-model-test-helpers.js";
import radiusPlugin from "./index.js";
import * as fixture from "./test-support.js";

const { fetchGuard, streamFetch, resolveAuth } = vi.hoisted(() => ({
  fetchGuard: vi.fn(),
  streamFetch: vi.fn(),
  resolveAuth: vi.fn(),
}));
vi.mock("openclaw/plugin-sdk/provider-auth-runtime", () => ({
  resolveApiKeyForProvider: resolveAuth,
}));
vi.mock("openclaw/plugin-sdk/ssrf-runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/ssrf-runtime")>()),
  fetchWithSsrFGuard: fetchGuard,
}));
vi.mock("openclaw/plugin-sdk/provider-transport-runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/provider-transport-runtime")>()),
  buildGuardedModelFetch: () => streamFetch,
}));

afterEach(() => {
  vi.useRealTimers();
  vi.resetAllMocks();
});
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

const response = (payload: object) => ({
  response: Response.json(payload),
  release: async () => {},
});
function mockCatalog(model: ReturnType<typeof fixture.catalogModel>) {
  fetchGuard.mockImplementation(async () =>
    response({ baseUrl: fixture.baseUrl, models: [model] }),
  );
}

it.each([true, false])(
  "returns Radius credentials with credentialOnly=%s and discovers models only for setup",
  async (credentialOnly) => {
    const provider = await registerSingleProviderPlugin(radiusPlugin);
    const method = provider.auth.find((auth) => auth.id === "oauth")!;
    mockCatalog(fixture.catalogModel("balanced", "Balanced"));
    fetchGuard
      .mockResolvedValueOnce(response(fixture.devicePayload))
      .mockResolvedValueOnce(response(fixture.tokenPayload));
    const { promise: deviceCode, resolve: codeShown } = Promise.withResolvers<void>();
    const { ctx } = fixture.authContext({
      config: { agents: { defaults: { model: { primary: "other/existing" } } } },
      credentialOnly,
      isRemote: true,
    });
    ctx.prompter.deviceCode = async () => codeShown();
    vi.useFakeTimers();
    const pending = method.run(ctx);
    await deviceCode;
    await vi.advanceTimersByTimeAsync(1_000);
    const result = await pending;
    expect(result.profiles).toEqual([
      {
        profileId: "radius:default",
        credential: {
          type: "oauth",
          provider: "radius",
          access: "access-test",
          refresh: "refresh-test",
          expires: Date.now() + 3_540_000,
        },
      },
    ]);
    expect(result.defaultModel).toBe(credentialOnly ? undefined : "radius/balanced");
    expect(result.configPatch).toEqual(
      credentialOnly ? undefined : { agents: { defaults: { models: { "radius/balanced": {} } } } },
    );
    expect(fetchGuard.mock.calls.map(([request]) => request.url)).toEqual([
      "https://radius.pi.dev/v1/oauth/device",
      "https://radius.pi.dev/v1/oauth/token",
      ...(credentialOnly ? [] : ["https://radius.pi.dev/v1/config"]),
    ]);
    expect(ctx.config.agents?.defaults?.model).toEqual({ primary: "other/existing" });
  },
);

it("routes a discovered organization model through the registered native transport", async () => {
  const metadata = fixture.catalogModel("organization/custom-model", "Organization model", 100_000);
  mockCatalog(metadata);
  const provider = await registerSingleProviderPlugin(radiusPlugin);
  const catalog = await runSingleProviderCatalog(provider, {
    resolveProviderAuth: () => ({
      apiKey: "RADIUS_API_KEY",
      discoveryApiKey: "test-radius-key",
      mode: "api_key",
      source: "env",
    }),
  });
  expect(catalog.models).toHaveLength(1);
  const modelsPath = path.join(tempDirs.make("radius-catalog-"), "models.json");
  fs.writeFileSync(modelsPath, JSON.stringify({ providers: { radius: catalog } }));
  const registry = ModelRegistry.create(AuthStorage.inMemory(), modelsPath);
  const model = registry.find("radius", metadata.id)!;
  expect(model.api).toBe("pi-messages");
  const streamFn = provider.createStreamFn!({
    model,
    modelId: model.id,
    provider: "radius",
  });
  assert(streamFn, "expected the registered native transport");
  streamFetch.mockResolvedValue(
    new Response(fixture.sse([{ type: "done", reason: "stop", usage: fixture.usage }])),
  );
  const stream = await streamFn(
    model,
    { messages: [{ role: "user", content: "Hello", timestamp: 0 }] },
    { apiKey: "test-radius-key" },
  );
  expect(await stream.result()).toMatchObject({
    api: "pi-messages",
    stopReason: "stop",
  });
  const [url, request] = streamFetch.mock.calls[0]!;
  expect(url).toBe("https://radius.pi.dev/v1/messages");
  expect(JSON.parse(request.body).model).toBe("organization/custom-model");
});

it("resolves a cold agent's model from its pinned account without inventing unknown models", async () => {
  const model = fixture.catalogModel("organization/cold-model", "Cold model");
  mockCatalog(model);
  resolveAuth.mockResolvedValue({ apiKey: "test-pinned-key" });
  const provider = await registerSingleProviderPlugin(radiusPlugin);
  const ctx = {
    provider: "radius",
    modelId: model.id,
    authProfileId: "radius:account-a",
    modelRegistry: ModelRegistry.inMemory(AuthStorage.inMemory()),
  };
  expect(ctx.modelRegistry.find("radius", model.id)).toBeUndefined();
  expect(await provider.prepareDynamicModel?.(ctx)).toMatchObject({
    ...model,
    provider: "radius",
    api: "pi-messages",
    baseUrl: fixture.baseUrl,
  });
  expect(resolveAuth).toHaveBeenCalledWith(
    expect.objectContaining({
      provider: "radius",
      profileId: "radius:account-a",
      lockedProfile: true,
    }),
  );
  expect(
    await provider.prepareDynamicModel?.({ ...ctx, modelId: "not-in-account" }),
  ).toBeUndefined();
});
