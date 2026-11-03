import type { PluginRuntime } from "openclaw/plugin-sdk/core";

type SessionEvents = Pick<
  PluginRuntime["system"],
  "captureSessionEventTarget" | "enqueueSessionEvent"
>;
type EventTarget = Awaited<ReturnType<SessionEvents["captureSessionEventTarget"]>>;

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
  async notify(
    captured: { agentId: string; sessionKey: string; expectedTarget: EventTarget } | undefined,
    approval: FinishedApproval,
  ): Promise<void> {
    if (!captured || approval.state === "pending") {
      return;
    }
    try {
      const receipt = this.events.enqueueSessionEvent(approvalNoticeText(approval), {
        agentId: captured.agentId,
        sessionKey: captured.sessionKey,
        contextKey: `onepassword-approval:${approval.requestId}`,
        expectedTarget: captured.expectedTarget,
      });
      const accepted = await receipt.accepted;
      if (!accepted.ok) {
        this.warn("1Password approval: the session did not accept the follow-up.");
      }
    } catch {
      this.warn("1Password approval: could not resume the session after approval.");
    }
  }
}
