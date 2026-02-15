import { Type } from "@sinclair/typebox";
import type { Db } from "../db.js";
import type { BridgeClient } from "../bridge-client.js";

const schema = Type.Object({
  contract_id: Type.Number({ description: "Contract ID to read" }),
  include_attachments: Type.Optional(
    Type.Boolean({ description: "If true, resolve and include attachment content (default: false)" }),
  ),
});

export function createContractReadTool(db: Db, bridge: BridgeClient) {
  return {
    name: "contract_read",
    label: "Read Contract",
    description:
      "Read full contract details including intent, qa_doc, system_ref, and optionally attachment content.",
    parameters: schema,
    async execute(_toolCallId: string, params: Record<string, unknown>) {
      const contractId = params.contract_id as number;
      if (!contractId) {
        return json({ error: "contract_id is required" });
      }

      const contract = await db.getContract(contractId);
      if (!contract) {
        return json({ error: "Contract not found", contract_id: contractId });
      }

      const result: Record<string, unknown> = {
        id: contract.id,
        state: contract.state,
        intent: contract.intent,
        qa_doc: contract.qa_doc,
        owner: contract.owner,
        project_id: contract.project_id,
        claimed_by: contract.claimed_by,
        system_ref: contract.system_ref,
        message_id: contract.message_id,
        message_platform: contract.message_platform,
        sender_email: contract.sender_email,
        sender_name: contract.sender_name,
        attachment_ids: contract.attachment_ids,
        attempt_count: contract.attempt_count,
        max_attempts: contract.max_attempts,
        qa_results: contract.qa_results,
        execution_log: contract.execution_log,
        created_at: contract.created_at,
        claimed_at: contract.claimed_at,
      };

      // Optionally resolve attachments
      if (params.include_attachments && contract.attachment_ids.length > 0) {
        const attachments: Array<Record<string, unknown>> = [];
        for (const fileId of contract.attachment_ids) {
          try {
            const att = await bridge.readAttachment(fileId);
            attachments.push({ file_id: fileId, ...((att.result as Record<string, unknown>) ?? {}) });
          } catch {
            attachments.push({ file_id: fileId, error: "Failed to read attachment" });
          }
        }
        result.attachments = attachments;
      }

      return json(result);
    },
  };
}

function json(payload: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }],
    details: payload,
  };
}
