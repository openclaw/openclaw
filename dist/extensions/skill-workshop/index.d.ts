import { A as OpenClawPluginDefinition, C as OpenClawPluginApi, k as OpenClawPluginConfigSchema } from "../../types-Vx7Jq4_-2.js";
//#region extensions/skill-workshop/src/types.d.ts
type SkillWorkshopStatus = "pending" | "applied" | "rejected" | "quarantined";
type SkillChange = {
  kind: "create";
  description: string;
  body: string;
} | {
  kind: "append";
  section: string;
  body: string;
  description?: string;
} | {
  kind: "replace";
  oldText: string;
  newText: string;
};
type SkillProposal = {
  id: string;
  createdAt: number;
  updatedAt: number;
  workspaceDir: string;
  agentId?: string;
  sessionId?: string;
  skillName: string;
  title: string;
  reason: string;
  source: "agent_end" | "reviewer" | "tool";
  status: SkillWorkshopStatus;
  change: SkillChange;
  scanFindings?: SkillScanFinding[];
  quarantineReason?: string;
};
type SkillScanFinding = {
  severity: "info" | "warn" | "critical";
  ruleId: string;
  message: string;
};
//#endregion
//#region extensions/skill-workshop/src/signals.d.ts
declare function createProposalFromMessages(params: {
  messages: unknown[];
  workspaceDir: string;
  agentId?: string;
  sessionId?: string;
}): SkillProposal | undefined;
//#endregion
//#region extensions/skill-workshop/src/store.d.ts
type SkillWorkshopReviewState = {
  turnsSinceReview: number;
  toolCallsSinceReview: number;
  lastReviewAt?: number;
};
declare class SkillWorkshopStore {
  readonly stateDir: string;
  readonly filePath: string;
  private readonly relativePath;
  constructor(params: {
    stateDir: string;
    workspaceDir: string;
  });
  list(status?: SkillWorkshopStatus): Promise<SkillProposal[]>;
  get(id: string): Promise<SkillProposal | undefined>;
  add(proposal: SkillProposal, maxPending: number): Promise<SkillProposal>;
  updateStatus(id: string, status: SkillWorkshopStatus): Promise<SkillProposal>;
  recordReviewTurn(toolCalls: number): Promise<SkillWorkshopReviewState>;
  markReviewed(): Promise<SkillWorkshopReviewState>;
}
//#endregion
//#region extensions/skill-workshop/src/skills.d.ts
declare function applyProposalToWorkspace(params: {
  proposal: SkillProposal;
  maxSkillBytes: number;
}): Promise<{
  skillPath: string;
  created: boolean;
  findings: SkillScanFinding[];
}>;
//#endregion
//#region extensions/skill-workshop/src/config.d.ts
type SkillWorkshopConfig = {
  enabled: boolean;
  autoCapture: boolean;
  approvalPolicy: "pending" | "auto";
  reviewMode: "off" | "heuristic" | "llm" | "hybrid";
  reviewInterval: number;
  reviewMinToolCalls: number;
  reviewTimeoutMs: number;
  maxPending: number;
  maxSkillBytes: number;
};
//#endregion
//#region extensions/skill-workshop/src/reviewer.d.ts
type ReviewContext = {
  agentId: string;
  sessionId?: string;
  sessionKey?: string;
  workspaceDir: string;
  modelProviderId?: string;
  modelId?: string;
  messageProvider?: string;
  channelId?: string;
};
declare function reviewTranscriptForProposal(params: {
  api: OpenClawPluginApi;
  config: SkillWorkshopConfig;
  ctx: ReviewContext;
  messages: unknown[];
}): Promise<SkillProposal | undefined>;
//#endregion
//#region extensions/skill-workshop/src/scanner.d.ts
declare function scanSkillContent(content: string): SkillScanFinding[];
//#endregion
//#region extensions/skill-workshop/index.d.ts
declare const _default: {
  id: string;
  name: string;
  description: string;
  configSchema: OpenClawPluginConfigSchema;
  register: NonNullable<OpenClawPluginDefinition["register"]>;
} & Pick<OpenClawPluginDefinition, "kind" | "reload" | "nodeHostCommands" | "securityAuditCollectors">;
//#endregion
export { SkillWorkshopStore, applyProposalToWorkspace, createProposalFromMessages, _default as default, reviewTranscriptForProposal, scanSkillContent };