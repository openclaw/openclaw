import type { Static } from "typebox";
import { closedObject } from "./closed-object.js";
import { NonEmptyString } from "./primitives.js";
import { stringLiteralUnion } from "./string-literal-union.js";

/** Request-scoped installer facts; no package output or local paths cross this boundary. */
export const PluginInstallActivitySchema = closedObject({
  activityId: NonEmptyString,
  stage: stringLiteralUnion(["resolve", "download", "extract", "files", "dependencies", "runtime"]),
  status: stringLiteralUnion(["started", "completed", "failed"]),
});
export const PluginsInstallProgressEventSchema = closedObject({
  ...PluginInstallActivitySchema.properties,
  requestId: NonEmptyString,
});
export type PluginInstallActivity = Static<typeof PluginInstallActivitySchema>;
export type PluginsInstallProgressEvent = Static<typeof PluginsInstallProgressEventSchema>;
