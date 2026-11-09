import { describe, expect, it } from "vitest";
import { createNativeModelOwnedRuntimeModel } from "../defaults.js";
import { buildAgentRuntimeAuthPlan } from "../runtime-plan/auth.js";
import { projectPreparedModelProvider } from "./support.js";

const model = createNativeModelOwnedRuntimeModel({
  provider: "openai",
  modelId: "gpt-future-native",
});
const plan = buildAgentRuntimeAuthPlan({
  provider: "openai",
  harnessId: "codex",
  providerAuthAliasesEnabled: false,
});

describe("native model support projection", () => {
  it("does not turn structural transport into an authored native-account route", () => {
    const result = projectPreparedModelProvider({ model, plan, nativeModelOwned: true });
    expect(result).not.toHaveProperty("api");
    expect(result).not.toHaveProperty("baseUrl");
    expect(result.preparedAuth).toEqual({ source: "harness" });
  });
  it.each([false, undefined])(
    "keeps transport without verified native ownership (%s)",
    (nativeModelOwned) => {
      expect(projectPreparedModelProvider({ model, plan, nativeModelOwned })).toMatchObject({
        api: "openai-responses",
        baseUrl: "",
      });
    },
  );
  it("does not infer a native account before authentication preparation", () => {
    expect(projectPreparedModelProvider({ model, nativeModelOwned: true })).toMatchObject({
      api: "openai-responses",
      baseUrl: "",
    });
  });
  it("preserves forwarded credentials instead of treating them as native authentication", () => {
    const prepared = {
      ...plan,
      forwardedAuthProfileId: "fixture-profile",
      selectedAuthMode: "oauth",
    };
    expect(
      projectPreparedModelProvider({ model, plan: prepared, nativeModelOwned: true }),
    ).toMatchObject({
      api: "openai-responses",
      baseUrl: "",
      preparedAuth: { source: "profile", mode: "oauth" },
    });
  });
  it("preserves concrete custom routes and their compatibility restrictions", () => {
    const prepared = {
      ...plan,
      modelRoute: {
        provider: "openai",
        modelId: model.id,
        api: "openai-responses" as const,
        baseUrl: "https://relay.example.test/v1",
        authRequirement: "api-key" as const,
        requestTransportOverrides: "none" as const,
        runtimePolicy: { compatibleIds: ["openclaw"] },
      },
    };
    expect(
      projectPreparedModelProvider({ model, plan: prepared, nativeModelOwned: true }),
    ).toMatchObject({
      api: "openai-responses",
      baseUrl: "https://relay.example.test/v1",
      runtimePolicy: { compatibleIds: ["openclaw"] },
      preparedAuth: { requirement: "api-key" },
    });
  });
  it("retains deferred policy and transport-override refusals", () => {
    const prepared = {
      ...plan,
      deferredRouteSupport: {
        requestTransportOverrides: "present" as const,
        runtimePolicy: { compatibleIds: ["openclaw"] },
      },
    };
    expect(
      projectPreparedModelProvider({ model, plan: prepared, nativeModelOwned: true }),
    ).toMatchObject({
      requestTransportOverrides: "present",
      runtimePolicy: { compatibleIds: ["openclaw"] },
    });
  });
});
