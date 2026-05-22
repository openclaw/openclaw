import { i as matrixSetupAdapter, n as matrixOnboardingAdapter, t as createMatrixThreadBindingManager } from "../../thread-bindings-DBHEU3UY.js";
import { r as resetMatrixThreadBindingsForTests } from "../../thread-bindings-shared-Ba2tK3ax.js";
import { t as setMatrixRuntime } from "../../runtime-BZMCOUlf.js";
import { n as normalizeCompatibilityConfig, t as legacyConfigRules } from "../../doctor-contract-Cx14CdtW.js";
import { n as collectRuntimeConfigAssignments, r as secretTargetRegistryEntries } from "../../secret-contract-LbWiQK6b.js";

//#region extensions/matrix/src/setup-contract.d.ts
declare const singleAccountKeysToMove: ("deviceId" | "replyToMode" | "avatarUrl" | "groups" | "responsePrefix" | "dm" | "mediaMaxMb" | "actions" | "ackReaction" | "ackReactionScope" | "threadBindings" | "textChunkLimit" | "chunkMode" | "blockStreaming" | "reactionNotifications" | "initialSyncLimit" | "allowBots" | "dangerouslyAllowNameMatching" | "threadReplies" | "autoJoin" | "encryption" | "allowlistOnly" | "startupVerification" | "startupVerificationCooldownHours" | "autoJoinAllowlist" | "rooms")[];
declare const namedAccountPromotionKeys: ("password" | "deviceId" | "name" | "avatarUrl" | "homeserver" | "userId" | "accessToken" | "deviceName" | "initialSyncLimit" | "encryption")[];
declare function resolveSingleAccountPromotionTarget(params: {
  channel: Record<string, unknown>;
}): string;
//#endregion
export { collectRuntimeConfigAssignments, createMatrixThreadBindingManager, legacyConfigRules, matrixSetupAdapter, matrixOnboardingAdapter as matrixSetupWizard, namedAccountPromotionKeys, normalizeCompatibilityConfig, resetMatrixThreadBindingsForTests, resolveSingleAccountPromotionTarget, secretTargetRegistryEntries, setMatrixRuntime, singleAccountKeysToMove };