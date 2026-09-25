import { Type, type Static } from "typebox";
import {
  UPDATE_RUN_DRIVER_LIMIT,
  UPDATE_RUN_PHASES,
  UPDATE_RUN_STATUSES,
  UPDATE_RUN_STEP_STATUSES,
  UPDATE_RUN_TRIGGERS,
} from "../update-run-vocabulary.js";
import { closedObject } from "./closed-object.js";

const text = Type.String({ maxLength: 1024 });
const timestamp = Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER });
// Match the ledger's RFC 9562 UUID contract, including nil/max UUIDs.
const runId = Type.String({
  pattern:
    "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$",
});
const phase = Type.Enum(UPDATE_RUN_PHASES);
const status = Type.Enum(UPDATE_RUN_STATUSES);
const version = closedObject({
  version: Type.Optional(Type.Union([text, Type.Null()])),
  sha: Type.Optional(Type.Union([text, Type.Null()])),
  buildId: Type.Optional(Type.Union([text, Type.Null()])),
});
const driver = closedObject({
  host: Type.String({ minLength: 1, maxLength: 255 }),
  pid: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
  startIdentity: Type.String({ pattern: "^\\d+$", maxLength: 128 }),
});
const snapshotLocation = closedObject({
  kind: Type.Enum(["explicit-tmpdir", "state-volume", "system-tmpdir"]),
  directory: text,
});
const snapshotBytes = Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER });
const admissionCheck = closedObject({
  name: text,
  status: Type.Enum(["ok", "warn", "refuse"]),
  detail: Type.Optional(text),
});
const admissionChecks = Type.Array(admissionCheck, { maxItems: 32 });
const admission = closedObject({
  owner: Type.Enum(["candidate", "installed"]),
  protocol: Type.Optional(Type.Literal(1)),
  candidateVersion: Type.Optional(text),
  checks: Type.Optional(admissionChecks),
  fallbackReason: Type.Optional(text),
});
const candidateAdmission = closedObject({
  protocol: Type.Literal(1),
  verdict: Type.Enum(["admit", "refuse"]),
  reasons: Type.Array(
    closedObject({ code: text, message: text, nextAction: Type.Optional(text) }),
    { maxItems: 32 },
  ),
  warnings: Type.Array(closedObject({ code: text, message: text }), { maxItems: 32 }),
  facts: closedObject({
    candidateVersion: text,
    installedVersion: Type.Union([text, Type.Null()]),
    nodeEngines: Type.Optional(text),
    checks: admissionChecks,
  }),
});
const destinationPath = Type.String({ maxLength: 240 });
const nullableDestinationPath = Type.Union([destinationPath, Type.Null()]);

