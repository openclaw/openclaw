import type { ExecAsk, ExecSecurity, ExecTarget } from "../infra/exec-approvals-core.js";

export type DelegatedFileToolRestriction = {
  workspaceOnly: boolean;
  readOnly: boolean;
  applyPatchEnabled: boolean;
  applyPatchWorkspaceOnly: boolean;
  applyPatchAllowModels: string[] | null;
};

type DelegatedSafeBinProfile = {
  name: string;
  minPositional: number | null;
  maxPositional: number | null;
  allowedValueFlags: string[];
  allowedBooleanFlags: string[];
  deniedFlags: string[];
};

export type DelegatedExecRestriction = {
  security: ExecSecurity;
  ask: ExecAsk;
  askFallback: ExecSecurity;
  autoReview: boolean;
  bypassHostApprovalFloors: boolean;
  host: ExecTarget;
  elevation: "off" | "ask" | "full";
  strictInlineEval: boolean;
  safeBins: string[];
  safeBinProfiles: DelegatedSafeBinProfile[];
};

export type DelegatedSandboxRestriction = {
  backend: "docker" | "podman";
  workspaceAccess: "none" | "ro" | "rw";
  network: "none" | "bridge";
  readOnlyRoot: boolean;
  capDrop: string[];
  tmpfs: string[];
  browserAllowHostControl: boolean;
};

export type DelegatedParameterUnsupported = {
  scope: "exec" | "fileTools" | "applyPatch" | "sandbox";
  reason:
    | "source-filesystem-root"
    | "exec-node-binding"
    | "exec-trusted-paths"
    | "exec-reviewer-binding"
    | "exec-sandbox-escape"
    | "sandbox-backend"
    | "sandbox-resource-binding";
};

/** Independent owner predicates; resources and approval grants never enter this record. */
export type DelegatedToolParameterPolicy = {
  fileTools: DelegatedFileToolRestriction[];
  exec: DelegatedExecRestriction[];
  sandbox: DelegatedSandboxRestriction[];
  unsupported: DelegatedParameterUnsupported[];
};

export type DelegatedParameterApplicability = {
  exec: boolean;
  fileTools: boolean;
  fileWrites?: boolean;
  applyPatch: boolean;
  sandbox: boolean;
};
