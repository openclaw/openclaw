import { afterEach, describe, expect, it, vi } from "vitest";
import * as discovery from "../agent-model-discovery.js";
import { createEmptyAgentDiscoveryStores, resolveModelAsync } from "./model.js";
import { makeModel } from "./model.test-harness.js";

afterEach(() => vi.restoreAllMocks());

describe("configured decision endpoints in chat resolution", () => {
  it.each(["judge", " JUDGE "])("rejects %s before chat discovery", async (provider) => {
    const discoverAuth = vi.spyOn(discovery, "discoverAuthStorageFacts");
    const discoverModels = vi.spyOn(discovery, "discoverModels");
    const stores = createEmptyAgentDiscoveryStores();
    const result = await resolveModelAsync(
      provider,
      "custom",
      undefined,
      {
        models: {
          providers: {
            judge: {
              type: "decision",
              decisionProvider: "typesafe",
              baseUrl: "https://decision.example.test",
              models: [makeModel("custom")],
            },
          },
        },
      },
      stores,
    );
    expect(result.model).toBeUndefined();
    expect(result.error).toContain("configured for decision models");
    expect(result.authStorage).toBe(stores.authStorage);
    expect(result.modelRegistry).toBe(stores.modelRegistry);
    expect(discoverAuth).not.toHaveBeenCalled();
    expect(discoverModels).not.toHaveBeenCalled();
  });
});
