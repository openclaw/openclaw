/**
 * Approval Message Broker
 *
 * Integrates approval interlay with OpenClaw's message routing system
 * to post approval requests to Slack and monitor for reactions.
 */

import type { Router } from "express";

export interface ApprovalMessage {
  channel: string;
  message: string;
  sessionKey: string;
  userId: string;
  timestamp: string;
  messageTs?: string; // Slack message timestamp (set when posted)
}

// In-memory store of pending approvals (would be in a real DB)
const pendingApprovals = new Map<string, ApprovalMessage>();

/**
 * Register approval message broker routes with the OpenClaw gateway.
 * Call this during gateway initialization.
 */
export function registerApprovalBroker(router: Router): void {
  /**
   * POST /api/approval/request
   * Post an approval request to the configured Slack channel.
   */
  router.post("/api/approval/request", async (req, res) => {
    try {
      const { channel, message, sessionKey, userId } = req.body;

      if (!channel || !message || !sessionKey || !userId) {
        return res.status(400).json({ error: "Missing required fields" });
      }

      const approval: ApprovalMessage = {
        channel,
        message,
        sessionKey,
        userId,
        timestamp: new Date().toISOString(),
      };

      // Store for tracking
      pendingApprovals.set(sessionKey, approval);

      console.log(
        `[ApprovalBroker] Posting approval request to ${channel} for session ${sessionKey}`,
      );

      // Post to Slack via message system
      // This would normally be handled by OpenClaw's message routing
      // For now, we emit an event that the main process can handle
      if (process.send) {
        process.send({
          type: "post-message",
          channel,
          message,
          meta: { sessionKey, userId, approvalRequest: true },
        });
      }

      res.json({ success: true, sessionKey });
    } catch (err) {
      console.error("[ApprovalBroker] Failed to post approval request:", err);
      res.status(500).json({ error: "Failed to post approval request" });
    }
  });

  /**
   * POST /api/approval/reaction
   * Handle approval reaction from Slack (called via Slack event adapter).
   */
  router.post("/api/approval/reaction", async (req, res) => {
    try {
      const { reaction, sessionKey } = req.body;

      if (!reaction || !sessionKey) {
        return res.status(400).json({ error: "Missing reaction or sessionKey" });
      }

      const approval = pendingApprovals.get(sessionKey);
      if (!approval) {
        return res.status(404).json({ error: "Approval not found" });
      }

      const decision =
        reaction === "heavy_check_mark" || reaction === "white_check_mark" ? "approve" : "reject";

      console.log(
        `[ApprovalBroker] User reacted with ${reaction} to session ${sessionKey}: ${decision}`,
      );

      // Notify the session that a decision was made
      if (process.send) {
        process.send({
          type: "approval-response",
          sessionKey,
          decision,
          reaction,
        });
      }

      // Clean up
      pendingApprovals.delete(sessionKey);

      res.json({ success: true, decision, sessionKey });
    } catch (err) {
      console.error("[ApprovalBroker] Failed to handle approval reaction:", err);
      res.status(500).json({ error: "Failed to handle approval reaction" });
    }
  });

  /**
   * GET /api/approval/status/:sessionKey
   * Check the status of an approval request.
   */
  router.get("/api/approval/status/:sessionKey", (req, res) => {
    const { sessionKey } = req.params;
    const approval = pendingApprovals.get(sessionKey);

    if (!approval) {
      return res.status(404).json({ error: "Approval not found" });
    }

    res.json({
      sessionKey,
      ...approval,
    });
  });
}

/**
 * Post an approval request via the message system.
 * Called from the approval interlay.
 */
export async function postApprovalViaMessageSystem(params: {
  channel: string;
  message: string;
  sessionKey: string;
  userId: string;
}): Promise<{ messageTs?: string }> {
  try {
    // Send to gateway via process IPC
    if (process.send) {
      return new Promise((resolve) => {
        const handler = (msg: Record<string, unknown>) => {
          if (msg.type === "message-posted" && msg.sessionKey === params.sessionKey) {
            process.removeListener("message", handler as any);
            resolve({ messageTs: msg.ts as string });
          }
        };

        process.on("message", handler as any);

        process.send({
          type: "post-approval",
          channel: params.channel,
          message: params.message,
          sessionKey: params.sessionKey,
          userId: params.userId,
        });

        // Timeout after 5s
        setTimeout(() => {
          process.removeListener("message", handler as any);
          resolve({});
        }, 5000);
      });
    }

    return {};
  } catch (err) {
    console.error("[ApprovalBroker] Failed to post approval via message system:", err);
    return {};
  }
}
