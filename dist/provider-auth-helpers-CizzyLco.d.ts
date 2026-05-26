import { i as OpenClawConfig } from "./types.openclaw-BLF4DJTX.js";
import { l as SecretInput, p as SecretRef } from "./types.secrets-tbFW-hY6.js";
import { t as SecretInputMode } from "./provider-auth-types-C72FsWut.js";
import { OAuthCredentials } from "@earendil-works/pi-ai";

//#region src/plugins/provider-auth-helpers.d.ts
type ApiKeyStorageOptions = {
  secretInputMode?: SecretInputMode;
  config?: OpenClawConfig;
};
type WriteOAuthCredentialsOptions = {
  syncSiblingAgents?: boolean;
  profileName?: string;
  displayName?: string;
};
declare function buildApiKeyCredential(provider: string, input: SecretInput, metadata?: Record<string, string>, options?: ApiKeyStorageOptions): {
  type: "api_key";
  provider: string;
  key?: string;
  keyRef?: SecretRef;
  metadata?: Record<string, string>;
};
declare function upsertApiKeyProfile(params: {
  provider: string;
  input: SecretInput;
  agentDir?: string;
  options?: ApiKeyStorageOptions;
  profileId?: string;
  metadata?: Record<string, string>;
}): string;
declare function applyAuthProfileConfig(cfg: OpenClawConfig, params: {
  profileId: string;
  provider: string;
  mode: "api_key" | "aws-sdk" | "oauth" | "token";
  email?: string;
  displayName?: string;
  preferProfileFirst?: boolean;
}): OpenClawConfig;
declare function writeOAuthCredentials(provider: string, creds: OAuthCredentials, agentDir?: string, options?: WriteOAuthCredentialsOptions): Promise<string>;
//#endregion
export { upsertApiKeyProfile as a, buildApiKeyCredential as i, WriteOAuthCredentialsOptions as n, writeOAuthCredentials as o, applyAuthProfileConfig as r, ApiKeyStorageOptions as t };