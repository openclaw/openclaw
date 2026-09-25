import path from "node:path";
import type { OpenClawCodingToolsOptions } from "./agent-tools.options.js";
import { resolveConfiguredApplyPatchPolicy } from "./apply-patch-policy.js";
import type { ExecToolDefaults } from "./bash-tools.exec-types.js";
import type { ResolvedConversationCapabilityProfile } from "./conversation-capability-profile.js";
import { resolveConversationToolPolicies } from "./conversation-tool-policy-pipeline.js";
import {
  applyDelegatedToolParameters,
  captureDelegatedToolParameters,
  type DelegatedToolParameterFacts,
} from "./inherited-tool-parameters.js";
import {
  captureDelegatedSourceToolPolicy,
  captureInheritedToolPolicy,
  createInheritedToolPolicyMatcher,
} from "./inherited-tool-policy.js";
import type {
  InheritedToolPolicyRef,
  InheritedToolPolicySourceCapture,
  InheritedToolPolicyV2,
} from "./inherited-tool-policy.schema.js";
import type { resolveExecToolConfig } from "./lazy-exec-tool.js";
import { resolveSandboxConfigForAgent } from "./sandbox/config.js";
import type { SandboxContext } from "./sandbox/types.js";
import { resolveSessionPermissionCoreToolPolicy } from "./session-permission-exec-mode.js";
import { resolveToolFsConfig } from "./tool-fs-policy.js";
import type { ToolPolicyLike } from "./tool-policy.js";

export function prepareCodingToolDelegatedParameters(params: {
  options?: OpenClawCodingToolsOptions;
  capabilityProfile: ResolvedConversationCapabilityProfile;
  preparedExecDefaults: ExecToolDefaults;
  execConfig: ReturnType<typeof resolveExecToolConfig>;
  sandbox?: SandboxContext;
  workspaceRoot: string;
  isMemoryFlushRun: boolean;
  runtimeProfileAlsoAllow?: readonly string[];
  toolSearchControlAllowlist?: readonly string[];
}) {
  const {
    options,
    capabilityProfile,
    preparedExecDefaults,
    execConfig,
    sandbox,
    workspaceRoot,
    isMemoryFlushRun,
    runtimeProfileAlsoAllow,
    toolSearchControlAllowlist,
  } = params;
  const agentId = capabilityProfile.policy.agentId;
  const fsConfig = resolveToolFsConfig({ cfg: options?.config, agentId });
  const sessionPermissionPolicy = options?.sessionPermissionPolicy;
  const sessionCoreToolPolicy = sessionPermissionPolicy
    ? resolveSessionPermissionCoreToolPolicy(sessionPermissionPolicy)
    : undefined;
  const workspaceOnly =
    options?.requireWorkspaceOnly === true ||
    isMemoryFlushRun ||
    (sessionCoreToolPolicy?.workspaceOnly ?? fsConfig.workspaceOnly === true);
  const readOnly = sessionCoreToolPolicy?.readOnly ?? false;
  const applyPatchPolicy = resolveConfiguredApplyPatchPolicy({
    config: execConfig.applyPatch,
    workspaceOnly,
    readOnly,
    requireWorkspaceOnly: options?.requireWorkspaceOnly === true,
    sessionPolicy: sessionCoreToolPolicy,
    modelProvider: options?.modelProvider,
    modelId: options?.modelId,
  });

  const parameterFacts: DelegatedToolParameterFacts = {
    exec: preparedExecDefaults,
    fileTools: {
      workspaceOnly,
      readOnly,
      applyPatchWorkspaceOnly: applyPatchPolicy.applyPatchWorkspaceOnly,
      applyPatchEnabled: applyPatchPolicy.applyPatchEnabled,
      configuredApplyPatchEnabled: execConfig.applyPatch?.enabled !== false,
      applyPatchAllowModels: execConfig.applyPatch?.allowModels,
      rootIsWorkspace:
        Boolean(sandbox) ||
        !sessionPermissionPolicy?.root ||
        path.resolve(sessionPermissionPolicy.root) === path.resolve(workspaceRoot),
    },
    sandbox: {
      sandboxed: Boolean(sandbox),
      config: (() => {
        const configured = resolveSandboxConfigForAgent(options?.config, agentId);
        return sandbox
          ? {
              ...configured,
              backend: sandbox.backendId,
              workspaceAccess: sandbox.workspaceAccess,
              docker: sandbox.docker,
              browser: {
                ...configured.browser,
                enabled: Boolean(sandbox.browser),
                allowHostControl: sandbox.browserAllowHostControl,
              },
            }
          : configured;
      })(),
    },
    modelProvider: options?.modelProvider,
    modelId: options?.modelId,
  };
  const inheritedActionPolicy = capabilityProfile.policy.inheritedActionPolicy;
  const configuredPolicies = resolveConversationToolPolicies({
    capabilityProfile,
    additionalProfileAllow: runtimeProfileAlsoAllow,
    additionalPolicyAllow: toolSearchControlAllowlist,
  });
  const configuredPolicy = captureInheritedToolPolicy({
    policies: Object.values(configuredPolicies),
    inherited: inheritedActionPolicy,
    parameters: captureDelegatedToolParameters(parameterFacts),
    runtimeAllow: capabilityProfile.policy.runtimeToolPolicyForInheritance?.allow,
  });
  const nameAllowed = createInheritedToolPolicyMatcher({
    policy: {
      ...configuredPolicy,
      clauses: configuredPolicy.clauses.filter((clause) => clause.kind !== "restart-safe"),
    },
  });
  const allows = (name: string) => nameAllowed({ name });
  const appliedParameters = inheritedActionPolicy
    ? applyDelegatedToolParameters({
        ...parameterFacts,
        policy: inheritedActionPolicy.parameters,
        applicability: {
          exec: allows("exec"),
          fileTools: ["read", "write", "edit", "apply_patch"].some(allows),
          fileWrites: ["write", "edit", "apply_patch"].some(allows),
          applyPatch: allows("apply_patch"),
          sandbox: ["exec", "read", "write", "edit", "apply_patch", "browser"].some(allows),
        },
      })
    : { exec: preparedExecDefaults, fileTools: { workspaceOnly, readOnly, ...applyPatchPolicy } };
  return {
    configuredPolicy,
    appliedParameters,
    applyPatchPolicy: { ...applyPatchPolicy, ...appliedParameters.fileTools },
  };
}

