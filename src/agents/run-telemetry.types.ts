export type AgentRunTimeoutPhase =
  | "queue_timeout"
  | "preflight_timeout"
  | "provider_timeout"
  | "post_turn_timeout"
  | "gateway_draining";

export type AgentRunLifecyclePhase =
  | "accepted"
  | "preflight"
  | "provider"
  | "post_turn"
  | "completed"
  | "error"
  | "gateway_draining";

export type AgentRunPhaseTimings = {
  acceptedToStartMs?: number;
  sessionQueueWaitMs?: number;
  globalQueueWaitMs?: number;
  sessionLockWaitMs?: number;
  preflightMs?: number;
  providerElapsedMs?: number;
  providerFirstTokenMs?: number;
  postTurnMs?: number;
};
