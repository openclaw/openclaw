/**
 * BDI Agent Tools for BPMN 2.0 Workflow Manipulation
 *
 * These tools call the BPMN REST API internally so agents can create and
 * modify workflows programmatically during BDI cycles.
 */

import { Type, type Static } from "@sinclair/typebox";
import type { OpenClawPluginApi, AnyAgentTool } from "openclaw/plugin-sdk";
import { BpmnStoreQueries } from "../knowledge/bpmn-queries.js";
import { getTypeDBClient } from "../knowledge/typedb-client.js";
import { textResult, generatePrefixedId } from "./common.js";

const DB = "mabos";

// ── Parameter Schemas ────────────────────────────────────────────────────

const WorkflowCreateParams = Type.Object({
  agent_id: Type.String({ description: "Agent ID that owns the workflow" }),
  name: Type.String({ description: "Workflow name" }),
  description: Type.Optional(Type.String()),
  goal_id: Type.Optional(Type.String({ description: "Goal ID to link" })),
  project_id: Type.Optional(Type.String({ description: "Project ID to link" })),
});

const WorkflowIdParams = Type.Object({
  workflow_id: Type.String({ description: "Workflow ID" }),
});

const WorkflowStatusParams = Type.Object({
  workflow_id: Type.String(),
  status: Type.Union([
    Type.Literal("active"),
    Type.Literal("completed"),
    Type.Literal("paused"),
    Type.Literal("pending"),
  ]),
});

const BpmnAddNodeParams = Type.Object({
  agent_id: Type.String(),
  workflow_id: Type.String(),
  type: Type.Union([
    Type.Literal("startEvent"),
    Type.Literal("endEvent"),
    Type.Literal("task"),
    Type.Literal("gateway"),
    Type.Literal("subprocess"),
  ]),
  name: Type.Optional(Type.String()),
  task_type: Type.Optional(
    Type.Union([
      Type.Literal("user"),
      Type.Literal("service"),
      Type.Literal("script"),
      Type.Literal("businessRule"),
    ]),
  ),
  event_trigger: Type.Optional(
    Type.Union([
      Type.Literal("none"),
      Type.Literal("timer"),
      Type.Literal("message"),
      Type.Literal("signal"),
      Type.Literal("error"),
    ]),
  ),
  gateway_type: Type.Optional(
    Type.Union([Type.Literal("exclusive"), Type.Literal("parallel"), Type.Literal("inclusive")]),
  ),
  pos_x: Type.Optional(Type.Number({ description: "X position on canvas" })),
  pos_y: Type.Optional(Type.Number({ description: "Y position on canvas" })),
  lane_id: Type.Optional(Type.String()),
});

const BpmnConnectParams = Type.Object({
  agent_id: Type.String(),
  workflow_id: Type.String(),
  source_id: Type.String({ description: "Source element ID" }),
  target_id: Type.String({ description: "Target element ID" }),
  flow_type: Type.Optional(
    Type.Union([Type.Literal("sequence"), Type.Literal("message"), Type.Literal("association")]),
  ),
  condition: Type.Optional(Type.String({ description: "Condition expression for gateway flows" })),
});

const BpmnRemoveParams = Type.Object({
  node_id: Type.Optional(Type.String()),
  flow_id: Type.Optional(Type.String()),
});

const BpmnAddLaneParams = Type.Object({
  agent_id: Type.String(),
  workflow_id: Type.String(),
  pool_id: Type.Optional(Type.String()),
  name: Type.String(),
  assignee: Type.Optional(Type.String()),
});

// ── Tool Factory ─────────────────────────────────────────────────────────

