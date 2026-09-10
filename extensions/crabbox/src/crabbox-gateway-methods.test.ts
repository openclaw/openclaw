import {
  createPluginStateSyncKeyedStoreForTests,
  resetPluginStateStoreForTests,
} from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { createTestPluginApi } from "openclaw/plugin-sdk/plugin-test-api";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import plugin from "../index.js";
import {
  listCrabboxImages,
  mutateCrabboxImage,
  recoverCrabboxImage,
} from "./crabbox-gateway-methods.js";
import type { CrabboxSnapshotActions } from "./crabbox-worker-snapshot-actions.js";
import {
  CrabboxWarmImageRequestError,
  listCrabboxWarmImages,
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

function createActions() {
  openCrabboxWarmImageStore().register("profile", record());
  const image = listCrabboxWarmImages()[0]!;
  return {
    pin: vi.fn<CrabboxSnapshotActions["pin"]>(() => image),
    rollback: vi.fn<CrabboxSnapshotActions["rollback"]>(() => image),
    delete: vi.fn<CrabboxSnapshotActions["delete"]>(async () => ({ status: "deleted" })),
  };
}

describe("Crabbox snapshot mutations", () => {
  it.each(["pin", "delete", "rollback"] as const)(
    "rejects malformed %s requests before calling the owner",
    async (action) => {
      const actions = createActions();
      const valid =
        action === "pin"
          ? { checkpointId: "chk_fixture", pinned: true }
          : { checkpointId: "chk_fixture" };
      for (const params of [
        undefined,
        [],
        {},
        { ...valid, checkpointId: 1 },
        { ...valid, checkpointId: " " },
        { ...valid, extra: true },
        ...(action === "pin"
          ? [{ checkpointId: "chk_fixture" }, { checkpointId: "chk_fixture", pinned: "true" }]
          : [{ ...valid, pinned: true }]),
      ]) {
        const respond = vi.fn();
        await mutateCrabboxImage(createApi(), actions, action, { params, respond });
        expect(respond).toHaveBeenCalledWith(
          false,
          expect.any(Object),
          expect.objectContaining({ code: "INVALID_REQUEST" }),
        );
      }
      expect(actions[action]).not.toHaveBeenCalled();
    },
  );

  it.each([true, false])(
    "passes pin=%s to its owner and returns the updated summary",
    async (pinned) => {
      const actions = createActions();
      const respond = vi.fn();
      await mutateCrabboxImage(createApi(), actions, "pin", {
        params: { checkpointId: "chk_fixture", pinned },
        respond,
      });
      expect(actions.pin).toHaveBeenCalledWith("chk_fixture", pinned);
      expect(respond).toHaveBeenCalledWith(
        true,
        expect.objectContaining({ checkpointId: "chk_fixture" }),
      );
    },
  );

  it("passes a previous checkpoint to rollback and returns the owner's summary", async () => {
    const actions = createActions();
    const respond = vi.fn();
    await mutateCrabboxImage(createApi(), actions, "rollback", {
      params: { checkpointId: "chk_previous" },
      respond,
    });
    expect(actions.rollback).toHaveBeenCalledWith("chk_previous");
    expect(respond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({ checkpointId: "chk_fixture" }),
    );
  });

  it.each(["deleted", "retiring"] as const)(
    "uses current Crabbox profiles for deletion and returns %s",
    async (status) => {
      const actions = createActions();
      actions.delete.mockResolvedValue({ status });
      const api = createApi();
      api.config.cloudWorkers = {
        profiles: {
          synthetic: { provider: "crabbox", settings: SETTINGS },
          other: { provider: "other", settings: {} },
        },
      };
      const respond = vi.fn();
      await mutateCrabboxImage(api, actions, "delete", {
        params: { checkpointId: "chk_fixture" },
        respond,
      });
      expect(actions.delete).toHaveBeenCalledWith("chk_fixture", [SETTINGS]);
      expect(respond).toHaveBeenCalledWith(true, { status });
    },
  );

  it.each(["pin", "delete", "rollback"] as const)(
    "maps %s owner refusals separately from storage failures",
    async (action) => {
      const actions = createActions();
      for (const [error, code] of [
        [new CrabboxWarmImageRequestError("Unknown checkpoint"), "INVALID_REQUEST"],
        [new Error("Store unavailable"), "UNAVAILABLE"],
      ] as const) {
        actions[action].mockImplementation(() => {
          throw error;
        });
        const respond = vi.fn();
        await mutateCrabboxImage(createApi(), actions, action, {
          params: { checkpointId: "chk_fixture", ...(action === "pin" ? { pinned: false } : {}) },
          respond,
        });
        expect(respond).toHaveBeenCalledWith(
          false,
          { error: error.message },
          expect.objectContaining({ code, message: error.message }),
        );
      }
    },
  );
});

describe("Crabbox snapshots Gateway methods", () => {
  it("registers all snapshot methods with admin scope", () => {
    const registerGatewayMethod = vi.fn();
    plugin.register(createTestPluginApi({ registerGatewayMethod }));
    expect(registerGatewayMethod.mock.calls).toEqual([
      ["crabbox.images.list", expect.any(Function), { scope: "operator.admin" }],
      ["crabbox.images.recover", expect.any(Function), { scope: "operator.admin" }],
      ["crabbox.images.pin", expect.any(Function), { scope: "operator.admin" }],
      ["crabbox.images.delete", expect.any(Function), { scope: "operator.admin" }],
      ["crabbox.images.rollback", expect.any(Function), { scope: "operator.admin" }],
    ]);
  });

  it("bounds list and mutation summaries without losing held status or changing ownership", async () => {
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
    const image = listCrabboxWarmImages().find((entry) => entry.profileKey === "current")!;
    const actions: CrabboxSnapshotActions = {
      pin: () => image,
      rollback: () => image,
      delete: async () => ({ status: "deleted" }),
    };
    for (const action of ["pin", "rollback"] as const) {
      const mutationResponse = vi.fn();
      await mutateCrabboxImage(createApi(), actions, action, {
        params: { checkpointId: "chk_fixture", ...(action === "pin" ? { pinned: true } : {}) },
        respond: mutationResponse,
      });
      expect(mutationResponse).toHaveBeenCalledWith(
        true,
        payload.images.find((entry: { profileKey: string }) => entry.profileKey === "current"),
      );
    }
    expect(Object.keys(image.allocations)).toHaveLength(21);
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
