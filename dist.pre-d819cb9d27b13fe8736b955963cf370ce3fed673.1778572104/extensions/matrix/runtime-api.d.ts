import { i as OpenClawConfig } from "../../types.openclaw-BlE9q7jU.js";
import { l as closeDispatcher, o as SsrFPolicy, t as LookupFn, u as createPinnedDispatcher, x as resolvePinnedHostnameWithPolicy } from "../../ssrf-DAZxh7gy.js";
import { s as RuntimeLogger } from "../../types-core-C4sdPbS4.js";
import { n as RuntimeEnv } from "../../runtime-B7xbUSXv.js";
import { i as WizardPrompter } from "../../prompts-BT1CkWIz.js";
import { b as ChannelMessageActionContext, u as ChannelDirectoryEntry } from "../../types.core-BoZgMdCh.js";
import { n as PluginRuntime } from "../../types-6GKVZ6OQ.js";
import { n as formatZonedTimestamp } from "../../format-datetime-BDNqizjK.js";
import { d as ssrfPolicyFromAllowPrivateNetwork, f as ssrfPolicyFromDangerouslyAllowPrivateNetwork, n as assertHttpUrlTargetsPrivateNetwork } from "../../ssrf-policy-BEVET-dK.js";
import { i as writeJsonFileAtomically } from "../../json-store-rl0r6sqE.js";
import { _ as resolveMatrixDefaultOrOnlyAccountId, a as resolveMatrixCredentialsPath, c as resolveMatrixLegacyFlatStoreRoot, d as listMatrixEnvAccountIds, f as resolveMatrixEnvAccountToken, g as resolveMatrixChannelConfig, h as resolveConfiguredMatrixAccountIds, i as resolveMatrixCredentialsFilename, l as sanitizeMatrixPathSegment, m as requiresExplicitMatrixDefaultAccount, n as resolveMatrixAccountStorageRoot, o as resolveMatrixHomeserverKey, p as findMatrixAccountEntry, r as resolveMatrixCredentialsDir, s as resolveMatrixLegacyFlatStoragePaths, t as hashMatrixAccessToken, u as getMatrixScopedEnvVarNames } from "../../storage-paths-CPm99uhZ.js";
import { a as setMatrixThreadBindingMaxAgeBySessionKey, i as setMatrixThreadBindingIdleTimeoutBySessionKey } from "../../thread-bindings-shared-CjPQ2f7G.js";
import { t as setMatrixRuntime } from "../../runtime-CJb_kzwZ.js";

//#region extensions/matrix/src/auth-precedence.d.ts
type MatrixResolvedStringField = "homeserver" | "userId" | "accessToken" | "password" | "deviceId" | "deviceName";
type MatrixResolvedStringValues = Record<MatrixResolvedStringField, string>;
type MatrixStringSourceMap = Partial<Record<MatrixResolvedStringField, string>>;
declare function resolveMatrixAccountStringValues(params: {
  accountId: string;
  account?: MatrixStringSourceMap;
  scopedEnv?: MatrixStringSourceMap;
  channel?: MatrixStringSourceMap;
  globalEnv?: MatrixStringSourceMap;
}): MatrixResolvedStringValues;
//#endregion
//#region extensions/matrix/src/matrix/deps.d.ts
declare function isMatrixSdkAvailable(): boolean;
declare function ensureMatrixSdkInstalled(params: {
  runtime: RuntimeEnv;
  confirm?: (message: string) => Promise<boolean>;
}): Promise<void>;
//#endregion
//#region extensions/matrix/runtime-api.d.ts
declare function chunkTextForOutbound(text: string, limit: number): string[];
//#endregion
export { type ChannelDirectoryEntry, type ChannelMessageActionContext, type LookupFn, type MatrixResolvedStringField, type MatrixResolvedStringValues, type OpenClawConfig, type PluginRuntime, type RuntimeEnv, type RuntimeLogger, type SsrFPolicy, type WizardPrompter, assertHttpUrlTargetsPrivateNetwork, chunkTextForOutbound, closeDispatcher, createPinnedDispatcher, ensureMatrixSdkInstalled, findMatrixAccountEntry, formatZonedTimestamp, getMatrixScopedEnvVarNames, hashMatrixAccessToken, isMatrixSdkAvailable, listMatrixEnvAccountIds, requiresExplicitMatrixDefaultAccount, resolveConfiguredMatrixAccountIds, resolveMatrixAccountStorageRoot, resolveMatrixAccountStringValues, resolveMatrixChannelConfig, resolveMatrixCredentialsDir, resolveMatrixCredentialsFilename, resolveMatrixCredentialsPath, resolveMatrixDefaultOrOnlyAccountId, resolveMatrixEnvAccountToken, resolveMatrixHomeserverKey, resolveMatrixLegacyFlatStoragePaths, resolveMatrixLegacyFlatStoreRoot, resolvePinnedHostnameWithPolicy, sanitizeMatrixPathSegment, setMatrixRuntime, setMatrixThreadBindingIdleTimeoutBySessionKey, setMatrixThreadBindingMaxAgeBySessionKey, ssrfPolicyFromAllowPrivateNetwork, ssrfPolicyFromDangerouslyAllowPrivateNetwork, writeJsonFileAtomically };