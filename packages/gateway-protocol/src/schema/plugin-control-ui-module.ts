import { Type } from "typebox";
import { PLUGIN_UI_CAPABILITIES } from "../plugin-ui-capabilities.js";
import { closedObject } from "./closed-object.js";
import { NonEmptyString } from "./primitives.js";

export const PluginUiCapabilitySchema = Type.Enum(PLUGIN_UI_CAPABILITIES, { type: "string" });
export const PluginUiCapabilitiesSchema = Type.Array(PluginUiCapabilitySchema, {
  maxItems: PLUGIN_UI_CAPABILITIES.length,
  uniqueItems: true,
});

/** One immutable browser build owned by an active native plugin. */
export const PluginControlUiModuleSchema = closedObject({
  /** Browser-local presentations survive transport loss without retaining Gateway services. */
  activation: Type.Optional(Type.Literal("browser-local")),
  pluginId: NonEmptyString,
  name: NonEmptyString,
  revision: NonEmptyString,
  entryUrl: NonEmptyString,
  panelIcon: Type.Optional(Type.String({ maxLength: 16 * 1024 * 3 + 64 })),
  imports: Type.Optional(Type.Array(NonEmptyString, { maxItems: 128 })),
  uiCapabilities: Type.Optional(PluginUiCapabilitiesSchema),
  // Host-owned runtime provenance; plugin manifests cannot opt into this delivery route.
  bundledDistribution: Type.Optional(
    closedObject({ packageName: NonEmptyString, packageVersion: NonEmptyString }),
  ),
  styles: Type.Array(NonEmptyString, { maxItems: 16 }),
});

export const PluginControlUiDiagnosticSchema = closedObject({
  pluginId: NonEmptyString,
  message: Type.String({ maxLength: 512 }),
  code: Type.Optional(Type.Literal("custom-plugin-ui-disabled")),
});
