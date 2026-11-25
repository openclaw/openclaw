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
import { schemaValidation, validation } from "./protocol-validation.test-support.js";

const basePlacement = { generation: 4, createdAtMs: 100, updatedAtMs: 200, stateChangedAtMs: 150 };
const workerBundleHash = "a".repeat(64);
const environmentFields = { environmentId: "environment-1", workerBundleHash };
const workspaceFields = {
  workspaceBaseManifestRef: "manifest-1",
  remoteWorkspaceDir: "/workspace/session-1",
};
const workerOwnedFields = { ...environmentFields, ...workspaceFields, activeOwnerEpoch: 7 };
const placed = <T extends object>(state: string, fields: T) => ({
  ...basePlacement,
  state,
  ...fields,
});
const key = "agent:main:dispatch";
const expected = { generation: 4, environmentId: "environment-1", ownerEpoch: 7 };
const moveRequest = (target: unknown, fields: object = {}) => ({ expected, target, ...fields });
const gateway = { kind: "gateway" };
const device = (deviceId = "device-1") => ({ kind: "device", deviceId });
const profile = (overrides: object = {}) => ({
  kind: "profile",
  profileId: "development",
  ...overrides,
});
const placement = schemaValidation(SessionPlacementSchema);
const progress = schemaValidation(SessionPlacementMoveSchema);
const dispatch = validation(validateSessionsDispatchParams);
const reclaim = validation(validateSessionsReclaimParams);
const reclaimed = validation(validateSessionsReclaimResult);
const moved = validation(validateSessionsMoveResult);
const moving = validation(validateSessionsMoveParams);
const retryProgress = (retry: { target: unknown }) => ({
  target: retry.target,
  updatedAtMs: 1,
  error: "move interrupted",
  retry,
});

describe("session dispatch protocol schemas", () => {
  it("accepts an explicit target, automatic device selection, or configured-default lookup", () => {
    const request = (target: Record<string, unknown>) => ({ key, ...target });
    dispatch.accepts(
      ...[
        { agentId: "main", profileId: "development", machineClass: "beast", os: "windows/wsl2" },
        { deviceId: "device-1" },
        { autoDevice: true },
        {},
        { profileId: "development", os: "x".repeat(64) },
      ].map(request),
    );
    dispatch.rejects(
      ...[
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
      ].map(request),
    );
  });

  it("accepts a session selector and exact failed generation for Gateway recovery", () => {
    reclaim.accepts({ key, agentId: "main" }, { key, recoverToGateway: { expectedGeneration: 3 } });
    reclaim.rejects(
      { key, profileId: "dev" },
      ...[{}, { expectedGeneration: -1 }, { expectedGeneration: 0.5 }].map((recoverToGateway) => ({
        key,
        recoverToGateway,
      })),
    );
  });

  it("accepts exactly the reclaim owner's terminal outcomes", () => {
    const result = (value: unknown) => ({
      ok: true,
      key,
      sessionId: "session-1",
      placement: value,
    });
    reclaimed.accepts(...["local", "reclaimed"].map((state) => result(placed(state, {}))));
    reclaimed.rejects(result(placed("requested", {})), result(placed("active", workerOwnedFields)));
  });

  it("keeps placement states closed", () => {
    const states = schemaValidation(SessionPlacementStateSchema);
    states.accepts("active");
    states.rejects("unknown");
  });

  it("requires workspace identity while starting", () => {
    const starting = placed("starting", { ...environmentFields, ...workspaceFields });
    placement.accepts(starting);
    const { workspaceBaseManifestRef: _manifest, ...missingManifest } = starting;
    placement.rejects(missingManifest, { ...starting, lastTranscriptAckCursor: 0 });
  });

  it("requires complete worker ownership for active placement", () => {
    placement.accepts(
      placed("active", {
        ...workerOwnedFields,
        lastTranscriptAckCursor: 2,
        lastLiveEventAckCursor: 9,
      }),
    );
    placement.rejects(placed("active", { ...environmentFields, activeOwnerEpoch: 7 }));
  });

  it("projects bounded durable move progress without operation authority", () => {
    progress.accepts(
      { target: gateway, updatedAtMs: 1 },
      { target: device(), updatedAtMs: 2, error: "device worker is offline" },
    );
    progress.rejects({
      target: gateway,
      updatedAtMs: 1,
      operationId: "move:v1:secret",
    });
  });

  it("validates projected retries with the same source and target constraints as Move requests", () => {
    const retries = [
      moveRequest(gateway),
      moveRequest(gateway, { abandonSource: true }),
      moveRequest(device()),
      moveRequest(profile({ profileId: "team", os: "linux", machineClass: "tiny" })),
      moveRequest(
        profile({
          profileId: "x".repeat(256),
          machineClass: "x".repeat(128),
          os: "x".repeat(64),
        }),
        { expected: { ...expected, environmentId: "x".repeat(256) } },
      ),
    ];
    for (const retry of retries) {
      progress.accepts(retryProgress(retry));
      moving.accepts({ key, ...retry });
    }
    for (const retry of [
      moveRequest(gateway, { expected: { ...expected, ownerEpoch: 0 } }),
      moveRequest(gateway, { expected: { ...expected, generation: -1 } }),
      moveRequest(gateway, { abandonSource: false }),
      moveRequest(device(), { abandonSource: true }),
      moveRequest(profile({ profileId: "team" }), { abandonSource: true }),
      moveRequest(gateway, { operationId: "move:v1:opaque" }),
      ...["", "x".repeat(129)].map((machineClass) => moveRequest(profile({ machineClass }))),
      ...["", "x".repeat(65)].map((os) => moveRequest(profile({ os }))),
      ...["x".repeat(257), " leading", "trailing "].flatMap((value) => [
        moveRequest(gateway, { expected: { ...expected, environmentId: value } }),
        moveRequest(device(value)),
      ]),
    ]) {
      progress.rejects(retryProgress(retry));
      moving.rejects({ key, ...retry });
    }
  });

  it("keeps the move result bounded to terminal placement state", () => {
    const result = {
      ok: true,
      key: "agent:main:dispatch",
      sessionId: "session-dispatch",
      placement: { state: "active", generation: 5 },
    };
    moved.accepts(result);
    moved.rejects(
      { ...result, placement: { state: "requested", generation: 5 } },
      { ...result, placement: { state: "reclaimed", generation: 5 } },
      {
        ...result,
        placement: { ...result.placement, remoteWorkspaceDir: "/workspace/session-dispatch" },
      },
      { ...result, providerSettings: {} },
    );
  });
});
