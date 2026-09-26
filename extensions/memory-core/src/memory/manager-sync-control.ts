import type {
  MemorySessionSyncTarget,
  MemorySyncParams,
  MemorySyncProgressUpdate,
} from "openclaw/plugin-sdk/memory-core-host-engine-storage";

export function hasTargetedSessionSyncParams(params: MemorySyncParams | undefined): boolean {
  return Boolean(
    params?.sessions?.some((session) => session.sessionId.trim().length > 0) ||
    params?.archiveFiles?.some((sessionFile) => sessionFile.trim().length > 0),
  );
}

export class MemoryTargetedSessionSyncQueue {
  readonly archiveFiles = new Set<string>();
  readonly sessions = new Map<string, MemorySessionSyncTarget>();
  readonly progressCallbacks = new Set<NonNullable<MemorySyncParams["progress"]>>();
  force = false;
  pending: Promise<void> | null = null;

  constructor(
    private readonly owner: {
      isClosed: () => boolean;
      getSyncing: () => Promise<void> | null;
      sync: (params?: MemorySyncParams) => Promise<void>;
    },
  ) {}

  get hasPending(): boolean {
    return this.pending !== null || this.archiveFiles.size > 0 || this.sessions.size > 0;
  }

  clear(): void {
    this.archiveFiles.clear();
    this.sessions.clear();
    this.force = false;
    this.progressCallbacks.clear();
  }

  enqueue(
    targets?: Pick<MemorySyncParams, "sessions" | "archiveFiles" | "force" | "progress">,
  ): Promise<void> {
    for (const sessionFile of targets?.archiveFiles ?? []) {
      const trimmed = sessionFile.trim();
      if (trimmed) {
        this.archiveFiles.add(trimmed);
      }
    }
    for (const session of targets?.sessions ?? []) {
      const normalized = normalizeQueuedMemorySessionSyncTarget(session);
      if (normalized) {
        this.sessions.set(memorySessionSyncTargetKey(normalized), normalized);
      }
    }
    if (this.archiveFiles.size === 0 && this.sessions.size === 0) {
      return this.owner.getSyncing() ?? Promise.resolve();
    }
    if (targets?.force) {
      this.force = true;
    }
    if (targets?.progress) {
      this.progressCallbacks.add(targets.progress);
    }
    if (!this.pending) {
      this.pending = (async () => {
        try {
          await this.owner.getSyncing()?.catch(() => undefined);
          while (!this.owner.isClosed() && (this.archiveFiles.size > 0 || this.sessions.size > 0)) {
            const pendingArchiveFiles = Array.from(this.archiveFiles);
            const pendingSessions = Array.from(this.sessions.values());
            const pendingForce = this.force;
            const pendingProgressCallbacks = Array.from(this.progressCallbacks);
            this.clear();
            const progress =
              pendingProgressCallbacks.length > 0
                ? (update: MemorySyncProgressUpdate) => {
                    for (const callback of pendingProgressCallbacks) {
                      callback(update);
                    }
                  }
                : undefined;
            try {
              await this.owner.sync({
                reason: "queued-sessions",
                ...(pendingForce ? { force: true } : {}),
                sessions: pendingSessions,
                archiveFiles: pendingArchiveFiles,
                ...(progress ? { progress } : {}),
              });
            } catch (err) {
              // Merge the failed batch with arrivals queued during sync so the
              // next trigger can retry every target instead of dropping work.
              for (const archiveFile of pendingArchiveFiles) {
                this.archiveFiles.add(archiveFile);
              }
              for (const session of pendingSessions) {
                this.sessions.set(memorySessionSyncTargetKey(session), session);
              }
              if (pendingForce) {
                this.force = true;
              }
              // Every caller awaiting this queue owner receives the rejection.
              // Do not retain callbacks that could otherwise fire after their
              // originating promise has already failed.
              this.progressCallbacks.clear();
              throw err;
            }
          }
        } finally {
          if (this.owner.isClosed()) {
            // A closed manager cannot drain retained work. Release every
            // manager-owned target and caller closure with the queue owner.
            this.clear();
          }
          this.pending = null;
        }
      })();
    }
    return this.pending ?? Promise.resolve();
  }
}

function normalizeQueuedMemorySessionSyncTarget(
  target: MemorySessionSyncTarget,
): MemorySessionSyncTarget | null {
  const sessionId = target.sessionId.trim();
  if (!sessionId) {
    return null;
  }
  const agentId = target.agentId?.trim();
  const sessionKey = target.sessionKey?.trim();
  return {
    ...(agentId ? { agentId } : {}),
    sessionId,
    ...(sessionKey ? { sessionKey } : {}),
  };
}

function memorySessionSyncTargetKey(target: MemorySessionSyncTarget): string {
  return [target.agentId ?? "", target.sessionId, target.sessionKey ?? ""].join("\0");
}
