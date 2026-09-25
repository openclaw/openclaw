import type { ExecToolDefaults } from "./bash-tools.exec-types.js";
import {
  applyDelegatedExecRestrictions,
  captureDelegatedExecRestriction,
  isDelegatedExecRestrictionSatisfied,
  needsDelegatedExecFallbackCommandPolicy,
} from "./delegated-exec-policy.js";
import type {
  DelegatedParameterApplicability,
  DelegatedToolParameterPolicy,
} from "./inherited-tool-parameters.types.js";
import {
  assertDelegatedSandboxRestrictions,
  captureDelegatedSandboxRestriction,
  isDelegatedSandboxRestrictionSatisfied,
} from "./sandbox/delegated-policy.js";
import type { SandboxConfig } from "./sandbox/types.js";
import {
  applyDelegatedFileToolRestrictions,
  captureDelegatedFileToolRestriction,
} from "./tool-fs-policy.js";

export type {
  DelegatedToolParameterPolicy,
  DelegatedParameterApplicability,
} from "./inherited-tool-parameters.types.js";

export function emptyDelegatedToolParameterPolicy(): DelegatedToolParameterPolicy {
  return { fileTools: [], exec: [], sandbox: [], unsupported: [] };
}

export type DelegatedToolParameterFacts = {
  exec: ExecToolDefaults;
  fileTools: Parameters<typeof captureDelegatedFileToolRestriction>[0] & {
    rootIsWorkspace: boolean;
    applyPatchEnabled: boolean;
  };
  sandbox: { sandboxed: boolean; config: SandboxConfig };
  modelProvider?: string;
  modelId?: string;
};

export function captureDelegatedToolParameters(
  facts: DelegatedToolParameterFacts,
): DelegatedToolParameterPolicy {
  const exec = captureDelegatedExecRestriction(facts.exec, facts.sandbox.sandboxed);
  const result: DelegatedToolParameterPolicy = {
    fileTools: [captureDelegatedFileToolRestriction(facts.fileTools)],
    exec: [exec.restriction],
    sandbox: [],
    unsupported: [...exec.unsupported],
  };
  if (!facts.fileTools.rootIsWorkspace) {
    if (facts.fileTools.workspaceOnly) {
      result.unsupported.push({ scope: "fileTools", reason: "source-filesystem-root" });
    } else if (
      facts.fileTools.applyPatchWorkspaceOnly &&
      facts.fileTools.configuredApplyPatchEnabled
    ) {
      result.unsupported.push({ scope: "applyPatch", reason: "source-filesystem-root" });
    }
  }
  if (facts.sandbox.sandboxed) {
    if (
      exec.restriction.elevation !== "off" ||
      exec.restriction.host === "gateway" ||
      exec.restriction.host === "node"
    ) {
      result.unsupported.push({ scope: "exec", reason: "exec-sandbox-escape" });
    }
    const sandbox = captureDelegatedSandboxRestriction(facts.sandbox.config);
    if (sandbox.restriction) {
      result.sandbox.push(sandbox.restriction);
    }
    if (sandbox.unsupported) {
      result.unsupported.push(sandbox.unsupported);
    }
  }
  return result;
}

class DelegatedToolParameterUnsupportedError extends Error {
  constructor(reason: string) {
    super(`Delegated tool parameter policy is unsupported: ${reason}`);
    this.name = "DelegatedToolParameterUnsupportedError";
  }
}

function assertSupported(
  policy: DelegatedToolParameterPolicy,
  applicability: DelegatedParameterApplicability,
) {
  const unsupported = policy.unsupported.find((entry) =>
    entry.scope === "fileTools"
      ? applicability.fileTools || applicability.applyPatch
      : applicability[entry.scope],
  );
  if (unsupported) {
    throw new DelegatedToolParameterUnsupportedError(unsupported.reason);
  }
}

export function applyDelegatedToolParameters(
  params: DelegatedToolParameterFacts & {
    policy: DelegatedToolParameterPolicy;
    applicability: DelegatedParameterApplicability;
  },
) {
  assertSupported(params.policy, params.applicability);
  if (params.applicability.sandbox) {
    assertDelegatedSandboxRestrictions(
      params.policy.sandbox,
      params.sandbox.sandboxed ? params.sandbox.config : undefined,
    );
  }
  return {
    exec: params.applicability.exec
      ? applyDelegatedExecRestrictions(
          { ...params.exec, ...(params.policy.sandbox.length ? { sandboxRequired: true } : {}) },
          params.policy.exec,
          params.sandbox.sandboxed,
        )
      : params.exec,
    fileTools: applyDelegatedFileToolRestrictions({
      ...params.fileTools,
      restrictions:
        params.applicability.fileTools || params.applicability.applyPatch
          ? params.policy.fileTools
          : [],
      modelProvider: params.modelProvider,
      modelId: params.modelId,
    }),
  };
}

/** Structural retained clauses prove implication without sampling commands or available tools. */
export function areDelegatedToolParametersCompatible(
  source: DelegatedToolParameterPolicy,
  target: DelegatedToolParameterPolicy,
  applicability: DelegatedParameterApplicability,
  targetEnforcedPolicy?: DelegatedToolParameterPolicy,
): { compatible: true } | { compatible: false; reason: string } {
  try {
    assertSupported(source, applicability);
  } catch (error) {
    if (error instanceof DelegatedToolParameterUnsupportedError) {
      return { compatible: false, reason: error.message };
    }
    throw error;
  }
  if (
    applicability.exec &&
    !source.exec.every((entry) => {
      if (!target.exec.some((candidate) => isDelegatedExecRestrictionSatisfied(entry, candidate))) {
        return false;
      }
      // Configured allowlists can gain local grants. Only an installed inherited
      // command predicate (or denied exec) proves this bound for the accepted work.
      return (
        (entry.security !== "allowlist" &&
          !entry.strictInlineEval &&
          !needsDelegatedExecFallbackCommandPolicy(entry)) ||
        target.exec.some((candidate) => candidate.security === "deny") ||
        targetEnforcedPolicy?.exec.some((candidate) =>
          isDelegatedExecRestrictionSatisfied(entry, candidate),
        ) === true
      );
    })
  ) {
    return {
      compatible: false,
      reason: "receiver exec policy does not retain the source restriction",
    };
  }
  if (
    (applicability.fileTools || applicability.applyPatch) &&
    !source.fileTools.every((entry) =>
      target.fileTools.some(
        (candidate) =>
          (!applicability.fileTools || !entry.workspaceOnly || candidate.workspaceOnly) &&
          (!(applicability.fileWrites ?? applicability.fileTools) ||
            !entry.readOnly ||
            candidate.readOnly) &&
          (!applicability.applyPatch ||
            ((entry.applyPatchEnabled || !candidate.applyPatchEnabled) &&
              (!entry.applyPatchWorkspaceOnly || candidate.applyPatchWorkspaceOnly) &&
              (entry.applyPatchAllowModels === null ||
                JSON.stringify(entry.applyPatchAllowModels) ===
                  JSON.stringify(candidate.applyPatchAllowModels)))),
      ),
    )
  ) {
    return {
      compatible: false,
      reason: "receiver file policy does not satisfy the source restriction",
    };
  }
  if (
    applicability.sandbox &&
    !source.sandbox.every((entry) =>
      target.sandbox.some((candidate) => isDelegatedSandboxRestrictionSatisfied(entry, candidate)),
    )
  ) {
    return {
      compatible: false,
      reason: "receiver sandbox does not satisfy the source restriction",
    };
  }
  return { compatible: true };
}
