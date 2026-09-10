import {
  createPluginStateSyncKeyedStoreForTests,
  resetPluginStateStoreForTests,
} from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { createTestPluginApi } from "openclaw/plugin-sdk/plugin-test-api";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import plugin from "../index.js";
import { listCrabboxImages, recoverCrabboxImage } from "./crabbox-gateway-methods.js";
import {
  listCrabboxLegacyWarmLeases,
  openCrabboxWarmImageStore,
  type WarmAllocationRecord,
  type WarmProfileRecord,
} from "./crabbox-worker-warm-image-store.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const SELECTOR = "capture-fixture";
const SETTINGS = { provider: "aws", class: "standard", ttl: "8h", idleTimeout: "45m" };

beforeEach(() => {
  resetPluginStateStoreForTests();
  vi.stubEnv("OPENCLAW_STATE_DIR", tempDirs.make("openclaw-crabbox-gateway-"));
});

afterEach(() => {
  resetPluginStateStoreForTests();
  vi.unstubAllEnvs();
});

function record(): WarmProfileRecord {
  return {
    version: 3,
    allocations: {},
    image: {
      checkpointId: "chk_fixture",
      kind: "native",
      state: "available",
      createdAtMs: 1,
      preparationKey: null,
      cacheKey: null,
      purpose: null,
      lastDemandAtMs: 2,
    },
    operation: {
      type: "capture",
      id: SELECTOR,
      startedAtMs: 3,
      leaseId: "cbx_source",
      provider: "aws",
      phase: "uncertain",
    },
  };
}

function createApi() {
  const api = createTestPluginApi({
    config: {
      cloudWorkers: {
        profiles: {
          linux: { provider: "crabbox", settings: SETTINGS },
          disabled: { provider: "crabbox", settings: { ...SETTINGS, warmImage: false } },
          environment: {
            provider: "crabbox",
            settings: { ...SETTINGS, setup: "true", setupEnv: ["SYNTHETIC_SETUP_INPUT"] },
          },
          explicit: {
            provider: "crabbox",
            settings: {
              ...SETTINGS,
              setup: "true",
              setupEnv: ["SYNTHETIC_SETUP_INPUT"],
              warmImage: true,
            },
          },
          classless: {
            provider: "crabbox",
            settings: { provider: "aws", ttl: "8h", idleTimeout: "45m" },
          },
          mac: { provider: "crabbox", settings: { ...SETTINGS, target: "macos" } },
          other: { provider: "fixture", settings: {} },
        },
      },
    },
  });
  api.runtime.config = { ...api.runtime.config, current: () => api.config };
  return api;
}

