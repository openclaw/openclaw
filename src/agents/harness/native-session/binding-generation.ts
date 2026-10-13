import type { OpenClawConfig } from "../../../config/types.openclaw.js";

type NativeSessionGenerationTarget = {
  agentId: string;
  sessionId: string;
  sessionKey?: string;
};

export type NativeSessionGenerationParams = {
  target: NativeSessionGenerationTarget;
  config?: OpenClawConfig;
  storePath?: string;
  assertCurrent?: () => void;
  createSupersededError: (sessionId: string) => Error;
};

export type NativeSessionGenerationReclaimPlan =
  | { kind: "resolved"; result: boolean }
  | { kind: "verify"; expectedPreviousSessionId: string };

export type NativeSessionGenerationAdoptionResult = "absent" | "current" | "adopted" | "conflict";
