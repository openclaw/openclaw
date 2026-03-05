import { PendingActionStore } from "./pending-actions.js";

const NONCE_PATTERN = /CONFIRM\s*(\d{6})/i;

type ReplyEvent = {
  sessionId: string;
  content: string;
  userId: string;
};

type ReplyResult = {
  approved: boolean;
  actionId?: string;
  reason?: string;
};

export class ConfirmationListener {
  private store: PendingActionStore;

  constructor(store: PendingActionStore) {
    this.store = store;
  }

  extractNonce(content: string): string | null {
    const match = content.match(NONCE_PATTERN);
    return match ? match[1] : null;
  }

  async handleReply(reply: ReplyEvent): Promise<ReplyResult> {
    const nonce = this.extractNonce(reply.content);
    if (!nonce) {
      return { approved: false, reason: "not a confirmation reply" };
    }

    const allPending = this.store.getAll();
    const action = allPending.find((a) => a.nonce === nonce && a.sessionId === reply.sessionId);

    if (!action) {
      return { approved: false, reason: "no matching pending action" };
    }

    if (action.authorizedUserId && reply.userId !== action.authorizedUserId) {
      return { approved: false, reason: "unauthorized user" };
    }

    if (action.expiresAt < Date.now()) {
      this.store.remove(action.id);
      return { approved: false, reason: "confirmation expired" };
    }

    this.store.remove(action.id);
    return { approved: true, actionId: action.id };
  }
}
