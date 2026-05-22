import { i as matrixSetupAdapter, n as matrixOnboardingAdapter, t as createMatrixThreadBindingManager } from "../../thread-bindings-CQ5k1rma.js";
import { r as resetMatrixThreadBindingsForTests } from "../../thread-bindings-shared-DuybVNdD.js";
import { t as setMatrixRuntime } from "../../runtime-D5QOmYgh.js";
import { n as normalizeCompatibilityConfig, t as legacyConfigRules } from "../../doctor-contract-CVWZVIFi.js";
import { n as collectRuntimeConfigAssignments, r as secretTargetRegistryEntries } from "../../secret-contract-JBReekJV.js";

//#region extensions/matrix/src/setup-contract.d.ts
declare const singleAccountKeysToMove: ("deviceId" | "replyToMode" | "avatarUrl" | "groups" | "dm" | "responsePrefix" | "mediaMaxMb" | "actions" | "ackReaction" | "ackReactionScope" | "threadBindings" | "threadReplies" | "textChunkLimit" | "chunkMode" | "reactionNotifications" | "allowBots" | "dangerouslyAllowNameMatching" | "autoJoin" | "blockStreaming" | "initialSyncLimit" | "encryption" | "allowlistOnly" | "startupVerification" | "startupVerificationCooldownHours" | "autoJoinAllowlist" | "rooms")[];
declare const namedAccountPromotionKeys: ("password" | "deviceId" | "name" | "avatarUrl" | "homeserver" | "userId" | "accessToken" | "deviceName" | "initialSyncLimit" | "encryption")[];
declare function resolveSingleAccountPromotionTarget(params: {
  channel: Record<string, unknown>;
}): string;
//#endregion
export { collectRuntimeConfigAssignments, createMatrixThreadBindingManager, legacyConfigRules, matrixSetupAdapter, matrixOnboardingAdapter as matrixSetupWizard, namedAccountPromotionKeys, normalizeCompatibilityConfig, resetMatrixThreadBindingsForTests, resolveSingleAccountPromotionTarget, secretTargetRegistryEntries, setMatrixRuntime, singleAccountKeysToMove };