/** Wire projection of the canonical update ledger record. */
export const UpdateRunRecordSchema = closedObject({
  runId,
  createdAtMs: timestamp,
  updatedAtMs: timestamp,
  trigger: Type.Enum(UPDATE_RUN_TRIGGERS),
  phase,
  status,
  reason: Type.Union([text, Type.Null()]),
  admission: Type.Optional(admission),
  origin: closedObject({
    admission: Type.Optional(admission),
    candidateAdmission: Type.Optional(candidateAdmission),
    driver: Type.Optional(driver),
    previousDrivers: Type.Optional(Type.Array(driver, { maxItems: UPDATE_RUN_DRIVER_LIMIT - 1 })),
    requester: Type.Optional(
      closedObject({
        channel: Type.Optional(text),
        accountId: Type.Optional(text),
        senderId: Type.Optional(text),
        authorizationSource: Type.Optional(text),
      }),
    ),
    sessionKey: Type.Optional(text),
    deliveryContext: Type.Optional(
      closedObject({
        channel: Type.Optional(text),
        to: Type.Optional(text),
        accountId: Type.Optional(text),
        threadId: Type.Optional(text),
      }),
    ),
    campaignId: Type.Optional(text),
    doctorHint: Type.Optional(text),
    nextAction: Type.Optional(text),
  }),
  target: closedObject({
    channel: Type.Optional(text),
    tag: Type.Optional(text),
    kind: Type.Optional(Type.Enum(["package", "git"])),
    version: Type.Optional(text),
    sha: Type.Optional(text),
    installationMethod: Type.Optional(
      Type.Union([
        Type.Enum(["git-checkout", "npm-global", "pnpm-global", "bun-global", "managed-service"]),
        Type.Null(),
      ]),
    ),
  }),
  before: version,
  after: version,
  steps: Type.Array(
    closedObject({
      step: text,
      status: Type.Enum(UPDATE_RUN_STEP_STATUSES),
      startedAtMs: Type.Optional(timestamp),
      endedAtMs: Type.Optional(timestamp),
      exitCode: Type.Optional(Type.Union([Type.Integer(), Type.Null()])),
      detail: Type.Optional(text),
      failureFacts: Type.Optional(
        Type.Array(
          closedObject({
            check: Type.String({ maxLength: 128 }),
            code: Type.String({ maxLength: 80 }),
            message: Type.Optional(Type.String({ maxLength: 200 })),
            affectedKey: Type.Optional(Type.String({ maxLength: 128 })),
            pluginId: Type.Optional(Type.String({ maxLength: 80 })),
            errorName: Type.Optional(Type.Union([Type.String({ maxLength: 80 }), Type.Null()])),
            location: Type.Optional(Type.Union([Type.String({ maxLength: 160 }), Type.Null()])),
            destination: Type.Optional(
              closedObject({
                ownership: Type.Enum(["foreign", "unknown"]),
                cause: Type.Enum([
                  "package-mismatch",
                  "launcher-mismatch",
                  "permission",
                  "probe-failure",
                  "unreadable-layout",
                ]),
                destinationKind: Type.Enum(["npm-global", "unknown"]),
                prefix: nullableDestinationPath,
                packageRoot: nullableDestinationPath,
                runningRoot: destinationPath,
                runningPrefix: nullableDestinationPath,
                launcher: nullableDestinationPath,
                launcherTarget: nullableDestinationPath,
              }),
            ),
          }),
          { maxItems: 5 },
        ),
      ),
      configChange: Type.Optional(
        Type.Union([
          closedObject({ kind: Type.Literal("key"), key: text }),
          closedObject({ kind: Type.Literal("migration"), message: text }),
        ]),
      ),
      configWriteRefusal: Type.Optional(
        closedObject({
          reason: text,
          message: text,
          keys: Type.Array(text, { maxItems: 32 }),
        }),
      ),
      snapshotCapacity: Type.Optional(
        closedObject({
          sqliteBytes: snapshotBytes,
          pluginBytes: Type.Union([snapshotBytes, Type.Null()]),
          requiredBytes: snapshotBytes,
          reason: Type.Enum([
            "explicit-tmpdir",
            "state-volume",
            "system-tmpdir",
            "snapshot-capacity-insufficient",
            "snapshot-location-unavailable",
          ]),
          candidates: Type.Array(
            closedObject({
              ...snapshotLocation.properties,
              availableBytes: Type.Union([snapshotBytes, Type.Null()]),
              allocationError: Type.Optional(text),
            }),
            { maxItems: 3 },
          ),
          selection: Type.Union([snapshotLocation, Type.Null()]),
        }),
      ),
    }),
    { maxItems: 128 },
  ),
  verification: closedObject({
    rollbackOutcome: Type.Optional(
      Type.Union([
        closedObject({
          status: Type.Enum(["not-needed", "not-attempted", "succeeded", "failed"]),
          reason: Type.String({ maxLength: 512 }),
        }),
        Type.Null(),
      ]),
    ),
    recovery: Type.Optional(
      Type.Union([
        closedObject({
          serviceRestartSafe: Type.Literal(true),
          packageRollbackVerified: Type.Optional(Type.Literal(true)),
          version: Type.String({ minLength: 1 }),
          buildId: Type.Optional(Type.String({ minLength: 1, maxLength: 96 })),
          service: Type.Optional(Type.Enum(["healthy", "failed"])),
          reason: Type.Optional(Type.String({ minLength: 1 })),
        }),
        closedObject({
          serviceRestartSafe: Type.Literal(false),
          packageRollbackVerified: Type.Optional(Type.Boolean()),
          reason: Type.Enum([
            "source-rollback-failed",
            "state-migration-started",
            "manager-unavailable",
            "deps-install-failed",
            "build-failed",
            "rollback-checkout-dirty",
            "runtime-verification-failed",
          ]),
        }),
        Type.Null(),
      ]),
    ),
    booted: Type.Optional(Type.Boolean()),
    runningVersion: Type.Optional(text),
    runningBuildId: Type.Optional(text),
    serviceRunning: Type.Optional(Type.Boolean()),
    pid: Type.Optional(timestamp),
    port: Type.Optional(Type.Integer({ minimum: 1, maximum: 65535 })),
    versionMatch: Type.Optional(Type.Boolean()),
    pluginErrors: Type.Optional(Type.Array(text, { maxItems: 32 })),
    channelsReady: Type.Optional(Type.Boolean()),
    readyz: Type.Optional(Type.Boolean()),
    settled: Type.Optional(Type.Boolean()),
    noticeDelivered: Type.Optional(Type.Boolean()),
    doctorHint: Type.Optional(text),
  }),
  repair: Type.Array(
    closedObject({
      attempt: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
      status: Type.Enum(["succeeded", "failed", "skipped"]),
      startedAtMs: timestamp,
      endedAtMs: Type.Optional(timestamp),
      summary: Type.Optional(text),
      reason: Type.Optional(text),
    }),
    { maxItems: 16 },
  ),
  confirmedAtMs: Type.Union([timestamp, Type.Null()]),
  finishedAtMs: Type.Union([timestamp, Type.Null()]),
  downtimeMs: Type.Union([timestamp, Type.Null()]),
});

