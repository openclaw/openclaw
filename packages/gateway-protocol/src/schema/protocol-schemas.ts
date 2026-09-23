import { MigrationProtocolSchemas } from "./migrations.js";
import { composeProtocolSchemaFragments } from "./protocol-schema-composer.js";
import { DerivedProtocolSchemas } from "./protocol-schema-selection.js";
import type { Registry } from "./protocol-schema-types.js";
import { SessionPlacementProtocolSchemas } from "./session-placement.js";

/** Public schema registry keyed by stable protocol schema name. */
export const ProtocolSchemas: Registry = composeProtocolSchemaFragments([
  DerivedProtocolSchemas,
  MigrationProtocolSchemas,
  SessionPlacementProtocolSchemas,
] as const);

export {
  MIN_CLIENT_PROTOCOL_VERSION,
  MIN_NODE_PROTOCOL_VERSION,
  MIN_PROBE_PROTOCOL_VERSION,
  PROTOCOL_VERSION,
} from "../version.js";
