import { Type } from "typebox";
import { closedObject } from "./closed-object.js";
import { NonEmptyString } from "./primitives.js";

export const PluginCatalogClawHubInstallSchema = closedObject({
  source: Type.Literal("clawhub"),
  packageName: NonEmptyString,
});

export const PluginCatalogOfficialInstallSchema = closedObject({
  source: Type.Literal("official"),
  pluginId: NonEmptyString,
});

// Branches stay named schemas: the Swift generator only emits discriminated
// unions whose branches resolve to registered types (see PluginsSessionActionResult).
export const PluginCatalogInstallActionSchema = Type.Union([
  PluginCatalogClawHubInstallSchema,
  PluginCatalogOfficialInstallSchema,
]);
