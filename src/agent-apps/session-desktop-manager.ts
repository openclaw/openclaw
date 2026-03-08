import type { DesktopID, IKernel } from "@aotui/runtime";
import type { DesktopBindingInput, DesktopRecord, SessionDesktopManager } from "./types.js";

type SessionDesktopManagerOptions = {
  afterCreate?: (record: DesktopRecord) => Promise<void> | void;
};

function normalizeSessionKey(sessionKey: string): string {
  return sessionKey.trim().toLowerCase();
}

function normalizeAgentId(agentId?: string): string {
  return agentId?.trim().toLowerCase() || "main";
}

function parseThreadInfo(sessionKey: string): { baseSessionKey?: string; threadId?: string } {
  const normalized = normalizeSessionKey(sessionKey);
  const topicIndex = normalized.lastIndexOf(":topic:");
  const threadIndex = normalized.lastIndexOf(":thread:");
  const markerIndex = Math.max(topicIndex, threadIndex);
  const marker = topicIndex > threadIndex ? ":topic:" : ":thread:";

  if (markerIndex === -1) {
    return {};
  }

  const baseSessionKey = normalized.slice(0, markerIndex);
  const threadId = normalized.slice(markerIndex + marker.length) || undefined;
  return { baseSessionKey, threadId };
}

function toDesktopId(sessionKey: string): DesktopID {
  return normalizeSessionKey(sessionKey) as DesktopID;
}

export class InMemorySessionDesktopManager implements SessionDesktopManager {
  private readonly records = new Map<string, DesktopRecord>();
  private readonly afterCreate?: SessionDesktopManagerOptions["afterCreate"];

  constructor(
    private readonly kernel: IKernel,
    options: SessionDesktopManagerOptions = {},
  ) {
    this.afterCreate = options.afterCreate;
  }

  async ensureDesktop(input: DesktopBindingInput): Promise<DesktopRecord> {
    const sessionKey = normalizeSessionKey(input.sessionKey);
    const existing = this.records.get(sessionKey);
    if (existing) {
      existing.lastActiveAt = Date.now();
      existing.sessionId = input.sessionId ?? existing.sessionId;
      existing.workspaceDir = input.workspaceDir ?? existing.workspaceDir;
      if (existing.status === "suspended") {
        await this.kernel.resume(existing.desktopId);
      }
      existing.status = "active";
      return existing;
    }

    const now = Date.now();
    const { baseSessionKey, threadId } = parseThreadInfo(sessionKey);
    const desktopId = await this.kernel.createDesktop(toDesktopId(sessionKey));
    const record: DesktopRecord = {
      desktopKey: sessionKey,
      desktopId,
      sessionKey,
      ...(baseSessionKey ? { baseSessionKey } : {}),
      ...(input.parentSessionKey
        ? { parentSessionKey: normalizeSessionKey(input.parentSessionKey) }
        : {}),
      ...(threadId ? { threadId } : {}),
      ...(input.sessionId ? { sessionId: input.sessionId } : {}),
      agentId: normalizeAgentId(input.agentId),
      ...(input.workspaceDir ? { workspaceDir: input.workspaceDir } : {}),
      createdAt: now,
      lastActiveAt: now,
      status: "active",
    };

    this.records.set(sessionKey, record);
    if (this.afterCreate) {
      await this.afterCreate(record);
    }
    return record;
  }

  async touchDesktop(sessionKey: string, sessionId?: string): Promise<void> {
    const record = this.records.get(normalizeSessionKey(sessionKey));
    if (!record) {
      return;
    }

    record.lastActiveAt = Date.now();
    record.status = "active";
    if (sessionId) {
      record.sessionId = sessionId;
    }
  }

  async suspendDesktop(sessionKey: string, _reason?: string): Promise<void> {
    const record = this.records.get(normalizeSessionKey(sessionKey));
    if (!record || record.status === "suspended") {
      return;
    }

    await this.kernel.suspend(record.desktopId);
    record.status = "suspended";
  }

  async resumeDesktop(sessionKey: string): Promise<void> {
    const record = this.records.get(normalizeSessionKey(sessionKey));
    if (!record) {
      return;
    }

    await this.kernel.resume(record.desktopId);
    record.status = "active";
    record.lastActiveAt = Date.now();
  }

  async resetDesktop(
    sessionKey: string,
    next?: Omit<DesktopBindingInput, "sessionKey"> & { reason?: string },
  ): Promise<DesktopRecord> {
    const normalized = normalizeSessionKey(sessionKey);
    const existing = this.records.get(normalized);
    const binding: DesktopBindingInput = {
      sessionKey: normalized,
      ...((next?.sessionId ?? existing?.sessionId)
        ? { sessionId: next?.sessionId ?? existing?.sessionId }
        : {}),
      ...((next?.agentId ?? existing?.agentId)
        ? { agentId: next?.agentId ?? existing?.agentId }
        : {}),
      ...((next?.parentSessionKey ?? existing?.parentSessionKey)
        ? { parentSessionKey: next?.parentSessionKey ?? existing?.parentSessionKey }
        : {}),
      ...((next?.workspaceDir ?? existing?.workspaceDir)
        ? { workspaceDir: next?.workspaceDir ?? existing?.workspaceDir }
        : {}),
    };

    await this.destroyDesktop(sessionKey, next?.reason);
    return await this.ensureDesktop(binding);
  }

  async destroyDesktop(sessionKey: string, _reason?: string): Promise<void> {
    const normalized = normalizeSessionKey(sessionKey);
    const record = this.records.get(normalized);
    if (!record) {
      return;
    }

    record.status = "destroying";
    await this.kernel.destroyDesktop(record.desktopId);
    this.records.delete(normalized);
  }

  async destroyAll(reason?: string): Promise<void> {
    const sessionKeys = [...this.records.keys()];
    for (const sessionKey of sessionKeys) {
      await this.destroyDesktop(sessionKey, reason);
    }
  }

  getDesktop(sessionKey: string): DesktopRecord | undefined {
    return this.records.get(normalizeSessionKey(sessionKey));
  }

  listDesktops(): DesktopRecord[] {
    return [...this.records.values()];
  }
}
