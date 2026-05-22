import { i as OpenClawConfig } from "../../types.openclaw-BdZr8Ncl.js";
import { l as closeDispatcher, o as SsrFPolicy, t as LookupFn, u as createPinnedDispatcher, x as resolvePinnedHostnameWithPolicy } from "../../ssrf-qTfRSneg.js";
import { s as RuntimeLogger } from "../../types-core-0qSk-WYG.js";
import { n as RuntimeEnv } from "../../runtime-DRy59NVK.js";
import { i as WizardPrompter } from "../../prompts-1-9JQ3ae.js";
import { b as ChannelMessageActionContext, u as ChannelDirectoryEntry } from "../../types.core-D5GEzFhB.js";
import { n as PluginRuntime } from "../../types-4PahHl43.js";
import { n as formatZonedTimestamp } from "../../format-datetime-5dhYrjFn.js";
import { d as ssrfPolicyFromAllowPrivateNetwork, f as ssrfPolicyFromDangerouslyAllowPrivateNetwork, n as assertHttpUrlTargetsPrivateNetwork } from "../../ssrf-policy-NW1NCo6p.js";
import { i as writeJsonFileAtomically } from "../../json-store-BgfKgRWO.js";
import { _ as resolveMatrixDefaultOrOnlyAccountId, a as resolveMatrixCredentialsPath, c as resolveMatrixLegacyFlatStoreRoot, d as listMatrixEnvAccountIds, f as resolveMatrixEnvAccountToken, g as resolveMatrixChannelConfig, h as resolveConfiguredMatrixAccountIds, i as resolveMatrixCredentialsFilename, l as sanitizeMatrixPathSegment, m as requiresExplicitMatrixDefaultAccount, n as resolveMatrixAccountStorageRoot, o as resolveMatrixHomeserverKey, p as findMatrixAccountEntry, r as resolveMatrixCredentialsDir, s as resolveMatrixLegacyFlatStoragePaths, t as hashMatrixAccessToken, u as getMatrixScopedEnvVarNames } from "../../storage-paths-CpUNt1l7.js";
import { a as setMatrixThreadBindingMaxAgeBySessionKey, i as setMatrixThreadBindingIdleTimeoutBySessionKey } from "../../thread-bindings-shared-CzPlIrlF.js";
import { t as setMatrixRuntime } from "../../runtime-BnF0ajYI.js";

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