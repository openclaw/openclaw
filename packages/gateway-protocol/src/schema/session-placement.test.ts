import { Value } from "typebox/value";
import { describe, expect, it } from "vitest";
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

const basePlacement = {
  generation: 4,
  createdAtMs: 100,
  updatedAtMs: 200,
  stateChangedAtMs: 150,
};
const workerBundleHash = "a".repeat(64);
const environmentFields = {
  environmentId: "environment-1",
  workerBundleHash,
};
const workspaceFields = {
  workspaceBaseManifestRef: "manifest-1",
  remoteWorkspaceDir: "/workspace/session-1",
};
const workerOwnedFields = {
  ...environmentFields,
  ...workspaceFields,
  activeOwnerEpoch: 7,
};

describe("session dispatch protocol schemas", () => {
  it("accepts an explicit target, automatic device selection, or configured-default lookup", () => {
    expect(
      validateSessionsDispatchParams({
        key: "agent:main:dispatch",
        agentId: "main",
        profileId: "development",
        machineClass: "beast",
        os: "windows/wsl2",
      }),
    ).toBe(true);
    expect(
      validateSessionsDispatchParams({
        key: "agent:main:dispatch",
        deviceId: "device-1",
      }),
    ).toBe(true);
    expect(validateSessionsDispatchParams({ key: "agent:main:dispatch", autoDevice: true })).toBe(
      true,
    );
    expect(validateSessionsDispatchParams({ key: "agent:main:dispatch" })).toBe(true);
    expect(
      validateSessionsDispatchParams({
        key: "agent:main:dispatch",
        profileId: "development",
        os: "x".repeat(64),
      }),
    ).toBe(true);
    for (const invalidOsTarget of [
      { os: "windows/wsl2" },
      { deviceId: "device-1", os: "windows/wsl2" },
      { autoDevice: true, os: "windows/wsl2" },
      { profileId: "development", os: "" },
      { profileId: "development", os: "x".repeat(65) },
    ]) {
      expect(
        validateSessionsDispatchParams({ key: "agent:main:dispatch", ...invalidOsTarget }),
      ).toBe(false);
    }
    expect(
      validateSessionsDispatchParams({ key: "agent:main:dispatch", machineClass: "beast" }),
    ).toBe(false);
    expect(
      validateSessionsDispatchParams({
        key: "agent:main:dispatch",
        profileId: "development",
        deviceId: "device-1",
      }),
    ).toBe(false);
    expect(
      validateSessionsDispatchParams({
        key: "agent:main:dispatch",
        deviceId: "device-1",
        machineClass: "beast",
      }),
    ).toBe(false);
    for (const invalidAutomaticTarget of [
      { autoDevice: false },
      { autoDevice: true, profileId: "development" },
      { autoDevice: true, deviceId: "device-1" },
      { autoDevice: true, machineClass: "beast" },
    ]) {
      expect(
        validateSessionsDispatchParams({
          key: "agent:main:dispatch",
          ...invalidAutomaticTarget,
        }),
      ).toBe(false);
    }
    expect(
      validateSessionsDispatchParams({
        key: "agent:main:dispatch",
        profileId: "development",
        machineClass: "",
      }),
    ).toBe(false);
    expect(
      validateSessionsDispatchParams({
        key: "agent:main:dispatch",
        profileId: "development",
        machineClass: "x".repeat(129),
      }),
    ).toBe(false);
    expect(
      validateSessionsDispatchParams({
        key: "agent:main:dispatch",
        profileId: "development",
        task: "run remotely",
      }),
    ).toBe(false);
  });

  it("accepts a session selector and exact failed generation for Gateway recovery", () => {
    expect(validateSessionsReclaimParams({ key: "agent:main:dispatch", agentId: "main" })).toBe(
      true,
    );
    expect(validateSessionsReclaimParams({ key: "agent:main:dispatch", profileId: "dev" })).toBe(
      false,
    );
    expect(
      validateSessionsReclaimParams({
        key: "agent:main:dispatch",
        recoverToGateway: { expectedGeneration: 3 },
      }),
    ).toBe(true);
    for (const recoverToGateway of [{}, { expectedGeneration: -1 }, { expectedGeneration: 0.5 }]) {
      expect(validateSessionsReclaimParams({ key: "agent:main:dispatch", recoverToGateway })).toBe(
        false,
      );
    }
  });

  it("accepts exactly the reclaim owner's terminal outcomes", () => {
    const result = {
      ok: true,
      key: "agent:main:dispatch",
      sessionId: "session-dispatch",
    };

    expect(
      validateSessionsReclaimResult({
        ...result,
        placement: { state: "local", ...basePlacement },
      }),
    ).toBe(true);
    expect(
      validateSessionsReclaimResult({
        ...result,
        placement: { state: "reclaimed", ...basePlacement },
      }),
    ).toBe(true);
    for (const placement of [
      { state: "requested", ...basePlacement },
      { state: "active", ...basePlacement, ...workerOwnedFields },
    ]) {
      expect(validateSessionsReclaimResult({ ...result, placement })).toBe(false);
    }
  });

  it("keeps placement states closed", () => {
    for (const state of placementStates) {
      expect(Value.Check(SessionPlacementStateSchema, state)).toBe(true);
    }
    expect(Value.Check(SessionPlacementStateSchema, "unknown")).toBe(false);
  });

  it("requires workspace identity while starting", () => {
    expect(
      Value.Check(SessionPlacementSchema, {
        state: "starting",
        ...basePlacement,
        ...environmentFields,
        ...workspaceFields,
      }),
    ).toBe(true);
    expect(
      Value.Check(SessionPlacementSchema, {
        state: "starting",
        ...basePlacement,
        ...environmentFields,
        remoteWorkspaceDir: "/workspace/session-1",
      }),
    ).toBe(false);
    expect(
      Value.Check(SessionPlacementSchema, {
        state: "starting",
        ...basePlacement,
        ...environmentFields,
        ...workspaceFields,
        lastTranscriptAckCursor: 0,
      }),
    ).toBe(false);
  });

  it.each(["active"] as const)("requires complete worker ownership for %s placement", (state) => {
    expect(
      Value.Check(SessionPlacementSchema, {
        state,
        ...basePlacement,
        ...workerOwnedFields,
        lastTranscriptAckCursor: 2,
        lastLiveEventAckCursor: 9,
      }),
    ).toBe(true);
    expect(
      Value.Check(SessionPlacementSchema, {
        state,
        ...basePlacement,
        environmentId: "environment-1",
        activeOwnerEpoch: 7,
        workerBundleHash,
      }),
    ).toBe(false);
  });

  it("accepts explicit abandonment only for a Gateway target", () => {
    const request = {
      key: "agent:main:dispatch",
      expected: { generation: 4, environmentId: "environment-1", ownerEpoch: 7 },
      abandonSource: true,
    };
    expect(validateSessionsMoveParams({ ...request, target: { kind: "gateway" } })).toBe(true);
    expect(
      validateSessionsMoveParams({
        ...request,
        target: { kind: "device", deviceId: "device-1" },
      }),
    ).toBe(false);
    expect(
      validateSessionsMoveParams({
        ...request,
        target: { kind: "profile", profileId: "development" },
      }),
    ).toBe(false);
    expect(
      validateSessionsMoveParams({ ...request, abandonSource: false, target: { kind: "gateway" } }),
    ).toBe(false);
  });

  it("bounds move source and target identifiers", () => {
    const accepted = "x".repeat(256);
    const rejected = "x".repeat(257);
    expect(
      validateSessionsMoveParams({
        key: "agent:main:dispatch",
        expected: { generation: 4, environmentId: accepted, ownerEpoch: 7 },
        target: {
          kind: "profile",
          profileId: accepted,
          machineClass: "x".repeat(128),
          os: "x".repeat(64),
        },
      }),
    ).toBe(true);
    for (const machineClass of ["", "x".repeat(129)]) {
      expect(
        validateSessionsMoveParams({
          key: "agent:main:dispatch",
          expected: { generation: 4, environmentId: "environment-1", ownerEpoch: 7 },
          target: { kind: "profile", profileId: "development", machineClass },
        }),
      ).toBe(false);
    }
    for (const os of ["", "x".repeat(65)]) {
      expect(
        validateSessionsMoveParams({
          key: "agent:main:dispatch",
          expected: { generation: 4, environmentId: "environment-1", ownerEpoch: 7 },
          target: { kind: "profile", profileId: "development", os },
        }),
      ).toBe(false);
    }
    for (const value of [rejected, " leading", "trailing "]) {
      expect(
        validateSessionsMoveParams({
          key: "agent:main:dispatch",
          expected: { generation: 4, environmentId: value, ownerEpoch: 7 },
          target: { kind: "gateway" },
        }),
      ).toBe(false);
      expect(
        validateSessionsMoveParams({
          key: "agent:main:dispatch",
          expected: { generation: 4, environmentId: "environment-1", ownerEpoch: 7 },
          target: { kind: "device", deviceId: value },
        }),
      ).toBe(false);
    }
  });

  it.each([{ generation: 4, environmentId: "environment-1", ownerEpoch: 0 }])(
    "rejects an inexact move source %#",
    (expected) => {
      expect(
        validateSessionsMoveParams({
          key: "agent:main:dispatch",
          expected,
          target: { kind: "gateway" },
        }),
      ).toBe(false);
    },
  );

  it("projects bounded durable move progress without operation authority", () => {
    expect(
      Value.Check(SessionPlacementMoveSchema, {
        target: { kind: "gateway" },
        updatedAtMs: 1,
      }),
    ).toBe(true);
    expect(
      Value.Check(SessionPlacementMoveSchema, {
        target: { kind: "device", deviceId: "device-1" },
        updatedAtMs: 2,
        error: "device worker is offline",
      }),
    ).toBe(true);
    expect(
      Value.Check(SessionPlacementMoveSchema, {
        target: { kind: "gateway" },
        updatedAtMs: 1,
        operationId: "move:v1:secret",
      }),
    ).toBe(false);
  });

  it("keeps the move result bounded to terminal placement state", () => {
    const result = {
      ok: true,
      key: "agent:main:dispatch",
      sessionId: "session-dispatch",
      placement: { state: "active", generation: 5 },
    };
    expect(validateSessionsMoveResult(result)).toBe(true);
    for (const state of ["requested", "reclaimed"] as const) {
      expect(
        validateSessionsMoveResult({
          ...result,
          placement: { state, generation: result.placement.generation },
        }),
      ).toBe(false);
    }
    expect(
      validateSessionsMoveResult({
        ...result,
        placement: {
          ...result.placement,
          remoteWorkspaceDir: "/workspace/session-dispatch",
        },
      }),
    ).toBe(false);
    expect(validateSessionsMoveResult({ ...result, providerSettings: {} })).toBe(false);
  });
});