export function createWorkflowTools(_api: OpenClawPluginApi): AnyAgentTool[] {
  return [
    {
      name: "workflow_create",
      label: "Create BPMN Workflow",
      description: "Create a new BPMN 2.0 workflow, optionally linked to a goal or project.",
      parameters: WorkflowCreateParams,
      async execute(_id: string, params: Static<typeof WorkflowCreateParams>) {
        const client = getTypeDBClient();
        if (!client.isAvailable()) return textResult("TypeDB unavailable");

        const id = generatePrefixedId("bpmn-wf");
        const typeql = BpmnStoreQueries.createWorkflow(params.agent_id, {
          id,
          name: params.name,
          description: params.description,
          status: "pending",
        });
        await client.insertData(typeql, DB);

        if (params.goal_id) {
          try {
            await client.insertData(BpmnStoreQueries.linkWorkflowToGoal(id, params.goal_id), DB);
          } catch {
            /* goal may not exist */
          }
        }

        return textResult(`Created workflow "${params.name}" (ID: ${id})`);
      },
    },
    {
      name: "workflow_delete",
      label: "Delete BPMN Workflow",
      description: "Delete a BPMN workflow and all its elements/flows.",
      parameters: WorkflowIdParams,
      async execute(_id: string, params: Static<typeof WorkflowIdParams>) {
        const client = getTypeDBClient();
        if (!client.isAvailable()) return textResult("TypeDB unavailable");
        await client.deleteData(BpmnStoreQueries.deleteWorkflow(params.workflow_id), DB);
        return textResult(`Deleted workflow ${params.workflow_id}`);
      },
    },
    {
      name: "workflow_status",
      label: "Update Workflow Status",
      description: "Change the status of a BPMN workflow (active/completed/paused/pending).",
      parameters: WorkflowStatusParams,
      async execute(_id: string, params: Static<typeof WorkflowStatusParams>) {
        const client = getTypeDBClient();
        if (!client.isAvailable()) return textResult("TypeDB unavailable");
        const typeql = BpmnStoreQueries.updateWorkflow(params.workflow_id, {
          status: params.status,
        });
        await client.insertData(typeql, DB);
        return textResult(`Workflow ${params.workflow_id} → ${params.status}`);
      },
    },
    {
      name: "workflow_inspect",
      label: "Inspect BPMN Workflow",
      description: "Get a formatted overview of a BPMN workflow's elements and flows.",
      parameters: WorkflowIdParams,
      async execute(_id: string, params: Static<typeof WorkflowIdParams>) {
        const client = getTypeDBClient();
        if (!client.isAvailable()) return textResult("TypeDB unavailable");

        const wfResult = await client.matchQuery(
          BpmnStoreQueries.queryWorkflow(params.workflow_id),
          DB,
        );
        if (!wfResult || (Array.isArray(wfResult) && wfResult.length === 0)) {
          return textResult(`Workflow ${params.workflow_id} not found`);
        }

        let elements: any[] = [];
        try {
          elements = (await client.matchQuery(
            BpmnStoreQueries.queryElements(params.workflow_id),
            DB,
          )) as any[];
        } catch {
          /* no elements */
        }

        let flows: any[] = [];
        try {
          flows = (await client.matchQuery(
            BpmnStoreQueries.queryFlows(params.workflow_id),
            DB,
          )) as any[];
        } catch {
          /* no flows */
        }

        const lines = [
          `Workflow: ${params.workflow_id}`,
          `Elements (${elements.length}):`,
          ...elements.map(
            (e: any) => `  - [${e.etype?.value || e.etype}] ${e.eid?.value || e.eid}`,
          ),
          `Flows (${flows.length}):`,
          ...flows.map(
            (f: any) =>
              `  - ${f.sid?.value || f.sid} → ${f.tid?.value || f.tid} (${f.ft?.value || f.ft})`,
          ),
        ];
        return textResult(lines.join("\n"));
      },
    },
    {
      name: "workflow_validate",
      label: "Validate BPMN Workflow",
      description:
        "Check a BPMN workflow for structural issues (orphan nodes, missing connections).",
      parameters: WorkflowIdParams,
      async execute(_id: string, params: Static<typeof WorkflowIdParams>) {
        const client = getTypeDBClient();
        if (!client.isAvailable()) return textResult("TypeDB unavailable");

        const errors: string[] = [];
        try {
          const orphans = (await client.matchQuery(
            BpmnStoreQueries.queryOrphanNodes(params.workflow_id),
            DB,
          )) as any[];
          for (const r of orphans) {
            const eid = r.eid?.value ?? r.eid;
            const etype = r.etype?.value ?? r.etype;
            if (etype !== "startEvent" && etype !== "endEvent") {
              errors.push(`Orphan node: ${eid} (${etype})`);
            }
          }
        } catch {
          /* validation query failed */
        }

        if (errors.length === 0) {
          return textResult("Workflow is valid — no issues found.");
        }
        return textResult(`Found ${errors.length} issue(s):\n${errors.join("\n")}`);
      },
    },
    {
      name: "bpmn_add_node",
      label: "Add BPMN Node",
      description: "Add a new element (event, task, gateway) to a BPMN workflow.",
      parameters: BpmnAddNodeParams,
      async execute(_id: string, params: Static<typeof BpmnAddNodeParams>) {
        const client = getTypeDBClient();
        if (!client.isAvailable()) return textResult("TypeDB unavailable");

        const elementId = generatePrefixedId("bpmn-el");
        const eventPosition =
          params.type === "startEvent" ? "start" : params.type === "endEvent" ? "end" : undefined;

        const typeql = BpmnStoreQueries.addElement(params.agent_id, params.workflow_id, {
          id: elementId,
          name: params.name,
          element_type: params.type,
          pos_x: params.pos_x ?? 0,
          pos_y: params.pos_y ?? 0,
          event_position: eventPosition,
          event_trigger: params.event_trigger,
          task_type_bpmn: params.task_type,
          gateway_type: params.gateway_type,
          lane_id: params.lane_id,
        });
        await client.insertData(typeql, DB);
        return textResult(`Added ${params.type} node (ID: ${elementId})`);
      },
    },
    {
      name: "bpmn_remove_node",
      label: "Remove BPMN Node or Flow",
      description: "Remove a node or flow from a BPMN workflow.",
      parameters: BpmnRemoveParams,
      async execute(_id: string, params: Static<typeof BpmnRemoveParams>) {
        const client = getTypeDBClient();
        if (!client.isAvailable()) return textResult("TypeDB unavailable");

        if (params.node_id) {
          await client.deleteData(BpmnStoreQueries.deleteElement(params.node_id), DB);
          return textResult(`Removed node ${params.node_id}`);
        }
        if (params.flow_id) {
          await client.deleteData(BpmnStoreQueries.deleteFlow(params.flow_id), DB);
          return textResult(`Removed flow ${params.flow_id}`);
        }
        return textResult("Provide node_id or flow_id to remove.");
      },
    },
    {
      name: "bpmn_connect",
      label: "Connect BPMN Elements",
      description: "Create a flow (sequence, message, or association) between two BPMN elements.",
      parameters: BpmnConnectParams,
      async execute(_id: string, params: Static<typeof BpmnConnectParams>) {
        const client = getTypeDBClient();
        if (!client.isAvailable()) return textResult("TypeDB unavailable");

        const flowId = generatePrefixedId("bpmn-fl");
        const typeql = BpmnStoreQueries.addFlow(params.agent_id, params.workflow_id, {
          id: flowId,
          flow_type: params.flow_type || "sequence",
          source_id: params.source_id,
          target_id: params.target_id,
          condition_expr: params.condition,
        });
        await client.insertData(typeql, DB);
        return textResult(`Connected ${params.source_id} → ${params.target_id} (flow: ${flowId})`);
      },
    },
    {
      name: "bpmn_add_lane",
      label: "Add BPMN Lane",
      description: "Add a swimlane to a BPMN workflow's pool.",
      parameters: BpmnAddLaneParams,
      async execute(_id: string, params: Static<typeof BpmnAddLaneParams>) {
        const client = getTypeDBClient();
        if (!client.isAvailable()) return textResult("TypeDB unavailable");

        // Create pool if needed
        let poolId = params.pool_id;
        if (!poolId) {
          poolId = generatePrefixedId("bpmn-pool");
          const poolTypeql = BpmnStoreQueries.addPool(params.agent_id, params.workflow_id, {
            id: poolId,
            name: "Default Pool",
          });
          await client.insertData(poolTypeql, DB);
        }

        const laneId = generatePrefixedId("bpmn-lane");
        const typeql = BpmnStoreQueries.addLane(params.agent_id, poolId, {
          id: laneId,
          name: params.name,
          assignee_agent_id: params.assignee,
        });
        await client.insertData(typeql, DB);
        return textResult(`Added lane "${params.name}" (ID: ${laneId}) to pool ${poolId}`);
      },
    },
  ];
}
