// Resolves whether one sandboxed session is confined to its writable workspace.
import type { SessionEntry } from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { normalizeExecTarget } from "../../infra/exec-approvals.js";
import { resolveEffectiveSessionToolsVisibility } from "../../plugin-sdk/session-visibility.js";
import { resolveAgentConfig } from "../agent-scope.js";
import {
  resolveEffectiveToolPolicy,
  resolveInheritedToolPolicyForSession,
  resolveSubagentToolPolicyForSession,
} from "../agent-tools.policy.js";
import { buildModelAliasIndex, resolveModelRefFromString } from "../model-selection.js";
import { resolveSessionModelRef } from "../session-model-ref.js";
import { isToolAllowedByPolicies } from "../tool-policy-match.js";
import {
  expandToolGroups,
  mergeAlsoAllowPolicy,
  normalizeToolPolicyName,
  resolveToolProfilePolicy,
} from "../tool-policy.js";
import { resolveSandboxConfigForAgent } from "./config.js";
import type { resolveSandboxRuntimeStatus } from "./runtime-status.js";
import type { SandboxToolPolicy } from "./types.js";

type RestrictiveWorkspaceToolPolicy = SandboxToolPolicy & { allow: string[] };

const WORKSPACE_CONFINED_SANDBOX_TOOLS = new Set([
  "apply_patch",
  "edit",
  "exec",
  "view_image",
  "process",
  "read",
  "session_status",
  "sessions_history",
  "sessions_list",
  "sessions_search",
  "sessions_yield",
  "progress_card",
  "web_fetch",
  "web_search",
  "write",
]);

function findUnconfinedAllowedTool(
  policies: Array<SandboxToolPolicy | undefined>,
  confinedToolNames: ReadonlySet<string>,
) {
  const candidatePolicy = policies
    .filter((policy): policy is RestrictiveWorkspaceToolPolicy => Boolean(policy?.allow?.length))
    .toSorted((left, right) => left.allow.length - right.allow.length)[0];
  if (!candidatePolicy?.allow?.length) {
    return "unbounded allow policy";
  }
  for (const entry of candidatePolicy.allow) {
    for (const candidate of expandToolGroups([entry])) {
      const normalized = normalizeToolPolicyName(candidate);
      if (!isToolAllowedByPolicies(normalized, policies)) {
        continue;
      }
      if (WORKSPACE_CONFINED_SANDBOX_TOOLS.has(normalized) || confinedToolNames.has(normalized)) {
        continue;
      }
      return entry;
    }
  }
  return undefined;
}

type SandboxWorkspaceAuthority = {
  sandboxed: boolean;
  workspaceAccess: "none" | "ro" | "rw";
  confinementError?: string;
};

