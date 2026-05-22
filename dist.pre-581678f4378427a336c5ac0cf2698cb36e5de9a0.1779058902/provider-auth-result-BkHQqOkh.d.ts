import { i as OpenClawConfig } from "./types.openclaw-BMMD0Ykw.js";
import { Et as ProviderAuthResult } from "./types-Dd0yIOXW2.js";

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