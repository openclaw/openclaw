import { i as matrixSetupAdapter, n as matrixOnboardingAdapter, t as createMatrixThreadBindingManager } from "../../thread-bindings-CBNMrKag.js";
import { r as resetMatrixThreadBindingsForTests } from "../../thread-bindings-shared-BNs5qDcb.js";
import { t as setMatrixRuntime } from "../../runtime-DPBsBnBD.js";
import { n as normalizeCompatibilityConfig, t as legacyConfigRules } from "../../doctor-contract-8js-DqiV.js";
import { n as collectRuntimeConfigAssignments, r as secretTargetRegistryEntries } from "../../secret-contract-mv-Uyj5-.js";

//#region extensions/matrix/src/setup-contract.d.ts
declare const singleAccountKeysToMove: ("dm" | "responsePrefix" | "deviceId" | "replyToMode" | "avatarUrl" | "groups" | "threadReplies" | "textChunkLimit" | "chunkMode" | "mediaMaxMb" | "actions" | "threadBindings" | "reactionNotifications" | "ackReaction" | "allowBots" | "autoJoin" | "ackReactionScope" | "blockStreaming" | "initialSyncLimit" | "encryption" | "allowlistOnly" | "startupVerification" | "startupVerificationCooldownHours" | "autoJoinAllowlist" | "rooms")[];
declare const namedAccountPromotionKeys: ("name" | "password" | "deviceId" | "avatarUrl" | "initialSyncLimit" | "encryption" | "homeserver" | "userId" | "accessToken" | "deviceName")[];
declare function resolveSingleAccountPromotionTarget(params: {
  channel: Record<string, unknown>;
}): string;
//#endregion
export { collectRuntimeConfigAssignments, createMatrixThreadBindingManager, legacyConfigRules, matrixSetupAdapter, matrixOnboardingAdapter as matrixSetupWizard, namedAccountPromotionKeys, normalizeCompatibilityConfig, resetMatrixThreadBindingsForTests, resolveSingleAccountPromotionTarget, secretTargetRegistryEntries, setMatrixRuntime, singleAccountKeysToMove };