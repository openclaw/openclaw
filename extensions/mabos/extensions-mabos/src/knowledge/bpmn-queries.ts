/**
 * TypeQL Query Builders for BPMN 2.0 Workflow Entities
 *
 * Follows the same agent-scoped pattern as GoalStoreQueries:
 *   (owner: $agent, owned: $entity) isa agent_owns
 */

// ── Workflow CRUD ────────────────────────────────────────────────────────

export class BpmnStoreQueries {
  /**
   * Create a BPMN workflow scoped to an agent.
   */
  static createWorkflow(
    agentId: string,
    workflow: {
      id: string;
      name: string;
      status?: string;
      description?: string;
      version?: number;
    },
  ): string {
    const now = new Date().toISOString();
    const optionals = [
      workflow.description ? `, has description ${JSON.stringify(workflow.description)}` : "",
      workflow.version !== undefined ? `, has workflow_version ${workflow.version}` : "",
    ].join("");

    return `match
  $agent isa agent, has uid ${JSON.stringify(agentId)};
insert
  $wf isa bpmn_workflow,
    has uid ${JSON.stringify(workflow.id)},
    has name ${JSON.stringify(workflow.name)},
    has status ${JSON.stringify(workflow.status || "pending")}${optionals},
    has created_at ${JSON.stringify(now)},
    has updated_at ${JSON.stringify(now)};
  (owner: $agent, owned: $wf) isa agent_owns;`;
  }

  /**
   * Query a single workflow by ID with all elements, flows, pools, lanes.
   */
  static queryWorkflow(workflowId: string): string {
    return `match
  $wf isa bpmn_workflow, has uid ${JSON.stringify(workflowId)},
    has name $wn, has status $ws;`;
  }

  /**
   * Query all workflows for an agent, optionally filtered.
   */
  static queryWorkflows(agentId: string, filters?: { status?: string; goalId?: string }): string {
    const clauses: string[] = [
      `$agent isa agent, has uid ${JSON.stringify(agentId)};`,
      `$wf isa bpmn_workflow, has uid $wfid, has name $wn, has status $ws, has created_at $wc, has updated_at $wu;`,
      `(owner: $agent, owned: $wf) isa agent_owns;`,
    ];
    if (filters?.status) {
      clauses.push(`$ws = ${JSON.stringify(filters.status)};`);
    }
    return `match\n  ${clauses.join("\n  ")}`;
  }

  /**
   * Update workflow metadata (name, status, description).
   */
  static updateWorkflow(
    workflowId: string,
    fields: { name?: string; status?: string; description?: string },
  ): string {
    const now = new Date().toISOString();
    const deletes: string[] = [];
    const inserts: string[] = [];

    if (fields.name !== undefined) {
      deletes.push(`$wf has $old_name;`);
      inserts.push(`$wf has name ${JSON.stringify(fields.name)};`);
    }
    if (fields.status !== undefined) {
      deletes.push(`$wf has $old_status;`);
      inserts.push(`$wf has status ${JSON.stringify(fields.status)};`);
    }
    if (fields.description !== undefined) {
      deletes.push(`$wf has $old_desc;`);
      inserts.push(`$wf has description ${JSON.stringify(fields.description)};`);
    }

    inserts.push(`$wf has updated_at ${JSON.stringify(now)};`);
    deletes.push(`$wf has $old_updated;`);

    return `match
  $wf isa bpmn_workflow, has uid ${JSON.stringify(workflowId)}, has updated_at $old_updated${fields.name !== undefined ? ", has name $old_name" : ""}${fields.status !== undefined ? ", has status $old_status" : ""}${fields.description !== undefined ? ", has description $old_desc" : ""};
delete
  ${deletes.join("\n  ")}
insert
  ${inserts.join("\n  ")}`;
  }

  /**
   * Delete a workflow and all contained entities (cascade).
   */
  static deleteWorkflow(workflowId: string): string {
    return `match
  $wf isa bpmn_workflow, has uid ${JSON.stringify(workflowId)};
delete
  $wf isa bpmn_workflow;`;
  }

  // ── Element CRUD ─────────────────────────────────────────────────────

