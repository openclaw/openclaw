import { d as setMatrixThreadBindingIdleTimeoutBySessionKey, n as getMatrixThreadBindingManager, p as setMatrixThreadBindingMaxAgeBySessionKey, s as resetMatrixThreadBindingsForTests } from "../../thread-bindings-shared-DqHSkUdc.js";
import { a as resolveMatrixDefaultOrOnlyAccountId, i as resolveMatrixChannelConfig, n as requiresExplicitMatrixDefaultAccount, r as resolveConfiguredMatrixAccountIds, t as findMatrixAccountEntry } from "../../account-selection-DH-J6xpP.js";
import { n as listMatrixEnvAccountIds, r as resolveMatrixEnvAccountToken, t as getMatrixScopedEnvVarNames } from "../../env-vars-C0ewhPgu.js";
import { a as resolveMatrixCredentialsPath, c as resolveMatrixLegacyFlatStoreRoot, i as resolveMatrixCredentialsFilename, l as sanitizeMatrixPathSegment, n as resolveMatrixAccountStorageRoot, o as resolveMatrixHomeserverKey, r as resolveMatrixCredentialsDir, s as resolveMatrixLegacyFlatStoragePaths, t as hashMatrixAccessToken } from "../../storage-paths-B-nyhNhU.js";
import { t as matrixPlugin } from "../../channel-Cql0NDTP.js";
import { n as matrixSetupAdapter, t as createMatrixSetupWizardProxy } from "../../setup-core-HljLbiEV.js";
import { t as matrixOnboardingAdapter } from "../../setup-surface-B4idWEVz.js";
import { t as createMatrixThreadBindingManager } from "../../thread-bindings-BlR7XL37.js";
//#region extensions/matrix/api.ts
const matrixSessionBindingAdapterChannels = ["matrix"];
//#endregion
export { createMatrixSetupWizardProxy, createMatrixThreadBindingManager, findMatrixAccountEntry, getMatrixScopedEnvVarNames, getMatrixThreadBindingManager, hashMatrixAccessToken, listMatrixEnvAccountIds, matrixOnboardingAdapter, matrixOnboardingAdapter as matrixSetupWizard, matrixPlugin, matrixSessionBindingAdapterChannels, matrixSetupAdapter, requiresExplicitMatrixDefaultAccount, resetMatrixThreadBindingsForTests, resolveConfiguredMatrixAccountIds, resolveMatrixAccountStorageRoot, resolveMatrixChannelConfig, resolveMatrixCredentialsDir, resolveMatrixCredentialsFilename, resolveMatrixCredentialsPath, resolveMatrixDefaultOrOnlyAccountId, resolveMatrixEnvAccountToken, resolveMatrixHomeserverKey, resolveMatrixLegacyFlatStoragePaths, resolveMatrixLegacyFlatStoreRoot, sanitizeMatrixPathSegment, setMatrixThreadBindingIdleTimeoutBySessionKey, setMatrixThreadBindingMaxAgeBySessionKey };
