import { i as OpenClawConfig } from "./types.openclaw-BLF4DJTX.js";
import { At as ProviderAuthResult } from "./types-Vx7Jq4_-2.js";

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