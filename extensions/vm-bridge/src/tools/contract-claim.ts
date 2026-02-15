import { Type } from "@sinclair/typebox";
import type { Db } from "../db.js";

const schema = Type.Object({
  contract_id: Type.Number({ description: "Contract ID to claim" }),
  claimed_by: Type.String({ description: "VM instance identifier claiming this contract" }),
});

export function createContractClaimTool(db: Db) {
  return {
    name: "contract_claim",
    label: "Claim Contract",
    description:
      "Atomically claim a contract for execution. Fails if already claimed by another VM. Transitions state from PLANNING to IMPLEMENTING.",
    parameters: schema,
    async execute(_toolCallId: string, params: Record<string, unknown>) {
      const contractId = params.contract_id as number;
      const claimedBy = params.claimed_by as string;

      if (!contractId || !claimedBy) {
        return json({ error: "contract_id and claimed_by are required" });
      }

      const contract = await db.claimContract(contractId, claimedBy);
      if (!contract) {
        return json({
          error: "Claim failed — contract may not exist, not in PLANNING state, or already claimed",
          contract_id: contractId,
        });
      }

      return json({
        claimed: true,
        contract: {
          id: contract.id,
          state: contract.state,
          intent: contract.intent,
          qa_doc: contract.qa_doc,
          project_id: contract.project_id,
          system_ref: contract.system_ref,
          claimed_by: contract.claimed_by,
          claimed_at: contract.claimed_at,
        },
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
