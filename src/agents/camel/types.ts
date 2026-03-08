import type { CAMEL_VALUE_BRAND } from "./value.js";

export enum SourceKind {
  User = "user",
  CaMeL = "camel",
  Assistant = "assistant",
  Tool = "tool",
  TrustedTool = "trustedTool",
}

export interface ToolSource {
  kind: "tool";
  toolName: string;
  innerSources?: Set<string | SourceKind>;
}

export type Source = SourceKind | ToolSource;

export type Readers =
  | { kind: "public" }
  | {
      kind: "restricted";
      allowedReaders: Set<string>;
    };

export interface Capabilities {
  sources: Set<Source>;
  readers: Readers;
  metadata?: Record<string, unknown>;
}

export interface CaMeLValue<T = unknown> {
  raw: T;
  capabilities: Capabilities;
  dependencies: CaMeLValue[];
  [CAMEL_VALUE_BRAND]?: true;
}

export type PolicyResult =
  | { allowed: true }
  | {
      denied: true;
      reason: string;
    };

export type SecurityPolicy = (
  toolName: string,
  args: Record<string, CaMeLValue>,
  dependencies: CaMeLValue[],
) => PolicyResult;

export interface CaMeLPolicyConfig {
  trustedRecipients?: string[];
  requireApproval?: string[];
  noSideEffectTools?: string[];
}

export interface CaMeLConfig {
  enabled: boolean;
  mode: "strict" | "permissive";
  qModel?: string;
  policies: CaMeLPolicyConfig;
}

export type ApprovalRequest = {
  toolName: string;
  reason: string;
};

export type ApprovalHandler = (request: ApprovalRequest) => Promise<boolean>;
