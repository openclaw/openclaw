import { r as ChannelAccountSnapshot } from "./types.core-BkmTlRzr.js";
//#region src/channels/account-snapshot-fields.d.ts
declare const CREDENTIAL_STATUS_KEYS: readonly ["tokenStatus", "botTokenStatus", "appTokenStatus", "signingSecretStatus", "userTokenStatus"];
type CredentialStatusKey = (typeof CREDENTIAL_STATUS_KEYS)[number];
declare function resolveConfiguredFromCredentialStatuses(account: unknown): boolean | undefined;
declare function resolveConfiguredFromRequiredCredentialStatuses(account: unknown, requiredKeys: CredentialStatusKey[]): boolean | undefined;
declare function projectCredentialSnapshotFields(account: unknown): Pick<Partial<ChannelAccountSnapshot>, "tokenSource" | "botTokenSource" | "appTokenSource" | "signingSecretSource" | "tokenStatus" | "botTokenStatus" | "appTokenStatus" | "signingSecretStatus" | "userTokenStatus">;
//#endregion
export { resolveConfiguredFromCredentialStatuses as n, resolveConfiguredFromRequiredCredentialStatuses as r, projectCredentialSnapshotFields as t };