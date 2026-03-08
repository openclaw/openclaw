import type { CachedSnapshot, DesktopID, IKernel, Operation } from "@aotui/runtime";
import type { AgentMessage, AgentTool } from "@mariozechner/pi-agent-core";

export type AotuiInjectedMessageKind =
  | "system_instruction"
  | "desktop_state"
  | "app_state"
  | "view_state";

export type AotuiInjectedMessageMeta = {
  aotui: true;
  desktopKey: string;
  snapshotId: string;
  kind: AotuiInjectedMessageKind;
  viewId?: string;
};

export type DesktopBindingInput = {
  sessionKey: string;
  sessionId?: string;
  agentId?: string;
  channelId?: string;
  accountId?: string;
  threadId?: string | number;
  parentSessionKey?: string;
  workspaceDir?: string;
};

export type DesktopRecordStatus = "active" | "suspended" | "destroying";

export type DesktopRecord = {
  desktopKey: string;
  desktopId: DesktopID;
  sessionKey: string;
  baseSessionKey?: string;
  parentSessionKey?: string;
  threadId?: string;
  sessionId?: string;
  agentId: string;
  workspaceDir?: string;
  createdAt: number;
  lastActiveAt: number;
  status: DesktopRecordStatus;
};

export type AotuiToolBinding = {
  toolName: string;
  description: string;
  parameters?: Record<string, unknown>;
  operation: Operation;
};

export type AotuiTurnProjection = {
  snapshotId: string;
  createdAt: number;
  messages: AgentMessage[];
  tools: AgentTool[];
  bindings: AotuiToolBinding[];
};

export type OpenClawTransformContext = (
  messages: AgentMessage[],
  signal?: AbortSignal,
) => AgentMessage[] | Promise<AgentMessage[]>;

export type OpenClawAgentHandle = {
  state: {
    tools: AgentTool[];
  };
  setTools: (tools: AgentTool[]) => void;
  transformContext?: OpenClawTransformContext;
};

export interface SessionDesktopManager {
  ensureDesktop(input: DesktopBindingInput): Promise<DesktopRecord>;
  touchDesktop(sessionKey: string, sessionId?: string): Promise<void>;
  suspendDesktop(sessionKey: string, reason?: string): Promise<void>;
  resumeDesktop(sessionKey: string): Promise<void>;
  resetDesktop(
    sessionKey: string,
    next?: Omit<DesktopBindingInput, "sessionKey"> & { reason?: string },
  ): Promise<DesktopRecord>;
  destroyDesktop(sessionKey: string, reason?: string): Promise<void>;
  destroyAll(reason?: string): Promise<void>;
  getDesktop(sessionKey: string): DesktopRecord | undefined;
  listDesktops(): DesktopRecord[];
}

export interface AotuiSnapshotProjector {
  projectMessages(snapshot: CachedSnapshot, meta: DesktopRecord): AgentMessage[];
  projectToolBindings(snapshot: CachedSnapshot, meta: DesktopRecord): AotuiToolBinding[];
}

export interface AotuiAgentAdapter {
  install(): Promise<void>;
  dispose(): Promise<void>;
  getSessionKey(): string;
  getDesktopRecord(): DesktopRecord;
  ensureDesktopReady(): Promise<void>;
  buildAotuiMessages(): Promise<AgentMessage[]>;
  buildAotuiTools(): Promise<AgentTool[]>;
  routeToolCall(toolName: string, args: unknown, toolCallId: string): Promise<unknown>;
  refreshToolsAndContext(): Promise<void>;
}

export interface AotuiKernelService {
  start(): Promise<void>;
  stop(reason?: string): Promise<void>;
  isStarted(): boolean;
  getKernel(): IKernel;
  getDesktopManager(): SessionDesktopManager;
}
