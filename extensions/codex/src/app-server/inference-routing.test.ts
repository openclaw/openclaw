import { afterEach, describe, expect, it, vi } from "vitest";
import { createFakeCodexAppServerClient } from "./codex-app-server.test-fixtures.js";
import {
  ownCodexInferenceClient,
  prepareCodexInferenceThreadConfig,
  assertCodexInferenceRouteConfig,
  bindCodexInferenceThread,
  getCodexInferenceThread,
} from "./inference-routing.js";
import type { CodexConfigReadResponse } from "./protocol.js";
import { createClientHarness } from "./test-support.js";

const clients: ReturnType<typeof createClientHarness>[] = [];
afterEach(() => {
  for (const entry of clients.splice(0)) {
    entry.client.close();
  }
});
function harness() {
  const value = createClientHarness();
  clients.push(value);
  return value;
}
function prepareThread(
  client: ReturnType<typeof createClientHarness>["client"],
  effectiveConfig?: CodexConfigReadResponse,
) {
  return prepareCodexInferenceThreadConfig({
    client,
    binding: undefined,
    clientId: "fixture-native-client",
    cwd: "/workspace",
    effectiveConfig,
    assertCurrent: () => {},
  });
}

async function prepare(
  h: ReturnType<typeof harness>,
  type: string,
  snapshot: CodexConfigReadResponse = { config: {}, origins: {} },
) {
  const index = h.writes.length;
  const pending = prepareThread(h.client, snapshot);
  const request = JSON.parse(await h.waitForWrite(index));
  expect(request.method).toBe("account/read");
  h.send({ id: request.id, result: { account: { type } } });
  const prepared = await pending;
  if (!prepared) {
    throw new Error("expected an owned route");
  }
  expect(prepared.config).toEqual({ openai_base_url: prepared.route.baseUrl });
  return prepared.route;
}

describe("managed inference route ownership", () => {
  it("leaves unowned native clients completely untouched", async () => {
    const h = harness();
    expect(await prepareThread(h.client)).toBeUndefined();
    expect(h.writes).toEqual([]);
  });

  it.each([
    ["apiKey", "https://api.openai.com/v1"],
    ["chatgpt", "https://chatgpt.com/backend-api/codex"],
  ])(
    "resolves %s from native account state and retains only exact host-owned route trust",
    async (type, upstream) => {
      const h = harness();
      ownCodexInferenceClient(h.client);
      const route = await prepare(h, type);
      expect(route.upstream).toBe(upstream);
      expect(new URL(route.baseUrl).pathname.endsWith(new URL(upstream).pathname)).toBe(true);
      const config = { openai_base_url: route.baseUrl };
      expect(() => assertCodexInferenceRouteConfig(h.client, route, config)).not.toThrow();
      expect(() => assertCodexInferenceRouteConfig(h.client, { ...route }, config)).toThrow(
        "overridden",
      );
      expect(() =>
        assertCodexInferenceRouteConfig(h.client, route, {
          openai_base_url: "http://127.0.0.1:1/v1",
        }),
      ).toThrow("overridden");
      bindCodexInferenceThread(h.client, "root", route);
      expect(getCodexInferenceThread(h.client, "root")).toBe(route);
      bindCodexInferenceThread(h.client, "peer", route);
      bindCodexInferenceThread(h.client, "root", undefined);
      expect(getCodexInferenceThread(h.client, "root")).toBeUndefined();
      expect(getCodexInferenceThread(h.client, "peer") === route).toBe(true);
      expect(() => route.assertCurrent()).not.toThrow();
      h.send({
        method: "account/updated",
        params: { authMode: type === "chatgpt" ? "chatgptAuthTokens" : "apiKey" },
      });
      expect(await prepare(h, type)).toBe(route);
      h.client.close();
      expect(() => assertCodexInferenceRouteConfig(h.client, route, config)).toThrow();
    },
  );

  it("preserves an explicit native upstream and revokes routes on account-mode changes", async () => {
    const h = harness();
    ownCodexInferenceClient(h.client);
    const route = await prepare(h, "chatgpt", {
      config: { openai_base_url: "https://api.openai.com/v1" },
      origins: {},
    });
    expect(route.upstream).toBe("https://api.openai.com/v1");
    h.send({ method: "account/updated", params: { authMode: "apiKey" } });
    expect(() => route.assertCurrent()).toThrow();
    await expect(prepareThread(h.client)).rejects.toThrow("ownership changed");
  });

  it("keeps the physical client owner across same-build module copies", async () => {
    const h = harness();
    ownCodexInferenceClient(h.client);
    const route = await prepare(h, "apiKey");
    bindCodexInferenceThread(h.client, "root", route);
    vi.resetModules();
    const copy = await import("./inference-routing.js");
    expect(copy.getCodexInferenceThread(h.client, "root") === route).toBe(true);
    expect(() =>
      copy.assertCodexInferenceRouteConfig(h.client, route, { openai_base_url: route.baseUrl }),
    ).not.toThrow();
    h.client.close();
    expect(() => copy.getCodexInferenceThread(h.client, "root")).toThrow("closed");
  });

  const legacyProfiles: CodexConfigReadResponse["config"][] = [
    { model_provider: "bedrock" },
    { features: { respect_system_proxy: true } },
    { openai_base_url: "http://127.0.0.1:1234/v1" },
    { openai_base_url: "https://models.example.com/v1" },
  ];
  it.each(legacyProfiles)(
    "preserves unsupported native profiles without redirecting them (%j)",
    async (config) => {
      const fake = createFakeCodexAppServerClient(async () => ({ account: { type: "apiKey" } }));
      ownCodexInferenceClient(fake.client);
      try {
        const outcome = await prepareThread(fake.client, { config, origins: {} }).then(
          (prepared) => ({ route: prepared?.route }),
          (error: unknown) => ({ error }),
        );
        expect(fake.request).not.toHaveBeenCalled();
        expect("error" in outcome).toBe(false);
        expect("route" in outcome && outcome.route === undefined).toBe(true);
      } finally {
        fake.close();
      }
    },
  );

  it("does not guess an endpoint without native account evidence", async () => {
    const h = harness();
    ownCodexInferenceClient(h.client);
    const pending = prepareThread(h.client, { config: {}, origins: {} });
    const request = JSON.parse(await h.waitForWrite(0));
    h.send({ id: request.id, result: { account: { type: "unknown" } } });
    expect(await pending).toBeUndefined();
  });
});
