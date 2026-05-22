import { i as matrixSetupAdapter, n as matrixOnboardingAdapter, t as createMatrixThreadBindingManager } from "../../thread-bindings-Wzs3Rj_2.js";
import { r as resetMatrixThreadBindingsForTests } from "../../thread-bindings-shared-Ddk3opvy.js";
import { t as setMatrixRuntime } from "../../runtime-BYm8aLr3.js";
import { n as normalizeCompatibilityConfig, t as legacyConfigRules } from "../../doctor-contract-Da2qcNAd.js";
import { n as collectRuntimeConfigAssignments, r as secretTargetRegistryEntries } from "../../secret-contract-dNhyUOaa.js";

//#region extensions/matrix/src/setup-contract.d.ts
declare const singleAccountKeysToMove: ("deviceId" | "replyToMode" | "avatarUrl" | "groups" | "responsePrefix" | "dm" | "actions" | "textChunkLimit" | "allowBots" | "dangerouslyAllowNameMatching" | "chunkMode" | "blockStreaming" | "mediaMaxMb" | "ackReaction" | "ackReactionScope" | "threadBindings" | "reactionNotifications" | "threadReplies" | "autoJoin" | "initialSyncLimit" | "encryption" | "allowlistOnly" | "startupVerification" | "startupVerificationCooldownHours" | "autoJoinAllowlist" | "rooms")[];
declare const namedAccountPromotionKeys: ("password" | "deviceId" | "name" | "avatarUrl" | "initialSyncLimit" | "encryption" | "homeserver" | "userId" | "accessToken" | "deviceName")[];
declare function resolveSingleAccountPromotionTarget(params: {
  channel: Record<string, unknown>;
}): string;
//#endregion
export { collectRuntimeConfigAssignments, createMatrixThreadBindingManager, legacyConfigRules, matrixSetupAdapter, matrixOnboardingAdapter as matrixSetupWizard, namedAccountPromotionKeys, normalizeCompatibilityConfig, resetMatrixThreadBindingsForTests, resolveSingleAccountPromotionTarget, secretTargetRegistryEntries, setMatrixRuntime, singleAccountKeysToMove };