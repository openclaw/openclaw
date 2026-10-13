import fs from "node:fs/promises";
import {
  resolveAcpSessionCwd,
  resolveAcpThreadSessionDetailLines,
} from "@openclaw/acp-core/runtime/session-identifiers";
import type { AcpRuntimeSessionMode } from "@openclaw/acp-core/runtime/types";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { getAcpSessionManager } from "../../../acp/control-plane/manager.js";
import type { AcpInitializeSessionInput } from "../../../acp/control-plane/manager.types.js";
import { formatThinkingLevels } from "../../../auto-reply/thinking.js";
import type { SessionEntry } from "../../../config/sessions/types.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import { isMissingPathError } from "../../../infra/errors.js";
import {
  getSessionBindingService,
  type SessionBindingRecord,
} from "../../../infra/outbound/session-binding-service.js";
import { resolveAgentConfig } from "../../agent-scope.js";
import { splitTrailingAuthProfile } from "../../model-ref-profile.js";
import {
  resolveConfiguredSubagentSpawnModelSelection,
  resolveThinkingDefault,
} from "../../model-selection.js";
import type { PreparedSpawnThreadBinding } from "../../spawn-plan.js";
import { buildSpawnThreadBinding } from "./spawn-thread-binding.js";
import { splitModelRef } from "./subagent-spawn-plan.js";
import { resolveSubagentThinkingOverride } from "./subagent-spawn-thinking.js";

const ACP_RUNTIME_TIMEOUT_MAX_SECONDS = 24 * 60 * 60;

export async function resolveRuntimeCwdForAcpSpawn(params: {
  resolvedCwd?: string;
  explicitCwd?: string;
}): Promise<string | undefined> {
  if (!params.resolvedCwd) {
    return undefined;
  }
  if (normalizeOptionalString(params.explicitCwd)) {
    return params.resolvedCwd;
  }
  try {
    await fs.access(params.resolvedCwd);
    return params.resolvedCwd;
  } catch (error) {
    if (isMissingPathError(error)) {
      return undefined;
    }
    throw error;
  }
}

type AcpSpawnInitializedSession = Awaited<
  ReturnType<ReturnType<typeof getAcpSessionManager>["initializeSession"]>
>;

export type AcpSpawnInitializedRuntime = {
  initialized: AcpSpawnInitializedSession;
  sessionId: string;
  sessionEntry: SessionEntry;
};

type AcpSpawnRuntimeOptions = {
  model?: string;
  thinking?: string;
  timeoutSeconds?: number;
};

export function resolveAcpSpawnRuntimeOptions(params: {
  cfg: OpenClawConfig;
  targetAgentId: string;
  configAgentId?: string;
  model?: string;
  thinking?: string;
  runTimeoutSeconds?: number;
}):
  | {
      ok: true;
      runtimeOptions?: AcpSpawnRuntimeOptions;
      modelExplicit: boolean;
      thinkingExplicit: boolean;
    }
  | { ok: false; error: string } {
  const policyAgentId = params.configAgentId ?? params.targetAgentId;
  const modelExplicit = normalizeOptionalString(params.model) !== undefined;
  const thinkingExplicit = normalizeOptionalString(params.thinking) !== undefined;
  const rawModel = resolveConfiguredSubagentSpawnModelSelection({
    cfg: params.cfg,
    agentId: policyAgentId,
    modelOverride: params.model,
    modelRuntime: "acp",
  });
  const modelSelection = splitTrailingAuthProfile(rawModel ?? "");
  if (modelExplicit && modelSelection.profile) {
    return {
      ok: false,
      error:
        "ACP model overrides cannot select OpenClaw auth profiles; configure credentials in the ACP runtime instead.",
    };
  }
  const model = modelSelection.model || undefined;
  const targetAgentConfig = resolveAgentConfig(params.cfg, policyAgentId);
  const thinkingPlan = resolveSubagentThinkingOverride({
    cfg: params.cfg,
    targetAgentConfig,
    thinkingOverrideRaw: params.thinking,
  });
  if (thinkingPlan.status === "error") {
    const { provider, model: modelId } = splitModelRef(model);
    return {
      ok: false,
      error: `Invalid thinking level "${thinkingPlan.thinkingCandidateRaw}". Use one of: ${formatThinkingLevels(provider, modelId)}.`,
    };
  }

  let thinking = thinkingPlan.thinkingOverride;
  if (!thinking) {
    const { provider, model: modelId } = splitModelRef(model);
    thinking =
      provider && modelId
        ? resolveThinkingDefault({
            cfg: params.cfg,
            agentId: policyAgentId,
            provider,
            model: modelId,
          })
        : targetAgentConfig?.thinkingDefault;
  }
  const timeoutSeconds = params.runTimeoutSeconds
    ? Math.min(params.runTimeoutSeconds, ACP_RUNTIME_TIMEOUT_MAX_SECONDS)
    : undefined;
  const runtimeOptions =
    model || thinking || timeoutSeconds
      ? {
          ...(model ? { model } : {}),
          ...(thinking ? { thinking } : {}),
          ...(timeoutSeconds ? { timeoutSeconds } : {}),
        }
      : undefined;
  return { ok: true, runtimeOptions, modelExplicit, thinkingExplicit };
}

