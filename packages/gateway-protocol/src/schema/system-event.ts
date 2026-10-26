import * as Checks from "../compiled/protocol.generated/schema-system-event.js";
// Gateway Protocol schema module defines operator-originated system events.
import { createProtocolValidator } from "../protocol-validator.js";
import { SystemEventParamsSchema } from "./system-event-schema.js";

/** Backward-compatible system-presence marker for removing retained input recency. */
export const SYSTEM_PRESENCE_CLEAR_LAST_INPUT_TAG = "system-presence-clear-last-input";
/** Non-sensitive overwrite for Gateways that accept tags but do not interpret the clear marker. */
export const SYSTEM_PRESENCE_LEGACY_CLEAR_LAST_INPUT_SECONDS = 2_592_000;

export const validateSystemEventParams = createProtocolValidator(
  SystemEventParamsSchema,
  Checks.isSystemEventParams,
);
