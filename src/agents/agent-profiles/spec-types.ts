// Agent Profile spec types, vendored as types only.
// Source: RFC openclaw/rfcs#18 and the agentprofiles 0.1.0 package (agentprofiles.io/v1).
// This file holds only the shapes OpenClaw reads. It carries no validator and no runtime code.
// The package can return as a dependency once the RFC ships it as a published contract.

export type AgentProfileThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";

export type AgentProfileSystemPrompt =
  | Readonly<{ text: string }>
  | Readonly<{ file: Readonly<{ path: string }> }>;

export type AgentProfileCommon = Readonly<{
  systemPrompt?: AgentProfileSystemPrompt;
  thinkingLevel?: AgentProfileThinkingLevel;
}>;

export type AgentProfileSpec = Readonly<
  {
    common: AgentProfileCommon;
  } & Record<string, unknown>
>;

export type AgentProfileResource = Readonly<{
  apiVersion: "agentprofiles.io/v1";
  kind: "AgentProfile";
  metadata: Readonly<{
    namespace: string;
    name: string;
  }>;
  extends?: string;
  spec: AgentProfileSpec;
}>;
