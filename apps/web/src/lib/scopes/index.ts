export type {
  ScopeRiskLevel,
  ScopeDefinition,
  ScopeCategory,
  ScopePreset,
  ConnectionProviderScopes,
} from "./types";

export {
  getProviderScopes,
  getAllProviderScopes,
  getProviderPresets,
  getPresetScopes,
  getDefaultScopes,
  expandScopes,
} from "./registry";
