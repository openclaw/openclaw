import type { Static } from "typebox";
import { Type } from "typebox";
import { ControlUiRepositorySourceSchema } from "../plugin-control-ui-repositories.js";
import { ControlUiSettingsPlacementSchema } from "../plugin-control-ui-settings.js";
import { PLUGIN_UI_CAPABILITIES } from "../plugin-ui-capabilities.js";
import { closedObject } from "./closed-object.js";
import { NonEmptyString } from "./primitives.js";
import { stringLiteralUnion } from "./string-literal-union.js";

export const PluginUiCapabilitySchema = Type.Enum(PLUGIN_UI_CAPABILITIES, { type: "string" });
export const PluginUiCapabilitiesSchema = Type.Array(PluginUiCapabilitySchema, {
  maxItems: PLUGIN_UI_CAPABILITIES.length,
  uniqueItems: true,
});

/** One immutable browser build owned by an active native plugin. */
export const PluginControlUiModuleSchema = closedObject({
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
  settingsViews: Type.Optional(Type.Array(ControlUiSettingsPlacementSchema, { maxItems: 32 })),
});

export const PluginControlUiDiagnosticSchema = closedObject({
  pluginId: NonEmptyString,
  message: Type.String({ maxLength: 512 }),
  code: Type.Optional(Type.Literal("custom-plugin-ui-disabled")),
});

/** Lists browser builds; reading this catalog never reloads backend plugin code. */
export const PluginsControlUiListParamsSchema = closedObject({});
export const PluginsControlUiReloadParamsSchema = closedObject({
  pluginId: Type.Optional(NonEmptyString),
});
export const PluginsControlUiCatalogSchema = closedObject({
  revision: NonEmptyString,
  plugins: Type.Array(PluginControlUiModuleSchema, { maxItems: 64 }),
  repositorySources: Type.Optional(
    Type.Array(
      closedObject({ pluginId: NonEmptyString, ...ControlUiRepositorySourceSchema.properties }),
      { maxItems: 1024 },
    ),
  ),
  inlineViews: Type.Optional(
    Type.Array(
      closedObject({
        pluginId: NonEmptyString,
        id: NonEmptyString,
        label: NonEmptyString,
        version: Type.Integer({ minimum: 1, maximum: 65535 }),
      }),
    ),
  ),
  diagnostics: Type.Array(PluginControlUiDiagnosticSchema, { maxItems: 64 }),
});
export const PluginsControlUiChangedEventSchema = closedObject({ revision: NonEmptyString });
const PluginControlUiActivationSchema = closedObject({
  pluginId: NonEmptyString,
  revision: NonEmptyString,
  status: stringLiteralUnion(["activated", "failed"]),
  error: Type.Optional(Type.String({ maxLength: 512 })),
});
export const PluginsControlUiReportParamsSchema = closedObject({
  reports: Type.Array(PluginControlUiActivationSchema, { minItems: 1, maxItems: 64 }),
});
export const PluginsControlUiStatusParamsSchema = closedObject({
  pluginId: Type.Optional(NonEmptyString),
});
export const PluginsControlUiStatusResultSchema = closedObject({
  clients: Type.Array(
    closedObject({
      connId: NonEmptyString,
      activations: Type.Array(PluginControlUiActivationSchema, { maxItems: 64 }),
    }),
    { maxItems: 128 },
  ),
});

export type PluginControlUiModule = Static<typeof PluginControlUiModuleSchema>;
export type PluginControlUiDiagnostic = Static<typeof PluginControlUiDiagnosticSchema>;
export type PluginsControlUiCatalog = Static<typeof PluginsControlUiCatalogSchema>;
export type PluginsControlUiReloadParams = Static<typeof PluginsControlUiReloadParamsSchema>;
export type PluginControlUiActivation = Static<typeof PluginControlUiActivationSchema>;
