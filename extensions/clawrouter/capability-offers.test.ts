import { describe, expect, it } from "vitest";
import { readClawRouterCapabilityOffers } from "./capability-offers.js";

function catalog(offerPatch = {}, providerPatch = {}) {
  return {
    version: "clawrouter.client-catalog.v1",
    providers: [
      {
        id: "tavily",
        allowed: true,
        executable: true,
        nativeBaseUrl: "/v1/native/tavily",
        routes: [
          {
            endpoint: "search",
            path: "/search",
            methods: ["POST"],
            requestFormat: "tavily.search",
            responseFormat: "tavily.search",
          },
        ],
        models: [],
        offers: [
          {
            endpoint: "search",
            modelId: null,
            transport: "http",
            routeKind: "native",
            route: "/v1/native/tavily/search",
            eligible: true,
            affordability: "request-dependent",
            ...offerPatch,
          },
        ],
        ...providerPatch,
      },
    ],
  };
}

describe("ClawRouter capability offer projection", () => {
  it("joins model-less search and manifest offers to their declared native format", () => {
    const native = readClawRouterCapabilityOffers(catalog(), "https://router.example/v1");
    expect(native).toEqual([
      {
        providerId: "tavily",
        endpoint: "search",
        url: "https://router.example/v1/native/tavily/search",
        routeKind: "native",
        methods: ["POST"],
        requestFormat: "tavily.search",
        responseFormat: "tavily.search",
      },
    ]);
    const manifest = readClawRouterCapabilityOffers(
      catalog({
        routeKind: "manifest",
        route: "/v1/proxy/tavily/search",
      }),
      "https://other.example/prefix/v1",
    );
    expect(manifest[0]?.url).toBe("https://other.example/prefix/v1/proxy/tavily/search");
  });

  it("does not infer grants, formats, models, transports or external destinations", () => {
    for (const patch of [
      { eligible: false },
      { affordability: "exact-blocked" },
      { transport: "websocket" },
      { modelId: "tavily/not-listed" },
      { modelId: undefined },
      { endpoint: "missing" },
      { routeKind: "playground" },
      { route: "https://upstream.example/search" },
      { routeKind: "unified", route: "/v1/search" },
    ]) {
      expect(readClawRouterCapabilityOffers(catalog(patch), "https://router.example/v1")).toEqual(
        [],
      );
    }
    for (const patch of [
      { allowed: false },
      { executable: false },
      { routes: [] },
      { nativeBaseUrl: "https://upstream.example" },
    ]) {
      expect(
        readClawRouterCapabilityOffers(catalog({}, patch), "https://router.example/v1"),
      ).toEqual([]);
    }
  });

  it("resolves only the listed model's template without allowing path injection", () => {
    const body = catalog(
      { modelId: "tavily/fixture", route: "/v1/native/tavily/models/${model}" },
      {
        models: [{ id: "tavily/fixture", upstream: "name/with?query" }],
        routes: [
          {
            endpoint: "search",
            path: "/models/${model}",
            methods: ["POST"],
            requestFormat: "fixture.generate",
            responseFormat: "fixture.generate",
          },
        ],
      },
    );
    expect(readClawRouterCapabilityOffers(body, "https://router.example/v1")[0]?.url).toBe(
      "https://router.example/v1/native/tavily/models/name%2Fwith%3Fquery",
    );
  });
});
