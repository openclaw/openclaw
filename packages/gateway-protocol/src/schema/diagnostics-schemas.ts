import { Type } from "typebox";
import { closedObject } from "./closed-object.js";

/** At most 30 five-second windows (150 seconds) in one capture. */
export const DiagnosticsCpuProfileParamsSchema = closedObject({
  windows: Type.Optional(Type.Integer({ minimum: 1, maximum: 30 })),
  windowMs: Type.Optional(Type.Integer({ minimum: 100, maximum: 5_000 })),
});

/** Integer inputs are clamped by the capture owner to safe sampling bounds. */
export const DiagnosticsHeapProfileParamsSchema = closedObject({
  durationMs: Type.Optional(Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER })),
  samplingIntervalBytes: Type.Optional(
    Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
  ),
  includeCollected: Type.Optional(Type.Boolean()),
  includeObjectsCollectedByMajorGC: Type.Optional(Type.Boolean()),
  includeObjectsCollectedByMinorGC: Type.Optional(Type.Boolean()),
});

export const DiagnosticsHeapSnapshotParamsSchema = closedObject({
  reason: Type.Optional(Type.String({ maxLength: 256 })),
});
