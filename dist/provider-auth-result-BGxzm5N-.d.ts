import { i as OpenClawConfig } from "./types.openclaw-DIZy8jcb.js";
import { Tt as ProviderAuthResult } from "./types-lCXG2pW_.js";

//#region src/plugin-sdk/provider-auth-result.d.ts
/** Build the standard auth result payload for OAuth-style provider login flows. */
declare function buildOauthProviderAuthResult(params: {
  providerId: string;
  defaultModel: string;
  access: string;
  refresh?: string | null;
  expires?: number | null;
  email?: string | null;
  displayName?: string | null;
  profileName?: string | null;
  profilePrefix?: string;
  credentialExtra?: Record<string, unknown>;
  configPatch?: Partial<OpenClawConfig>;
  notes?: string[];
}): ProviderAuthResult;
//#endregion
export { buildOauthProviderAuthResult as t };