import * as Checks from "./compiled/protocol.generated/migration-api.js";
// Public memory-migration wire contracts and validators.
import { createProtocolValidator } from "./protocol-validator.js";
import {
  MigrationsMemoryApplyParamsSchema,
  MigrationsMemoryPlanParamsSchema,
} from "./schema/migrations.js";

export * from "./schema/migrations.js";

export const validateMigrationsMemoryPlanParams = createProtocolValidator(
  MigrationsMemoryPlanParamsSchema,
  Checks.isMigrationsMemoryPlanParams,
);
export const validateMigrationsMemoryApplyParams = createProtocolValidator(
  MigrationsMemoryApplyParamsSchema,
  Checks.isMigrationsMemoryApplyParams,
);
