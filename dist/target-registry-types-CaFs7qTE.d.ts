//#region src/secrets/target-registry-types.d.ts
type SecretTargetConfigFile = "openclaw.json" | "auth-profiles.json";
type SecretTargetShape = "secret_input" | "sibling_ref";
type SecretTargetExpected = "string" | "string-or-object";
type AuthProfileType = "api_key" | "token";
type SecretTargetRegistryEntry = {
  id: string;
  targetType: string;
  targetTypeAliases?: string[];
  configFile: SecretTargetConfigFile;
  pathPattern: string;
  refPathPattern?: string;
  secretShape: SecretTargetShape;
  expectedResolvedValue: SecretTargetExpected;
  includeInPlan: boolean;
  includeInConfigure: boolean;
  includeInAudit: boolean;
  providerIdPathSegmentIndex?: number;
  accountIdPathSegmentIndex?: number;
  authProfileType?: AuthProfileType;
  trackProviderShadowing?: boolean;
};
type ResolvedPlanTarget = {
  entry: SecretTargetRegistryEntry;
  pathSegments: string[];
  refPathSegments?: string[];
  providerId?: string;
  accountId?: string;
};
type DiscoveredConfigSecretTarget = {
  entry: SecretTargetRegistryEntry;
  path: string;
  pathSegments: string[];
  refPath?: string;
  refPathSegments?: string[];
  value: unknown;
  refValue?: unknown;
  providerId?: string;
  accountId?: string;
};
//#endregion
export { SecretTargetExpected as a, SecretTargetConfigFile as i, DiscoveredConfigSecretTarget as n, SecretTargetRegistryEntry as o, ResolvedPlanTarget as r, SecretTargetShape as s, AuthProfileType as t };