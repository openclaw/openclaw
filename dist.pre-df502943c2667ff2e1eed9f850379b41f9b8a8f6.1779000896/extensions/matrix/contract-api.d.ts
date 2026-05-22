import { i as matrixSetupAdapter, n as matrixOnboardingAdapter, t as createMatrixThreadBindingManager } from "../../thread-bindings-d2hMrQuC.js";
import { r as resetMatrixThreadBindingsForTests } from "../../thread-bindings-shared-WAAWBiB1.js";
import { t as setMatrixRuntime } from "../../runtime-Bw9s3tIw.js";
import { n as normalizeCompatibilityConfig, t as legacyConfigRules } from "../../doctor-contract-B7aOolxb.js";
import { n as collectRuntimeConfigAssignments, r as secretTargetRegistryEntries } from "../../secret-contract-CkqBa3zw.js";

//#region extensions/matrix/src/setup-contract.d.ts
declare const singleAccountKeysToMove: ("deviceId" | "replyToMode" | "avatarUrl" | "groups" | "responsePrefix" | "dm" | "actions" | "threadReplies" | "textChunkLimit" | "chunkMode" | "mediaMaxMb" | "threadBindings" | "reactionNotifications" | "ackReaction" | "allowBots" | "dangerouslyAllowNameMatching" | "autoJoin" | "ackReactionScope" | "blockStreaming" | "initialSyncLimit" | "encryption" | "allowlistOnly" | "startupVerification" | "startupVerificationCooldownHours" | "autoJoinAllowlist" | "rooms")[];
declare const namedAccountPromotionKeys: ("password" | "deviceId" | "name" | "avatarUrl" | "initialSyncLimit" | "encryption" | "homeserver" | "userId" | "accessToken" | "deviceName")[];
declare function resolveSingleAccountPromotionTarget(params: {
  channel: Record<string, unknown>;
}): string;
//#endregion
export { collectRuntimeConfigAssignments, createMatrixThreadBindingManager, legacyConfigRules, matrixSetupAdapter, matrixOnboardingAdapter as matrixSetupWizard, namedAccountPromotionKeys, normalizeCompatibilityConfig, resetMatrixThreadBindingsForTests, resolveSingleAccountPromotionTarget, secretTargetRegistryEntries, setMatrixRuntime, singleAccountKeysToMove };