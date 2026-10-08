// Browser producers consumed through generated public declarations by the Control UI.
export const CONTROL_UI_PLUGIN_BOUNDARY_UNITS = [["github", "control-ui-api"]] as const;
export const CONTROL_UI_PLUGIN_SOURCE_ROOTS = CONTROL_UI_PLUGIN_BOUNDARY_UNITS.map(
  ([id]) => `extensions/${id}`,
);