export const UpdateRunsGetParamsSchema = closedObject({ runId });
export const UpdateRunsGetResultSchema = closedObject({
  run: Type.Union([UpdateRunRecordSchema, Type.Null()]),
});
export const UpdateRunsListParamsSchema = closedObject({
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
});
export const UpdateRunsListResultSchema = closedObject({
  runs: Type.Array(UpdateRunRecordSchema, { maxItems: 100 }),
});
export const UpdateRunChangedEventSchema = closedObject({
  runId,
  phase,
  status,
  updatedAtMs: timestamp,
});

/** Transient display guidance; never persisted in update history. */
export const ExternalSupervisorGuidanceSchema = closedObject({
  version: Type.Literal(1),
  action: Type.Literal("update"),
  name: Type.String({ minLength: 1, maxLength: 128 }),
  runFrom: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
  command: Type.String({ minLength: 1, maxLength: 1024 }),
});

/** Existing update.run response fields remain available alongside the durable run identity. */
export const UpdateRunResultSchema = closedObject({
  runId,
  ok: Type.Boolean(),
  result: Type.Unknown(),
  ackDelivered: Type.Optional(Type.Boolean()),
  ackQueued: Type.Optional(Type.Boolean()),
  acknowledgement: Type.Optional(Type.String()),
  externalSupervisorGuidance: Type.Optional(ExternalSupervisorGuidanceSchema),
  code: Type.Optional(Type.String()),
  message: Type.Optional(Type.String()),
  handoff: Type.Optional(Type.Unknown()),
  restart: Type.Optional(Type.Unknown()),
  sentinel: Type.Optional(Type.Unknown()),
});

export type UpdateRunRecord = Static<typeof UpdateRunRecordSchema>;
export type UpdateRunsGetParams = Static<typeof UpdateRunsGetParamsSchema>;
export type UpdateRunsGetResult = Static<typeof UpdateRunsGetResultSchema>;
export type UpdateRunsListParams = Static<typeof UpdateRunsListParamsSchema>;
export type UpdateRunsListResult = Static<typeof UpdateRunsListResultSchema>;
export type UpdateRunChangedEvent = Static<typeof UpdateRunChangedEventSchema>;
export type UpdateRunResult = Static<typeof UpdateRunResultSchema>;
