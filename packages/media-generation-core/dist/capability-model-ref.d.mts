//#region src/capability-model-ref.d.ts
type CapabilityModelProviderCandidate = {
  id: string;
  aliases?: readonly string[];
  defaultModel?: string | null;
  models?: readonly string[];
};
type CapabilityModelRef = {
  provider: string;
  model: string;
};
type ProviderIdNormalizer = (value: string) => string | undefined;
declare function findCapabilityProviderById<T extends CapabilityModelProviderCandidate>(params: {
  providers: readonly T[];
  providerId?: string;
  normalizeProviderId?: ProviderIdNormalizer;
}): T | undefined;
declare function resolveCapabilityProviderModelOnlyRef(params: {
  providers: readonly CapabilityModelProviderCandidate[];
  raw?: string;
}): CapabilityModelRef | null;
declare function resolveCapabilityModelRefForProviders(params: {
  providers: readonly CapabilityModelProviderCandidate[];
  raw?: string;
  parseModelRef: (raw: string | undefined) => CapabilityModelRef | null;
  normalizeProviderId?: ProviderIdNormalizer;
}): CapabilityModelRef | null;
//#endregion
export { CapabilityModelProviderCandidate, CapabilityModelRef, findCapabilityProviderById, resolveCapabilityModelRefForProviders, resolveCapabilityProviderModelOnlyRef };