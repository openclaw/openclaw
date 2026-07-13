import type { Static } from "typebox";
import { Type } from "typebox";
import { closedObject } from "./closed-object.js";
import { NonEmptyString } from "./primitives.js";

/** Durable gateway ownership states for one session execution placement. */
export const SessionPlacementStateSchema = Type.Union([
  Type.Literal("local"),
  Type.Literal("requested"),
  Type.Literal("provisioning"),
  Type.Literal("syncing"),
  Type.Literal("starting"),
  Type.Literal("active"),
  Type.Literal("draining"),
  Type.Literal("reconciling"),
  Type.Literal("reclaimed"),
  Type.Literal("failed"),
]);

const SessionPlacementTimingProperties = {
  generation: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
  createdAtMs: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
  updatedAtMs: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
  stateChangedAtMs: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
};

const SessionPlacementOwnerEpochSchema = Type.Integer({
  minimum: 1,
  maximum: Number.MAX_SAFE_INTEGER,
});

const WorkerBundleHashSchema = Type.String({
  minLength: 64,
  maxLength: 64,
  pattern: "^[a-f0-9]{64}$",
});

const SessionPlacementWorkspaceProperties = {
  workspaceBaseManifestRef: NonEmptyString,
  remoteWorkspaceDir: NonEmptyString,
};

const SessionPlacementAckProperties = {
  lastTranscriptAckCursor: Type.Optional(
    Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
  ),
  lastLiveEventAckCursor: Type.Optional(
    Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
  ),
};

const TerminalSessionPlacementProperties = {
  environmentId: Type.Optional(NonEmptyString),
  activeOwnerEpoch: Type.Optional(SessionPlacementOwnerEpochSchema),
  workspaceBaseManifestRef: Type.Optional(NonEmptyString),
  remoteWorkspaceDir: Type.Optional(NonEmptyString),
  workerBundleHash: Type.Optional(WorkerBundleHashSchema),
  ...SessionPlacementAckProperties,
};

function createUnownedSessionPlacementSchema<const State extends "local" | "requested">(
  state: State,
) {
  return closedObject({ state: Type.Literal(state), ...SessionPlacementTimingProperties });
}

function createWorkerOwnedSessionPlacementSchema<
  const State extends "active" | "draining" | "reconciling",
>(state: State) {
  return closedObject({
    state: Type.Literal(state),
    ...SessionPlacementTimingProperties,
    environmentId: NonEmptyString,
    activeOwnerEpoch: SessionPlacementOwnerEpochSchema,
    workerBundleHash: WorkerBundleHashSchema,
    ...SessionPlacementWorkspaceProperties,
    ...SessionPlacementAckProperties,
  });
}

export const LocalSessionPlacementSchema = createUnownedSessionPlacementSchema("local");
export const RequestedSessionPlacementSchema = createUnownedSessionPlacementSchema("requested");

export const ProvisioningSessionPlacementSchema = closedObject({
  state: Type.Literal("provisioning"),
  ...SessionPlacementTimingProperties,
  environmentId: Type.Optional(NonEmptyString),
});

export const SyncingSessionPlacementSchema = closedObject({
  state: Type.Literal("syncing"),
  ...SessionPlacementTimingProperties,
  environmentId: NonEmptyString,
  workerBundleHash: WorkerBundleHashSchema,
});

export const StartingSessionPlacementSchema = closedObject({
  state: Type.Literal("starting"),
  ...SessionPlacementTimingProperties,
  environmentId: NonEmptyString,
  workerBundleHash: WorkerBundleHashSchema,
  ...SessionPlacementWorkspaceProperties,
});

export const ActiveWorkerSessionPlacementSchema = createWorkerOwnedSessionPlacementSchema("active");
export const DrainingSessionPlacementSchema = createWorkerOwnedSessionPlacementSchema("draining");
export const ReconcilingSessionPlacementSchema =
  createWorkerOwnedSessionPlacementSchema("reconciling");

export const ReclaimedSessionPlacementSchema = closedObject({
  state: Type.Literal("reclaimed"),
  ...SessionPlacementTimingProperties,
  ...TerminalSessionPlacementProperties,
});

export const FailedSessionPlacementSchema = closedObject({
  state: Type.Literal("failed"),
  ...SessionPlacementTimingProperties,
  ...TerminalSessionPlacementProperties,
  recoveryError: NonEmptyString,
});

/** Gateway-visible placement projection; `state` remains the closed discriminator. */
export const SessionPlacementSchema = Type.Union([
  LocalSessionPlacementSchema,
  RequestedSessionPlacementSchema,
  ProvisioningSessionPlacementSchema,
  SyncingSessionPlacementSchema,
  StartingSessionPlacementSchema,
  ActiveWorkerSessionPlacementSchema,
  DrainingSessionPlacementSchema,
  ReconcilingSessionPlacementSchema,
  ReclaimedSessionPlacementSchema,
  FailedSessionPlacementSchema,
]);

/** Requests one-way dispatch of an existing local session to a configured worker profile. */
export const SessionsDispatchParamsSchema = closedObject({
  key: NonEmptyString,
  agentId: Type.Optional(NonEmptyString),
  profileId: NonEmptyString,
});

/** Result returned once session dispatch reaches durable worker ownership. */
export const SessionsDispatchResultSchema = closedObject({
  ok: Type.Literal(true),
  key: NonEmptyString,
  sessionId: NonEmptyString,
  placement: ActiveWorkerSessionPlacementSchema,
});

export const SessionPlacementProtocolSchemas = {
  SessionPlacementState: SessionPlacementStateSchema,
  LocalSessionPlacement: LocalSessionPlacementSchema,
  RequestedSessionPlacement: RequestedSessionPlacementSchema,
  ProvisioningSessionPlacement: ProvisioningSessionPlacementSchema,
  SyncingSessionPlacement: SyncingSessionPlacementSchema,
  StartingSessionPlacement: StartingSessionPlacementSchema,
  ActiveWorkerSessionPlacement: ActiveWorkerSessionPlacementSchema,
  DrainingSessionPlacement: DrainingSessionPlacementSchema,
  ReconcilingSessionPlacement: ReconcilingSessionPlacementSchema,
  ReclaimedSessionPlacement: ReclaimedSessionPlacementSchema,
  FailedSessionPlacement: FailedSessionPlacementSchema,
  SessionPlacement: SessionPlacementSchema,
  SessionsDispatchParams: SessionsDispatchParamsSchema,
  SessionsDispatchResult: SessionsDispatchResultSchema,
} as const;

export type SessionPlacementState = Static<typeof SessionPlacementStateSchema>;
export type SessionPlacement = Static<typeof SessionPlacementSchema>;
export type SessionsDispatchParams = Static<typeof SessionsDispatchParamsSchema>;
export type SessionsDispatchResult = Static<typeof SessionsDispatchResultSchema>;
