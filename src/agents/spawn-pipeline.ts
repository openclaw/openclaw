import type { SubagentLifecycleHookRunner } from "../plugins/hooks.js";
import { registerSubagentRun } from "./subagents/registry/subagent-registry.js";
import type { SubagentRegistrationScope } from "./subagents/registry/subagent-registry.types.js";

type SpawnPipelinePhase = "initialize" | "dispatch" | "register";

export type SpawnBackendAdapter<TState> = {
  initialize(): Promise<TState>;
  dispatchTurn(state: TState): Promise<{ runId: string }>;
  cleanupOnFailure(params: {
    phase: SpawnPipelinePhase;
    state?: TState;
    error: unknown;
    registrationScope?: SubagentRegistrationScope;
  }): Promise<void>;
};

type RegisterSubagentRunInput = Parameters<typeof registerSubagentRun>[0];

type SpawnProgressOrigin = {
  channel?: string;
  accountId?: string;
  to?: string;
  threadId?: string | number;
  channelId?: string;
  messageId?: string | number;
};

type SpawnPipelineResult<TState> =
  | { ok: true; state: TState; runId: string; registrationScope?: SubagentRegistrationScope }
  | {
      ok: false;
      phase: SpawnPipelinePhase;
      error: unknown;
      state?: TState;
      runId?: string;
    };

export function summarizeSpawnError(error: unknown): string {
  return error instanceof Error ? error.message : typeof error === "string" ? error : "error";
}

type SpawnPipelineParams<TState> = {
  adapter: SpawnBackendAdapter<TState>;
  assertActive?: () => void;
  admissionReservation?: { release: () => void };
  buildRegistration: (state: TState, runId: string) => RegisterSubagentRunInput;
  hookRunner?: SubagentLifecycleHookRunner | null;
  progressOrigin?: SpawnProgressOrigin;
  /** Session key the started-progress hook fires against. Backends differ on
      purpose: native passes the controller-side requester key, ACP its
      historical completion-owner key; do not collapse them. */
  progressSessionKey: string;
};

export async function runSpawnPipeline<TState>(
  params: SpawnPipelineParams<TState>,
): Promise<SpawnPipelineResult<TState>> {
  let phase: SpawnPipelinePhase = "initialize";
  let state: TState | undefined;
  let runId: string | undefined;
  let registrationScope: SubagentRegistrationScope | undefined;
  try {
    let registration: RegisterSubagentRunInput;
    try {
      params.assertActive?.();
      state = await params.adapter.initialize();
      // Retain initialization's rollback handle before checking a parent that
      // may have closed while the backend was preparing its child.
      phase = "dispatch";
      params.assertActive?.();
      ({ runId } = await params.adapter.dispatchTurn(state));
      phase = "register";
      params.assertActive?.();
      registration = params.buildRegistration(state, runId);
      const completion = registerSubagentRun(registration, {
        assertCurrent: params.assertActive,
        retainOwnership: (scope) => {
          registrationScope = scope;
        },
      });
      if (completion) {
        await completion;
      }
      // Release launch admission only after any authority preparation and registry acknowledgement.
      params.admissionReservation?.release();
    } catch (error) {
      await params.adapter.cleanupOnFailure({
        phase,
        state,
        error,
        ...(registrationScope ? { registrationScope } : {}),
      });
      return { ok: false, phase, state, runId, error };
    }

    if (params.hookRunner?.hasHooks("subagent_progress")) {
      try {
        await params.hookRunner.runSubagentProgress(
          {
            phase: "started",
            runId,
            childSessionKey: registration.childSessionKey,
            requester: params.progressOrigin,
          },
          {
            runId,
            childSessionKey: registration.childSessionKey,
            requesterSessionKey: params.progressSessionKey,
          },
        );
      } catch {
        // Presentation hooks are best-effort after the run is durably registered.
      }
    }
    return { ok: true, state, runId, ...(registrationScope ? { registrationScope } : {}) };
  } finally {
    params.admissionReservation?.release();
  }
}
