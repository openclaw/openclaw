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
  entries: Array<{ entryId: string; granted: boolean; website?: string }>;
};

const host = (website: string | undefined) => (website ? new URL(website).hostname : "the site");

// Shown in the chat as well as waking the agent, so it stays one short sentence each.
// fill defaults to the newest request and its only granted login, so no ids are needed.
function approvalNoticeText(approval: FinishedApproval): string {
  const granted = approval.entries.filter((entry) => entry.granted);
  const sites = [...new Set(approval.entries.map((entry) => host(entry.website)))].join(", ");
  if (granted.length === 0) {
    return `1Password sign-in for ${sites} wasn't approved. Don't ask again unless the user wants to.`;
  }
  return `1Password approved sign-in for ${granted.map((entry) => host(entry.website)).join(", ")}. Continue: open the sign-in page and fill it.`;
}

// Short, person-readable reasons for the codes a connect card can end with.
function connectFailure(code: string | undefined): string {
  switch (code) {
    case "disconnectExistingConnectionFirst":
      return "another account is already connected";
    case "connectExpired":
      return "the link expired";
    default:
      return "it wasn't completed";
  }
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
        ? "1Password connected. Continue with the logins this task needs."
        : `1Password didn't connect: ${connectFailure(connect.code)}. Connect again only if the user asks.`,
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
