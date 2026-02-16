/**
 * Draft a reply for a completed contract.
 * Uses Communication Roles for tone and attaches QA screenshot.
 */

import type { BridgeClient } from "./bridge-client.js";
import type { Contract, Db } from "./db.js";

type Logger = { info: (msg: string) => void; warn: (msg: string) => void; error: (msg: string) => void };

export async function draftReply(
  contract: Contract,
  db: Db,
  bridge: BridgeClient,
  logger?: Logger,
): Promise<{ draftId: string; replyContent: string } | null> {
  if (!contract.message_id || !contract.message_platform) {
    return null;
  }

  // Look up sender's communication style and roles for tone guidance
  let toneGuidance = "";
  if (contract.sender_email) {
    const contact = await db.getContactByEmail(contract.sender_email);
    if (contact) {
      const toneFragments: string[] = [];

      // Use communication_style from contact record
      if (contact.communication_style) {
        toneFragments.push(contact.communication_style);
      }

      // Look up role style_rules if contact has assigned roles
      if (contact.role_ids.length > 0) {
        const rolesResult = await bridge.rolesList();
        const allRoles = rolesResult.result as Record<string, unknown> | undefined;
        if (allRoles) {
          for (const roleId of contact.role_ids) {
            const roleData = findRole(allRoles, roleId);
            if (roleData?.style_rules) {
              toneFragments.push(roleData.style_rules as string);
            }
          }
        }
      }

      if (toneFragments.length > 0) {
        toneGuidance = `\n\nTone guidance for this recipient:\n${toneFragments.join("\n")}`;
      }
    }
  }

  // Build reply body using LLM
  const apiKey = process.env.OPENAI_API_KEY;
  let replyContent: string;

  if (apiKey) {
    const prompt = [
      "Write a brief, professional reply email confirming that a task has been completed.",
      `Task: ${contract.intent}`,
      contract.execution_log ? `What was done: ${contract.execution_log.slice(0, 500)}` : null,
      contract.qa_results ? `QA result: ${JSON.stringify(contract.qa_results).slice(0, 300)}` : null,
      toneGuidance || null,
      "",
      "Keep it under 4 sentences. Do not use subject line. Just the body text.",
    ].filter((s) => s !== null).join("\n");

    try {
      const resp = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model: "gpt-4o-mini",
          messages: [{ role: "user", content: prompt }],
          temperature: 0.3,
          max_tokens: 300,
        }),
        signal: AbortSignal.timeout(15_000),
      });
      const data = (await resp.json()) as {
        choices: Array<{ message: { content: string } }>;
      };
      replyContent = data.choices[0].message.content.trim();
    } catch {
      replyContent = `The requested change has been completed: ${contract.intent}`;
    }
  } else {
    replyContent = `The requested change has been completed: ${contract.intent}`;
  }

  // Create the draft via MCP — use the same account that received the original message
  const account = contract.message_account ?? "xcellerate";
  if (contract.message_platform === "outlook") {
    const draftResult = await bridge.createReplyDraft(contract.message_id, replyContent, account);
    const draftData = draftResult.result as Record<string, unknown> | undefined;
    const draftId = draftData?.draft_id as string | undefined;
    if (draftId) {
      // Attach QA screenshot if available (best-effort)
      const screenshotPath = (contract.qa_results as Record<string, unknown>)?.screenshot_path as string | undefined;
      if (screenshotPath) {
        try {
          await bridge.addAttachmentToDraft(draftId, screenshotPath, account);
        } catch (err) {
          logger?.warn(`[reply-drafter] Failed to attach screenshot for contract #${contract.id}: ${err instanceof Error ? err.message : String(err)}`);
        }
      } else {
        logger?.warn(`[reply-drafter] No screenshot available for contract #${contract.id} — reply will be sent without QA evidence`);
      }
      return { draftId, replyContent };
    }
  }

  // For Zoom, we'll draft as a direct message (no draft concept)
  return { draftId: `zoom:${contract.message_id}`, replyContent };
}

function findRole(roles: Record<string, unknown>, roleId: string): Record<string, unknown> | null {
  // Roles are grouped by dimension, search all dimensions
  for (const dimensionRoles of Object.values(roles)) {
    if (Array.isArray(dimensionRoles)) {
      const found = dimensionRoles.find(
        (r: Record<string, unknown>) => r.role_id === roleId,
      );
      if (found) return found as Record<string, unknown>;
    }
  }
  return null;
}
