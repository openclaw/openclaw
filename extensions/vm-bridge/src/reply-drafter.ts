/**
 * Draft a reply for a completed contract.
 * Uses Communication Roles for tone and attaches QA screenshot.
 */

import type { BridgeClient } from "./bridge-client.js";
import type { Contract, Db } from "./db.js";

export async function draftReply(
  contract: Contract,
  db: Db,
  bridge: BridgeClient,
): Promise<{ draftId: string; replyContent: string } | null> {
  if (!contract.message_id || !contract.message_platform) {
    return null;
  }

  // Look up sender's communication roles for tone guidance
  let toneGuidance = "";
  if (contract.sender_email) {
    const contact = await db.getContactByEmail(contract.sender_email);
    if (contact?.roles && Object.keys(contact.roles).length > 0) {
      const rolesResult = await bridge.rolesList();
      const allRoles = rolesResult.result as Record<string, unknown> | undefined;
      if (allRoles) {
        const roleDescriptions: string[] = [];
        for (const [, roleId] of Object.entries(contact.roles)) {
          // Roles data is structured by dimension, find the matching role
          const roleData = findRole(allRoles, roleId as string);
          if (roleData?.style_rules) {
            roleDescriptions.push(roleData.style_rules as string);
          }
        }
        if (roleDescriptions.length > 0) {
          toneGuidance = `\n\nTone guidance for this recipient:\n${roleDescriptions.join("\n")}`;
        }
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

  // Create the draft via MCP
  if (contract.message_platform === "outlook") {
    const draftResult = await bridge.createReplyDraft(contract.message_id, replyContent);
    const draftData = draftResult.result as Record<string, unknown> | undefined;
    const draftId = draftData?.draft_id as string | undefined;
    if (draftId) {
      // Attach QA screenshot if available (best-effort)
      const screenshotPath = (contract.qa_results as Record<string, unknown>)?.screenshot_path as string | undefined;
      if (screenshotPath) {
        try {
          await bridge.addAttachmentToDraft(draftId, screenshotPath, "xcellerate");
        } catch {
          // Attachment is best-effort — draft still valid without it
        }
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
