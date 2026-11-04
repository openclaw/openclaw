import {
  formatValidationErrors,
  validateSkillsWorkshopArchiveParams,
  validateSkillsWorkshopChangesParams,
  validateSkillsWorkshopListParams,
  validateSkillsWorkshopReadParams,
  validateSkillsWorkshopRestoreParams,
  validateSkillsWorkshopUndoParams,
  type ValidationError,
} from "@openclaw/gateway-protocol";
import { listAgentIds, resolveDefaultAgentId } from "openclaw/plugin-sdk/agent-scope-runtime";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import {
  ErrorCodes,
  errorShape,
  type GatewayRequestHandlerOptions,
} from "openclaw/plugin-sdk/gateway-runtime";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { normalizeAgentId } from "openclaw/plugin-sdk/routing";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import { applyWorkshopDraft, discardWorkshopDraft, viewWorkshopDraft } from "./drafts.js";
import {
  archiveWorkshopSkill,
  listWorkshopChanges,
  restoreWorkshopSkill,
  viewWorkshopSkill,
  WorkshopWriteError,
} from "./library.js";
import { undoWorkshopReview } from "./review-undo.js";
import { buildSkillsWorkshopListResult } from "./workshop-list.js";

type Validator<T> = ((params: unknown) => params is T) & { errors?: ValidationError[] | null };
type ResolvedWorkshopAgent = { cfg: OpenClawConfig; agentId: string };

/** The selected agent, or an INVALID_REQUEST answer naming why none could be selected. */
function resolveWorkshopAgent(
  params: { agentId?: string },
  cfg: OpenClawConfig,
): { ok: true; resolved: ResolvedWorkshopAgent } | { ok: false; message: string } {
  const agentIdRaw = normalizeOptionalString(params.agentId);
  let agentId: string;
  try {
    agentId = agentIdRaw
      ? normalizeAgentId(agentIdRaw)
      : resolveDefaultAgentId(cfg, {
          surface: "skills workspace",
          hint: "Pass agentId to select a configured agent.",
        });
  } catch (error) {
    // AgentSelectionRequiredError: several agents and no default under explicit ownership.
    if (
      !(error instanceof Error) ||
      !("code" in error) ||
      error.code !== "AGENT_SELECTION_REQUIRED"
    ) {
      throw error;
    }
    return { ok: false, message: error.message };
  }
  if (agentIdRaw && !listAgentIds(cfg).includes(agentId)) {
    return { ok: false, message: `unknown agent id "${agentIdRaw}"` };
  }
  return { ok: true, resolved: { cfg, agentId } };
}

/**
 * The caller's Gateway authority, captured at admission and rechecked by the library before
 * each final file effect: a closed transport, revoked device or changed requester refuses.
 */
function captureRequesterAuthority(invocation: GatewayRequestHandlerOptions): () => void {
  const { client, signal, hasCurrentClientAuthority, sessionMutationCommitGuard } = invocation;
  return () => {
    signal?.throwIfAborted();
    if (client?.invalidated || hasCurrentClientAuthority?.() === false) {
      throw new Error("Gateway requester authority changed");
    }
    sessionMutationCommitGuard?.();
  };
}

function writeContext(resolved: ResolvedWorkshopAgent, invocation: GatewayRequestHandlerOptions) {
  return {
    config: resolved.cfg,
    agentId: resolved.agentId,
    actor: "user" as const,
    assertLive: captureRequesterAuthority(invocation),
  };
}

function requireDraftId(draftId: string | undefined): string {
  if (!draftId) {
    throw new WorkshopWriteError("draftId is required.");
  }
  return draftId;
}