  /**
   * Add a BPMN element to a workflow.
   */
  static addElement(
    agentId: string,
    workflowId: string,
    element: {
      id: string;
      name?: string;
      element_type: string;
      pos_x: number;
      pos_y: number;
      size_w?: number;
      size_h?: number;
      event_position?: string;
      event_trigger?: string;
      event_catching?: boolean;
      task_type_bpmn?: string;
      loop_type?: string;
      gateway_type?: string;
      subprocess_type?: string;
      assignee_agent_id?: string;
      action_tool?: string;
      lane_id?: string;
      documentation?: string;
    },
  ): string {
    const now = new Date().toISOString();
    const opt = (key: string, val: string | number | boolean | undefined) => {
      if (val === undefined) return "";
      if (typeof val === "boolean") return `, has ${key} ${val}`;
      if (typeof val === "number") return `, has ${key} ${val}`;
      return `, has ${key} ${JSON.stringify(val)}`;
    };

    const optionals = [
      opt("name", element.name),
      opt("event_position", element.event_position),
      opt("event_trigger", element.event_trigger),
      opt("event_catching", element.event_catching),
      opt("task_type_bpmn", element.task_type_bpmn),
      opt("loop_type", element.loop_type),
      opt("gateway_type", element.gateway_type),
      opt("subprocess_type", element.subprocess_type),
      opt("assignee_agent_id", element.assignee_agent_id),
      opt("action_tool", element.action_tool),
      opt("lane_id", element.lane_id),
      opt("documentation", element.documentation),
    ].join("");

    return `match
  $agent isa agent, has uid ${JSON.stringify(agentId)};
  $wf isa bpmn_workflow, has uid ${JSON.stringify(workflowId)};
insert
  $el isa bpmn_element,
    has uid ${JSON.stringify(element.id)},
    has element_type ${JSON.stringify(element.element_type)},
    has pos_x ${element.pos_x},
    has pos_y ${element.pos_y},
    has size_w ${element.size_w ?? 160},
    has size_h ${element.size_h ?? 80}${optionals},
    has created_at ${JSON.stringify(now)};
  (owner: $agent, owned: $el) isa agent_owns;
  (wf_container: $wf, wf_contained: $el) isa workflow_contains_element;`;
  }

  /**
   * Update element properties.
   */
  static updateElement(
    elementId: string,
    fields: Record<string, string | number | boolean>,
  ): string {
    const deletes: string[] = [];
    const inserts: string[] = [];

    for (const [key, val] of Object.entries(fields)) {
      const varName = `$old_${key}`;
      deletes.push(`$el has ${varName};`);
      if (typeof val === "boolean") {
        inserts.push(`$el has ${key} ${val};`);
      } else if (typeof val === "number") {
        inserts.push(`$el has ${key} ${val};`);
      } else {
        inserts.push(`$el has ${key} ${JSON.stringify(val)};`);
      }
    }

    // Build match clause that fetches old values
    const matchOlds = Object.keys(fields)
      .map((key) => `, has ${key} $old_${key}`)
      .join("");

    return `match
  $el isa bpmn_element, has uid ${JSON.stringify(elementId)}${matchOlds};
delete
  ${deletes.join("\n  ")}
insert
  ${inserts.join("\n  ")}`;
  }

  /**
   * Update element position only (for drag events).
   */
  static updateElementPosition(elementId: string, x: number, y: number): string {
    return `match
  $el isa bpmn_element, has uid ${JSON.stringify(elementId)}, has pos_x $old_x, has pos_y $old_y;
delete
  $el has $old_x;
  $el has $old_y;
insert
  $el has pos_x ${x};
  $el has pos_y ${y};`;
  }

  /**
   * Delete an element by ID.
   */
  static deleteElement(elementId: string): string {
    return `match
  $el isa bpmn_element, has uid ${JSON.stringify(elementId)};
delete
  $el isa bpmn_element;`;
  }

  /**
   * Query all elements for a workflow.
   */
  static queryElements(workflowId: string): string {
    return `match
  $wf isa bpmn_workflow, has uid ${JSON.stringify(workflowId)};
  (wf_container: $wf, wf_contained: $el) isa workflow_contains_element;
  $el isa bpmn_element, has uid $eid, has element_type $etype, has pos_x $px, has pos_y $py, has size_w $sw, has size_h $sh;`;
  }

  // ── Flow CRUD ────────────────────────────────────────────────────────

