import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import {
  createPluginStateSyncKeyedStoreForTests,
  resetPluginStateStoreForTests,
} from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { createTestPluginApi } from "openclaw/plugin-sdk/plugin-test-api";
import { closeOpenClawStateDatabaseAsync } from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import plugin from "../index.js";
import {
  listCrabboxImages,
  mutateCrabboxImage,
  recoverCrabboxImage,
} from "./crabbox-gateway-methods.js";
import { crabboxState, openWarmImageStore } from "./crabbox-state.test-support.js";
import type { CrabboxSnapshotActions } from "./crabbox-worker-snapshot-actions.js";
import {
  CrabboxWarmImageRequestError,
  listCrabboxWarmImages,
  listCrabboxLegacyWarmLeases,
  type WarmAllocationRecord,
  type WarmProfileRecord,
} from "./crabbox-worker-warm-image-store.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const SELECTOR = "capture-fixture";
const SETTINGS = { provider: "aws", class: "standard", ttl: "8h", idleTimeout: "45m" };
const setup = {
  setup: "true",
  setupSecrets: { SYNTHETIC_SETUP_INPUT: { source: "store", provider: "default", id: "SETUP" } },
};
const profileCases = [
  [
    "classless",
    { provider: "aws", ttl: "8h", idleTimeout: "45m" },
    undefined,
    "linux",
    "off",
    "machine class",
  ],
  ["disabled", { ...SETTINGS, warmImage: false }, "standard", "linux", "off", "Disabled"],
  ["environment", { ...SETTINGS, ...setup }, "standard", "linux", "on", "default"],
  ["explicit", { ...SETTINGS, ...setup, warmImage: true }, "standard", "linux", "on", "Explicitly"],
  ["linux", SETTINGS, "standard", "linux", "on", "default"],
  ["mac", { ...SETTINGS, target: "macos" }, "standard", "macos", "off", "Linux"],
] as const;
let api: ReturnType<typeof createApi>;
let respond: ReturnType<typeof vi.fn>;
let actions: ReturnType<typeof createActions>;

beforeEach(async () => {
  await closeOpenClawStateDatabaseAsync();
  resetPluginStateStoreForTests();
  vi.stubEnv("OPENCLAW_STATE_DIR", tempDirs.make("openclaw-crabbox-gateway-"));
  api = createApi();
  respond = vi.fn();
  actions = createActions();
});

afterEach(async () => {
  await closeOpenClawStateDatabaseAsync();
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
  const testApi = createTestPluginApi({
    runtime: { state: crabboxState } as OpenClawPluginApi["runtime"],
    id: "crabbox",
    config: {
      cloudWorkers: {
        profiles: {
          ...Object.fromEntries(
            profileCases.map(([id, settings]) => [id, { provider: "crabbox", settings }]),
          ),
          other: { provider: "fixture", settings: {} },
        },
      },
    },
  });
  testApi.runtime.config = { ...testApi.runtime.config, current: () => testApi.config };
  return testApi;
}

function createActions() {
  return {
    pin: vi.fn<CrabboxSnapshotActions["pin"]>(),
    rollback: vi.fn<CrabboxSnapshotActions["rollback"]>(),
    delete: vi.fn<CrabboxSnapshotActions["delete"]>(),
  };
}

function expectInvalid() {
  expect(respond).toHaveBeenCalledWith(
    false,
    expect.any(Object),
    expect.objectContaining({ code: "INVALID_REQUEST" }),
  );
}

function registerCapture() {
  const current = record();
  openWarmImageStore().register("profile", current);
  return current;
}

async function recover(params: unknown) {
  respond.mockClear();
  await recoverCrabboxImage(crabboxState, { params, respond });
  return respond;
}

async function list(params: unknown = {}) {
  respond.mockClear();
  await listCrabboxImages(api, { params, respond });
  return respond.mock.calls[0]![1];
}

async function mutate(
  action: "pin" | "delete" | "rollback",
  params: unknown = { checkpointId: "chk_fixture", ...(action === "pin" ? { pinned: true } : {}) },
) {
  respond.mockClear();
  await mutateCrabboxImage(api, actions, action, { params, respond });
}

describe("Crabbox snapshot mutations", () => {
  it.each(["pin", "delete"] as const)(
    "rejects malformed %s requests before calling the owner",
    async (action) => {
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
        await mutate(action, params);
        expectInvalid();
      }
      expect(actions[action]).not.toHaveBeenCalled();
    },
  );

  it("uses current Crabbox profiles for deletion and preserves pending retirement", async () => {
    actions.delete.mockResolvedValue({ status: "retiring" });
    api.config.cloudWorkers = {
      profiles: {
        synthetic: { provider: "crabbox", settings: SETTINGS },
        other: { provider: "other", settings: {} },
      },
    };
    await mutate("delete");
    expect(actions.delete).toHaveBeenCalledWith("chk_fixture", [SETTINGS]);
    expect(respond).toHaveBeenCalledWith(true, { status: "retiring" });
  });

  it("maps owner refusals separately from storage failures", async () => {
    for (const [error, code] of [
      [new CrabboxWarmImageRequestError("Unknown checkpoint"), "INVALID_REQUEST"],
      [new Error("Store unavailable"), "UNAVAILABLE"],
    ] as const) {
      actions.rollback.mockImplementation(() => {
        throw error;
      });
      await mutate("rollback");
      expect(respond).toHaveBeenCalledWith(
        false,
        { error: error.message },
        expect.objectContaining({ code, message: error.message }),
      );
    }
  });
});

