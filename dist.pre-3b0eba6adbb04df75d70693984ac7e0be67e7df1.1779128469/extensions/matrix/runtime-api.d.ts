import { i as OpenClawConfig } from "../../types.openclaw-DZQrhn8E.js";
import { S as resolvePinnedHostnameWithPolicy, l as closeDispatcher, o as SsrFPolicy, t as LookupFn, u as createPinnedDispatcher } from "../../ssrf-HuuPklwv.js";
import { s as RuntimeLogger } from "../../types-core-Crp55Z_y.js";
import { n as RuntimeEnv } from "../../runtime-BGFXd35m.js";
import { i as WizardPrompter } from "../../prompts-W8K_XJ_v.js";
import { b as ChannelMessageActionContext, u as ChannelDirectoryEntry } from "../../types.core-DiLRQ15F.js";
import { n as PluginRuntime } from "../../types-DIe2gsAQ.js";
import { n as formatZonedTimestamp } from "../../format-datetime-DtmnBs56.js";
import { d as ssrfPolicyFromDangerouslyAllowPrivateNetwork, n as assertHttpUrlTargetsPrivateNetwork, u as ssrfPolicyFromAllowPrivateNetwork } from "../../ssrf-policy-D_AJX44j.js";
import { i as writeJsonFileAtomically } from "../../json-store-CrqA0Sg4.js";
import { _ as resolveMatrixDefaultOrOnlyAccountId, a as resolveMatrixCredentialsPath, c as resolveMatrixLegacyFlatStoreRoot, d as listMatrixEnvAccountIds, f as resolveMatrixEnvAccountToken, g as resolveMatrixChannelConfig, h as resolveConfiguredMatrixAccountIds, i as resolveMatrixCredentialsFilename, l as sanitizeMatrixPathSegment, m as requiresExplicitMatrixDefaultAccount, n as resolveMatrixAccountStorageRoot, o as resolveMatrixHomeserverKey, p as findMatrixAccountEntry, r as resolveMatrixCredentialsDir, s as resolveMatrixLegacyFlatStoragePaths, t as hashMatrixAccessToken, u as getMatrixScopedEnvVarNames } from "../../storage-paths-CUGBuG6j.js";
import { a as setMatrixThreadBindingMaxAgeBySessionKey, i as setMatrixThreadBindingIdleTimeoutBySessionKey } from "../../thread-bindings-shared-mlZOBF9S.js";
import { t as setMatrixRuntime } from "../../runtime-Bxdo003K.js";

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
declare function ensureMatrixSdkInstalled(params?: {
  runtime?: RuntimeEnv;
  confirm?: (message: string) => Promise<boolean>;
  resolveFn?: (id: string) => string;
}): Promise<void>;
//#endregion
//#region extensions/matrix/runtime-api.d.ts
declare function chunkTextForOutbound(text: string, limit: number): string[];
//#endregion
export { type ChannelDirectoryEntry, type ChannelMessageActionContext, type LookupFn, type MatrixResolvedStringField, type MatrixResolvedStringValues, type OpenClawConfig, type PluginRuntime, type RuntimeEnv, type RuntimeLogger, type SsrFPolicy, type WizardPrompter, assertHttpUrlTargetsPrivateNetwork, chunkTextForOutbound, closeDispatcher, createPinnedDispatcher, ensureMatrixSdkInstalled, findMatrixAccountEntry, formatZonedTimestamp, getMatrixScopedEnvVarNames, hashMatrixAccessToken, isMatrixSdkAvailable, listMatrixEnvAccountIds, requiresExplicitMatrixDefaultAccount, resolveConfiguredMatrixAccountIds, resolveMatrixAccountStorageRoot, resolveMatrixAccountStringValues, resolveMatrixChannelConfig, resolveMatrixCredentialsDir, resolveMatrixCredentialsFilename, resolveMatrixCredentialsPath, resolveMatrixDefaultOrOnlyAccountId, resolveMatrixEnvAccountToken, resolveMatrixHomeserverKey, resolveMatrixLegacyFlatStoragePaths, resolveMatrixLegacyFlatStoreRoot, resolvePinnedHostnameWithPolicy, sanitizeMatrixPathSegment, setMatrixRuntime, setMatrixThreadBindingIdleTimeoutBySessionKey, setMatrixThreadBindingMaxAgeBySessionKey, ssrfPolicyFromAllowPrivateNetwork, ssrfPolicyFromDangerouslyAllowPrivateNetwork, writeJsonFileAtomically };