  /**
   * Create a flow connecting two elements.
   */
  static addFlow(
    agentId: string,
    workflowId: string,
    flow: {
      id: string;
      flow_type: string;
      source_id: string;
      target_id: string;
      name?: string;
      condition_expr?: string;
      is_default?: boolean;
    },
  ): string {
    const now = new Date().toISOString();
    const opt = (key: string, val: string | boolean | undefined) => {
      if (val === undefined) return "";
      if (typeof val === "boolean") return `, has ${key} ${val}`;
      return `, has ${key} ${JSON.stringify(val)}`;
    };

    const optionals = [
      opt("name", flow.name),
      opt("condition_expr", flow.condition_expr),
      opt("is_default", flow.is_default),
    ].join("");

    return `match
  $agent isa agent, has uid ${JSON.stringify(agentId)};
  $wf isa bpmn_workflow, has uid ${JSON.stringify(workflowId)};
  $src isa bpmn_element, has uid ${JSON.stringify(flow.source_id)};
  $tgt isa bpmn_element, has uid ${JSON.stringify(flow.target_id)};
insert
  $fl isa bpmn_flow,
    has uid ${JSON.stringify(flow.id)},
    has flow_type ${JSON.stringify(flow.flow_type)}${optionals},
    has created_at ${JSON.stringify(now)};
  (owner: $agent, owned: $fl) isa agent_owns;
  (wff_container: $wf, wff_contained: $fl) isa workflow_contains_flow;
  (flow_source: $src, flow_target: $tgt, flow_edge: $fl) isa flow_connects;`;
  }

  /**
   * Update a flow's properties.
   */
  static updateFlow(flowId: string, fields: Record<string, string | boolean>): string {
    const deletes: string[] = [];
    const inserts: string[] = [];
    const matchOlds = Object.keys(fields)
      .map((key) => `, has ${key} $old_${key}`)
      .join("");

    for (const [key, val] of Object.entries(fields)) {
      deletes.push(`$fl has $old_${key};`);
      if (typeof val === "boolean") {
        inserts.push(`$fl has ${key} ${val};`);
      } else {
        inserts.push(`$fl has ${key} ${JSON.stringify(val)};`);
      }
    }

    return `match
  $fl isa bpmn_flow, has uid ${JSON.stringify(flowId)}${matchOlds};
delete
  ${deletes.join("\n  ")}
insert
  ${inserts.join("\n  ")}`;
  }

  /**
   * Delete a flow by ID.
   */
  static deleteFlow(flowId: string): string {
    return `match
  $fl isa bpmn_flow, has uid ${JSON.stringify(flowId)};
delete
  $fl isa bpmn_flow;`;
  }

  /**
   * Query all flows for a workflow.
   */
  static queryFlows(workflowId: string): string {
    return `match
  $wf isa bpmn_workflow, has uid ${JSON.stringify(workflowId)};
  (wff_container: $wf, wff_contained: $fl) isa workflow_contains_flow;
  $fl isa bpmn_flow, has uid $fid, has flow_type $ft;
  (flow_source: $src, flow_target: $tgt, flow_edge: $fl) isa flow_connects;
  $src has uid $sid;
  $tgt has uid $tid;`;
  }

  // ── Swimlane CRUD ────────────────────────────────────────────────────

  /**
   * Add a pool to a workflow.
   */
  static addPool(
    agentId: string,
    workflowId: string,
    pool: {
      id: string;
      name: string;
      participant_ref?: string;
      is_black_box?: boolean;
    },
  ): string {
    const now = new Date().toISOString();
    const opt = (key: string, val: string | boolean | undefined) => {
      if (val === undefined) return "";
      if (typeof val === "boolean") return `, has ${key} ${val}`;
      return `, has ${key} ${JSON.stringify(val)}`;
    };

    return `match
  $agent isa agent, has uid ${JSON.stringify(agentId)};
  $wf isa bpmn_workflow, has uid ${JSON.stringify(workflowId)};
insert
  $pool isa bpmn_pool,
    has uid ${JSON.stringify(pool.id)},
    has name ${JSON.stringify(pool.name)}${opt("participant_ref", pool.participant_ref)}${opt("is_black_box", pool.is_black_box)},
    has created_at ${JSON.stringify(now)};
  (owner: $agent, owned: $pool) isa agent_owns;
  (wfp_container: $wf, wfp_contained: $pool) isa workflow_contains_pool;`;
  }

