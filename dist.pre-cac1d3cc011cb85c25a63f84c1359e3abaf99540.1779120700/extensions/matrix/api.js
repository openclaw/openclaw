import { d as setMatrixThreadBindingIdleTimeoutBySessionKey, n as getMatrixThreadBindingManager, p as setMatrixThreadBindingMaxAgeBySessionKey, s as resetMatrixThreadBindingsForTests } from "../../thread-bindings-shared-D1u8zFKl.js";
import { a as resolveMatrixDefaultOrOnlyAccountId, i as resolveMatrixChannelConfig, n as requiresExplicitMatrixDefaultAccount, r as resolveConfiguredMatrixAccountIds, t as findMatrixAccountEntry } from "../../account-selection-BHwRurY9.js";
import { n as listMatrixEnvAccountIds, r as resolveMatrixEnvAccountToken, t as getMatrixScopedEnvVarNames } from "../../env-vars-ClImwAjD.js";
import { a as resolveMatrixCredentialsPath, c as resolveMatrixLegacyFlatStoreRoot, i as resolveMatrixCredentialsFilename, l as sanitizeMatrixPathSegment, n as resolveMatrixAccountStorageRoot, o as resolveMatrixHomeserverKey, r as resolveMatrixCredentialsDir, s as resolveMatrixLegacyFlatStoragePaths, t as hashMatrixAccessToken } from "../../storage-paths-BR9nSh8U.js";
import { t as matrixPlugin } from "../../channel-CP03nrgC.js";
import { n as matrixSetupAdapter, t as createMatrixSetupWizardProxy } from "../../setup-core-BeFQ54YB.js";
import { t as matrixOnboardingAdapter } from "../../setup-surface-s0cTgCPG.js";
import { t as createMatrixThreadBindingManager } from "../../thread-bindings-BNLyoy9g.js";
//#region extensions/matrix/api.ts
const matrixSessionBindingAdapterChannels = ["matrix"];
//#endregion
export { createMatrixSetupWizardProxy, createMatrixThreadBindingManager, findMatrixAccountEntry, getMatrixScopedEnvVarNames, getMatrixThreadBindingManager, hashMatrixAccessToken, listMatrixEnvAccountIds, matrixOnboardingAdapter, matrixOnboardingAdapter as matrixSetupWizard, matrixPlugin, matrixSessionBindingAdapterChannels, matrixSetupAdapter, requiresExplicitMatrixDefaultAccount, resetMatrixThreadBindingsForTests, resolveConfiguredMatrixAccountIds, resolveMatrixAccountStorageRoot, resolveMatrixChannelConfig, resolveMatrixCredentialsDir, resolveMatrixCredentialsFilename, resolveMatrixCredentialsPath, resolveMatrixDefaultOrOnlyAccountId, resolveMatrixEnvAccountToken, resolveMatrixHomeserverKey, resolveMatrixLegacyFlatStoragePaths, resolveMatrixLegacyFlatStoreRoot, sanitizeMatrixPathSegment, setMatrixThreadBindingIdleTimeoutBySessionKey, setMatrixThreadBindingMaxAgeBySessionKey };
