import type { AcpSessionStore } from "@openclaw/acp-core/session";
import type { AcpBackgroundRun, AcpPendingPrompt } from "./translator.prompt-state.js";

// Prompt-less background runs are bounded so a long-lived bridge cannot
// accumulate streaming state for runs that never reach a terminal state.
const MAX_BACKGROUND_RUNS = 64;
// Settled prompt runs stay excluded from background delivery so late gateway
// events for them cannot be re-delivered through a fresh background context.
const MAX_PROMPT_RUN_IDS = 256;
// Runs whose session rebound to another gateway key stay quarantined: a
// gateway run belongs to the session it started under, so events arriving
// under a different key must not re-attach it to the rebound session.
const MAX_REVOKED_RUN_IDS = 256;

/**
 * Attaches prompt-less gateway runs (e.g. a sub-agent completion waking the
 * requester session after its turn ended) to the open ACP session sharing
 * their session key, so their assistant text and tool events reach the client
 * as session/update notifications without settling any session/prompt response.
 */
export class AcpBackgroundRunRegistry {
  private readonly runs = new Map<string, AcpBackgroundRun>();
  private readonly promptRunIds = new Set<string>();
  private readonly revokedRunIds = new Set<string>();

  constructor(
    private readonly sessionStore: AcpSessionStore,
    private readonly pendingPrompts: Map<string, AcpPendingPrompt>,
    private readonly log: (msg: string) => void,
  ) {}

  /** Records a run this bridge started as a prompt; its post-settlement events stay excluded. */
  rememberPromptRun(runId: string): void {
    this.promptRunIds.add(runId);
    if (this.promptRunIds.size > MAX_PROMPT_RUN_IDS) {
      const oldest = this.promptRunIds.values().next().value;
      if (oldest !== undefined) {
        this.promptRunIds.delete(oldest);
      }
    }
  }

  /** Records a run whose session rebound elsewhere; it can never re-attach. */
  private rememberRevokedRun(runId: string): void {
    this.revokedRunIds.add(runId);
    if (this.revokedRunIds.size > MAX_REVOKED_RUN_IDS) {
      const oldest = this.revokedRunIds.values().next().value;
      if (oldest !== undefined) {
        this.revokedRunIds.delete(oldest);
      }
    }
  }

  /** Returns the retained streaming context for a prompt-less run, attaching one when eligible. */
  resolve(sessionKey: string, runId?: string): AcpBackgroundRun | undefined {
    if (!runId) {
      return undefined;
    }
    const existing = this.runs.get(runId);
    if (existing) {
      // Delivery authority is the session store's current binding, not the
      // retained route: closure or reassignment (session/resume, session/load)
      // revokes delivery even for an already attached run. Events must also
      // arrive under the same key the run attached under; a foreign key never
      // re-targets a cached context into a session now bound elsewhere.
      const session = this.sessionStore.getSession(existing.sessionId);
      if (!session || session.sessionKey !== sessionKey || existing.sessionKey !== sessionKey) {
        this.runs.delete(runId);
        if (session) {
          this.log(
            `background run revoked: ${existing.sessionId} rebound from ${existing.sessionKey} to ${session.sessionKey}`,
          );
          this.rememberRevokedRun(runId);
        }
        return undefined;
      }
      // A prompt that started after attachment owns the session now; retained
      // contexts follow the same no-pending-prompt rule as fresh attaches so a
      // foreign run can never interleave into the active prompt stream. The
      // context is retained (not deleted) so post-prompt deltas still dedupe.
      if (this.pendingPrompts.has(existing.sessionId)) {
        return undefined;
      }
      if (session.ledgerSessionId) {
        existing.ledgerSessionId = session.ledgerSessionId;
      } else {
        delete existing.ledgerSessionId;
      }
      return existing;
    }
    // Late events from a run this bridge started as a prompt must not be
    // re-delivered through a fresh background context after settlement.
    if (this.promptRunIds.has(runId) || this.revokedRunIds.has(runId)) {
      return undefined;
    }
    // Bind to an open session without a pending prompt: interleaving a
    // foreign run into an active prompt stream would break run scoping.
    const candidates = this.sessionStore.findSessionsByKey?.(sessionKey) ?? [];
    const session = candidates.find((candidate) => !this.pendingPrompts.has(candidate.sessionId));
    if (!session) {
      return undefined;
    }
    const run: AcpBackgroundRun = {
      sessionId: session.sessionId,
      sessionKey,
      ...(session.ledgerSessionId ? { ledgerSessionId: session.ledgerSessionId } : {}),
      idempotencyKey: runId,
    };
    this.runs.set(runId, run);
    if (this.runs.size > MAX_BACKGROUND_RUNS) {
      const oldest = this.runs.keys().next().value;
      if (oldest !== undefined) {
        this.runs.delete(oldest);
      }
    }
    this.log(`background run attached: ${sessionKey} (${runId}) -> ${session.sessionId}`);
    return run;
  }

  owns(run: AcpBackgroundRun): boolean {
    return this.runs.get(run.idempotencyKey) === run;
  }
}
