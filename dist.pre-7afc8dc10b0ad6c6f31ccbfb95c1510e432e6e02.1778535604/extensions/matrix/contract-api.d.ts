import { i as matrixSetupAdapter, n as matrixOnboardingAdapter, t as createMatrixThreadBindingManager } from "../../thread-bindings-BCClV9at.js";
import { r as resetMatrixThreadBindingsForTests } from "../../thread-bindings-shared-BdyfeyRv.js";
import { t as setMatrixRuntime } from "../../runtime-5HRoaiKA.js";
import { n as normalizeCompatibilityConfig, t as legacyConfigRules } from "../../doctor-contract-B4lR9d38.js";
import { n as collectRuntimeConfigAssignments, r as secretTargetRegistryEntries } from "../../secret-contract-CsMvpx9R.js";

//#region extensions/matrix/src/setup-contract.d.ts
declare const singleAccountKeysToMove: ("dm" | "responsePrefix" | "deviceId" | "replyToMode" | "avatarUrl" | "groups" | "mediaMaxMb" | "textChunkLimit" | "chunkMode" | "blockStreaming" | "ackReaction" | "actions" | "threadReplies" | "threadBindings" | "reactionNotifications" | "allowBots" | "autoJoin" | "ackReactionScope" | "initialSyncLimit" | "encryption" | "allowlistOnly" | "startupVerification" | "startupVerificationCooldownHours" | "autoJoinAllowlist" | "rooms")[];
declare const namedAccountPromotionKeys: ("name" | "password" | "deviceId" | "avatarUrl" | "homeserver" | "userId" | "accessToken" | "deviceName" | "initialSyncLimit" | "encryption")[];
declare function resolveSingleAccountPromotionTarget(params: {
  channel: Record<string, unknown>;
}): string;
//#endregion
export { collectRuntimeConfigAssignments, createMatrixThreadBindingManager, legacyConfigRules, matrixSetupAdapter, matrixOnboardingAdapter as matrixSetupWizard, namedAccountPromotionKeys, normalizeCompatibilityConfig, resetMatrixThreadBindingsForTests, resolveSingleAccountPromotionTarget, secretTargetRegistryEntries, setMatrixRuntime, singleAccountKeysToMove };