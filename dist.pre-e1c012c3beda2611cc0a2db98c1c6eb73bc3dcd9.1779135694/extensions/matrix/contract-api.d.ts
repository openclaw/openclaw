import { i as matrixSetupAdapter, n as matrixOnboardingAdapter, t as createMatrixThreadBindingManager } from "../../thread-bindings-C0Xl8y1D.js";
import { r as resetMatrixThreadBindingsForTests } from "../../thread-bindings-shared-BNs5qDcb.js";
import { t as setMatrixRuntime } from "../../runtime-CdO3ErNO.js";
import { n as normalizeCompatibilityConfig, t as legacyConfigRules } from "../../doctor-contract-CuZL0f-v.js";
import { n as collectRuntimeConfigAssignments, r as secretTargetRegistryEntries } from "../../secret-contract-fch84AqJ.js";

//#region extensions/matrix/src/setup-contract.d.ts
declare const singleAccountKeysToMove: ("deviceId" | "replyToMode" | "avatarUrl" | "groups" | "dm" | "responsePrefix" | "mediaMaxMb" | "actions" | "ackReaction" | "ackReactionScope" | "threadBindings" | "allowBots" | "dangerouslyAllowNameMatching" | "textChunkLimit" | "chunkMode" | "blockStreaming" | "initialSyncLimit" | "encryption" | "allowlistOnly" | "threadReplies" | "reactionNotifications" | "startupVerification" | "startupVerificationCooldownHours" | "autoJoin" | "autoJoinAllowlist" | "rooms")[];
declare const namedAccountPromotionKeys: ("password" | "deviceId" | "name" | "avatarUrl" | "initialSyncLimit" | "encryption" | "homeserver" | "userId" | "accessToken" | "deviceName")[];
declare function resolveSingleAccountPromotionTarget(params: {
  channel: Record<string, unknown>;
}): string;
//#endregion
export { collectRuntimeConfigAssignments, createMatrixThreadBindingManager, legacyConfigRules, matrixSetupAdapter, matrixOnboardingAdapter as matrixSetupWizard, namedAccountPromotionKeys, normalizeCompatibilityConfig, resetMatrixThreadBindingsForTests, resolveSingleAccountPromotionTarget, secretTargetRegistryEntries, setMatrixRuntime, singleAccountKeysToMove };