  /**
   * Add a lane to a pool.
   */
  static addLane(
    agentId: string,
    poolId: string,
    lane: {
      id: string;
      name: string;
      assignee_agent_id?: string;
    },
  ): string {
    const now = new Date().toISOString();
    const assigneeOpt = lane.assignee_agent_id
      ? `, has assignee_agent_id ${JSON.stringify(lane.assignee_agent_id)}`
      : "";

    return `match
  $agent isa agent, has uid ${JSON.stringify(agentId)};
  $pool isa bpmn_pool, has uid ${JSON.stringify(poolId)};
insert
  $lane isa bpmn_lane,
    has uid ${JSON.stringify(lane.id)},
    has name ${JSON.stringify(lane.name)}${assigneeOpt},
    has created_at ${JSON.stringify(now)};
  (owner: $agent, owned: $lane) isa agent_owns;
  (pl_container: $pool, pl_contained: $lane) isa pool_contains_lane;`;
  }

  /**
   * Update a lane.
   */
  static updateLane(laneId: string, fields: { name?: string; assignee_agent_id?: string }): string {
    const deletes: string[] = [];
    const inserts: string[] = [];
    const matchOlds: string[] = [];

    if (fields.name !== undefined) {
      matchOlds.push(`, has name $old_name`);
      deletes.push(`$lane has $old_name;`);
      inserts.push(`$lane has name ${JSON.stringify(fields.name)};`);
    }
    if (fields.assignee_agent_id !== undefined) {
      matchOlds.push(`, has assignee_agent_id $old_assignee`);
      deletes.push(`$lane has $old_assignee;`);
      inserts.push(`$lane has assignee_agent_id ${JSON.stringify(fields.assignee_agent_id)};`);
    }

    return `match
  $lane isa bpmn_lane, has uid ${JSON.stringify(laneId)}${matchOlds.join("")};
delete
  ${deletes.join("\n  ")}
insert
  ${inserts.join("\n  ")}`;
  }

  /**
   * Delete a lane.
   */
  static deleteLane(laneId: string): string {
    return `match
  $lane isa bpmn_lane, has uid ${JSON.stringify(laneId)};
delete
  $lane isa bpmn_lane;`;
  }

  /**
   * Query pools for a workflow.
   */
  static queryPools(workflowId: string): string {
    return `match
  $wf isa bpmn_workflow, has uid ${JSON.stringify(workflowId)};
  (wfp_container: $wf, wfp_contained: $pool) isa workflow_contains_pool;
  $pool isa bpmn_pool, has uid $pid, has name $pn;`;
  }

  /**
   * Query lanes for a pool.
   */
  static queryLanes(poolId: string): string {
    return `match
  $pool isa bpmn_pool, has uid ${JSON.stringify(poolId)};
  (pl_container: $pool, pl_contained: $lane) isa pool_contains_lane;
  $lane isa bpmn_lane, has uid $lid, has name $ln;`;
  }

  // ── Linkage ──────────────────────────────────────────────────────────

  /**
   * Link a workflow to a goal.
   */
  static linkWorkflowToGoal(workflowId: string, goalId: string): string {
    return `match
  $wf isa bpmn_workflow, has uid ${JSON.stringify(workflowId)};
  $goal isa goal, has uid ${JSON.stringify(goalId)};
insert
  (gh_goal: $goal, gh_workflow: $wf) isa goal_has_workflow;`;
  }

  /**
   * Link a workflow to a project (if project entity exists).
   */
  static linkWorkflowToProject(workflowId: string, projectId: string): string {
    return `match
  $wf isa bpmn_workflow, has uid ${JSON.stringify(workflowId)};
  $proj isa task, has uid ${JSON.stringify(projectId)};
insert
  (ph_project: $proj, ph_workflow: $wf) isa project_has_workflow;`;
  }

  // ── Validation Queries ───────────────────────────────────────────────

  /**
   * Find orphan nodes (no incoming or outgoing flows).
   */
  static queryOrphanNodes(workflowId: string): string {
    return `match
  $wf isa bpmn_workflow, has uid ${JSON.stringify(workflowId)};
  (wf_container: $wf, wf_contained: $el) isa workflow_contains_element;
  $el has uid $eid, has element_type $etype;
  not {
    (flow_source: $el, flow_target: $any, flow_edge: $f1) isa flow_connects;
  };
  not {
    (flow_source: $any2, flow_target: $el, flow_edge: $f2) isa flow_connects;
  };`;
  }
}
