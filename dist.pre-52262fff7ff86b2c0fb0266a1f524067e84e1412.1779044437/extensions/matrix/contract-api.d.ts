import { i as matrixSetupAdapter, n as matrixOnboardingAdapter, t as createMatrixThreadBindingManager } from "../../thread-bindings-CoYL-nD2.js";
import { r as resetMatrixThreadBindingsForTests } from "../../thread-bindings-shared-DEpfx1Kj.js";
import { t as setMatrixRuntime } from "../../runtime-Cn1H46fj.js";
import { n as normalizeCompatibilityConfig, t as legacyConfigRules } from "../../doctor-contract-B29Z8iUs.js";
import { n as collectRuntimeConfigAssignments, r as secretTargetRegistryEntries } from "../../secret-contract-DZ9oqySI.js";

//#region extensions/matrix/src/setup-contract.d.ts
declare const singleAccountKeysToMove: ("deviceId" | "replyToMode" | "avatarUrl" | "groups" | "dm" | "responsePrefix" | "dangerouslyAllowNameMatching" | "textChunkLimit" | "chunkMode" | "blockStreaming" | "mediaMaxMb" | "allowBots" | "actions" | "ackReaction" | "ackReactionScope" | "threadBindings" | "threadReplies" | "reactionNotifications" | "autoJoin" | "initialSyncLimit" | "encryption" | "allowlistOnly" | "startupVerification" | "startupVerificationCooldownHours" | "autoJoinAllowlist" | "rooms")[];
declare const namedAccountPromotionKeys: ("password" | "deviceId" | "name" | "avatarUrl" | "initialSyncLimit" | "encryption" | "homeserver" | "userId" | "accessToken" | "deviceName")[];
declare function resolveSingleAccountPromotionTarget(params: {
  channel: Record<string, unknown>;
}): string;
//#endregion
export { collectRuntimeConfigAssignments, createMatrixThreadBindingManager, legacyConfigRules, matrixSetupAdapter, matrixOnboardingAdapter as matrixSetupWizard, namedAccountPromotionKeys, normalizeCompatibilityConfig, resetMatrixThreadBindingsForTests, resolveSingleAccountPromotionTarget, secretTargetRegistryEntries, setMatrixRuntime, singleAccountKeysToMove };