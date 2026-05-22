import { d as setMatrixThreadBindingIdleTimeoutBySessionKey, n as getMatrixThreadBindingManager, p as setMatrixThreadBindingMaxAgeBySessionKey, s as resetMatrixThreadBindingsForTests } from "../../thread-bindings-shared-B9cZqSAE.js";
import { a as resolveMatrixDefaultOrOnlyAccountId, i as resolveMatrixChannelConfig, n as requiresExplicitMatrixDefaultAccount, r as resolveConfiguredMatrixAccountIds, t as findMatrixAccountEntry } from "../../account-selection-Bsr13OpT.js";
import { n as listMatrixEnvAccountIds, r as resolveMatrixEnvAccountToken, t as getMatrixScopedEnvVarNames } from "../../env-vars-CtBgJ0Ht.js";
import { a as resolveMatrixCredentialsPath, c as resolveMatrixLegacyFlatStoreRoot, i as resolveMatrixCredentialsFilename, l as sanitizeMatrixPathSegment, n as resolveMatrixAccountStorageRoot, o as resolveMatrixHomeserverKey, r as resolveMatrixCredentialsDir, s as resolveMatrixLegacyFlatStoragePaths, t as hashMatrixAccessToken } from "../../storage-paths-DHq8ICz-.js";
import { t as matrixPlugin } from "../../channel-bLXNMFoE.js";
import { n as matrixSetupAdapter, t as createMatrixSetupWizardProxy } from "../../setup-core-CHhie-Wz.js";
import { t as matrixOnboardingAdapter } from "../../setup-surface-BvgkznuZ.js";
import { t as createMatrixThreadBindingManager } from "../../thread-bindings-BxD-Bx72.js";
//#region extensions/matrix/api.ts
const matrixSessionBindingAdapterChannels = ["matrix"];
//#endregion
export { createMatrixSetupWizardProxy, createMatrixThreadBindingManager, findMatrixAccountEntry, getMatrixScopedEnvVarNames, getMatrixThreadBindingManager, hashMatrixAccessToken, listMatrixEnvAccountIds, matrixOnboardingAdapter, matrixOnboardingAdapter as matrixSetupWizard, matrixPlugin, matrixSessionBindingAdapterChannels, matrixSetupAdapter, requiresExplicitMatrixDefaultAccount, resetMatrixThreadBindingsForTests, resolveConfiguredMatrixAccountIds, resolveMatrixAccountStorageRoot, resolveMatrixChannelConfig, resolveMatrixCredentialsDir, resolveMatrixCredentialsFilename, resolveMatrixCredentialsPath, resolveMatrixDefaultOrOnlyAccountId, resolveMatrixEnvAccountToken, resolveMatrixHomeserverKey, resolveMatrixLegacyFlatStoragePaths, resolveMatrixLegacyFlatStoreRoot, sanitizeMatrixPathSegment, setMatrixThreadBindingIdleTimeoutBySessionKey, setMatrixThreadBindingMaxAgeBySessionKey };