export function bindCodingToolDelegationSource(params: {
  options?: OpenClawCodingToolsOptions;
  configuredPolicy: InheritedToolPolicyV2;
  ownerOnlyCoreToolPolicy?: ToolPolicyLike;
  preparedExecDefaults: ExecToolDefaults;
  sandbox?: SandboxContext;
  agentId?: string;
}): InheritedToolPolicySourceCapture {
  const {
    options,
    configuredPolicy,
    ownerOnlyCoreToolPolicy,
    preparedExecDefaults,
    sandbox,
    agentId,
  } = params;
  const inheritedToolPolicyRef: InheritedToolPolicyRef = options?.inheritedToolPolicyRef ?? {};
  inheritedToolPolicyRef.current = captureInheritedToolPolicy({
    policies: [ownerOnlyCoreToolPolicy],
    inherited: configuredPolicy,
    parameters: { fileTools: [], exec: [], sandbox: [], unsupported: [] },
  });
  const captureSource: NonNullable<InheritedToolPolicyRef["captureSource"]> = (
    policy,
    assertCurrent,
  ) =>
    captureDelegatedSourceToolPolicy({
      policy,
      exec: preparedExecDefaults,
      sandboxed: Boolean(sandbox),
      config: options?.config,
      agentId,
      assertCurrent,
    });
  inheritedToolPolicyRef.captureSource = captureSource;
  const assertSourceGenerationCurrent = () => {
    options?.abortSignal?.throwIfAborted();
    if (inheritedToolPolicyRef.captureSource !== captureSource) {
      throw new Error("Delegated action restrictions belong to a replaced tool generation.");
    }
  };
  const captureInheritedToolPolicyForDelegation: InheritedToolPolicySourceCapture = async () => {
    assertSourceGenerationCurrent();
    if (options?.captureInheritedToolPolicyForDelegation) {
      const captured = await options.captureInheritedToolPolicyForDelegation();
      const assertCurrent = () => {
        assertSourceGenerationCurrent();
        captured.assertCurrent();
      };
      assertCurrent();
      return { policy: captured.policy, assertCurrent };
    }
    const source = inheritedToolPolicyRef.current;
    if (!source) {
      throw new Error("Delegated action restrictions have not been prepared.");
    }
    const sourceBytes = JSON.stringify(source);
    const assertCurrent = () => {
      assertSourceGenerationCurrent();
      if (JSON.stringify(inheritedToolPolicyRef.current) !== sourceBytes) {
        throw new Error("Delegated action restrictions changed before acceptance.");
      }
    };
    const policy = await captureSource(source, assertCurrent);
    assertCurrent();
    return { policy, assertCurrent };
  };
  return captureInheritedToolPolicyForDelegation;
}