export async function initializeAcpSpawnRuntime(params: {
  assertActive?: () => void;
  cfg: OpenClawConfig;
  sessionKey: string;
  ownerAgentId: string;
  runtimeAgentId: string;
  runtimeMode: AcpRuntimeSessionMode;
  backendId?: string;
  resumeSessionId?: string;
  revalidateResume?: AcpInitializeSessionInput["revalidateResume"];
  runtimeOptions?: AcpSpawnRuntimeOptions;
  modelExplicit?: boolean;
  thinkingExplicit?: boolean;
  cwd?: string;
}): Promise<AcpSpawnInitializedRuntime> {
  params.assertActive?.();
  const initialized = await getAcpSessionManager().initializeSession({
    assertActive: params.assertActive,
    cfg: params.cfg,
    sessionKey: params.sessionKey,
    agentId: params.ownerAgentId,
    agent: params.runtimeAgentId,
    mode: params.runtimeMode,
    resumeSessionId: params.resumeSessionId,
    revalidateResume: params.revalidateResume,
    runtimeOptions: params.runtimeOptions,
    modelExplicit: params.modelExplicit,
    thinkingExplicit: params.thinkingExplicit,
    cwd: params.cwd,
    backendId: params.backendId,
  });

  return {
    initialized,
    sessionId: initialized.sessionEntry.sessionId,
    sessionEntry: initialized.sessionEntry,
  };
}

export async function bindPreparedAcpThread(params: {
  assertActive?: () => void;
  cfg: OpenClawConfig;
  sessionKey: string;
  targetAgentId: string;
  label?: string;
  preparedBinding: PreparedSpawnThreadBinding;
  initializedRuntime: AcpSpawnInitializedRuntime;
}): Promise<SessionBindingRecord> {
  const binding = await getSessionBindingService().bind(
    buildSpawnThreadBinding({
      cfg: params.cfg,
      sessionKey: params.sessionKey,
      targetKind: "session",
      agentId: params.targetAgentId,
      label: params.label,
      binding: params.preparedBinding,
      sessionCwd: resolveAcpSessionCwd(params.initializedRuntime.initialized.meta),
      sessionDetails: resolveAcpThreadSessionDetailLines({
        sessionKey: params.sessionKey,
        meta: params.initializedRuntime.initialized.meta,
      }),
    }),
  );
  params.assertActive?.();
  if (!binding.conversation.conversationId) {
    throw new Error(
      params.preparedBinding.placement === "child"
        ? `Failed to create and bind a ${params.preparedBinding.channel} thread for this ACP session.`
        : `Failed to bind the current ${params.preparedBinding.channel} conversation for this ACP session.`,
    );
  }

  return binding;
}
