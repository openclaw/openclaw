import { Type, type Static } from "typebox";

const timestamp = Type.String({ maxLength: 40 });
const message = Type.String({ maxLength: 1000 });
const count = Type.Integer({ minimum: 0 });

/** One store's part of a maintenance pass. Unready stores are skipped, never created. */
export const MaintenanceVault = Type.Object(
  {
    binding: Type.String({ maxLength: 120 }),
    label: Type.String({ maxLength: 160 }),
    outcome: Type.Union([Type.Literal("ok"), Type.Literal("failed"), Type.Literal("skipped")]),
    partitions: count,
    scanned: count,
    linked: count,
    ambiguous: count,
    noSubject: count,
    failed: count,
    message: Type.Optional(message),
  },
  { additionalProperties: false },
);
export type MaintenanceVault = Static<typeof MaintenanceVault>;

export const MaintenanceRun = Type.Object(
  {
    trigger: Type.Union([Type.Literal("scheduled"), Type.Literal("catch-up")]),
    /** The schedule slot this pass ran for. */
    slot: timestamp,
    startedAt: timestamp,
    finishedAt: timestamp,
    linked: count,
    vaults: Type.Array(MaintenanceVault, { maxItems: 500 }),
  },
  { additionalProperties: false },
);
export type MaintenanceRun = Static<typeof MaintenanceRun>;

export const MaintenanceStatus = Type.Object(
  {
    enabled: Type.Boolean(),
    /** Writes disabled plugin-wide: nothing is scheduled. */
    writesEnabled: Type.Boolean(),
    schedule: Type.String({ maxLength: 100 }),
    timezone: Type.String({ maxLength: 100 }),
    /** Why the schedule could not be used; the pass does not run until it is fixed. */
    configError: Type.Optional(message),
    running: Type.Boolean(),
    nextRunAt: Type.Union([timestamp, Type.Null()]),
    lastRun: Type.Union([MaintenanceRun, Type.Null()]),
    jobs: Type.Array(Type.String({ maxLength: 40 }), { maxItems: 10 }),
  },
  { additionalProperties: false },
);
export type MaintenanceStatus = Static<typeof MaintenanceStatus>;
