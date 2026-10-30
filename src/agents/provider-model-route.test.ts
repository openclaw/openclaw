import { afterEach, describe, expect, it } from "vitest";
import { resetConfigRuntimeState, setRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import {
  captureRuntimeConfig,
  projectConfigOntoRuntimeSourceSnapshot,
} from "../config/runtime-source-projection.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  createProviderModelCatalogRoutePolicy,
  modelMatchesProviderModelRoute,
  projectProviderModelRouteConfig,
} from "./provider-model-route.js";

const platformRoute = {
  api: "openai-responses",
  baseUrl: "https://api.openai.com/v1",
  authRequirement: "api-key",
  requestTransportOverrides: "none",
} as const;

afterEach(() => resetConfigRuntimeState());

describe("provider model route consumers", () => {
  it.each(["captured", "published"] as const)(
    "reuses %s route projections only within config and source generations",
    (inputKind) => {
      const source: OpenClawConfig = {
        models: { providers: { openai: { baseUrl: platformRoute.baseUrl, models: [] } } },
        gateway: { port: 19001 },
      };
      const runtime: OpenClawConfig = {
        ...source,
        gateway: { ...source.gateway, mode: "local" },
      };
      setRuntimeConfigSnapshot(runtime, source);
      const config = inputKind === "captured" ? captureRuntimeConfig(runtime) : runtime;
      const select = (route = platformRoute, input = config) =>
        projectProviderModelRouteConfig({ provider: "openai", config: input, route });
      const selected = select();
      const authored = projectConfigOntoRuntimeSourceSnapshot(selected);
      expect(authored.gateway).toEqual({ port: 19001 });
      expect(authored.models?.providers?.openai).toMatchObject({ auth: "api-key" });
      expect(projectConfigOntoRuntimeSourceSnapshot(selected)).toBe(authored);
      const otherRoute = { ...platformRoute, baseUrl: "https://proxy.example.test/v1" };
      const other = projectProviderModelRouteConfig({
        provider: "openai",
        config,
        route: otherRoute,
      });
      expect(other.models?.providers?.openai?.baseUrl).toBe(otherRoute.baseUrl);
      expect(select()).toBe(selected);
      expect(
        projectProviderModelRouteConfig({ provider: "openai", config, route: otherRoute }),
      ).toBe(other);

      const nextSource: OpenClawConfig = {
        ...source,
        models: {
          providers: {
            openai: { ...source.models!.providers!.openai!, headers: { "x-policy": "next" } },
          },
        },
      };
      setRuntimeConfigSnapshot(runtime, nextSource);
      const refreshed = select();
      expect(refreshed).not.toBe(selected);
      expect(
        projectConfigOntoRuntimeSourceSnapshot(refreshed).models?.providers?.openai?.headers,
      ).toEqual({ "x-policy": "next" });
      expect(projectConfigOntoRuntimeSourceSnapshot(selected)).toBe(authored);
      expect(select(platformRoute, captureRuntimeConfig(runtime))).not.toBe(refreshed);

      const mutableInput = { ...runtime, gateway: { ...runtime.gateway } };
      const mutable = select(platformRoute, mutableInput);
      mutableInput.gateway.port = 19002;
      expect(select(platformRoute, mutableInput)).not.toBe(mutable);
      expect(select(platformRoute, mutableInput).gateway?.port).toBe(19002);
    },
  );

  it("matches exact and owner-canonical endpoint spellings", () => {
    for (const baseUrl of [
      "https://api.openai.com/v1/",
      "https://api.openai.com",
      "https://api.openai.com:443/v1",
    ]) {
      expect(
        modelMatchesProviderModelRoute({
          provider: "openai",
          api: "openai-responses",
          baseUrl,
          route: platformRoute,
        }),
      ).toBe(true);
    }
    expect(
      modelMatchesProviderModelRoute({
        provider: "openai",
        api: "openai-completions",
        baseUrl: platformRoute.baseUrl,
        route: platformRoute,
      }),
    ).toBe(false);
  });

  it("projects a selected route onto only the normalized provider owner", () => {
    const config = projectProviderModelRouteConfig({
      provider: "openai",
      config: {
        models: {
          providers: {
            openai: {
              auth: "oauth",
              baseUrl: "https://api.openai.com/v1",
              models: [],
            },
            " OpenAI ": {
              auth: "api-key",
              api: "openai-completions",
              baseUrl: "https://legacy.example.test/v1",
              models: [],
            },
          },
        },
      },
      route: platformRoute,
    });

    expect(Object.keys(config.models?.providers ?? {})).toEqual(["openai"]);
    expect(config.models?.providers?.openai).toMatchObject({
      auth: "api-key",
      api: platformRoute.api,
      baseUrl: platformRoute.baseUrl,
      models: [],
    });
  });

  it("creates provider-scoped logical catalog policy", () => {
    const policy = createProviderModelCatalogRoutePolicy("openai");
    expect(policy.resolveIdentity({ provider: "OpenAI", id: "gpt-5.4-codex" })).toEqual({
      id: "gpt-5.4",
      key: "openai/gpt-5.4",
    });
    expect(policy.resolveIdentity({ provider: "openai", id: "openai/acme-model" })).toEqual({
      id: "openai/acme-model",
      key: "openai/openai/acme-model",
    });
    expect(policy.resolveIdentity({ provider: "anthropic", id: "gpt-5.4-codex" })).toBeNull();
  });
});
