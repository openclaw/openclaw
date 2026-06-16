import { capturePluginRegistration } from "openclaw/plugin-sdk/plugin-test-runtime";
import { describe, expect, it } from "vitest";
import plugin from "./index.js";

describe("clawrouter provider plugin", () => {
  it("registers managed proxy-key auth and dynamic routing hooks", () => {
    const captured = capturePluginRegistration(plugin);
    const provider = captured.providers[0];

    expect(provider).toMatchObject({
      id: "clawrouter",
      label: "ClawRouter",
      docsPath: "/providers/clawrouter",
      envVars: ["CLAWROUTER_API_KEY"],
      isModernModelRef: expect.any(Function),
      normalizeResolvedModel: expect.any(Function),
      resolveDynamicModel: expect.any(Function),
    });
    expect(provider?.auth[0]).toMatchObject({
      id: "api-key",
      label: "ClawRouter proxy key",
      kind: "api_key",
    });
  });

  it("normalizes configured ClawRouter roots to the API base URL", () => {
    const provider = capturePluginRegistration(plugin).providers[0];
    const normalized = provider?.normalizeConfig?.({
      provider: "clawrouter",
      providerConfig: {
        baseUrl: "https://clawrouter.example/",
        models: [],
      },
    } as never);

    expect(normalized).toMatchObject({
      baseUrl: "https://clawrouter.example/v1",
    });
  });
});
