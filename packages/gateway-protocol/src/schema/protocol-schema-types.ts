import type { MigrationProtocolSchemas } from "./migrations.js";
import type { DerivedProtocolSchemas } from "./protocol-schema-selection.js";
import type { SessionPlacementProtocolSchemas } from "./session-placement.js";

type AvailableSchemas = typeof DerivedProtocolSchemas &
  typeof MigrationProtocolSchemas &
  typeof SessionPlacementProtocolSchemas;
type WritableKeys =
  | "ProgressCardStepStatus"
  | "ProgressCardStep"
  | "ProgressCard"
  | "ProgressCardGetParams"
  | "ProgressCardGetResult"
  | "ProgressCardPutParams"
  | "ProgressCardPutResult"
  | "ProgressCardChangedEvent";

// Preserve the public write permissions without historical owner-group factors.
export type Registry = {
  readonly [Key in Exclude<keyof AvailableSchemas, WritableKeys>]: AvailableSchemas[Key];
} & {
  [Key in WritableKeys]: AvailableSchemas[Key];
};
