import type { Static } from "typebox";
import * as Checks from "../compiled/protocol.generated/schema-diagnostics.js";
import { createProtocolValidator } from "../protocol-validator.js";
import {
  DiagnosticsHeapProfileParamsSchema,
  DiagnosticsHeapSnapshotParamsSchema,
} from "./diagnostics-schemas.js";

export type DiagnosticsHeapProfileParams = Static<typeof DiagnosticsHeapProfileParamsSchema>;
export const validateDiagnosticsHeapProfileParams = createProtocolValidator(
  DiagnosticsHeapProfileParamsSchema,
  Checks.isDiagnosticsHeapProfileParams,
);

export const validateDiagnosticsHeapSnapshotParams = createProtocolValidator(
  DiagnosticsHeapSnapshotParamsSchema,
  Checks.isDiagnosticsHeapSnapshotParams,
);