describe("Crabbox snapshots Gateway methods", () => {
  it("registers all snapshot methods with admin scope", () => {
    const registerGatewayMethod = vi.fn();
    plugin.register(
      createTestPluginApi({
        runtime: { state: crabboxState } as OpenClawPluginApi["runtime"],
        registerGatewayMethod,
      }),
    );
    expect(registerGatewayMethod.mock.calls).toEqual(
      ["list", "recover", "pin", "delete", "rollback"].map((method) => [
        `crabbox.images.${method}`,
        expect.any(Function),
        { scope: "operator.admin" },
      ]),
    );
  });

  it("bounds list and mutation summaries without losing held status or changing ownership", async () => {
    const current = record();
    const metadata = {
      profileId: "linux",
      backend: "aws",
      machineClass: "standard",
      os: "linux",
      projectLabel: "git.example.test/team/project",
      projectRoot: "/projects/example",
    };
    Object.assign(current, metadata, { projectKey: "project-key" });
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
    const store = openWarmImageStore();
    store.register("current", current);
    const captureUnsupported = {
      atMs: 100,
      provider: "hetzner",
      message: "Native checkpoints are unsupported for this coordinator target.",
    };
    store.register("older", { version: 3, allocations: {}, captureUnsupported });
    const payload = await list();

    expect(respond).toHaveBeenCalledWith(true, {
      images: expect.arrayContaining([
        expect.objectContaining({
          profileKey: "current",
          ...metadata,
          held: true,
          allocationCount: 21,
          capture: expect.objectContaining({ phase: "uncertain", stale: true }),
        }),
        expect.objectContaining({
          profileKey: "older",
          profileId: undefined,
          projectLabel: undefined,
          projectRoot: undefined,
          state: "no-image",
          captureUnsupported,
          held: false,
          allocationCount: 0,
        }),
      ]),
      legacyLeases: [],
      profiles: expect.any(Array),
    });
    const summary = payload.images.find(
      (image: { profileKey: string }) => image.profileKey === "current",
    );
    expect(Object.keys(summary.allocations)).toHaveLength(20);
    expect(store.lookup("current")).toEqual(current);
    const image = (await listCrabboxWarmImages(crabboxState)).find(
      (entry) => entry.profileKey === "current",
    )!;
    actions.pin.mockResolvedValue(image);
    actions.rollback.mockResolvedValue(image);
    for (const action of ["pin", "rollback"] as const) {
      await mutate(action);
      expect(respond).toHaveBeenCalledWith(true, summary);
    }
    expect(Object.keys(image.allocations)).toHaveLength(21);
  });

  it("uses current configured defaults without resolving secrets or including other providers", async () => {
    expect((await list()).profiles).toEqual(
      profileCases.map(([id, , machineClass, os, warmImages, reason]) => ({
        id,
        backend: "aws",
        machineClass,
        os,
        warmImages,
        reason: expect.stringContaining(reason),
      })),
    );
    api.config = {};
    expect((await list()).profiles).toEqual([]);
  });

  it.each([
    { selector: SELECTOR },
    { selector: " ", acknowledgeProviderCleanup: true },
    { selector: SELECTOR, acknowledgeProviderCleanup: true, extra: true },
  ])("refuses invalid recovery params without changing capture ownership: %j", async (params) => {
    const current = registerCapture();
    await recover(params);
    expectInvalid();
    expect(openWarmImageStore().lookup("profile")).toEqual(current);
  });

  it("recovers the exact acknowledged capture and returns the CLI result shape", async () => {
    const current = registerCapture();
    const params = { selector: SELECTOR, acknowledgeProviderCleanup: true };
    await recover(params);
    expect(respond).toHaveBeenCalledWith(true, {
      images: [expect.objectContaining({ checkpointId: "chk_fixture", capture: undefined })],
      legacyLeases: [],
      recoveredCapture: SELECTOR,
      nextSteps: expect.stringContaining("Restart the Gateway"),
    });
    expect(openWarmImageStore().lookup("profile")).toEqual({
      ...current,
      operation: undefined,
    });
    expect(await recover(params)).toHaveBeenCalledWith(
      false,
      expect.any(Object),
      expect.objectContaining({ code: "UNAVAILABLE" }),
    );
  });

  it("reports legacy allocations with doctor guidance and recovers only the acknowledged row", async () => {
    const legacy = createPluginStateSyncKeyedStoreForTests<{ machineClass: string }>("crabbox", {
      namespace: "warm-leases",
      maxEntries: 256,
    });
    legacy.register("cbx_legacy", { machineClass: "standard" });
    const selector = (await listCrabboxLegacyWarmLeases(crabboxState))[0]!.selector;
    expect((await list()).legacyLeases).toEqual([
      {
        leaseId: "cbx_legacy",
        machineClass: "standard",
        selector,
        recoveryHint: expect.stringContaining(
          `--recover ${selector} --acknowledge-provider-cleanup`,
        ),
      },
    ]);
    await recover({ selector, acknowledgeProviderCleanup: true });
    expect(legacy.lookup("cbx_legacy")).toBeUndefined();
  });

  it("rejects list parameters before accessing state", async () => {
    await list({ selector: SELECTOR });
    expectInvalid();
  });
});
