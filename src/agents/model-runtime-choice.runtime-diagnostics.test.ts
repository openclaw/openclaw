import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  onInternalDiagnosticEvent,
  resetDiagnosticEventsForTest,
  waitForDiagnosticEventsDrained,
  type DiagnosticEventPayload,
} from "../plugin-sdk/diagnostic-runtime.js";
import { createPluginMetadataSnapshotFixture } from "../plugins/plugin-metadata.test-support.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import type { AuthProfileStore } from "./auth-profiles/types.js";
import { createPreparedConfiguredRuntimeModelLookup } from "./embedded-agent-runner/model.static-id.js";
import { prepareModelChoice, preparePublishedModelRuntimeChoice } from "./model-runtime-choice.js";
import { setPreparedModelRuntimeAuthStore } from "./prepared-model-runtime-auth.js";
import type { PreparedModelRuntimeSnapshot } from "./prepared-model-runtime.types.js";
import { AuthStorage, ModelRegistry } from "./sessions/index.js";

const published = vi.hoisted((): { owner?: PreparedModelRuntimeSnapshot } => ({}));
vi.mock("./prepared-model-catalog.js", () => ({
  getPublishedPreparedModelCatalogOwnerSnapshot: () => published.owner,
  materializePreparedModelCatalogOwner: (owner: PreparedModelRuntimeSnapshot) => owner,
  withPreparedModelCatalogOwner: async <T>(
    _params: unknown,
    read: (owner: PreparedModelRuntimeSnapshot) => T | Promise<T>,
  ) => {
    if (!published.owner) {
      throw new Error("No published test model owner");
    }
    return await read(published.owner);
  },
}));

const cfg: OpenClawConfig = { plugins: { enabled: false } };
const request = {
  cfg,
  agentId: "main",
  provider: "fixture",
  model: "model",
  runtimeId: "openclaw",
};

function publish(isCurrent = () => true, config = cfg, auth = true) {
  const entry = { provider: "fixture", id: "model", name: "Model" };
  const metadataSnapshot = createPluginMetadataSnapshotFixture();
  const configuredRuntimeModels: PreparedModelRuntimeSnapshot["configuredRuntimeModels"] = [];
  const owner: PreparedModelRuntimeSnapshot = {
    config,
    observationConfig: config,
    catalogOwner: { agentId: "main", workspaceDir: "/tmp/runtime-choice" },
    agentId: "main",
    agentDir: "/tmp/runtime-choice/agent",
    workspaceDir: "/tmp/runtime-choice",
    activeProjectKeys: [],
    authModes: {},
    metadataSnapshot,
    isCurrent,
    allowGatewaySubagentBinding: false,
    modelCatalog: { entries: [entry], routeVariants: [entry] },
    configuredRuntimeModels,
    findConfiguredRuntimeModel: createPreparedConfiguredRuntimeModelLookup(
      configuredRuntimeModels,
      metadataSnapshot,
    ),
    inlineProviderModels: [],
    createStores() {
      const authStorage = AuthStorage.inMemory({});
      return { authStorage, modelRegistry: ModelRegistry.inMemory(authStorage) };
    },
  };
  if (auth) {
    setPreparedModelRuntimeAuthStore(owner, {
      version: 1,
      profiles: {
        "fixture:account": { type: "api_key", provider: "fixture", key: "synthetic-credential" },
      },
    });
  }
  published.owner = owner;
  return owner;
}