export function resolveSandboxWorkspaceAuthority(params: {
  config: OpenClawConfig;
  agentId?: string;
  sessionKey: string;
  sessionEntry?: Pick<
    SessionEntry,
    "execHost" | "execNode" | "model" | "modelProvider" | "modelOverride" | "providerOverride"
  >;
  confinedToolNames?: readonly string[];
  requiredToolNames?: readonly string[];
  modelProvider?: string;
  modelId?: string;
  preparedRuntimeStatus: ReturnType<typeof resolveSandboxRuntimeStatus>;
}): SandboxWorkspaceAuthority {
  const runtime = params.preparedRuntimeStatus;
  const sandbox = resolveSandboxConfigForAgent(params.config, runtime.agentId);
  if (!runtime.sandboxed) {
    return { sandboxed: false, workspaceAccess: sandbox.workspaceAccess };
  }
  const backend = sandbox.backend.trim().toLowerCase();
  let confinementError: string | undefined;
  if (backend !== "docker" && backend !== "podman") {
    confinementError = "target sandbox backend does not provide local workspace confinement.";
  } else if (runtime.sandboxRequired || sandbox.scope !== "session") {
    confinementError = "target sandbox is not exclusive to this worker session.";
  } else if (
    sandbox.docker.dangerouslyAllowExternalBindSources === true ||
    sandbox.docker.dangerouslyAllowReservedContainerTargets === true ||
    sandbox.docker.dangerouslyAllowContainerNamespaceJoin === true
  ) {
    confinementError = "target sandbox enables dangerous Docker isolation overrides.";
  } else {
    const agentConfig = resolveAgentConfig(params.config, runtime.agentId);
    const elevated = agentConfig?.tools?.elevated;
    if (params.config.tools?.elevated?.enabled === true && elevated?.enabled !== false) {
      confinementError = "target agent can request host-level elevated execution.";
    }
    const rawSessionExecHost = params.sessionEntry?.execHost?.trim();
    const sessionExecHost = normalizeExecTarget(rawSessionExecHost);
    const execHost =
      sessionExecHost ??
      agentConfig?.tools?.exec?.host ??
      params.config.tools?.exec?.host ??
      "auto";
    if (!confinementError && rawSessionExecHost && !sessionExecHost) {
      confinementError = "target session has an invalid shell execution override.";
    } else if (
      !confinementError &&
      (Boolean(params.sessionEntry?.execNode?.trim()) ||
        (execHost !== "auto" && execHost !== "sandbox"))
    ) {
      confinementError = "target sandbox routes shell execution outside the sandbox.";
    } else if (!confinementError && sandbox.browser.allowHostControl) {
      confinementError = "target sandbox allows host browser control.";
    } else if (
      !confinementError &&
      ["agent", "all"].includes(
        resolveEffectiveSessionToolsVisibility({ cfg: params.config, sandboxed: true }),
      )
    ) {
      confinementError = "target sandbox allows access to host-wide sessions.";
    } else if (!confinementError) {
      const selected = resolveSessionModelRef(params.config, params.sessionEntry, runtime.agentId);
      const explicitProvider = params.modelProvider?.trim();
      const explicitModel = params.modelId?.trim();
      let model = { provider: explicitProvider ?? selected.provider, model: selected.model };
      if (explicitModel) {
        const defaultProvider = explicitProvider ?? selected.provider;
        const raw =
          explicitProvider && !explicitModel.includes("/")
            ? `${explicitProvider}/${explicitModel}`
            : explicitModel;
        model = resolveModelRefFromString({
          cfg: params.config,
          raw,
          defaultProvider,
          aliasIndex: buildModelAliasIndex({ cfg: params.config, defaultProvider }),
        })?.ref ?? { provider: defaultProvider, model: explicitModel };
      }
      const effective = resolveEffectiveToolPolicy({
        config: params.config,
        agentId: runtime.agentId,
        sessionKey: params.sessionKey,
        modelProvider: model.provider,
        modelId: model.model,
      });
      const policies = [
        mergeAlsoAllowPolicy(
          resolveToolProfilePolicy(effective.profile),
          effective.profileAlsoAllow,
        ),
        mergeAlsoAllowPolicy(
          resolveToolProfilePolicy(effective.providerProfile),
          effective.providerProfileAlsoAllow,
        ),
        effective.globalPolicy,
        effective.globalProviderPolicy,
        effective.agentPolicy,
        effective.agentProviderPolicy,
        sandbox.tools,
        resolveSubagentToolPolicyForSession(params.config, params.sessionKey),
        resolveInheritedToolPolicyForSession(params.config, params.sessionKey),
      ];
      const unavailableTool = (params.requiredToolNames ?? [])
        .map(normalizeToolPolicyName)
        .find((name) => !isToolAllowedByPolicies(name, policies));
      if (unavailableTool) {
        confinementError = `target tool policy blocks required tool ${unavailableTool}.`;
      } else {
        const unsafeTool = findUnconfinedAllowedTool(
          policies,
          new Set((params.confinedToolNames ?? []).map(normalizeToolPolicyName)),
        );
        if (unsafeTool) {
          confinementError = `target sandbox allows unclassified tool surface ${unsafeTool}.`;
        }
      }
    }
  }
  return {
    sandboxed: true,
    workspaceAccess: runtime.sandboxRequired ? runtime.workspaceAccess : sandbox.workspaceAccess,
    ...(confinementError ? { confinementError } : {}),
  };
}
