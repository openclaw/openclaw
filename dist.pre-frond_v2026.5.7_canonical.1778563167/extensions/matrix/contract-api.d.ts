import { i as matrixSetupAdapter, n as matrixOnboardingAdapter, t as createMatrixThreadBindingManager } from "../../thread-bindings-VRrXA6Nx.js";
import { r as resetMatrixThreadBindingsForTests } from "../../thread-bindings-shared-CNjZ7BWN.js";
import { t as setMatrixRuntime } from "../../runtime-CdNKMajV.js";
import { n as normalizeCompatibilityConfig, t as legacyConfigRules } from "../../doctor-contract-DsIEA7Og.js";
import { n as collectRuntimeConfigAssignments, r as secretTargetRegistryEntries } from "../../secret-contract-DprmPpxF.js";

//#region extensions/matrix/src/setup-contract.d.ts
declare const singleAccountKeysToMove: ("deviceId" | "replyToMode" | "avatarUrl" | "groups" | "responsePrefix" | "dm" | "actions" | "mediaMaxMb" | "textChunkLimit" | "chunkMode" | "blockStreaming" | "ackReaction" | "threadReplies" | "threadBindings" | "reactionNotifications" | "allowBots" | "dangerouslyAllowNameMatching" | "autoJoin" | "ackReactionScope" | "initialSyncLimit" | "encryption" | "allowlistOnly" | "startupVerification" | "startupVerificationCooldownHours" | "autoJoinAllowlist" | "rooms")[];
declare const namedAccountPromotionKeys: ("password" | "deviceId" | "name" | "avatarUrl" | "initialSyncLimit" | "encryption" | "homeserver" | "userId" | "accessToken" | "deviceName")[];
declare function resolveSingleAccountPromotionTarget(params: {
  channel: Record<string, unknown>;
}): string;
//#endregion
export { collectRuntimeConfigAssignments, createMatrixThreadBindingManager, legacyConfigRules, matrixSetupAdapter, matrixOnboardingAdapter as matrixSetupWizard, namedAccountPromotionKeys, normalizeCompatibilityConfig, resetMatrixThreadBindingsForTests, resolveSingleAccountPromotionTarget, secretTargetRegistryEntries, setMatrixRuntime, singleAccountKeysToMove };