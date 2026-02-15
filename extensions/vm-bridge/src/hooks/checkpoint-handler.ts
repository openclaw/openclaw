/**
 * Checkpoint handler — intercepts incoming emails to process
 * approve/reject/edit replies for contract checkpoints.
 *
 * Message format: CONTRACT:<id> <action>
 *   - CONTRACT:42 approve
 *   - CONTRACT:42 reject
 *   - CONTRACT:42 edit: Updated intent text here
 *   - CONTRACT:42 revise (same as edit for checkpoint 2)
 */

import type { Db } from "../db.js";
import type { BridgeClient } from "../bridge-client.js";
import type { VmBridgeConfig } from "../config.js";

type Logger = {
  info: (msg: string) => void;
  warn: (msg: string) => void;
  error: (msg: string) => void;
};

export function createCheckpointHandler(
  db: Db,
  config: VmBridgeConfig,
  bridge: BridgeClient,
  logger: Logger,
) {
  const prefix = config.checkpoints.replyPrefix;

  return async (event: { content?: string; senderEmail?: string }) => {
    const content = event.content?.trim();
    if (!content) return;

    // Only process emails from our own checkpoint address
    if (event.senderEmail && event.senderEmail.toLowerCase() !== config.checkpoints.selfEmail.toLowerCase()) {
      return;
    }

    // Match: CONTRACT:42 approve / reject / edit: ...
    const pattern = new RegExp(
      `${escapeRegex(prefix)}(\\d+)\\s+(approve|reject|edit:\\s*(.+)|revise)`,
      "i",
    );
    const match = content.match(pattern);
    if (!match) return;

    const contractId = parseInt(match[1], 10);
    const action = match[2].toLowerCase();
    const editText = match[3]?.trim();

    const contract = await db.getContract(contractId);
    if (!contract) {
      logger.warn(`[vm-bridge] Checkpoint reply for unknown contract #${contractId}`);
      return;
    }

    // --- Checkpoint 1: Contract is RAW, waiting for approval ---
    if (contract.state === "RAW") {
      if (action === "approve") {
        await db.updateContract(contractId, { state: "PLANNING" });
        logger.info(`[vm-bridge] Contract #${contractId} approved -> PLANNING`);
      } else if (action === "reject") {
        await db.updateContract(contractId, { state: "ABANDONED" });
        logger.info(`[vm-bridge] Contract #${contractId} rejected -> ABANDONED`);
      } else if (action.startsWith("edit:") && editText) {
        await db.updateContract(contractId, { state: "PLANNING" });
        await db.updateContractIntent(contractId, editText);
        logger.info(`[vm-bridge] Contract #${contractId} edited + approved -> PLANNING`);
      }
      return;
    }

    // --- Checkpoint 2: Contract is DONE, reply draft waiting for approval ---
    if (contract.state === "DONE" && contract.reply_draft_id) {
      if (action === "approve") {
        // Send the Outlook draft
        const sendResult = await bridge.sendDraft(contract.reply_draft_id);
        const sendData = sendResult.result as Record<string, unknown> | undefined;
        if (sendData?.pending_id) {
          await bridge.confirmSend(sendData.pending_id as string);
        }
        await db.updateContract(contractId, { reply_sent: true });
        logger.info(`[vm-bridge] Contract #${contractId} reply sent`);
      } else if (action === "revise" || action.startsWith("edit:")) {
        // Clear the draft so the poller re-drafts on next tick
        await db.updateContract(contractId, {
          reply_draft_id: null as unknown as string,
          reply_content: null as unknown as string,
          checkpoint2_msg_id: null as unknown as string,
        });
        logger.info(`[vm-bridge] Contract #${contractId} reply revision requested`);
      }
    }
  };
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
