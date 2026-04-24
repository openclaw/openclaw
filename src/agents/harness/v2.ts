import type {
  AgentHarness,
  AgentHarnessAttemptParams,
  AgentHarnessAttemptResult,
  AgentHarnessCompactParams,
  AgentHarnessCompactResult,
  AgentHarnessResetParams,
  AgentHarnessResultClassification,
  AgentHarnessSupport,
  AgentHarnessSupportContext,
} from "./types.js";

export type AgentHarnessV2PreparedRun = {
  harnessId: string;
  label: string;
  pluginId?: string;
  params: AgentHarnessAttemptParams;
};

export type AgentHarnessV2Session = {
  harnessId: string;
  label: string;
  pluginId?: string;
  params: AgentHarnessAttemptParams;
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
  const compact = harness.compact;
  const reset = harness.reset;
  const dispose = harness.dispose;
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
    }),
    start: async (prepared) => ({
      harnessId: prepared.harnessId,
      label: prepared.label,
      pluginId: prepared.pluginId,
      params: prepared.params,
    }),
    resume: async (session) => session,
    send: async (session) => harness.runAttempt(session.params),
    resolveOutcome: async (session, result) =>
      applyAgentHarnessV2Classification(harness, result, session.params),
    cleanup: async () => {},
    compact: compact ? (params) => compact(params) : undefined,
    reset: reset ? (params) => reset(params) : undefined,
    dispose: dispose ? () => dispose() : undefined,
  };
}

export function applyAgentHarnessV2Classification(
  harness: Pick<AgentHarness, "id" | "classify">,
  result: AgentHarnessAttemptResult,
  params: AgentHarnessAttemptParams,
): AgentHarnessAttemptResult {
  const classification = harness.classify?.(result, params);
  if (!classification || classification === "ok") {
    return { ...result, agentHarnessId: harness.id };
  }
  return {
    ...result,
    agentHarnessId: harness.id,
    agentHarnessResultClassification: classification as Exclude<
      AgentHarnessResultClassification,
      "ok"
    >,
  };
}