describe("Crabbox snapshots Gateway methods", () => {
  it("registers both plugin methods with admin scope", () => {
    const registerGatewayMethod = vi.fn();
    plugin.register(createTestPluginApi({ registerGatewayMethod }));
    expect(registerGatewayMethod.mock.calls).toEqual([
      ["crabbox.images.list", expect.any(Function), { scope: "operator.admin" }],
      ["crabbox.images.recover", expect.any(Function), { scope: "operator.admin" }],
    ]);
  });

  it("lists display facts and older records without mutating ownership, with bounded allocations", () => {
    const current = record();
    Object.assign(current, {
      profileId: "linux",
      backend: "aws",
      machineClass: "standard",
      os: "linux",
      projectKey: "project-key",
      projectLabel: "git.example.test/team/project",
    });
    const allocation: WarmAllocationRecord = {
      choice: { kind: "cold" },
      machineClass: "standard",
      phase: "enrolled",
      preparationKey: null,
      cacheKey: null,
      purpose: null,
      demandAtMs: null,
      imageGeneration: null,
    };
    for (let index = 0; index < 21; index++) {
      current.allocations[`cbx_${String(index).padStart(2, "0")}`] = allocation;
    }
    // The only holder is beyond the output limit; truncation cannot change held status.
    current.allocations.cbx_20 = {
      ...allocation,
      choice: { kind: "checkpoint", checkpointId: "chk_fixture" },
    };
    const store = openCrabboxWarmImageStore();
    store.register("current", current);
    store.register("older", { version: 3, allocations: {} });
    const respond = vi.fn();

    listCrabboxImages(createApi(), { params: {}, respond });

    expect(respond).toHaveBeenCalledWith(true, {
      images: expect.arrayContaining([
        expect.objectContaining({
          profileKey: "current",
          profileId: "linux",
          backend: "aws",
          machineClass: "standard",
          os: "linux",
          projectLabel: "git.example.test/team/project",
          held: true,
          allocationCount: 21,
          capture: expect.objectContaining({ phase: "uncertain", stale: true }),
        }),
        expect.objectContaining({
          profileKey: "older",
          profileId: undefined,
          projectLabel: undefined,
          state: "no-image",
          held: false,
          allocationCount: 0,
        }),
      ]),
      legacyLeases: [],
      profiles: expect.any(Array),
    });
    const payload = respond.mock.calls[0]![1];
    expect(
      Object.keys(
        payload.images.find((image: { profileKey: string }) => image.profileKey === "current")
          .allocations,
      ),
    ).toHaveLength(20);
    expect(store.lookup("current")).toEqual(current);
  });

  it("uses current configured defaults without reading setup environment or including other providers", () => {
    const api = createApi();
    const respond = vi.fn();
    listCrabboxImages(api, { params: {}, respond });
    const configuredFacts = { backend: "aws", machineClass: "standard", os: "linux" };
    expect(respond.mock.calls[0]![1].profiles).toEqual([
      {
        ...configuredFacts,
        machineClass: undefined,
        id: "classless",
        warmImages: "off",
        reason: expect.stringContaining("machine class"),
      },
      {
        ...configuredFacts,
        id: "disabled",
        warmImages: "off",
        reason: expect.stringContaining("Disabled"),
      },
      {
        ...configuredFacts,
        id: "environment",
        warmImages: "off",
        reason: expect.stringContaining("environment"),
      },
      {
        ...configuredFacts,
        id: "explicit",
        warmImages: "on",
        reason: expect.stringContaining("Explicitly"),
      },
      {
        ...configuredFacts,
        id: "linux",
        warmImages: "on",
        reason: expect.stringContaining("default"),
      },
      {
        ...configuredFacts,
        os: "macos",
        id: "mac",
        warmImages: "off",
        reason: expect.stringContaining("Linux"),
      },
    ]);
    api.config = {};
    respond.mockClear();
    listCrabboxImages(api, { params: {}, respond });
    expect(respond.mock.calls[0]![1].profiles).toEqual([]);
  });

  it.each([
    { selector: SELECTOR },
    { selector: SELECTOR, acknowledgeProviderCleanup: false },
    { selector: SELECTOR, acknowledgeProviderCleanup: "true" },
    { selector: " ", acknowledgeProviderCleanup: true },
    { selector: 1, acknowledgeProviderCleanup: true },
    { selector: SELECTOR, acknowledgeProviderCleanup: true, extra: true },
  ])("refuses invalid recovery params without changing capture ownership: %j", (params) => {
    const current = record();
    openCrabboxWarmImageStore().register("profile", current);
    const respond = vi.fn();
    recoverCrabboxImage({ params, respond });
    expect(respond).toHaveBeenCalledWith(
      false,
      expect.any(Object),
      expect.objectContaining({ code: "INVALID_REQUEST" }),
    );
    expect(openCrabboxWarmImageStore().lookup("profile")).toEqual(current);
  });

  it("recovers the exact acknowledged capture and returns the CLI result shape", () => {
    const current = record();
    openCrabboxWarmImageStore().register("profile", current);
    const respond = vi.fn();
    recoverCrabboxImage({
      params: { selector: SELECTOR, acknowledgeProviderCleanup: true },
      respond,
    });
    expect(respond).toHaveBeenCalledWith(true, {
      images: [expect.objectContaining({ checkpointId: "chk_fixture", capture: undefined })],
      legacyLeases: [],
      recoveredCapture: SELECTOR,
      nextSteps: expect.stringContaining("Restart the Gateway"),
    });
    expect(openCrabboxWarmImageStore().lookup("profile")).toEqual({
      ...current,
      operation: undefined,
    });
    respond.mockClear();
    recoverCrabboxImage({
      params: { selector: SELECTOR, acknowledgeProviderCleanup: true },
      respond,
    });
    expect(respond).toHaveBeenCalledWith(
      false,
      expect.any(Object),
      expect.objectContaining({ code: "UNAVAILABLE" }),
    );
  });

  it("reports legacy allocations with doctor guidance and recovers only the acknowledged row", () => {
    const legacy = createPluginStateSyncKeyedStoreForTests<{ machineClass: string }>("crabbox", {
      namespace: "warm-leases",
      maxEntries: 256,
    });
    legacy.register("cbx_legacy", { machineClass: "standard" });
    const selector = listCrabboxLegacyWarmLeases()[0]!.selector;
    const respond = vi.fn();
    listCrabboxImages(createApi(), { params: {}, respond });
    expect(respond.mock.calls[0]![1].legacyLeases).toEqual([
      {
        leaseId: "cbx_legacy",
        machineClass: "standard",
        selector,
        recoveryHint: expect.stringContaining(
          `--recover ${selector} --acknowledge-provider-cleanup`,
        ),
      },
    ]);
    recoverCrabboxImage({ params: { selector, acknowledgeProviderCleanup: true }, respond });
    expect(legacy.lookup("cbx_legacy")).toBeUndefined();
  });

  it("rejects list parameters before accessing state", () => {
    const respond = vi.fn();
    listCrabboxImages(createApi(), { params: { selector: SELECTOR }, respond });
    expect(respond).toHaveBeenCalledWith(
      false,
      expect.any(Object),
      expect.objectContaining({ code: "INVALID_REQUEST" }),
    );
  });
});
