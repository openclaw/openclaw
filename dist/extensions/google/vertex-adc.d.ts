//#region extensions/google/vertex-adc.d.ts
declare const GCP_VERTEX_CREDENTIALS_MARKER = "gcp-vertex-credentials";
declare function resetGoogleVertexAuthorizedUserTokenCacheForTest(): void;
declare function isGoogleVertexCredentialsMarker(apiKey: string | undefined): apiKey is undefined | typeof GCP_VERTEX_CREDENTIALS_MARKER;
declare function hasGoogleVertexAuthorizedUserAdcSync(env?: NodeJS.ProcessEnv): boolean;
declare function resolveGoogleVertexAuthorizedUserHeaders(fetchImpl?: typeof fetch): Promise<Record<string, string>>;
//#endregion
export { hasGoogleVertexAuthorizedUserAdcSync, isGoogleVertexCredentialsMarker, resetGoogleVertexAuthorizedUserTokenCacheForTest, resolveGoogleVertexAuthorizedUserHeaders };