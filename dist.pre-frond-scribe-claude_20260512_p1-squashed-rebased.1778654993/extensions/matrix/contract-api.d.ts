import { i as matrixSetupAdapter, n as matrixOnboardingAdapter, t as createMatrixThreadBindingManager } from "../../thread-bindings-D8bTg-Cu.js";
import { r as resetMatrixThreadBindingsForTests } from "../../thread-bindings-shared-DZuTQhgY.js";
import { t as setMatrixRuntime } from "../../runtime-DiWz2Op9.js";
import { n as normalizeCompatibilityConfig, t as legacyConfigRules } from "../../doctor-contract-DvZVCOIE.js";
import { n as collectRuntimeConfigAssignments, r as secretTargetRegistryEntries } from "../../secret-contract-eBV-BUtz.js";

//#region extensions/matrix/src/setup-contract.d.ts
declare const singleAccountKeysToMove: ("deviceId" | "replyToMode" | "avatarUrl" | "groups" | "dm" | "responsePrefix" | "actions" | "mediaMaxMb" | "ackReaction" | "ackReactionScope" | "threadBindings" | "textChunkLimit" | "chunkMode" | "blockStreaming" | "threadReplies" | "reactionNotifications" | "allowBots" | "dangerouslyAllowNameMatching" | "autoJoin" | "initialSyncLimit" | "encryption" | "allowlistOnly" | "startupVerification" | "startupVerificationCooldownHours" | "autoJoinAllowlist" | "rooms")[];
declare const namedAccountPromotionKeys: ("password" | "deviceId" | "name" | "avatarUrl" | "initialSyncLimit" | "encryption" | "homeserver" | "userId" | "accessToken" | "deviceName")[];
declare function resolveSingleAccountPromotionTarget(params: {
  channel: Record<string, unknown>;
}): string;
//#endregion
export { collectRuntimeConfigAssignments, createMatrixThreadBindingManager, legacyConfigRules, matrixSetupAdapter, matrixOnboardingAdapter as matrixSetupWizard, namedAccountPromotionKeys, normalizeCompatibilityConfig, resetMatrixThreadBindingsForTests, resolveSingleAccountPromotionTarget, secretTargetRegistryEntries, setMatrixRuntime, singleAccountKeysToMove };