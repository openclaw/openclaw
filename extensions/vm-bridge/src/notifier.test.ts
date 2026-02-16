import { describe, expect, it, vi } from "vitest";
import { Notifier } from "./notifier.js";
import type { BridgeClient } from "./bridge-client.js";
import type { Contract } from "./db.js";

function makeContract(overrides: Partial<Contract> = {}): Contract {
  return {
    id: 42,
    state: "RAW",
    intent: "Update business hours for Schaumburg",
    qa_doc: "Navigate to the GBP listing and verify Sunday hours show 8-5",
    owner: "claude-dev",
    project_id: "vvg-gbp",
    claimed_by: null,
    system_ref: {},
    message_id: "msg-1",
    message_platform: "outlook",
    message_account: null,
    sender_email: "jennifer@vvgtruck.com",
    sender_name: "Jennifer Holt",
    attachment_ids: [],
    attempt_count: 0,
    max_attempts: 3,
    qa_results: null,
    execution_log: null,
    reply_sent: false,
    reply_draft_id: null,
    reply_content: null,
    checkpoint1_msg_id: null,
    checkpoint2_msg_id: null,
    created_at: new Date(),
    claimed_at: null,
    completed_at: null,
    updated_at: new Date(),
    ...overrides,
  };
}

function createMockBridge() {
  return {
    createEmailDraft: vi.fn(async () => ({
      success: true,
      result: { draft_id: "draft-cp-123" },
    })),
    sendDraft: vi.fn(async () => ({
      success: true,
      result: { pending_id: "ps-abc" },
    })),
    confirmSend: vi.fn(async () => ({
      success: true,
      result: { message_id: "sent-msg-123" },
    })),
  } as unknown as BridgeClient;
}

describe("Notifier", () => {
  const config = { selfEmail: "mike@xcellerateeq.ai", selfAccount: "xcellerate", replyPrefix: "CONTRACT:" };

  describe("notifyCheckpoint1", () => {
    it("sends checkpoint 1 email and returns message ID", async () => {
      const bridge = createMockBridge();
      const notifier = new Notifier(bridge, config);
      const contract = makeContract();

      const msgId = await notifier.notifyCheckpoint1(contract);

      expect(msgId).toBe("sent-msg-123");
      expect(bridge.createEmailDraft).toHaveBeenCalledTimes(1);

      const [to, subject, body, account] = (bridge.createEmailDraft as any).mock.calls[0];
      expect(to).toBe("mike@xcellerateeq.ai");
      expect(account).toBe("xcellerate");
      expect(subject).toContain("CONTRACT:42");
      expect(subject).toContain("Review:");
      expect(body).toContain("CONTRACT:42");
      expect(body).toContain("Intent: Update business hours for Schaumburg");
      expect(body).toContain("Project: vvg-gbp");
      expect(body).toContain("Owner VM: claude-dev");
      expect(body).toContain("Jennifer Holt");
      expect(body).toContain("approve");
      expect(body).toContain("reject");
      expect(body).toContain("edit:");
    });

    it("sends the draft and confirms", async () => {
      const bridge = createMockBridge();
      const notifier = new Notifier(bridge, config);

      await notifier.notifyCheckpoint1(makeContract());

      expect(bridge.sendDraft).toHaveBeenCalledWith("draft-cp-123", "xcellerate");
      expect(bridge.confirmSend).toHaveBeenCalledWith("ps-abc");
    });

    it("returns null when no draft_id in create result", async () => {
      const bridge = {
        createEmailDraft: vi.fn(async () => ({ success: true, result: {} })),
        sendDraft: vi.fn(),
        confirmSend: vi.fn(),
      } as unknown as BridgeClient;
      const notifier = new Notifier(bridge, config);

      const msgId = await notifier.notifyCheckpoint1(makeContract());

      expect(msgId).toBeNull();
      expect(bridge.sendDraft).not.toHaveBeenCalled();
    });
  });

  describe("notifyCheckpoint2", () => {
    it("sends formatted checkpoint 2 email with draft preview", async () => {
      const bridge = createMockBridge();
      const notifier = new Notifier(bridge, config);
      const contract = makeContract({
        state: "DONE",
        intent: "Update hours",
        reply_content: "The hours have been updated as requested.",
        qa_results: { passed: true, screenshot_url: "/tmp/ss.png" },
      });

      await notifier.notifyCheckpoint2(contract);

      const [to, subject, body] = (bridge.createEmailDraft as any).mock.calls[0];
      expect(to).toBe("mike@xcellerateeq.ai");
      expect(subject).toContain("CONTRACT:42");
      expect(subject).toContain("Reply Draft:");
      expect(body).toContain("DONE: Update hours");
      expect(body).toContain("Draft reply: The hours have been updated");
      expect(body).toContain("approve");
      expect(body).toContain("revise");
    });
  });

  describe("notifyStuck", () => {
    it("sends stuck notification with attempt count", async () => {
      const bridge = createMockBridge();
      const notifier = new Notifier(bridge, config);
      const contract = makeContract({
        state: "STUCK",
        attempt_count: 3,
        execution_log: "Failed to find the edit button after 3 attempts",
      });

      await notifier.notifyStuck(contract);

      const [to, subject, body] = (bridge.createEmailDraft as any).mock.calls[0];
      expect(subject).toContain("STUCK:");
      expect(subject).toContain("CONTRACT:42");
      expect(body).toContain("Attempts: 3/3");
      expect(body).toContain("Failed to find the edit button");
    });
  });

  describe("notifyReview", () => {
    it("sends review notification with reason", async () => {
      const bridge = createMockBridge();
      const notifier = new Notifier(bridge, config);

      await notifier.notifyReview(
        "Quarterly report",
        "Please review the attached quarterly report and let me know your thoughts.",
        "cfo@company.com",
        "Classified as needs_review by ingestion",
      );

      const [to, subject, body] = (bridge.createEmailDraft as any).mock.calls[0];
      expect(subject).toContain("NEEDS REVIEW");
      expect(subject).toContain("cfo@company.com");
      expect(body).toContain("From: cfo@company.com");
      expect(body).toContain("Subject: Quarterly report");
      expect(body).toContain("Classified as needs_review");
    });
  });
});
