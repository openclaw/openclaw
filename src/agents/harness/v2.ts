import { applyAgentHarnessResultClassification } from "./result-classification.js";
import type {
  AgentHarness,
  AgentHarnessAttemptParams,
  AgentHarnessAttemptResult,
  AgentHarnessCompactParams,
  AgentHarnessCompactResult,
  AgentHarnessResetParams,
  AgentHarnessSupport,
  AgentHarnessSupportContext,
} from "./types.js";

type AgentHarnessV2RunBase = {
  harnessId: string;
  label: string;
  pluginId?: string;
  params: AgentHarnessAttemptParams;
};

export type AgentHarnessV2PreparedRun = AgentHarnessV2RunBase & {
  lifecycleState: "prepared";
};

export type AgentHarnessV2Session = AgentHarnessV2RunBase & {
  lifecycleState: "started";
};

export type AgentHarnessV2ToolCall = {
  id?: string;
  name: string;
  input?: unknown;
};

export type AgentHarnessV2CleanupParams = {
  session: AgentHarnessV2Session;
  result?: AgentHarnessAttemptResult;
  error?: unknown;
};

export type AgentHarnessV2 = {
  id: string;
  label: string;
  pluginId?: string;
  supports(ctx: AgentHarnessSupportContext): AgentHarnessSupport;
  prepare(params: AgentHarnessAttemptParams): Promise<AgentHarnessV2PreparedRun>;
  start(prepared: AgentHarnessV2PreparedRun): Promise<AgentHarnessV2Session>;
  resume?(session: AgentHarnessV2Session): Promise<AgentHarnessV2Session>;
  send(session: AgentHarnessV2Session): Promise<AgentHarnessAttemptResult>;
  handleToolCall?(session: AgentHarnessV2Session, call: AgentHarnessV2ToolCall): Promise<unknown>;
  resolveOutcome(
    session: AgentHarnessV2Session,
    result: AgentHarnessAttemptResult,
  ): Promise<AgentHarnessAttemptResult>;
  cleanup(params: AgentHarnessV2CleanupParams): Promise<void>;
  compact?(params: AgentHarnessCompactParams): Promise<AgentHarnessCompactResult | undefined>;
  reset?(params: AgentHarnessResetParams): Promise<void> | void;
  dispose?(): Promise<void> | void;
};

export function adaptAgentHarnessToV2(harness: AgentHarness): AgentHarnessV2 {
  return {
    id: harness.id,
    label: harness.label,
    pluginId: harness.pluginId,
    supports: (ctx) => harness.supports(ctx),
    prepare: async (params) => ({
      harnessId: harness.id,
      label: harness.label,
      pluginId: harness.pluginId,
      params,
      lifecycleState: "prepared",
    }),
    start: async (prepared) => ({
      harnessId: prepared.harnessId,
      label: prepared.label,
      pluginId: prepared.pluginId,
      params: prepared.params,
      lifecycleState: "started",
    }),
    resume: async (session) => session,
    send: async (session) => harness.runAttempt(session.params),
    resolveOutcome: async (session, result) =>
      applyAgentHarnessResultClassification(harness, result, session.params),
    cleanup: async (_params) => {
      // V1 harnesses have no per-attempt cleanup hook. Global cleanup remains
      // on dispose(), which must not run after every attempt.
    },
    compact: harness.compact ? (params) => harness.compact!(params) : undefined,
    reset: harness.reset ? (params) => harness.reset!(params) : undefined,
    dispose: harness.dispose ? () => harness.dispose!() : undefined,
  };
}