function defineWorkshopMethod<TParams extends { agentId?: string } & Record<string, unknown>>(
  method: string,
  validate: Validator<TParams>,
  run: (
    params: TParams,
    resolved: ResolvedWorkshopAgent,
    invocation: GatewayRequestHandlerOptions,
  ) => Promise<unknown>,
) {
  return async (invocation: GatewayRequestHandlerOptions): Promise<void> => {
    const { params, respond, context } = invocation;
    if (!validate(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid ${method} params: ${formatValidationErrors(validate.errors)}`,
        ),
      );
      return;
    }
    const agent = resolveWorkshopAgent(params, context.getRuntimeConfig());
    if (!agent.ok) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, agent.message));
      return;
    }
    try {
      respond(true, await run(params, agent.resolved, invocation), undefined);
    } catch (error) {
      if (!(error instanceof WorkshopWriteError)) {
        throw error;
      }
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, error.message));
    }
  };
}

// Reads need operator.read, changes operator.admin; none depend on a person profile.
const READ = { scope: "operator.read", profileAccess: "independent" } as const;
const ADMIN = { scope: "operator.admin", profileAccess: "independent" } as const;

/** The `skills.workshop.*` Gateway methods, unchanged in name, params, results and scope. */
export function registerSkillWorkshopGatewayMethods(api: OpenClawPluginApi): void {
  const register = (
    method: string,
    handler: (invocation: GatewayRequestHandlerOptions) => Promise<void>,
    opts: typeof READ | typeof ADMIN,
  ) => api.registerGatewayMethod(method, handler, opts);

  register(
    "skills.workshop.list",
    defineWorkshopMethod("skills.workshop.list", validateSkillsWorkshopListParams, (_p, resolved) =>
      buildSkillsWorkshopListResult({ config: resolved.cfg, agentId: resolved.agentId }),
    ),
    READ,
  );
  register(
    "skills.workshop.changes",
    defineWorkshopMethod(
      "skills.workshop.changes",
      validateSkillsWorkshopChangesParams,
      async (params, resolved) => ({
        changes: await listWorkshopChanges(resolved.agentId, {
          limit: params.limit,
          beforeMs: params.beforeMs,
        }),
      }),
    ),
    READ,
  );
  register(
    "skills.workshop.read",
    defineWorkshopMethod(
      "skills.workshop.read",
      validateSkillsWorkshopReadParams,
      async (params, resolved) => {
        if (!params.draftId) {
          return viewWorkshopSkill(
            resolved.cfg,
            resolved.agentId,
            params.name,
            params.filePath,
            params.versionId,
          );
        }
        const { draft, filePath, content } = await viewWorkshopDraft(
          resolved.cfg,
          resolved.agentId,
          params.draftId,
          params.filePath,
        );
        return { name: draft.skillName, filePath, content, files: draft.files };
      },
    ),
    READ,
  );
  register(
    "skills.workshop.archive",
    defineWorkshopMethod(
      "skills.workshop.archive",
      validateSkillsWorkshopArchiveParams,
      async (params, resolved, invocation) => ({
        change: await archiveWorkshopSkill(writeContext(resolved, invocation), {
          name: params.name,
          reason: params.reason,
        }),
      }),
    ),
    ADMIN,
  );
  register(
    "skills.workshop.restore",
    defineWorkshopMethod(
      "skills.workshop.restore",
      validateSkillsWorkshopRestoreParams,
      async (params, resolved, invocation) => ({
        change: await restoreWorkshopSkill(writeContext(resolved, invocation), {
          name: params.name,
          versionId: params.versionId,
        }),
      }),
    ),
    ADMIN,
  );
  // Draft methods take the read params: `name` is the skill the caller reviewed.
  register(
    "skills.workshop.applyDraft",
    defineWorkshopMethod(
      "skills.workshop.applyDraft",
      validateSkillsWorkshopReadParams,
      async (params, resolved, invocation) => ({
        changes: await applyWorkshopDraft(
          writeContext(resolved, invocation),
          requireDraftId(params.draftId),
          params.name,
        ),
      }),
    ),
    ADMIN,
  );
  register(
    "skills.workshop.discardDraft",
    defineWorkshopMethod(
      "skills.workshop.discardDraft",
      validateSkillsWorkshopReadParams,
      async (params, resolved, invocation) => {
        const { config, agentId, assertLive } = writeContext(resolved, invocation);
        await discardWorkshopDraft(config, agentId, requireDraftId(params.draftId), assertLive);
        return { changes: [] };
      },
    ),
    ADMIN,
  );
  register(
    "skills.workshop.undo",
    defineWorkshopMethod(
      "skills.workshop.undo",
      validateSkillsWorkshopUndoParams,
      (params, resolved, invocation) =>
        undoWorkshopReview(writeContext(resolved, invocation), { runId: params.runId }),
    ),
    ADMIN,
  );
}
