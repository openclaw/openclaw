import { i as matrixSetupAdapter, n as matrixOnboardingAdapter, t as createMatrixThreadBindingManager } from "../../thread-bindings-BuuLeaXh.js";
import { r as resetMatrixThreadBindingsForTests } from "../../thread-bindings-shared-CzPlIrlF.js";
import { t as setMatrixRuntime } from "../../runtime-BnF0ajYI.js";
import { n as normalizeCompatibilityConfig, t as legacyConfigRules } from "../../doctor-contract-DpcsyBC2.js";
import { n as collectRuntimeConfigAssignments, r as secretTargetRegistryEntries } from "../../secret-contract-GanrBnf9.js";

//#region extensions/matrix/src/setup-contract.d.ts
declare const singleAccountKeysToMove: ("dm" | "deviceId" | "replyToMode" | "avatarUrl" | "groups" | "responsePrefix" | "mediaMaxMb" | "actions" | "ackReaction" | "ackReactionScope" | "threadBindings" | "threadReplies" | "textChunkLimit" | "chunkMode" | "reactionNotifications" | "allowBots" | "dangerouslyAllowNameMatching" | "autoJoin" | "blockStreaming" | "initialSyncLimit" | "encryption" | "allowlistOnly" | "startupVerification" | "startupVerificationCooldownHours" | "autoJoinAllowlist" | "rooms")[];
declare const namedAccountPromotionKeys: ("password" | "deviceId" | "name" | "avatarUrl" | "initialSyncLimit" | "encryption" | "homeserver" | "userId" | "accessToken" | "deviceName")[];
declare function resolveSingleAccountPromotionTarget(params: {
  channel: Record<string, unknown>;
}): string;
//#endregion
export { collectRuntimeConfigAssignments, createMatrixThreadBindingManager, legacyConfigRules, matrixSetupAdapter, matrixOnboardingAdapter as matrixSetupWizard, namedAccountPromotionKeys, normalizeCompatibilityConfig, resetMatrixThreadBindingsForTests, resolveSingleAccountPromotionTarget, secretTargetRegistryEntries, setMatrixRuntime, singleAccountKeysToMove };