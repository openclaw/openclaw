import type { PluginRuntime } from "openclaw/plugin-sdk/core";

type SessionEvents = Pick<
  PluginRuntime["system"],
  "captureSessionEventTarget" | "enqueueSessionEvent"
>;
type EventTarget = Awaited<ReturnType<SessionEvents["captureSessionEventTarget"]>>;
type Captured = { agentId: string; sessionKey: string; expectedTarget: EventTarget };

// Public projection of a finished request; never carries links, tokens or references.
type FinishedApproval = {
  state: string;
  requestId: string;
  entries: Array<{ entryId: string; granted: boolean }>;
};

// Agent-facing text that resumes the task once a request leaves the pending state.
function approvalNoticeText(approval: FinishedApproval): string {
  const granted = approval.entries.filter((entry) => entry.granted).map((entry) => entry.entryId);
  const head = `1Password approval for requestId=${approval.requestId} finished with state=${approval.state}.`;
  if (granted.length === 0) {
    return `${head} No logins were granted. Tell the user and do not retry without asking.`;
  }
  return [
    head,
    `Granted entryIds: ${granted.join(", ")}.`,
    "Continue the task that requested this login: open the sign-in page in the managed browser,",
    "then call onepassword_autofill fill with this requestId, the entryId and the tab.",
  ].join(" ");
}

/**
 * Wakes the session that requested approval. The target is captured while the
 * Control UI request is current, so a later reset or replaced session is skipped.
 */
export class ApprovalNotifier {
  constructor(
    private readonly events: SessionEvents,
    private readonly warn: (message: string) => void,
  ) {}

  /** Capture the requesting session before the background checker starts. */
  async capture(target: { agentId: string; sessionKey: string }) {
    try {
      const expectedTarget = await this.events.captureSessionEventTarget(
        target.agentId,
        target.sessionKey,
      );
      return { ...target, expectedTarget };
    } catch {
      // Approval still works without a wake; the user can prompt the agent manually.
      this.warn("1Password approval: could not capture the session to resume after approval.");
      return undefined;
    }
  }

  /** Enqueue one follow-up turn for a finished request; pending results are ignored. */
  async notify(captured: Captured | undefined, approval: FinishedApproval): Promise<void> {
    if (approval.state === "pending") {
      return;
    }
    await this.enqueue(
      captured,
      approvalNoticeText(approval),
      `onepassword-approval:${approval.requestId}`,
    );
  }

  /** Resume the chat that started a connect card once its consent finishes. */
  async notifyConnect(
    captured: Captured | undefined,
    connect: { sessionId: string; state: "connected" | "failed"; code?: string },
  ): Promise<void> {
    await this.enqueue(
      captured,
      connect.state === "connected"
        ? "1Password is now connected. Continue the task that needed it: call onepassword_autofill request_logins for the logins it needs."
        : `1Password connect did not complete (code=${connect.code ?? "connectDeclined"}). Tell the user; start connect again only if they ask.`,
      `onepassword-connect:${connect.sessionId}`,
    );
  }

  private async enqueue(
    captured: Captured | undefined,
    text: string,
    contextKey: string,
  ): Promise<void> {
    if (!captured) {
      return;
    }
    try {
      const receipt = this.events.enqueueSessionEvent(text, {
        agentId: captured.agentId,
        sessionKey: captured.sessionKey,
        contextKey,
        expectedTarget: captured.expectedTarget,
      });
      const accepted = await receipt.accepted;
      if (!accepted.ok) {
        this.warn("1Password Autofill: the session did not accept the follow-up.");
      }
    } catch {
      this.warn("1Password Autofill: could not resume the session.");
    }
  }
}
