/**
 * BPMN Migration — Converts existing tropos-goal-model.json workflows
 * to TypeDB BPMN entities.
 *
 * For each BusinessGoal.workflows[]:
 *   1. Create bpmn_workflow + goal_has_workflow
 *   2. For each step → create bpmn_element (type=task, task_type=service)
 *   3. Generate start event + end event
 *   4. Create sequence flows: start → step1 → step2 → ... → end
 *   5. Create bpmn_lane per agent in workflow.agents[]
 */

import { Type, type Static } from "@sinclair/typebox";
import type { OpenClawPluginApi, AnyAgentTool } from "openclaw/plugin-sdk";
import { BpmnStoreQueries } from "../knowledge/bpmn-queries.js";
import { getTypeDBClient } from "../knowledge/typedb-client.js";
import { textResult } from "./common.js";

const BpmnMigrateParams = Type.Object({
  business_id: Type.String({ description: "Business ID (e.g., 'vividwalls')" }),
  database: Type.Optional(
    Type.String({ description: "TypeDB database name (defaults to 'mabos')" }),
  ),
});

export function createBpmnMigrateTools(_api: OpenClawPluginApi): AnyAgentTool[] {
  return [
    {
      name: "bpmn_migrate_workflows",
      label: "Migrate Workflows to BPMN",
      description:
        "Converts existing Tropos goal model workflows into BPMN 2.0 entities in TypeDB. " +
        "Creates bpmn_workflow, bpmn_element, bpmn_flow, and bpmn_lane records.",
      parameters: BpmnMigrateParams,
      async execute(_id: string, params: Static<typeof BpmnMigrateParams>) {
        const client = getTypeDBClient();
        if (!client.isAvailable()) {
          const connected = await client.connect();
          if (!connected) {
            return textResult("TypeDB is not available. Start the server first.");
          }
        }

        const dbName = params.database || "mabos";
        const counts = {
          workflows: 0,
          elements: 0,
          flows: 0,
          lanes: 0,
          errors: [] as string[],
        };

        try {
          await client.ensureDatabase(dbName);
        } catch (e) {
          return textResult(
            `Failed to ensure database "${dbName}": ${e instanceof Error ? e.message : String(e)}`,
          );
        }

        // Load goal model from workspace
        const { readFile } = await import("node:fs/promises");
        const { join } = await import("node:path");
        const ws = _api.workspace?.dir || process.cwd();
        const modelPath = join(ws, "businesses", params.business_id, "tropos-goal-model.json");

        let goalModel: any;
        try {
          goalModel = JSON.parse(await readFile(modelPath, "utf-8"));
        } catch (e) {
          return textResult(
            `Could not read goal model at ${modelPath}: ${e instanceof Error ? e.message : String(e)}`,
          );
        }

        const goals = goalModel.goals || [];
        const defaultAgent = "vw-ceo";

        for (const goal of goals) {
          const goalWorkflows = goal.workflows || [];
          for (const wf of goalWorkflows) {
            const wfId = `bpmn-wf-${wf.id || goal.id + "-" + wf.name}`
              .replace(/\s+/g, "-")
              .toLowerCase();
            const agentId = goal.actor || defaultAgent;

            // 1. Create bpmn_workflow
            try {
              const typeql = BpmnStoreQueries.createWorkflow(agentId, {
                id: wfId,
                name: wf.name || `${goal.name} Workflow`,
                status: wf.status || "pending",
                description: `Migrated from goal: ${goal.name}`,
              });
              await client.insertData(typeql, dbName);
              counts.workflows++;
            } catch (e) {
              counts.errors.push(`Workflow ${wfId}: ${e instanceof Error ? e.message : String(e)}`);
              continue;
            }

            // 2. Link to goal
            try {
              if (goal.id) {
                const linkTypeql = BpmnStoreQueries.linkWorkflowToGoal(wfId, goal.id);
                await client.insertData(linkTypeql, dbName);
              }
            } catch {
              // Goal may not exist in TypeDB yet
            }

            // 3. Create start event
            const startId = `${wfId}-start`;
            try {
              const typeql = BpmnStoreQueries.addElement(agentId, wfId, {
                id: startId,
                element_type: "startEvent",
                event_position: "start",
                event_trigger: "none",
                pos_x: 50,
                pos_y: 200,
                size_w: 40,
                size_h: 40,
              });
              await client.insertData(typeql, dbName);
              counts.elements++;
            } catch (e) {
              counts.errors.push(`Start event: ${e instanceof Error ? e.message : String(e)}`);
            }

            // 4. Create task elements for each step
            const steps = wf.steps || [];
            const stepIds: string[] = [];
            for (let i = 0; i < steps.length; i++) {
              const step = steps[i];
              const stepId = `${wfId}-step-${step.id || i}`;
              stepIds.push(stepId);
              try {
                const typeql = BpmnStoreQueries.addElement(agentId, wfId, {
                  id: stepId,
                  name: step.name || `Step ${i + 1}`,
                  element_type: "task",
                  task_type_bpmn: "service",
                  pos_x: 200 + i * 220,
                  pos_y: 200,
                  size_w: 160,
                  size_h: 80,
                  action_tool: step.action,
                });
                await client.insertData(typeql, dbName);
                counts.elements++;
              } catch (e) {
                counts.errors.push(`Step ${stepId}: ${e instanceof Error ? e.message : String(e)}`);
              }
            }

            // 5. Create end event
            const endId = `${wfId}-end`;
            try {
              const typeql = BpmnStoreQueries.addElement(agentId, wfId, {
                id: endId,
                element_type: "endEvent",
                event_position: "end",
                pos_x: 200 + steps.length * 220,
                pos_y: 200,
                size_w: 40,
                size_h: 40,
              });
              await client.insertData(typeql, dbName);
              counts.elements++;
            } catch (e) {
              counts.errors.push(`End event: ${e instanceof Error ? e.message : String(e)}`);
            }

            // 6. Create sequence flows
            const allNodeIds = [startId, ...stepIds, endId];
            for (let i = 0; i < allNodeIds.length - 1; i++) {
              const flowId = `${wfId}-flow-${i}`;
              try {
                const typeql = BpmnStoreQueries.addFlow(agentId, wfId, {
                  id: flowId,
                  flow_type: "sequence",
                  source_id: allNodeIds[i],
                  target_id: allNodeIds[i + 1],
                });
                await client.insertData(typeql, dbName);
                counts.flows++;
              } catch (e) {
                counts.errors.push(`Flow ${flowId}: ${e instanceof Error ? e.message : String(e)}`);
              }
            }

            // 7. Create lanes per agent
            const agents = wf.agents || [];
            if (agents.length > 0) {
              // Create a pool first
              const poolId = `${wfId}-pool`;
              try {
                const typeql = BpmnStoreQueries.addPool(agentId, wfId, {
                  id: poolId,
                  name: wf.name || "Main Pool",
                });
                await client.insertData(typeql, dbName);
              } catch {
                // pool may fail
              }

              for (const ag of agents) {
                const laneId = `${wfId}-lane-${ag}`;
                try {
                  const typeql = BpmnStoreQueries.addLane(agentId, poolId, {
                    id: laneId,
                    name: ag,
                    assignee_agent_id: ag,
                  });
                  await client.insertData(typeql, dbName);
                  counts.lanes++;
                } catch (e) {
                  counts.errors.push(
                    `Lane ${laneId}: ${e instanceof Error ? e.message : String(e)}`,
                  );
                }
              }
            }
          }
        }

        const summary = [
          `BPMN Migration Complete:`,
          `  Workflows created: ${counts.workflows}`,
          `  Elements created: ${counts.elements}`,
          `  Flows created: ${counts.flows}`,
          `  Lanes created: ${counts.lanes}`,
        ];
        if (counts.errors.length > 0) {
          summary.push(
            `  Errors (${counts.errors.length}):`,
            ...counts.errors.slice(0, 10).map((e) => `    - ${e}`),
          );
        }
        return textResult(summary.join("\n"));
      },
    },
  ];
}