describe("published runtime choice", () => {
  let events: Extract<DiagnosticEventPayload, { type: "model.runtime_choice" }>[];
  beforeEach(() => {
    published.owner = undefined;
    resetDiagnosticEventsForTest();
    events = [];
    onInternalDiagnosticEvent(
      (event, metadata) => {
        if (metadata.trusted && event.type === "model.runtime_choice") {
          events.push(event);
        }
      },
      { include: ["model.runtime_choice"] },
    );
  });
  afterEach(async () => {
    await waitForDiagnosticEventsDrained();
    resetDiagnosticEventsForTest();
  });

  it("keeps support admission separate from published runtime decisions", async () => {
    const config: OpenClawConfig = {
      ...cfg,
      models: {
        providers: {
          fixture: {
            api: "openai-completions",
            baseUrl: "https://models.example.invalid/v1",
            models: [],
          },
        },
      },
    };
    let current = true;
    publish(() => current, config);
    expect(
      await prepareModelChoice({
        cfg: config,
        agentId: "main",
        raw: "fixture/off-catalog",
        source: "override",
      }),
    ).toMatchObject({ kind: "resolved", ref: { provider: "fixture", model: "off-catalog" } });
    await waitForDiagnosticEventsDrained();
    expect(events).toEqual([]);

    const choice = await preparePublishedModelRuntimeChoice({
      ...request,
      cfg: config,
      model: "off-catalog",
    });
    expect(choice.kind).toBe("ready");
    if (choice.kind !== "ready") {
      throw new Error("Expected the published runtime choice after support admission");
    }
    expect(choice.validate()).toBeUndefined();
    current = false;
    expect(choice.validate()).toContain("not available");
    await waitForDiagnosticEventsDrained();
    expect(events.map(({ phase, outcome, reason }) => ({ phase, outcome, reason }))).toEqual([
      { phase: "prepare", outcome: "ready", reason: "ready" },
      { phase: "validate", outcome: "ready", reason: "ready" },
      { phase: "validate", outcome: "unavailable", reason: "owner-stale" },
    ]);
    expect(events.at(-1)?.checks).toMatchObject({
      commitOwnerFreshness: "stale",
      nativeAvailability: "not-reached",
    });
  });

  it("refuses an unpublished or unresolved model", async () => {
    expect(await preparePublishedModelRuntimeChoice(request)).toMatchObject({
      kind: "unavailable",
    });
    publish();
    expect(
      await preparePublishedModelRuntimeChoice({ ...request, model: "unobserved" }),
    ).toMatchObject({ kind: "unavailable" });
    await waitForDiagnosticEventsDrained();
    expect(events.map((event) => event.reason)).toEqual([
      "owner-missing",
      "off-catalog-resolution-unavailable",
    ]);
    expect(events[1]?.checks).toMatchObject({
      catalogPresence: "absent",
      offCatalogAuth: "available",
      offCatalogAuthMode: "available",
      offCatalogResolution: "unresolved",
      runtimeEligibility: "not-reached",
    });
  });

  it("validates an off-catalog model through its configured route", async () => {
    const config: OpenClawConfig = {
      ...cfg,
      models: {
        providers: {
          fixture: {
            api: "openai-completions",
            baseUrl: "https://models.example.invalid/v1",
            models: [],
          },
        },
      },
    };
    let current = true;
    publish(() => current, config);
    const choice = await preparePublishedModelRuntimeChoice({
      ...request,
      cfg: config,
      model: "off-catalog",
    });
    expect(choice.kind).toBe("ready");
    if (choice.kind !== "ready") {
      throw new Error("Expected the configured off-catalog route to be selectable");
    }
    expect(choice.validate()).toBeUndefined();
    current = false;
    expect(choice.validate()).toContain("not available");
    await waitForDiagnosticEventsDrained();
    expect(events.map((event) => event.reason)).toEqual(["ready", "ready", "owner-stale"]);
    expect(events[0]?.checks).toMatchObject({
      catalogPresence: "absent",
      offCatalogAuth: "available",
      offCatalogAuthMode: "available",
      offCatalogResolution: "resolved",
      runtimeEligibility: "eligible",
      nativeAvailability: "not-reached",
    });
    expect(events[2]?.checks.nativeAvailability).toBe("not-reached");
  });

  it("does not grant an incompatible runtime to an off-catalog model", async () => {
    const config: OpenClawConfig = {
      ...cfg,
      models: {
        providers: {
          fixture: {
            api: "openai-completions",
            baseUrl: "https://models.example.invalid/v1",
            models: [],
          },
        },
      },
    };
    publish(() => true, config);
    expect(
      await preparePublishedModelRuntimeChoice({
        ...request,
        cfg: config,
        model: "off-catalog",
        runtimeId: "codex",
      }),
    ).toMatchObject({ kind: "unavailable" });
  });

  it("distinguishes absent auth ownership from an off-catalog credential refusal", async () => {
    publish(() => true, cfg, false);
    expect(await preparePublishedModelRuntimeChoice(request)).toMatchObject({
      kind: "unavailable",
    });
    const owner = publish();
    setPreparedModelRuntimeAuthStore(owner, { version: 1, profiles: {} });
    expect(
      await preparePublishedModelRuntimeChoice({ ...request, model: "off-catalog" }),
    ).toMatchObject({ kind: "unavailable" });
    await waitForDiagnosticEventsDrained();
    expect(events.map((event) => event.reason)).toEqual([
      "auth-store-missing",
      "off-catalog-auth-unavailable",
    ]);
    expect(events[0]?.checks).toMatchObject({
      ownerLookup: "present",
      authStore: "absent",
      catalogPresence: "not-reached",
      runtimeEligibility: "not-reached",
    });
    expect(events[1]?.checks).toMatchObject({
      offCatalogAuth: "unavailable",
      offCatalogAuthMode: "unavailable",
      offCatalogResolution: "not-reached",
      runtimeEligibility: "not-reached",
    });
  });

  it("does not materialize off-catalog local auth without a supported auth mode", async () => {
    const config: OpenClawConfig = {
      ...cfg,
      models: {
        providers: {
          fixture: {
            api: "openai-completions",
            baseUrl: "http://127.0.0.1:11434/v1",
            models: [
              {
                id: "model",
                name: "Model",
                reasoning: false,
                input: ["text"],
                contextWindow: 32000,
                maxTokens: 2048,
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              },
            ],
          },
        },
      },
    };
    const owner = publish(() => true, config);
    setPreparedModelRuntimeAuthStore(owner, { version: 1, profiles: {} });
    expect(
      await preparePublishedModelRuntimeChoice({ ...request, cfg: config, model: "off-catalog" }),
    ).toMatchObject({ kind: "unavailable" });
    await waitForDiagnosticEventsDrained();
    expect(events[0]).toMatchObject({
      reason: "off-catalog-auth-mode-unavailable",
      checks: {
        offCatalogAuth: "available",
        offCatalogAuthMode: "unavailable",
        offCatalogResolution: "not-reached",
        runtimeEligibility: "not-reached",
      },
    });
  });

  it("retains explicit account pins instead of granting a sibling profile", async () => {
    const owner = publish();
    const auth: AuthProfileStore = {
      version: 1,
      profiles: {
        "fixture:account": { type: "api_key", provider: "fixture", key: "synthetic-credential" },
        "fixture:revoked": {
          type: "token",
          provider: "fixture",
          token: "synthetic-expired-token",
          expires: 1,
        },
      },
    };
    setPreparedModelRuntimeAuthStore(owner, auth);
    const before = structuredClone(auth);
    const choice = await preparePublishedModelRuntimeChoice({
      ...request,
      sessionEntry: {
        authProfileOverride: "fixture:revoked",
        authProfileOverrideSource: "user",
        providerOverride: "fixture",
      },
    });
    expect(choice).toMatchObject({ kind: "unavailable" });
    await waitForDiagnosticEventsDrained();
    expect(events[0]?.reason).toBe("runtime-ineligible");
    expect(JSON.stringify(events)).not.toContain("fixture:revoked");
    expect(auth).toEqual(before);
  });

  it("records runtime ineligibility without adding native readiness probes", async () => {
    const owner = publish();
    expect(
      await preparePublishedModelRuntimeChoice({ ...request, runtimeId: "unregistered-runtime" }),
    ).toMatchObject({ kind: "unavailable" });
    await waitForDiagnosticEventsDrained();
    expect(events[0]).toMatchObject({
      phase: "prepare",
      reason: "runtime-ineligible",
      checks: {
        runtimeEligibility: "ineligible",
        nativeAvailability: "not-reached",
        commitOwnerFreshness: "not-reached",
      },
    });
    expect(owner.isCurrent()).toBe(true);
  });

  it("rechecks native readiness once per current guard and never after owner revocation", async () => {
    let current = true;
    let ready = true;
    const owner = publish(() => current);
    const registry = createEmptyPluginRegistry();
    const readiness = vi.fn(() =>
      ready ? { accountType: "fixture", authMode: "oauth" } : undefined,
    );
    const native = {
      provider: "fixture",
      id: "model",
      name: "Model",
      nativeRuntime: "fixture-native",
    };
    registry.agentHarnesses.push({
      pluginId: "fixture-native",
      source: "test",
      harness: {
        id: "fixture-native",
        label: "Fixture",
        authBootstrap: "harness",
        supports: () => ({ supported: true }),
        readModelCatalogReadiness: readiness,
        runAttempt: async () => {
          throw new Error("unused");
        },
      },
    });
    const nativeOwner: PreparedModelRuntimeSnapshot = {
      ...owner,
      pluginRegistry: registry,
      modelCatalog: { entries: [native], routeVariants: [native] },
    };
    published.owner = nativeOwner;
    const auth: AuthProfileStore = { version: 1, profiles: {} };
    setPreparedModelRuntimeAuthStore(nativeOwner, auth);
    const choice = await preparePublishedModelRuntimeChoice({
      ...request,
      runtimeId: "fixture-native",
    });
    expect(choice.kind).toBe("ready");
    if (choice.kind !== "ready") {
      throw new Error("Expected native fixture readiness");
    }
    const prepareProbes = readiness.mock.calls.length;
    expect(prepareProbes).toBe(1);
    expect(choice.validate()).toBeUndefined();
    expect(readiness).toHaveBeenCalledTimes(prepareProbes + 1);
    ready = false;
    expect(choice.validate()).toContain("not available");
    expect(readiness).toHaveBeenCalledTimes(prepareProbes + 2);
    current = false;
    expect(choice.validate()).toContain("not available");
    expect(readiness).toHaveBeenCalledTimes(prepareProbes + 2);
    await waitForDiagnosticEventsDrained();
    expect(events.map((event) => event.reason)).toEqual([
      "ready",
      "ready",
      "native-unavailable",
      "owner-stale",
    ]);
    expect(events[2]?.checks).toMatchObject({
      commitOwnerFreshness: "current",
      nativeAvailability: "unavailable",
    });
    expect(events[3]?.checks).toMatchObject({
      commitOwnerFreshness: "stale",
      nativeAvailability: "not-reached",
    });
    expect(auth).toEqual({ version: 1, profiles: {} });
  });

  it("rechecks the same generation at the session commit boundary", async () => {
    let current = true;
    publish(() => current);
    const choice = await preparePublishedModelRuntimeChoice(request);
    expect(choice.kind).toBe("ready");
    if (choice.kind !== "ready") {
      throw new Error("Expected a supported runtime");
    }
    expect(choice.validate()).toBeUndefined();
    current = false;
    expect(choice.validate()).toContain("not available");
  });
});
