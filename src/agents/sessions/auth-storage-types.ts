import type { OAuthCredentials } from "../../llm/utils/oauth/types.js";
import type { AuthProfileCredentialSource } from "../auth-profiles/types.js";

export type ApiKeyCredential = {
  type: "api_key";
  key: string;
};

export type OAuthCredential = {
  type: "oauth";
} & OAuthCredentials;

export type TokenCredential = {
  type: "token";
  token: string;
  expires?: number;
};

export type AuthCredential = ApiKeyCredential | OAuthCredential | TokenCredential;

export type AuthStorageData = Record<string, AuthCredential>;

export type LockResult<T> = {
  result: T;
  next?: string;
};

export interface AuthStorageBackend {
  read?(): string | undefined;
  assertProviderReady?(provider?: string, baseUrl?: string): void;
  getCredentialSource?(provider: string): AuthProfileCredentialSource | undefined;
  assertCredentialReady?(source: AuthProfileCredentialSource, baseUrl?: string): void;
  withLock<T>(fn: (current: string | undefined) => LockResult<T>): T;
  withLockAsync<T>(fn: (current: string | undefined) => Promise<LockResult<T>>): Promise<T>;
}
