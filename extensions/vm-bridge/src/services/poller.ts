/**
 * Poller service — single async loop every 60s.
 *
 * Each tick:
 * 1. Ingest new emails + Zoom messages
 * 2. Classify each new message
 * 3. Dispatch actionable messages → create contracts → checkpoint 1
 * 4. Detect completed contracts → draft replies → checkpoint 2
 * 5. Detect stuck contracts → notify
 */

import type { Db, Contract } from "../db.js";
import type { BridgeClient } from "../bridge-client.js";
import type { VmBridgeConfig } from "../config.js";
import type { Notifier } from "../notifier.js";
import { classifyMessage } from "../classifier.js";
import { dispatchMessage } from "../dispatcher.js";
import { createContract } from "../contract-factory.js";
import { draftReply } from "../reply-drafter.js";

type Logger = {
  info: (msg: string) => void;
  warn: (msg: string) => void;
  error: (msg: string) => void;
};

export function createPollerService(
  db: Db,
  config: VmBridgeConfig,
  bridge: BridgeClient,
  notifier: Notifier,
) {
  let intervalHandle: ReturnType<typeof setInterval> | null = null;
  let logger: Logger;

  async function tick() {
    try {
      await ingestAndClassify();
      await detectCompletions();
      await detectStuck();
    } catch (err) {
      logger.error(`[vm-bridge] Poller tick failed: ${err}`);
    }
  }

  async function ingestAndClassify() {
    // 1. Ingest emails for each account
    for (const account of config.polling.accounts) {
      try {
        const result = await bridge.ingestEmails(
          account,
          config.polling.emailDaysBack,
          config.polling.maxEmailsPerRun,
        );
        const data = result.result as Record<string, unknown> | undefined;
        const created = (data?.contracts_created as number) ?? 0;
        const skipped = (data?.skipped as number) ?? 0;
        const needsReview = (data?.needs_review as number) ?? 0;

        if (created > 0 || needsReview > 0) {
          logger.info(
            `[vm-bridge] Ingested ${account}: ${created} contracts, ${needsReview} review, ${skipped} skipped`,
          );
        }

        // Process needs_review items — the existing ingest_emails already classifies,
        // but for items it flags as needs_review, we notify via email
        const reviewItems = data?.review_items as Array<Record<string, unknown>> | undefined;
        if (reviewItems) {
          for (const item of reviewItems) {
            await notifier.notifyReview(
              (item.subject as string) ?? "",
              (item.body as string) ?? "",
              (item.sender as string) ?? "",
              "Classified as needs_review by ingestion",
            );
          }
        }
      } catch (err) {
        logger.error(`[vm-bridge] Email ingestion failed for ${account}: ${err}`);
      }
    }

    // 2. Ingest Zoom messages
    if (config.polling.zoomEnabled) {
      try {
        const result = await bridge.messagesList("zoom", config.polling.emailDaysBack, 50);
        const messages = (result.result as Record<string, unknown>)?.messages as Array<Record<string, unknown>> | undefined;

        if (messages && messages.length > 0) {
          for (const msg of messages) {
            // Skip self-messages (checkpoint replies are handled by the hook)
            // Only process messages that haven't been processed yet
            const msgId = msg.id as string;
            const enrichment = await bridge.enrichmentsGet("zoom", msgId);
            const enrichData = enrichment.result as Record<string, unknown> | undefined;
            if (enrichData?.ingestion) continue; // Already processed

            const classification = await classifyMessage(
              {
                body: (msg.content as string) ?? "",
                sender_email: (msg.sender_email as string) ?? "",
                sender_name: (msg.sender_name as string) ?? "",
                platform: "zoom",
              },
              bridge,
              config.classifier.model,
            );

            // Mark as processed
            await bridge.mcpCall("enrichments_save", {
              platform: "zoom",
              message_id: msgId,
              enrichment_type: "ingestion",
              data: { classification: classification.classification, processed_at: new Date().toISOString() },
            });

            if (classification.classification === "actionable") {
              const dispatch = await dispatchMessage(
                (msg.sender_email as string) ?? "",
                (msg.content as string) ?? "",
                undefined,
                db,
                config.classifier.model,
              );

              if (dispatch.matched) {
                const contract = await createContract(db, {
                  dispatch,
                  message_id: msgId,
                  message_platform: "zoom",
                  sender_email: (msg.sender_email as string) ?? "",
                  sender_name: (msg.sender_name as string) ?? "",
                });

                const cp1MsgId = await notifier.notifyCheckpoint1(contract);
                if (cp1MsgId) {
                  await db.updateContract(contract.id, { checkpoint1_msg_id: cp1MsgId });
                }
                logger.info(`[vm-bridge] Created contract #${contract.id} from Zoom message`);
              } else if ((dispatch.confidence ?? 0) < 0.7) {
                await notifier.notifyReview(
                  "",
                  (msg.content as string) ?? "",
                  (msg.sender_email as string) ?? "",
                  "Low confidence project match",
                );
              }
            } else if (classification.classification === "needs_review") {
              await notifier.notifyReview(
                "",
                (msg.content as string) ?? "",
                (msg.sender_email as string) ?? "",
                classification.reasoning,
              );
            }
          }
        }
      } catch (err) {
        logger.error(`[vm-bridge] Zoom ingestion failed: ${err}`);
      }
    }

    // 3. For contracts created by ingest_emails() (state=RAW, no checkpoint yet),
    //    send checkpoint 1 notifications. These were created by the universal
    //    MCP's ingestion pipeline, not by our dispatcher above.
    const rawContracts = await db.findRawContracts();
    for (const contract of rawContracts) {
      try {
        const cp1MsgId = await notifier.notifyCheckpoint1(contract);
        if (cp1MsgId) {
          await db.updateContract(contract.id, { checkpoint1_msg_id: cp1MsgId });
        }
      } catch (err) {
        logger.error(`[vm-bridge] Failed to notify checkpoint 1 for #${contract.id}: ${err}`);
      }
    }
  }

  async function detectCompletions() {
    const completed = await db.findCompletedContracts();
    for (const contract of completed) {
      try {
        const draft = await draftReply(contract, db, bridge);
        if (draft) {
          await db.updateContract(contract.id, {
            reply_draft_id: draft.draftId,
            reply_content: draft.replyContent,
          });

          const updatedContract = await db.getContract(contract.id);
          if (updatedContract) {
            const cp2MsgId = await notifier.notifyCheckpoint2(updatedContract);
            if (cp2MsgId) {
              await db.updateContract(contract.id, { checkpoint2_msg_id: cp2MsgId });
            }
          }
          logger.info(`[vm-bridge] Draft reply created for contract #${contract.id}`);
        }
      } catch (err) {
        logger.error(`[vm-bridge] Failed to draft reply for #${contract.id}: ${err}`);
      }
    }
  }

  async function detectStuck() {
    const stuck = await db.findStuckContracts();
    for (const contract of stuck) {
      // Only notify once (check if we've already notified)
      if (!contract.checkpoint2_msg_id) {
        try {
          await notifier.notifyStuck(contract);
          // Use checkpoint2_msg_id as a "notified" flag for stuck contracts
          await db.updateContract(contract.id, { checkpoint2_msg_id: "stuck-notified" });
        } catch (err) {
          logger.error(`[vm-bridge] Failed to notify stuck contract #${contract.id}: ${err}`);
        }
      }
    }
  }

  return {
    id: "vm-bridge-poller",
    start: async (ctx: { logger: Logger }) => {
      logger = ctx.logger;
      logger.info(`[vm-bridge] Poller starting (interval: ${config.polling.intervalMs}ms)`);
      await tick();
      intervalHandle = setInterval(tick, config.polling.intervalMs);
    },
    stop: async (ctx: { logger: Logger }) => {
      if (intervalHandle) {
        clearInterval(intervalHandle);
        intervalHandle = null;
      }
      ctx.logger.info("[vm-bridge] Poller stopped");
    },
  };
}
