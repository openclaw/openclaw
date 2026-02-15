import { Type } from "@sinclair/typebox";
import type { Db } from "../db.js";

const schema = Type.Object({
  owner: Type.String({ description: "VM identifier to poll contracts for (e.g. 'claude-dev')" }),
});

export function createContractPollTool(db: Db) {
  return {
    name: "contract_poll",
    label: "Poll Contracts",
    description:
      "Poll for claimable contracts assigned to a VM. Returns contracts in PLANNING state that haven't been claimed yet.",
    parameters: schema,
    async execute(_toolCallId: string, params: Record<string, unknown>) {
      const owner = params.owner as string;
      if (!owner) {
        return json({ error: "owner is required" });
      }

      const contracts = await db.pollContracts(owner);
      return json({
        count: contracts.length,
        contracts: contracts.map((c) => ({
          id: c.id,
          intent: c.intent,
          qa_doc: c.qa_doc,
          project_id: c.project_id,
          system_ref: c.system_ref,
          sender_email: c.sender_email,
          attachment_ids: c.attachment_ids,
          created_at: c.created_at,
        })),
      });
    },
  };
}

function json(payload: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }],
    details: payload,
  };
}
