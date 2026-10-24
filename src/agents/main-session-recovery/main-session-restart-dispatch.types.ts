import type { InternalSessionEntry as SessionEntry } from "../../config/sessions.js";
import type { SessionSourceAssertion } from "../../config/sessions/session-source-authority.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { GatewayRecoveryRuntime } from "../../gateway/server-instance-runtime.types.js";
import type { CommandLane } from "../../process/lanes.js";
import type { SessionControllerInput } from "../../sessions/session-controller.mailbox.js";
import type { MainSessionRecoveryObservation } from "./main-session-recovery-state.js";
import type { MainSessionRecoverySkipReason } from "./main-session-restart-recovery-diagnostics.js";
import type {
  ExpectedRestartRecoveryTarget,
  ExhaustedRestartRecoveryTarget,
} from "./main-session-restart-recovery-shared.js";

export type ResumeMainSessionParams = {
  agentId: string;
  canonicalSessionKey?: string;
  cfg?: OpenClawConfig;
  controllerInput?: SessionControllerInput;
  lane?: CommandLane.Main | CommandLane.RestartRecovery;
  entry: SessionEntry;
  observation: MainSessionRecoveryObservation;
  completionSource?: SessionSourceAssertion;
  executionSource?: SessionSourceAssertion;
  releaseCompletionSource?: () => void;
  recoveryAttempt: number;
  storePath: string;
  sessionKey: string;
  pendingFinalDeliveryText?: string | null;
  forceRestartSafeTools?: boolean;
  forceCodeModeTools?: boolean;
  signal?: AbortSignal;
  lifecycleGeneration?: string;
  shouldContinue?: () => boolean;
  gatewayRuntime: GatewayRecoveryRuntime;
};

export type RecoverMainSessionStoreParams = {
  storeAgentId?: string;
  preparedEntries?: readonly { sessionKey: string; entry: SessionEntry }[];
  cfg?: OpenClawConfig;
  controllerInput?: SessionControllerInput;
  lane?: CommandLane.Main | CommandLane.RestartRecovery;
  observationOnly?: boolean;
  onExhaustedTarget?: (target: ExhaustedRestartRecoveryTarget) => void;
  onSkipped?: (reason: MainSessionRecoverySkipReason) => void;
  onPreparationPending?: (target: ExhaustedRestartRecoveryTarget) => void;
  passId?: string;
  storePath: string;
  stateDir?: string;
  handledSessionKeys: Set<string>;
  expectedTarget?: ExpectedRestartRecoveryTarget;
  lifecycleGeneration?: string;
  shouldContinue?: () => boolean;
  signal?: AbortSignal;
  gatewayRuntime: GatewayRecoveryRuntime;
};
