import type { CachedSnapshot, IKernel } from "@aotui/runtime";
import type { AgentTool, AgentToolResult } from "@mariozechner/pi-agent-core";
import { OpenClawSnapshotProjector, replaceAotuiInjectedMessages } from "./projector.js";
import type {
  AotuiAgentAdapter,
  AotuiSnapshotProjector,
  AotuiToolBinding,
  AotuiTurnProjection,
  DesktopRecord,
  OpenClawAgentHandle,
  SessionDesktopManager,
} from "./types.js";

type OpenClawAgentAdapterOptions = {
  sessionKey: string;
  sessionId?: string;
  agentId?: string;
  kernel: IKernel;
  desktopManager: SessionDesktopManager;
  agent: OpenClawAgentHandle;
  baseTools?: AgentTool[];
  projector?: AotuiSnapshotProjector;
  ownerId?: string;
};

function normalizeSessionKey(sessionKey: string): string {
  return sessionKey.trim().toLowerCase();
}

function serializeToolPayload(payload: unknown): string {
  if (typeof payload === "string") {
    return payload;
  }
  if (payload === undefined) {
    return "ok";
  }
  try {
    return JSON.stringify(payload, null, 2);
  } catch {
    return `[unserializable ${typeof payload}]`;
  }
}

function buildToolResult(details: unknown): AgentToolResult<unknown> {
  return {
    content: [{ type: "text", text: serializeToolPayload(details) }],
    details,
  };
}

export class OpenClawAgentAdapter implements AotuiAgentAdapter {
  private readonly sessionKey: string;
  private readonly ownerId: string;
  private readonly baseTools: AgentTool[];
  private readonly projector: AotuiSnapshotProjector;
  private readonly bindingCache = new Map<string, AotuiToolBinding>();
  private originalTransformContext?: OpenClawAgentHandle["transformContext"];
  private desktopRecord?: DesktopRecord;

  constructor(private readonly options: OpenClawAgentAdapterOptions) {
    this.sessionKey = normalizeSessionKey(options.sessionKey);
    this.ownerId = options.ownerId ?? "openclaw";
    this.baseTools = [...(options.baseTools ?? [])];
    this.projector = options.projector ?? new OpenClawSnapshotProjector();
  }

  async install(): Promise<void> {
    await this.ensureDesktopReady();
    await this.refreshToolsAndContext();

    this.originalTransformContext = this.options.agent.transformContext;
    this.options.agent.transformContext = async (messages, signal) => {
      const baseMessages = this.originalTransformContext
        ? await this.originalTransformContext(messages, signal)
        : messages;

      const projection = await this.buildTurnProjection();
      this.applyProjection(projection);
      await this.options.desktopManager.touchDesktop(this.sessionKey, this.options.sessionId);
      return replaceAotuiInjectedMessages(baseMessages, projection.messages);
    };
  }

  async dispose(): Promise<void> {
    this.options.agent.transformContext = this.originalTransformContext;
  }

  getSessionKey(): string {
    return this.sessionKey;
  }

  getDesktopRecord(): DesktopRecord {
    if (!this.desktopRecord) {
      throw new Error(`Desktop is not ready for session ${this.sessionKey}`);
    }
    return this.desktopRecord;
  }

  async ensureDesktopReady(): Promise<void> {
    if (this.desktopRecord) {
      await this.options.desktopManager.touchDesktop(this.sessionKey, this.options.sessionId);
      return;
    }

    this.desktopRecord = await this.options.desktopManager.ensureDesktop({
      sessionKey: this.sessionKey,
      sessionId: this.options.sessionId,
      agentId: this.options.agentId,
    });
  }

  async buildAotuiMessages() {
    const projection = await this.buildTurnProjection();
    return projection.messages;
  }

  async buildAotuiTools(): Promise<AgentTool[]> {
    const projection = await this.buildTurnProjection();
    this.applyProjection(projection);
    return projection.tools;
  }

  async routeToolCall(toolName: string, args: unknown, toolCallId: string): Promise<unknown> {
    const binding = await this.resolveBinding(toolName);
    if (!binding) {
      return {
        toolCallId,
        toolName,
        error: {
          code: "E_TOOL_NOT_FOUND",
          message: `Unknown AOTUI tool: ${toolName}`,
        },
      };
    }

    const operation = {
      ...binding.operation,
      args: (args as Record<string, unknown>) ?? {},
    };

    const desktopRecord = this.getDesktopRecord();
    this.options.kernel.acquireLock(desktopRecord.desktopId, this.ownerId);
    try {
      const result = await this.options.kernel.execute(
        desktopRecord.desktopId,
        operation,
        this.ownerId,
      );

      if (result.success) {
        return {
          toolCallId,
          toolName,
          result: result.data ?? { success: true },
        };
      }

      return {
        toolCallId,
        toolName,
        error: result.error ?? {
          code: "E_OPERATION_FAILED",
          message: "AOTUI operation failed",
        },
      };
    } finally {
      this.options.kernel.releaseLock(desktopRecord.desktopId, this.ownerId);
    }
  }

  async refreshToolsAndContext(): Promise<void> {
    const projection = await this.buildTurnProjection();
    this.applyProjection(projection);
    await this.options.desktopManager.touchDesktop(this.sessionKey, this.options.sessionId);
  }

  private async acquireSnapshot(): Promise<CachedSnapshot> {
    await this.ensureDesktopReady();
    return await this.options.kernel.acquireSnapshot(this.getDesktopRecord().desktopId);
  }

  private createTool(binding: AotuiToolBinding): AgentTool {
    return {
      name: binding.toolName,
      label: binding.toolName,
      description: binding.description,
      parameters: binding.parameters,
      execute: async (toolCallId, args) => {
        const rawResult = await this.routeToolCall(binding.toolName, args, toolCallId);
        return buildToolResult(rawResult);
      },
    } as AgentTool;
  }

  private async resolveBinding(toolName: string): Promise<AotuiToolBinding | undefined> {
    const cached = this.bindingCache.get(toolName);
    if (cached) {
      return cached;
    }

    const projection = await this.buildTurnProjection();
    this.applyProjection(projection);
    return this.bindingCache.get(toolName);
  }

  private applyProjection(projection: AotuiTurnProjection): void {
    this.bindingCache.clear();
    for (const binding of projection.bindings) {
      this.bindingCache.set(binding.toolName, binding);
    }
    this.options.agent.setTools([...this.baseTools, ...projection.tools]);
  }

  private async buildTurnProjection(): Promise<AotuiTurnProjection> {
    const snapshot = await this.acquireSnapshot();
    try {
      const desktopRecord = this.getDesktopRecord();
      const messages = this.projector.projectMessages(snapshot, desktopRecord);
      const bindings = this.projector.projectToolBindings(snapshot, desktopRecord);
      const tools = bindings.map((binding) => this.createTool(binding));

      return {
        snapshotId: String(snapshot.id),
        createdAt: snapshot.createdAt,
        messages,
        tools,
        bindings,
      };
    } finally {
      this.options.kernel.releaseSnapshot(snapshot.id);
    }
  }
}
