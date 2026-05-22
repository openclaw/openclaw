import { i as matrixSetupAdapter, n as matrixOnboardingAdapter, t as createMatrixThreadBindingManager } from "../../thread-bindings-B7p3jXbw.js";
import { r as resetMatrixThreadBindingsForTests } from "../../thread-bindings-shared-mlZOBF9S.js";
import { t as setMatrixRuntime } from "../../runtime-Bxdo003K.js";
import { n as normalizeCompatibilityConfig, t as legacyConfigRules } from "../../doctor-contract-9cX3Q8cO.js";
import { n as collectRuntimeConfigAssignments, r as secretTargetRegistryEntries } from "../../secret-contract-Cb4ID2lf.js";

//#region extensions/matrix/src/setup-contract.d.ts
declare const singleAccountKeysToMove: ("deviceId" | "replyToMode" | "avatarUrl" | "groups" | "dm" | "responsePrefix" | "actions" | "threadReplies" | "textChunkLimit" | "chunkMode" | "mediaMaxMb" | "threadBindings" | "reactionNotifications" | "ackReaction" | "allowBots" | "dangerouslyAllowNameMatching" | "autoJoin" | "ackReactionScope" | "blockStreaming" | "initialSyncLimit" | "encryption" | "allowlistOnly" | "startupVerification" | "startupVerificationCooldownHours" | "autoJoinAllowlist" | "rooms")[];
declare const namedAccountPromotionKeys: ("password" | "deviceId" | "name" | "avatarUrl" | "initialSyncLimit" | "encryption" | "homeserver" | "userId" | "accessToken" | "deviceName")[];
declare function resolveSingleAccountPromotionTarget(params: {
  channel: Record<string, unknown>;
}): string;
//#endregion
export { collectRuntimeConfigAssignments, createMatrixThreadBindingManager, legacyConfigRules, matrixSetupAdapter, matrixOnboardingAdapter as matrixSetupWizard, namedAccountPromotionKeys, normalizeCompatibilityConfig, resetMatrixThreadBindingsForTests, resolveSingleAccountPromotionTarget, secretTargetRegistryEntries, setMatrixRuntime, singleAccountKeysToMove };