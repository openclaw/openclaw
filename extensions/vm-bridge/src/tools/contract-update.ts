import { Type } from "@sinclair/typebox";
import type { Db } from "../db.js";

const schema = Type.Object({
  contract_id: Type.Number({ description: "Contract ID to update" }),
  state: Type.Optional(
    Type.String({ description: "New state: IMPLEMENTING, DONE, STUCK" }),
  ),
  qa_results: Type.Optional(
    Type.Object({}, { additionalProperties: true, description: "QA results: {passed: bool, screenshot_url?, details?}" }),
  ),
  execution_log: Type.Optional(
    Type.String({ description: "Summary of work done by the VM agent" }),
  ),
  attempt_count: Type.Optional(
    Type.Number({ description: "Current attempt number" }),
  ),
});

export function createContractUpdateTool(db: Db) {
  return {
    name: "contract_update",
    label: "Update Contract",
    description:
      "Update a contract's state, QA results, execution log, or attempt count. Used by VM agents to report progress.",
    parameters: schema,
    async execute(_toolCallId: string, params: Record<string, unknown>) {
      const contractId = params.contract_id as number;
      if (!contractId) {
        return json({ error: "contract_id is required" });
      }

      const updates: Record<string, unknown> = {};

      if (params.state) {
        const validStates = ["IMPLEMENTING", "DONE", "STUCK"];
        if (!validStates.includes(params.state as string)) {
          return json({ error: `Invalid state. Must be one of: ${validStates.join(", ")}` });
        }
        updates.state = params.state;
        if (params.state === "DONE") {
          updates.completed_at = new Date();
        }
      }
      if (params.qa_results !== undefined) updates.qa_results = params.qa_results;
      if (params.execution_log !== undefined) updates.execution_log = params.execution_log;
      if (params.attempt_count !== undefined) updates.attempt_count = params.attempt_count;

      if (Object.keys(updates).length === 0) {
        return json({ error: "No updates provided" });
      }

      const contract = await db.updateContract(contractId, updates);
      if (!contract) {
        return json({ error: "Contract not found", contract_id: contractId });
      }

      return json({
        updated: true,
        contract: {
          id: contract.id,
          state: contract.state,
          attempt_count: contract.attempt_count,
          qa_results: contract.qa_results,
          completed_at: contract.completed_at,
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
