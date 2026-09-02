/* oxlint-disable eslint/curly -- Keep checkpoint outcome guards compact. */
import {
  projectAgentHarnessTranscriptMessageForDisplay,
  type AgentMessage,
  type EmbeddedRunAttemptParamsV2,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import {
  commitProviderSessionTranscriptPrefix,
  hasProviderSessionTranscriptCapability,
} from "openclaw/plugin-sdk/provider-session-transcript-runtime";
import { applyCodexTranscriptTaint } from "./transcript-mirror-attestation.js";
import { codexTranscriptMirrorRuntime } from "./transcript-mirror.js";
import { attachCodexMirrorIdentity, readMirrorIdentity } from "./upstream-prompt-provenance.js";

export type CodexTranscriptCheckpointEntry = {
  read: () => AgentMessage | undefined;
  ready?: () => boolean;
  sourceFingerprint?: string;
};

/** Commits completed work in receipt order without waiting for the enclosing turn. */
export class CodexTranscriptCheckpoint {
  private readonly pending: CodexTranscriptCheckpointEntry[] = [];
  private readonly commentaryItemIds = new Set<string>();
  private lastTimestamp = 0;
  private writing = Promise.resolve();
  private tainted = false;
  private closed = false;

  constructor(
    private readonly params: EmbeddedRunAttemptParamsV2,
    private readonly threadId: string,
    private readonly turnId: string,
  ) {}

  usesProviderCapability(): boolean {
    return hasProviderSessionTranscriptCapability(this.params.hostCapabilities);
  }

  nextTimestamp = (): number => {
    this.lastTimestamp = Math.max(Date.now(), this.lastTimestamp + 1);
    return this.lastTimestamp;
  };

  enqueueCommentary = (itemId: string, entry: CodexTranscriptCheckpointEntry): void => {
    if (
      this.params.config?.ui?.prefs?.chatPersistCommentary === false ||
      this.commentaryItemIds.has(itemId)
    ) {
      return;
    }
    this.commentaryItemIds.add(itemId);
    this.enqueue({
      ...entry,
      read: () => {
        const message = entry.read();
        return message
          ? attachCodexMirrorIdentity(message, `${this.turnId}:commentary:${itemId}`)
          : undefined;
      },
    });
  };

  enqueue = (entry: CodexTranscriptCheckpointEntry): void => {
    if (this.params.sessionTarget && !this.closed) {
      this.pending.push(entry);
    }
  };

  flush(close = false): Promise<void> {
    if (this.closed) {
      return this.writing;
    }
    this.closed = close;
    this.writing = this.writing.then(async () => {
      const blocked = close ? -1 : this.pending.findIndex((entry) => entry.ready?.() === false);
      const count = blocked < 0 ? this.pending.length : blocked;
      if (count === 0) {
        return;
      }
      const taint = { tainted: this.tainted };
      const entries = this.pending.slice(0, count).flatMap((entry) => {
        const message = entry.read();
        return message
          ? [
              {
                message: projectAgentHarnessTranscriptMessageForDisplay({
                  hidden: this.params.trigger === "memory",
                  message: applyCodexTranscriptTaint(message, taint),
                }),
                sourceFingerprint: entry.sourceFingerprint,
              },
            ]
          : [];
      });
      for (const entry of entries) {
        if (entry.sourceFingerprint) {
          if (!hasProviderSessionTranscriptCapability(this.params.hostCapabilities))
            throw new Error("Codex provider transcript commit requires host capability");
          const mirrorIdentity = readMirrorIdentity(entry.message);
          if (!mirrorIdentity)
            throw new Error("Codex provider transcript message requires an exact mirror identity");
          const identity = `codex-app-server:${this.threadId}:${mirrorIdentity}`;
          const message = structuredClone(entry.message);
          Reflect.set(message, "idempotencyKey", identity);
          const outcome = await commitProviderSessionTranscriptPrefix({
            hostCapabilities: this.params.hostCapabilities,
            entries: [
              {
                eventId: identity,
                identity,
                message,
                sourceFingerprint: entry.sourceFingerprint,
              },
            ],
          });
          if (outcome.kind !== "committed" && outcome.kind !== "replayed")
            throw new Error(`Codex provider transcript commit ${outcome.kind}`);
        } else {
          await codexTranscriptMirrorRuntime.mirror({
            ...this.params.sessionTarget,
            sessionId: this.params.sessionId,
            cwd: this.params.workspaceDir,
            messages: [entry.message],
            idempotencyScope: `codex-app-server:${this.threadId}`,
            runId: this.params.runId,
            runMirrorIdentityPrefix: `${this.turnId}:`,
            config: this.params.config,
          });
        }
      }
      this.pending.splice(0, count);
      this.tainted = taint.tainted;
    });
    return this.writing;
  }
}
