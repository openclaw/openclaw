/**
 * Scope types for the web UI.
 * These mirror the server-side types but are optimized for client rendering.
 */

export type ScopeRiskLevel = "low" | "medium" | "high";

export interface ScopeDefinition {
  id: string;
  label: string;
  description: string;
  risk: ScopeRiskLevel;
  required?: boolean;
  recommended?: boolean;
  examples?: string[];
  implies?: string[];
}

export interface ScopeCategory {
  id: string;
  label: string;
  description?: string;
  scopes: string[];
  collapsed?: boolean;
}

export interface ScopePreset {
  id: string;
  label: string;
  description?: string;
  scopes: string[];
}

export interface ConnectionProviderScopes {
  providerId: string;
  label: string;
  scopes: ScopeDefinition[];
  categories?: ScopeCategory[];
  presets?: ScopePreset[];
}
