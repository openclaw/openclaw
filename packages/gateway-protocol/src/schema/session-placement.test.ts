import { describe, it } from "vitest";
import {
  SessionPlacementMoveSchema,
  SessionPlacementSchema,
  SessionPlacementStateSchema,
  validateSessionsDispatchParams,
  validateSessionsMoveParams,
  validateSessionsMoveResult,
  validateSessionsReclaimParams,
  validateSessionsReclaimResult,
} from "../index.js";
import { accepts, rejects, acceptsParams, rejectsParams } from "./schema.test-support.js";

const placementStates = [
  "local",
  "requested",
  "provisioning",
  "syncing",
  "starting",
  "active",
  "draining",
  "reconciling",
  "reclaimed",
  "failed",
] as const;

const basePlacement = { generation: 4, createdAtMs: 100, updatedAtMs: 200, stateChangedAtMs: 150 };
const workerBundleHash = "a".repeat(64);
const environmentFields = { environmentId: "environment-1", workerBundleHash };
const workspaceFields = {
  workspaceBaseManifestRef: "manifest-1",
  remoteWorkspaceDir: "/workspace/session-1",
};
const workerOwnedFields = { ...environmentFields, ...workspaceFields, activeOwnerEpoch: 7 };

describe("session dispatch protocol schemas", () => {
  it("accepts an explicit target, automatic device selection, or configured-default lookup", () => {
    const request = (target: Record<string, unknown>) => ({
      key: "agent:main:dispatch",
      ...target,
    });
    for (const target of [
      { agentId: "main", profileId: "development", machineClass: "beast", os: "windows/wsl2" },
      { deviceId: "device-1" },
      { autoDevice: true },
      {},
      { profileId: "development", os: "x".repeat(64) },
    ]) {
      acceptsParams(validateSessionsDispatchParams, request(target));
    }
    for (const target of [
      { os: "windows/wsl2" },
      { deviceId: "device-1", os: "windows/wsl2" },
      { autoDevice: true, os: "windows/wsl2" },
      { profileId: "development", os: "" },
      { profileId: "development", os: "x".repeat(65) },
      { machineClass: "beast" },
      { profileId: "development", deviceId: "device-1" },
      { deviceId: "device-1", machineClass: "beast" },
      { autoDevice: false },
      { autoDevice: true, profileId: "development" },
      { autoDevice: true, deviceId: "device-1" },
      { autoDevice: true, machineClass: "beast" },
      { profileId: "development", machineClass: "" },
      { profileId: "development", machineClass: "x".repeat(129) },
      { profileId: "development", task: "run remotely" },
    ]) {
      rejectsParams(validateSessionsDispatchParams, request(target));
    }
  });

  it("accepts a session selector and exact failed generation for Gateway recovery", () => {
    acceptsParams(validateSessionsReclaimParams, { key: "agent:main:dispatch", agentId: "main" });
    rejectsParams(validateSessionsReclaimParams, { key: "agent:main:dispatch", profileId: "dev" });
    acceptsParams(validateSessionsReclaimParams, {
      key: "agent:main:dispatch",
      recoverToGateway: { expectedGeneration: 3 },
    });
    for (const recoverToGateway of [{}, { expectedGeneration: -1 }, { expectedGeneration: 0.5 }]) {
      rejectsParams(validateSessionsReclaimParams, {
        key: "agent:main:dispatch",
        recoverToGateway,
      });
    }
  });

  it("accepts exactly the reclaim owner's terminal outcomes", () => {
    const result = { ok: true, key: "agent:main:dispatch", sessionId: "session-dispatch" };

    for (const state of ["local", "reclaimed"]) {
      acceptsParams(validateSessionsReclaimResult, {
        ...result,
        placement: { state, ...basePlacement },
      });
    }
    for (const placement of [
      { state: "requested", ...basePlacement },
      { state: "active", ...basePlacement, ...workerOwnedFields },
    ]) {
      rejectsParams(validateSessionsReclaimResult, { ...result, placement });
    }
  });

  it("keeps placement states closed", () => {
    for (const state of placementStates) {
      accepts(SessionPlacementStateSchema, state);
    }
    rejects(SessionPlacementStateSchema, "unknown");
  });

  it("requires workspace identity while starting", () => {
    const starting = {
      state: "starting",
      ...basePlacement,
      ...environmentFields,
      ...workspaceFields,
    };
    accepts(SessionPlacementSchema, starting);
    const { workspaceBaseManifestRef: _manifest, ...missingManifest } = starting;
    rejects(SessionPlacementSchema, missingManifest);
    rejects(SessionPlacementSchema, { ...starting, lastTranscriptAckCursor: 0 });
  });

  it.each(["active"] as const)("requires complete worker ownership for %s placement", (state) => {
    accepts(SessionPlacementSchema, {
      state,
      ...basePlacement,
      ...workerOwnedFields,
      lastTranscriptAckCursor: 2,
      lastLiveEventAckCursor: 9,
    });
    rejects(SessionPlacementSchema, {
      state,
      ...basePlacement,
      environmentId: "environment-1",
      activeOwnerEpoch: 7,
      workerBundleHash,
    });
  });

  it("accepts explicit abandonment only for a Gateway target", () => {
    const request = {
      key: "agent:main:dispatch",
      expected: { generation: 4, environmentId: "environment-1", ownerEpoch: 7 },
      abandonSource: true,
    };
    acceptsParams(validateSessionsMoveParams, { ...request, target: { kind: "gateway" } });
    rejectsParams(validateSessionsMoveParams, {
      ...request,
      target: { kind: "device", deviceId: "device-1" },
    });
    rejectsParams(validateSessionsMoveParams, {
      ...request,
      target: { kind: "profile", profileId: "development" },
    });
    rejectsParams(validateSessionsMoveParams, {
      ...request,
      abandonSource: false,
      target: { kind: "gateway" },
    });
  });

  it("bounds move source and target identifiers", () => {
    const accepted = "x".repeat(256);
    const rejected = "x".repeat(257);
    const request = {
      key: "agent:main:dispatch",
      expected: { generation: 4, environmentId: "environment-1", ownerEpoch: 7 },
    };
    acceptsParams(validateSessionsMoveParams, {
      ...request,
      expected: { ...request.expected, environmentId: accepted },
      target: {
        kind: "profile",
        profileId: accepted,
        machineClass: "x".repeat(128),
        os: "x".repeat(64),
      },
    });
    for (const machineClass of ["", "x".repeat(129)]) {
      rejectsParams(validateSessionsMoveParams, {
        ...request,
        target: { kind: "profile", profileId: "development", machineClass },
      });
    }
    for (const os of ["", "x".repeat(65)]) {
      rejectsParams(validateSessionsMoveParams, {
        ...request,
        target: { kind: "profile", profileId: "development", os },
      });
    }
    for (const value of [rejected, " leading", "trailing "]) {
      rejectsParams(validateSessionsMoveParams, {
        ...request,
        expected: { ...request.expected, environmentId: value },
        target: { kind: "gateway" },
      });
      rejectsParams(validateSessionsMoveParams, {
        ...request,
        target: { kind: "device", deviceId: value },
      });
    }
  });

  it("rejects an inexact move source", () => {
    rejectsParams(validateSessionsMoveParams, {
      key: "agent:main:dispatch",
      expected: { generation: 4, environmentId: "environment-1", ownerEpoch: 0 },
      target: { kind: "gateway" },
    });
  });

  it("projects bounded durable move progress without operation authority", () => {
    accepts(SessionPlacementMoveSchema, {
      target: { kind: "gateway" },
      updatedAtMs: 1,
    });
    accepts(SessionPlacementMoveSchema, {
      target: { kind: "device", deviceId: "device-1" },
      updatedAtMs: 2,
      error: "device worker is offline",
    });
    rejects(SessionPlacementMoveSchema, {
      target: { kind: "gateway" },
      updatedAtMs: 1,
      operationId: "move:v1:secret",
    });
  });

  it("validates projected retries with the same source and target constraints as Move requests", () => {
    const expected = { generation: 4, environmentId: "environment-1", ownerEpoch: 7 };
    const retries = [
      { expected, target: { kind: "gateway" } },
      { expected, target: { kind: "gateway" }, abandonSource: true },
      { expected, target: { kind: "device", deviceId: "device-1" } },
      {
        expected,
        target: { kind: "profile", profileId: "team", os: "linux", machineClass: "tiny" },
      },
    ];
    for (const retry of retries) {
      accepts(SessionPlacementMoveSchema, {
        target: retry.target,
        updatedAtMs: 1,
        error: "move interrupted",
        retry,
      });
      acceptsParams(validateSessionsMoveParams, { key: "agent:main:dispatch", ...retry });
    }
    for (const retry of [
      { expected: { ...expected, generation: -1 }, target: { kind: "gateway" } },
      { expected: { ...expected, environmentId: "x".repeat(257) }, target: { kind: "gateway" } },
      { expected, target: { kind: "gateway" }, abandonSource: false },
      { expected, target: { kind: "device", deviceId: "device-1" }, abandonSource: true },
      { expected, target: { kind: "profile", profileId: "team" }, abandonSource: true },
      { expected, target: { kind: "gateway" }, operationId: "move:v1:opaque" },
    ]) {
      rejects(SessionPlacementMoveSchema, {
        target: retry.target,
        updatedAtMs: 1,
        error: "move interrupted",
        retry,
      });
    }
  });

  it("keeps the move result bounded to terminal placement state", () => {
    const result = {
      ok: true,
      key: "agent:main:dispatch",
      sessionId: "session-dispatch",
      placement: { state: "active", generation: 5 },
    };
    acceptsParams(validateSessionsMoveResult, result);
    for (const state of ["requested", "reclaimed"] as const) {
      rejectsParams(validateSessionsMoveResult, {
        ...result,
        placement: { state, generation: result.placement.generation },
      });
    }
    rejectsParams(validateSessionsMoveResult, {
      ...result,
      placement: { ...result.placement, remoteWorkspaceDir: "/workspace/session-dispatch" },
    });
    rejectsParams(validateSessionsMoveResult, { ...result, providerSettings: {} });
  });
});
