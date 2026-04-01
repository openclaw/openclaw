/**
 * TypeQL Query Builders — Scoped per-agent via agent_owns relation
 *
 * Provides query builder classes for each storage domain:
 * - FactStoreQueries: assert, retract, query, explain facts
 * - RuleStoreQueries: create, list, toggle rules
 * - MemoryQueries: store, recall, consolidate memory items
 * - InferenceQueries: pattern matching, goal proving
 * - CBRQueries: store/retrieve cases
 *
 * All queries include agent scoping:
 *   (owner: $agent, owned: $entity) isa agent_owns
 */

// ── Fact Store Queries ──────────────────────────────────────────────────

export class FactStoreQueries {
  /**
   * Insert a fact triple scoped to an agent.
   */
  static assertFact(
    agentId: string,
    fact: {
      id: string;
      subject: string;
      predicate: string;
      object: string;
      confidence: number;
      source: string;
      validFrom?: string;
      validUntil?: string;
      derivedFrom?: string[];
      ruleId?: string;
    },
  ): string {
    const validFromClause = fact.validFrom
      ? `, has valid_from ${JSON.stringify(fact.validFrom)}`
      : "";
    const validUntilClause = fact.validUntil
      ? `, has valid_until ${JSON.stringify(fact.validUntil)}`
      : "";
    const ruleClause = fact.ruleId ? `, has rule_id ${JSON.stringify(fact.ruleId)}` : "";

    return `match
  $agent isa agent, has uid ${JSON.stringify(agentId)};
insert
  $fact isa spo_fact,
    has uid ${JSON.stringify(fact.id)},
    has subject ${JSON.stringify(fact.subject)},
    has predicate ${JSON.stringify(fact.predicate)},
    has object_value ${JSON.stringify(fact.object)},
    has confidence ${fact.confidence},
    has source ${JSON.stringify(fact.source)}${validFromClause}${validUntilClause}${ruleClause},
    has created_at ${JSON.stringify(new Date().toISOString())},
    has updated_at ${JSON.stringify(new Date().toISOString())};
  (owner: $agent, owned: $fact) isa agent_owns;`;
  }

  /**
   * Delete a fact by its uid.
   */
  static retractFact(agentId: string, factId: string): string {
    return `match
  $agent isa agent, has uid ${JSON.stringify(agentId)};
  $fact isa spo_fact, has uid ${JSON.stringify(factId)};
  (owner: $agent, owned: $fact) isa agent_owns;
delete
  $fact isa spo_fact;`;
  }

  /**
   * Query facts with optional SPO pattern filters.
   */
  static queryFacts(
    agentId: string,
    filters: {
      subject?: string;
      predicate?: string;
      object?: string;
      minConfidence?: number;
    },
  ): string {
    const clauses: string[] = [
      `$agent isa agent, has uid ${JSON.stringify(agentId)};`,
      `$fact isa spo_fact, has uid $fid, has subject $s, has predicate $p, has object_value $o, has confidence $c, has source $src;`,
      `(owner: $agent, owned: $fact) isa agent_owns;`,
    ];

    if (filters.subject && filters.subject !== "*") {
      clauses.push(`$s = ${JSON.stringify(filters.subject)};`);
    }
    if (filters.predicate) {
      clauses.push(`$p = ${JSON.stringify(filters.predicate)};`);
    }
    if (filters.object) {
      clauses.push(`$o = ${JSON.stringify(filters.object)};`);
    }
    if (filters.minConfidence !== undefined && filters.minConfidence > 0) {
      clauses.push(`$c >= ${filters.minConfidence};`);
    }

    return `match\n  ${clauses.join("\n  ")}`;
  }

  /**
   * Explain a fact by traversing derivation relationships.
   */
  static explainFact(agentId: string, factId: string): string {
    return `match
  $agent isa agent, has uid ${JSON.stringify(agentId)};
  $fact isa spo_fact, has uid ${JSON.stringify(factId)},
    has subject $s, has predicate $p, has object_value $o,
    has confidence $c, has source $src;
  (owner: $agent, owned: $fact) isa agent_owns;`;
  }
}

// ── Rule Store Queries ──────────────────────────────────────────────────

export class RuleStoreQueries {
  /**
   * Insert a rule scoped to an agent.
   */
  static createRule(
    agentId: string,
    rule: {
      id: string;
      name: string;
      description: string;
      type: string;
      conditionCount: number;
      confidenceFactor: number;
      enabled: boolean;
      domain?: string;
    },
  ): string {
    const domainClause = rule.domain ? `, has domain ${JSON.stringify(rule.domain)}` : "";

    return `match
  $agent isa agent, has uid ${JSON.stringify(agentId)};
insert
  $rule isa knowledge_rule,
    has uid ${JSON.stringify(rule.id)},
    has name ${JSON.stringify(rule.name)},
    has description ${JSON.stringify(rule.description)},
    has rule_type ${JSON.stringify(rule.type)},
    has condition_count ${rule.conditionCount},
    has confidence_factor ${rule.confidenceFactor},
    has enabled ${rule.enabled}${domainClause},
    has created_at ${JSON.stringify(new Date().toISOString())};
  (owner: $agent, owned: $rule) isa agent_owns;`;
  }

  /**
   * List rules for an agent, optionally filtered by type.
   */
  static listRules(agentId: string, type?: string): string {
    const typeClause = type && type !== "all" ? `, has rule_type ${JSON.stringify(type)}` : "";

    return `match
  $agent isa agent, has uid ${JSON.stringify(agentId)};
  $rule isa knowledge_rule, has uid $rid, has name $n, has rule_type $t, has enabled $e${typeClause};
  (owner: $agent, owned: $rule) isa agent_owns;`;
  }

  /**
   * Toggle a rule's enabled state.
   */
  static toggleRule(agentId: string, ruleId: string, enabled: boolean): string {
    return `match
  $agent isa agent, has uid ${JSON.stringify(agentId)};
  $rule isa knowledge_rule, has uid ${JSON.stringify(ruleId)}, has enabled $old_enabled;
  (owner: $agent, owned: $rule) isa agent_owns;
delete
  $rule has $old_enabled;
insert
  $rule has enabled ${enabled};`;
  }
}

// ── Memory Queries ──────────────────────────────────────────────────────

export class MemoryQueries {
  /**
   * Store a memory item scoped to an agent.
   */
  static storeItem(
    agentId: string,
    item: {
      id: string;
      content: string;
      type: string;
      importance: number;
      source: string;
      store: string;
      tags: string[];
    },
  ): string {
    const tagClauses = item.tags.map((t) => `, has tag ${JSON.stringify(t)}`).join("");
    const now = new Date().toISOString();

    return `match
  $agent isa agent, has uid ${JSON.stringify(agentId)};
insert
  $mem isa memory_item,
    has uid ${JSON.stringify(item.id)},
    has content ${JSON.stringify(item.content)},
    has memory_type ${JSON.stringify(item.type)},
    has importance ${item.importance},
    has source ${JSON.stringify(item.source)},
    has store_name ${JSON.stringify(item.store)},
    has access_count 0${tagClauses},
    has created_at ${JSON.stringify(now)},
    has accessed_at ${JSON.stringify(now)};
  (owner: $agent, owned: $mem) isa agent_owns;`;
  }

  /**
   * Recall memory items with filters.
   */
  static recallItems(
    agentId: string,
    filters: {
      query?: string;
      type?: string;
      store?: string;
      minImportance?: number;
    },
  ): string {
    const clauses: string[] = [
      `$agent isa agent, has uid ${JSON.stringify(agentId)};`,
      `$mem isa memory_item, has uid $mid, has content $c, has memory_type $t, has importance $imp, has store_name $sn;`,
      `(owner: $agent, owned: $mem) isa agent_owns;`,
    ];

    if (filters.type) {
      clauses.push(`$t = ${JSON.stringify(filters.type)};`);
    }
    if (filters.store && filters.store !== "all") {
      clauses.push(`$sn = ${JSON.stringify(filters.store)};`);
    }
    if (filters.minImportance !== undefined && filters.minImportance > 0) {
      clauses.push(`$imp >= ${filters.minImportance};`);
    }

    return `match\n  ${clauses.join("\n  ")}`;
  }

  /**
   * Consolidate: find short-term items eligible for promotion.
   */
  static consolidate(agentId: string, minImportance: number, minAccessCount: number): string {
    return `match
  $agent isa agent, has uid ${JSON.stringify(agentId)};
  $mem isa memory_item, has uid $mid, has store_name "short_term",
    has importance $imp, has access_count $ac;
  (owner: $agent, owned: $mem) isa agent_owns;
  { $imp >= ${minImportance}; } or { $ac >= ${minAccessCount}; };`;
  }
}

// ── Inference Queries ───────────────────────────────────────────────────

export class InferenceQueries {
  /**
   * Find facts matching a condition pattern (used in forward chaining).
   */
  static findMatchingPatterns(
    agentId: string,
    predicate: string,
    subject?: string,
    object?: string,
  ): string {
    const subjectClause =
      subject && !subject.startsWith("?") ? `, has subject ${JSON.stringify(subject)}` : "";
    const objectClause =
      object && !object.startsWith("?") ? `, has object_value ${JSON.stringify(object)}` : "";

    return `match
  $agent isa agent, has uid ${JSON.stringify(agentId)};
  $fact isa spo_fact, has predicate ${JSON.stringify(predicate)}${subjectClause}${objectClause},
    has subject $s, has object_value $o, has confidence $c;
  (owner: $agent, owned: $fact) isa agent_owns;`;
  }

  /**
   * Prove a goal by finding supporting facts and derivation chains.
   */
  static proveGoal(agentId: string, predicate: string, subject?: string, object?: string): string {
    const subjectClause = subject ? `, has subject ${JSON.stringify(subject)}` : "";
    const objectClause = object ? `, has object_value ${JSON.stringify(object)}` : "";

    return `match
  $agent isa agent, has uid ${JSON.stringify(agentId)};
  $fact isa spo_fact, has predicate ${JSON.stringify(predicate)}${subjectClause}${objectClause},
    has uid $fid, has subject $s, has object_value $o, has confidence $c, has source $src;
  (owner: $agent, owned: $fact) isa agent_owns;`;
  }
}

// ── CBR Queries ─────────────────────────────────────────────────────────

export class CBRQueries {
  /**
   * Store a case in TypeDB.
   */
  static storeCase(
    agentId: string,
    caseData: {
      id: string;
      situation: string;
      solution: string;
      outcome: string;
      domain: string;
    },
  ): string {
    return `match
  $agent isa agent, has uid ${JSON.stringify(agentId)};
insert
  $case isa cbr_case,
    has uid ${JSON.stringify(caseData.id)},
    has situation ${JSON.stringify(caseData.situation)},
    has solution ${JSON.stringify(caseData.solution)},
    has outcome ${JSON.stringify(caseData.outcome)},
    has domain ${JSON.stringify(caseData.domain)},
    has created_at ${JSON.stringify(new Date().toISOString())};
  (owner: $agent, owned: $case) isa agent_owns;`;
  }

  /**
   * Retrieve cases in a domain for similarity matching.
   */
  static retrieveSimilar(agentId: string, domain: string): string {
    return `match
  $agent isa agent, has uid ${JSON.stringify(agentId)};
  $case isa cbr_case, has uid $cid, has situation $sit, has solution $sol,
    has outcome $out, has domain ${JSON.stringify(domain)};
  (owner: $agent, owned: $case) isa agent_owns;`;
  }
}

// ── Goal Store Queries ──────────────────────────────────────────────────

export class GoalStoreQueries {
  /**
   * Insert a goal scoped to an agent.
   */
  static createGoal(
    agentId: string,
    goal: {
      id: string;
      name: string;
      description: string;
      hierarchy_level: string;
      success_criteria?: string;
      deadline?: string;
      priority: number;
      status?: string;
      parent_goal_id?: string;
    },
  ): string {
    const now = new Date().toISOString();
    const optionals = [
      goal.success_criteria
        ? `, has success_criteria ${JSON.stringify(goal.success_criteria)}`
        : "",
      goal.deadline ? `, has deadline ${JSON.stringify(goal.deadline)}` : "",
      goal.parent_goal_id ? `, has parent_goal_id ${JSON.stringify(goal.parent_goal_id)}` : "",
    ].join("");

    return `match
  $agent isa agent, has uid ${JSON.stringify(agentId)};
insert
  $goal isa goal,
    has uid ${JSON.stringify(goal.id)},
    has name ${JSON.stringify(goal.name)},
    has description ${JSON.stringify(goal.description)},
    has hierarchy_level ${JSON.stringify(goal.hierarchy_level)},
    has priority ${goal.priority},
    has progress 0.0,
    has status ${JSON.stringify(goal.status || "active")}${optionals},
    has created_at ${JSON.stringify(now)},
    has updated_at ${JSON.stringify(now)};
  (owner: $agent, owned: $goal) isa agent_owns;`;
  }

  /**
   * Link a desire to a goal via desire_motivates_goal relation.
   */
  static linkDesireToGoal(agentId: string, desireId: string, goalId: string): string {
    return `match
  $agent isa agent, has uid ${JSON.stringify(agentId)};
  $desire isa desire, has uid ${JSON.stringify(desireId)};
  $goal isa goal, has uid ${JSON.stringify(goalId)};
  (owner: $agent, owned: $desire) isa agent_owns;
  (owner: $agent, owned: $goal) isa agent_owns;
insert
  (motivator: $desire, motivated: $goal) isa desire_motivates_goal;`;
  }

  /**
   * Link a goal to a plan via goal_requires_plan relation.
   */
  static linkGoalToPlan(agentId: string, goalId: string, planId: string): string {
    return `match
  $agent isa agent, has uid ${JSON.stringify(agentId)};
  $goal isa goal, has uid ${JSON.stringify(goalId)};
  $plan isa plan, has uid ${JSON.stringify(planId)};
  (owner: $agent, owned: $goal) isa agent_owns;
  (owner: $agent, owned: $plan) isa agent_owns;
insert
  (requiring: $goal, required: $plan) isa goal_requires_plan;`;
  }

  /**
   * Query goals with optional filters.
   */
  static queryGoals(
    agentId: string,
    filters: { hierarchy_level?: string; status?: string; minPriority?: number },
  ): string {
    const clauses: string[] = [
      `$agent isa agent, has uid ${JSON.stringify(agentId)};`,
      `$goal isa goal, has uid $gid, has name $n, has hierarchy_level $hl, has priority $p, has status $st, has progress $pr;`,
      `(owner: $agent, owned: $goal) isa agent_owns;`,
    ];
    if (filters.hierarchy_level) {
      clauses.push(`$hl = ${JSON.stringify(filters.hierarchy_level)};`);
    }
    if (filters.status) {
      clauses.push(`$st = ${JSON.stringify(filters.status)};`);
    }
    if (filters.minPriority !== undefined && filters.minPriority > 0) {
      clauses.push(`$p >= ${filters.minPriority};`);
    }
    return `match\n  ${clauses.join("\n  ")}`;
  }

  /**
   * Update goal progress and optionally status.
   */
  static updateGoalProgress(
    agentId: string,
    goalId: string,
    progress: number,
    status?: string,
  ): string {
    const now = new Date().toISOString();
    const statusDelete = status ? `\n  $goal has $old_status;` : "";
    const statusInsert = status ? `\n  $goal has status ${JSON.stringify(status)};` : "";

    return `match
  $agent isa agent, has uid ${JSON.stringify(agentId)};
  $goal isa goal, has uid ${JSON.stringify(goalId)}, has progress $old_progress, has updated_at $old_updated;${statusDelete}
  (owner: $agent, owned: $goal) isa agent_owns;
delete
  $goal has $old_progress;
  $goal has $old_updated;${statusDelete ? `\n  $goal has $old_status;` : ""}
insert
  $goal has progress ${progress};
  $goal has updated_at ${JSON.stringify(now)};${statusInsert}`;
  }
}

// ── Desire Store Queries ────────────────────────────────────────────────

export class DesireStoreQueries {
  /**
   * Insert a desire scoped to an agent.
   */
  static createDesire(
    agentId: string,
    desire: {
      id: string;
      name: string;
      description: string;
      priority: number;
      importance: number;
      urgency: number;
      alignment: number;
      status?: string;
      category: string;
    },
  ): string {
    const now = new Date().toISOString();
    return `match
  $agent isa agent, has uid ${JSON.stringify(agentId)};
insert
  $desire isa desire,
    has uid ${JSON.stringify(desire.id)},
    has name ${JSON.stringify(desire.name)},
    has description ${JSON.stringify(desire.description)},
    has priority ${desire.priority},
    has importance ${desire.importance},
    has urgency ${desire.urgency},
    has alignment ${desire.alignment},
    has status ${JSON.stringify(desire.status || "active")},
    has category ${JSON.stringify(desire.category)},
    has created_at ${JSON.stringify(now)};
  (owner: $agent, owned: $desire) isa agent_owns;`;
  }

  /**
   * Query desires with optional filters.
   */
  static queryDesires(agentId: string, filters: { category?: string; status?: string }): string {
    const clauses: string[] = [
      `$agent isa agent, has uid ${JSON.stringify(agentId)};`,
      `$desire isa desire, has uid $did, has name $n, has priority $p, has category $cat, has status $st;`,
      `(owner: $agent, owned: $desire) isa agent_owns;`,
    ];
    if (filters.category) {
      clauses.push(`$cat = ${JSON.stringify(filters.category)};`);
    }
    if (filters.status) {
      clauses.push(`$st = ${JSON.stringify(filters.status)};`);
    }
    return `match\n  ${clauses.join("\n  ")}`;
  }
}

// ── Belief Store Queries ────────────────────────────────────────────────

export class BeliefStoreQueries {
  /**
   * Insert a belief scoped to an agent.
   */
  static createBelief(
    agentId: string,
    belief: {
      id: string;
      category: string;
      certainty: number;
      subject: string;
      content: string;
      source: string;
    },
  ): string {
    const now = new Date().toISOString();
    return `match
  $agent isa agent, has uid ${JSON.stringify(agentId)};
insert
  $belief isa belief,
    has uid ${JSON.stringify(belief.id)},
    has category ${JSON.stringify(belief.category)},
    has certainty ${belief.certainty},
    has subject ${JSON.stringify(belief.subject)},
    has content ${JSON.stringify(belief.content)},
    has source ${JSON.stringify(belief.source)},
    has created_at ${JSON.stringify(now)},
    has updated_at ${JSON.stringify(now)};
  (owner: $agent, owned: $belief) isa agent_owns;`;
  }

  /**
   * Link a belief to a goal via belief_supports_goal relation.
   */
  static linkBeliefToGoal(agentId: string, beliefId: string, goalId: string): string {
    return `match
  $agent isa agent, has uid ${JSON.stringify(agentId)};
  $belief isa belief, has uid ${JSON.stringify(beliefId)};
  $goal isa goal, has uid ${JSON.stringify(goalId)};
  (owner: $agent, owned: $belief) isa agent_owns;
  (owner: $agent, owned: $goal) isa agent_owns;
insert
  (believer: $belief, supported: $goal) isa belief_supports_goal;`;
  }

  /**
   * Query beliefs with optional filters.
   */
  static queryBeliefs(
    agentId: string,
    filters: { category?: string; minCertainty?: number },
  ): string {
    const clauses: string[] = [
      `$agent isa agent, has uid ${JSON.stringify(agentId)};`,
      `$belief isa belief, has uid $bid, has category $cat, has certainty $cert, has subject $sub, has content $c;`,
      `(owner: $agent, owned: $belief) isa agent_owns;`,
    ];
    if (filters.category) {
      clauses.push(`$cat = ${JSON.stringify(filters.category)};`);
    }
    if (filters.minCertainty !== undefined && filters.minCertainty > 0) {
      clauses.push(`$cert >= ${filters.minCertainty};`);
    }
    return `match\n  ${clauses.join("\n  ")}`;
  }
}

// ── Decision Store Queries ───────────────────────────────────────────

export class DecisionStoreQueries {
  /**
   * Insert a decision scoped to an agent.
   */
  static createDecision(
    agentId: string,
    decision: {
      id: string;
      name: string;
      description: string;
      urgency: string;
      options: string; // JSON string of DecisionOption[]
      recommendation?: string;
      status?: string;
    },
  ): string {
    const now = new Date().toISOString();
    const recClause = decision.recommendation
      ? `, has recommendation ${JSON.stringify(decision.recommendation)}`
      : "";
    return `match
  $agent isa agent, has uid ${JSON.stringify(agentId)};
insert
  $decision isa decision,
    has uid ${JSON.stringify(decision.id)},
    has name ${JSON.stringify(decision.name)},
    has description ${JSON.stringify(decision.description)},
    has urgency_level ${JSON.stringify(decision.urgency)},
    has status ${JSON.stringify(decision.status || "pending")},
    has options_json ${JSON.stringify(decision.options)}${recClause},
    has created_at ${JSON.stringify(now)},
    has updated_at ${JSON.stringify(now)};
  (owner: $agent, owned: $decision) isa agent_owns;`;
  }

  /**
   * Resolve a decision by updating its status and chosen option.
   */
  static resolveDecision(uid: string, resolution: string): string {
    const now = new Date().toISOString();
    return `match
  $d isa decision, has uid ${JSON.stringify(uid)}, has status $old_status, has updated_at $old_updated;
delete
  $d has $old_status;
  $d has $old_updated;
insert
  $d has status ${JSON.stringify(resolution)};
  $d has updated_at ${JSON.stringify(now)};`;
  }

  /**
   * Query decisions with optional filters.
   */
  static queryDecisions(agentId?: string, status?: string): string {
    const clauses: string[] = [];
    if (agentId) {
      clauses.push(`$agent isa agent, has uid ${JSON.stringify(agentId)};`);
      clauses.push(
        `$d isa decision, has uid $did, has name $n, has description $desc, has urgency_level $urg, has status $st, has options_json $opts, has created_at $ca;`,
      );
      clauses.push(`(owner: $agent, owned: $d) isa agent_owns;`);
    } else {
      clauses.push(
        `$d isa decision, has uid $did, has name $n, has description $desc, has urgency_level $urg, has status $st, has options_json $opts, has created_at $ca;`,
      );
    }
    if (status) {
      clauses.push(`$st = ${JSON.stringify(status)};`);
    }
    return `match\n  ${clauses.join("\n  ")}`;
  }

  /**
   * Link a decision to a goal it resolves.
   */
  static linkDecisionToGoal(decisionId: string, goalId: string): string {
    return `match
  $d isa decision, has uid ${JSON.stringify(decisionId)};
  $g isa goal, has uid ${JSON.stringify(goalId)};
insert
  (resolver: $d, resolved_goal: $g) isa decision_resolves_goal;`;
  }
}

// ── Workflow Store Queries ───────────────────────────────────────────

export class WorkflowStoreQueries {
  /**
   * Insert a workflow scoped to an agent.
   */
  static createWorkflow(
    agentId: string,
    workflow: {
      id: string;
      name: string;
      workflowType: string;
      trigger: string;
      status?: string;
      cronExpression?: string;
      cronEnabled?: boolean;
      cronTimezone?: string;
    },
  ): string {
    const now = new Date().toISOString();
    const cronClauses = [
      workflow.cronExpression
        ? `,\n    has cron_expression ${JSON.stringify(workflow.cronExpression)}`
        : "",
      workflow.cronEnabled !== undefined ? `,\n    has cron_enabled ${workflow.cronEnabled}` : "",
      workflow.cronTimezone
        ? `,\n    has cron_timezone ${JSON.stringify(workflow.cronTimezone)}`
        : "",
    ].join("");
    return `match
  $agent isa agent, has uid ${JSON.stringify(agentId)};
insert
  $wf isa workflow,
    has uid ${JSON.stringify(workflow.id)},
    has name ${JSON.stringify(workflow.name)},
    has workflow_type ${JSON.stringify(workflow.workflowType)},
    has trigger ${JSON.stringify(workflow.trigger)},
    has status ${JSON.stringify(workflow.status || "active")}${cronClauses},
    has created_at ${JSON.stringify(now)},
    has updated_at ${JSON.stringify(now)};
  (owner: $agent, owned: $wf) isa agent_owns;`;
  }

  /**
   * Query workflows with optional filters.
   */
  static queryWorkflows(agentId?: string, status?: string): string {
    const clauses: string[] = [];
    if (agentId) {
      clauses.push(`$agent isa agent, has uid ${JSON.stringify(agentId)};`);
      clauses.push(
        `$wf isa workflow, has uid $wid, has name $n, has workflow_type $wt, has trigger $tr, has status $st, has created_at $ca;`,
      );
      clauses.push(`(owner: $agent, owned: $wf) isa agent_owns;`);
    } else {
      clauses.push(
        `$wf isa workflow, has uid $wid, has name $n, has workflow_type $wt, has trigger $tr, has status $st, has created_at $ca;`,
      );
    }
    if (status) {
      clauses.push(`$st = ${JSON.stringify(status)};`);
    }
    return `match\n  ${clauses.join("\n  ")}`;
  }
}

// ── Task Store Queries ──────────────────────────────────────────────

export class TaskStoreQueries {
  /**
   * Insert a task scoped to an agent.
   */
  static createTask(
    agentId: string,
    task: {
      id: string;
      name: string;
      description: string;
      taskType: string;
      assignedAgentId?: string;
      status?: string;
      priority?: number;
      estimatedDuration?: string;
      dependsOnIds?: string;
    },
  ): string {
    const now = new Date().toISOString();
    const optionals = [
      task.assignedAgentId ? `, has assigned_agent_id ${JSON.stringify(task.assignedAgentId)}` : "",
      task.priority !== undefined ? `, has priority ${task.priority}` : "",
      task.estimatedDuration
        ? `, has estimated_duration ${JSON.stringify(task.estimatedDuration)}`
        : "",
      task.dependsOnIds ? `, has depends_on_ids ${JSON.stringify(task.dependsOnIds)}` : "",
    ].join("");

    return `match
  $agent isa agent, has uid ${JSON.stringify(agentId)};
insert
  $task isa task,
    has uid ${JSON.stringify(task.id)},
    has name ${JSON.stringify(task.name)},
    has description ${JSON.stringify(task.description)},
    has task_type ${JSON.stringify(task.taskType)},
    has status ${JSON.stringify(task.status || "proposed")}${optionals},
    has created_at ${JSON.stringify(now)},
    has updated_at ${JSON.stringify(now)};
  (owner: $agent, owned: $task) isa agent_owns;`;
  }

  /**
   * Query tasks with optional filters.
   */
  static queryTasks(agentId?: string, status?: string): string {
    const clauses: string[] = [];
    if (agentId) {
      clauses.push(`$agent isa agent, has uid ${JSON.stringify(agentId)};`);
      clauses.push(
        `$t isa task, has uid $tid, has name $n, has description $desc, has task_type $tt, has status $st, has created_at $ca;`,
      );
      clauses.push(`(owner: $agent, owned: $t) isa agent_owns;`);
    } else {
      clauses.push(
        `$t isa task, has uid $tid, has name $n, has description $desc, has task_type $tt, has status $st, has created_at $ca;`,
      );
    }
    if (status) {
      clauses.push(`$st = ${JSON.stringify(status)};`);
    }
    return `match\n  ${clauses.join("\n  ")}`;
  }

  /**
   * Update a task's status.
   */
  static updateTaskStatus(uid: string, status: string): string {
    const now = new Date().toISOString();
    return `match
  $t isa task, has uid ${JSON.stringify(uid)}, has status $old_status, has updated_at $old_updated;
delete
  $t has $old_status;
  $t has $old_updated;
insert
  $t has status ${JSON.stringify(status)};
  $t has updated_at ${JSON.stringify(now)};`;
  }
}

// ── Intention Store Queries ─────────────────────────────────────────

export class IntentionStoreQueries {
  /**
   * Insert an intention scoped to an agent.
   */
  static createIntention(
    agentId: string,
    intention: {
      id: string;
      name: string;
      description: string;
      status?: string;
      commitmentStrategy?: string;
      planRef?: string;
      deadline?: string;
    },
  ): string {
    const now = new Date().toISOString();
    const optionals = [
      intention.commitmentStrategy
        ? `, has commitment_strategy ${JSON.stringify(intention.commitmentStrategy)}`
        : "",
      intention.planRef ? `, has plan_ref ${JSON.stringify(intention.planRef)}` : "",
      intention.deadline ? `, has deadline ${JSON.stringify(intention.deadline)}` : "",
    ].join("");

    return `match
  $agent isa agent, has uid ${JSON.stringify(agentId)};
insert
  $int isa intention,
    has uid ${JSON.stringify(intention.id)},
    has name ${JSON.stringify(intention.name)},
    has description ${JSON.stringify(intention.description)},
    has status ${JSON.stringify(intention.status || "active")},
    has committed_at ${JSON.stringify(now)}${optionals},
    has created_at ${JSON.stringify(now)},
    has updated_at ${JSON.stringify(now)};
  (owner: $agent, owned: $int) isa agent_owns;`;
  }

  /**
   * Query intentions with optional filters.
   */
  static queryIntentions(agentId?: string, status?: string): string {
    const clauses: string[] = [];
    if (agentId) {
      clauses.push(`$agent isa agent, has uid ${JSON.stringify(agentId)};`);
      clauses.push(
        `$int isa intention, has uid $iid, has name $n, has status $st, has created_at $ca;`,
      );
      clauses.push(`(owner: $agent, owned: $int) isa agent_owns;`);
    } else {
      clauses.push(
        `$int isa intention, has uid $iid, has name $n, has status $st, has created_at $ca;`,
      );
    }
    if (status) {
      clauses.push(`$st = ${JSON.stringify(status)};`);
    }
    return `match\n  ${clauses.join("\n  ")}`;
  }

  /**
   * Update an intention's status.
   */
  static updateIntentionStatus(uid: string, status: string): string {
    const now = new Date().toISOString();
    return `match
  $int isa intention, has uid ${JSON.stringify(uid)}, has status $old_status, has updated_at $old_updated;
delete
  $int has $old_status;
  $int has $old_updated;
insert
  $int has status ${JSON.stringify(status)};
  $int has updated_at ${JSON.stringify(now)};`;
  }
}

// ── Base Schema ─────────────────────────────────────────────────────────

/**
 * Returns the base TypeQL schema needed for MABOS knowledge storage.
 * This should be defined before ontology-derived schema.
 */
export function getBaseSchema(): string {
  return `define

  # ── Core Attributes ──────────────────────────────────────────────────
  attribute uid, value string;
  attribute name, value string;
  attribute description, value string;
  attribute confidence, value double;
  attribute source, value string;
  attribute created_at, value string;
  attribute updated_at, value string;
  attribute subject, value string;
  attribute predicate, value string;
  attribute object_value, value string;
  attribute valid_from, value string;
  attribute valid_until, value string;
  attribute rule_id, value string;
  attribute rule_type, value string;
  attribute condition_count, value integer;
  attribute confidence_factor, value double;
  attribute enabled, value boolean;
  attribute domain, value string;
  attribute content, value string;
  attribute memory_type, value string;
  attribute importance, value double;
  attribute store_name, value string;
  attribute access_count, value integer;
  attribute accessed_at, value string;
  attribute tag, value string;
  attribute situation, value string;
  attribute solution, value string;
  attribute outcome, value string;
  attribute status, value string;

  # ── BDI Cognitive Attributes ─────────────────────────────────────────
  attribute category, value string;
  attribute certainty, value double;
  attribute priority, value double;
  attribute urgency, value double;
  attribute alignment, value double;
  attribute hierarchy_level, value string;
  attribute success_criteria, value string;
  attribute deadline, value string;
  attribute progress, value double;
  attribute parent_goal_id, value string;
  attribute commitment_strategy, value string;
  attribute plan_ref, value string;
  attribute plan_source, value string;
  attribute step_count, value integer;
  attribute adaptation_notes, value string;
  attribute step_type, value string;
  attribute tool_binding, value string;
  attribute estimated_duration, value string;
  attribute sequence_order, value integer;

  # ── Agent Identity & Role Attributes ─────────────────────────────────
  attribute role_title, value string;
  attribute department, value string;
  attribute responsibilities, value string;
  attribute autonomy_level, value string;
  attribute approval_threshold, value double;
  attribute proficiency_level, value double;
  attribute skill_category, value string;
  attribute tool_access, value string;

  # ── Cron / Scheduling Attributes ────────────────────────────────────
  attribute cron_expression, value string;
  attribute cron_enabled, value boolean;
  attribute cron_timezone, value string;

  # ── Workflow & Execution Attributes ──────────────────────────────────
  attribute workflow_type, value string;
  attribute trigger, value string;
  attribute current_step_id, value string;
  attribute assigned_agent_id, value string;
  attribute depends_on_ids, value string;
  attribute task_type, value string;
  attribute tool_used, value string;
  attribute input_summary, value string;
  attribute output_summary, value string;
  attribute success, value boolean;
  attribute duration_ms, value integer;

  # ── Reasoning & Heuristics Attributes ────────────────────────────────
  attribute method_category, value string;
  attribute applicability, value string;
  attribute method_used, value string;
  attribute conclusion, value string;
  attribute reasoning_trace, value string;
  attribute decision_type, value string;
  attribute options_count, value integer;
  attribute chosen_option, value string;
  attribute impact_level, value string;
  attribute urgency_level, value string;
  attribute resolved, value boolean;
  attribute options_json, value string;
  attribute recommendation, value string;
  attribute committed_at, value string;

  # ── Core Entities ────────────────────────────────────────────────────
  entity agent,
    owns uid @key,
    owns name;

  entity spo_fact,
    owns uid @key,
    owns subject,
    owns predicate,
    owns object_value,
    owns confidence,
    owns source,
    owns valid_from,
    owns valid_until,
    owns rule_id,
    owns created_at,
    owns updated_at;

  entity knowledge_rule,
    owns uid @key,
    owns name,
    owns description,
    owns rule_type,
    owns condition_count,
    owns confidence_factor,
    owns enabled,
    owns domain,
    owns created_at;

  entity memory_item,
    owns uid @key,
    owns content,
    owns memory_type,
    owns importance,
    owns source,
    owns store_name,
    owns access_count,
    owns tag,
    owns created_at,
    owns accessed_at;

  entity cbr_case,
    owns uid @key,
    owns situation,
    owns solution,
    owns outcome,
    owns domain,
    owns created_at;

  # ── BDI Cognitive Entities ───────────────────────────────────────────
  entity belief,
    owns uid @key,
    owns category,
    owns certainty,
    owns subject,
    owns content,
    owns source,
    owns valid_from,
    owns valid_until,
    owns created_at,
    owns updated_at;

  entity desire,
    owns uid @key,
    owns name,
    owns description,
    owns priority,
    owns importance,
    owns urgency,
    owns alignment,
    owns status,
    owns category,
    owns created_at;

  entity goal,
    owns uid @key,
    owns name,
    owns description,
    owns hierarchy_level,
    owns priority,
    owns success_criteria,
    owns deadline,
    owns progress,
    owns status,
    owns parent_goal_id,
    owns created_at,
    owns updated_at;

  entity intention,
    owns uid @key,
    owns name,
    owns description,
    owns commitment_strategy,
    owns status,
    owns plan_ref,
    owns deadline,
    owns committed_at,
    owns created_at,
    owns updated_at;

  entity plan,
    owns uid @key,
    owns name,
    owns description,
    owns plan_source,
    owns step_count,
    owns confidence,
    owns adaptation_notes,
    owns status,
    owns created_at,
    owns updated_at;

  entity plan_step,
    owns uid @key,
    owns name,
    owns step_type,
    owns tool_binding,
    owns estimated_duration,
    owns status,
    owns sequence_order,
    owns cron_expression,
    owns cron_enabled,
    owns cron_timezone,
    owns created_at;

  # ── Agent Identity & Role Entities ───────────────────────────────────
  entity persona,
    owns uid @key,
    owns role_title,
    owns department,
    owns responsibilities,
    owns autonomy_level,
    owns approval_threshold,
    owns created_at;

  entity skill,
    owns uid @key,
    owns name,
    owns proficiency_level,
    owns skill_category,
    owns tool_access,
    owns created_at;

  # ── Workflow & Execution Entities ────────────────────────────────────
  entity workflow,
    owns uid @key,
    owns name,
    owns workflow_type,
    owns trigger,
    owns status,
    owns current_step_id,
    owns cron_expression,
    owns cron_enabled,
    owns cron_timezone,
    owns created_at,
    owns updated_at;

  entity task,
    owns uid @key,
    owns name,
    owns description,
    owns priority,
    owns assigned_agent_id,
    owns depends_on_ids,
    owns status,
    owns task_type,
    owns estimated_duration,
    owns created_at,
    owns updated_at;

  entity action_execution,
    owns uid @key,
    owns tool_used,
    owns input_summary,
    owns output_summary,
    owns success,
    owns duration_ms,
    owns created_at;

  # ── Reasoning & Heuristics Entities ──────────────────────────────────
  entity reasoning_method,
    owns uid @key,
    owns name,
    owns method_category,
    owns applicability,
    owns description,
    owns created_at;

  entity reasoning_result,
    owns uid @key,
    owns method_used,
    owns conclusion,
    owns confidence,
    owns reasoning_trace,
    owns created_at;

  entity decision,
    owns uid @key,
    owns name,
    owns description,
    owns status,
    owns decision_type,
    owns options_count,
    owns chosen_option,
    owns impact_level,
    owns urgency_level,
    owns resolved,
    owns options_json,
    owns recommendation,
    owns created_at,
    owns updated_at;

  # ── Core Relations ──────────────────────────────────────────────────
  relation agent_owns,
    relates owner,
    relates owned;

  # ── BDI Relations ──────────────────────────────────────────────────
  relation belief_supports_goal,
    relates believer,
    relates supported;

  relation desire_motivates_goal,
    relates motivator,
    relates motivated;

  relation goal_requires_plan,
    relates requiring,
    relates required;

  relation plan_contains_step,
    relates container,
    relates contained;

  relation step_depends_on,
    relates dependent,
    relates dependency;

  # ── Agent Identity Relations ────────────────────────────────────────
  relation agent_has_skill,
    relates skilled,
    relates possessed;

  relation agent_has_persona,
    relates personified,
    relates persona_role;

  # ── Reasoning Relations ─────────────────────────────────────────────
  relation method_produces_result,
    relates method,
    relates result;

  relation decision_resolves_goal,
    relates resolver,
    relates resolved_goal;

  # ── Role-Playing Declarations: Core ─────────────────────────────────
  agent plays agent_owns:owner;
  spo_fact plays agent_owns:owned;
  knowledge_rule plays agent_owns:owned;
  memory_item plays agent_owns:owned;
  cbr_case plays agent_owns:owned;

  # ── Role-Playing Declarations: BDI ─────────────────────────────────
  belief plays agent_owns:owned;
  desire plays agent_owns:owned;
  goal plays agent_owns:owned;
  intention plays agent_owns:owned;
  plan plays agent_owns:owned;
  plan_step plays agent_owns:owned;
  persona plays agent_owns:owned;
  skill plays agent_owns:owned;
  workflow plays agent_owns:owned;
  task plays agent_owns:owned;
  action_execution plays agent_owns:owned;
  reasoning_method plays agent_owns:owned;
  reasoning_result plays agent_owns:owned;
  decision plays agent_owns:owned;

  belief plays belief_supports_goal:believer;
  goal plays belief_supports_goal:supported;

  desire plays desire_motivates_goal:motivator;
  goal plays desire_motivates_goal:motivated;

  goal plays goal_requires_plan:requiring;
  plan plays goal_requires_plan:required;

  plan plays plan_contains_step:container;
  plan_step plays plan_contains_step:contained;

  plan_step plays step_depends_on:dependent;
  plan_step plays step_depends_on:dependency;

  agent plays agent_has_skill:skilled;
  skill plays agent_has_skill:possessed;

  agent plays agent_has_persona:personified;
  persona plays agent_has_persona:persona_role;

  reasoning_method plays method_produces_result:method;
  reasoning_result plays method_produces_result:result;

  decision plays decision_resolves_goal:resolver;
  goal plays decision_resolves_goal:resolved_goal;

  # ── BPMN 2.0 Attributes ──────────────────────────────────────────────
  attribute element_type, value string;
  attribute event_position, value string;
  attribute event_trigger, value string;
  attribute event_catching, value boolean;
  attribute event_definition, value string;
  attribute task_type_bpmn, value string;
  attribute loop_type, value string;
  attribute is_compensation, value boolean;
  attribute subprocess_type, value string;
  attribute called_element, value string;
  attribute gateway_type, value string;
  attribute default_flow_id, value string;
  attribute flow_type, value string;
  attribute condition_expr, value string;
  attribute is_default, value boolean;
  attribute waypoints, value string;
  attribute pos_x, value double;
  attribute pos_y, value double;
  attribute size_w, value double;
  attribute size_h, value double;
  attribute pool_id, value string;
  attribute lane_id, value string;
  attribute participant_ref, value string;
  attribute is_black_box, value boolean;
  attribute assignee_agent_id, value string;
  attribute action_tool, value string;
  attribute schedule_json, value string;
  attribute workflow_version, value integer;
  attribute documentation, value string;

  # ── BPMN 2.0 Entities ────────────────────────────────────────────────
  entity bpmn_workflow,
    owns uid @key,
    owns name,
    owns status,
    owns description,
    owns workflow_version,
    owns created_at,
    owns updated_at;

  entity bpmn_element,
    owns uid @key,
    owns name,
    owns element_type,
    owns pos_x,
    owns pos_y,
    owns size_w,
    owns size_h,
    owns documentation,
    owns event_position,
    owns event_trigger,
    owns event_catching,
    owns event_definition,
    owns task_type_bpmn,
    owns loop_type,
    owns is_compensation,
    owns subprocess_type,
    owns called_element,
    owns gateway_type,
    owns default_flow_id,
    owns assignee_agent_id,
    owns action_tool,
    owns schedule_json,
    owns lane_id,
    owns created_at;

  entity bpmn_flow,
    owns uid @key,
    owns name,
    owns flow_type,
    owns condition_expr,
    owns is_default,
    owns waypoints,
    owns created_at;

  entity bpmn_pool,
    owns uid @key,
    owns name,
    owns participant_ref,
    owns is_black_box,
    owns created_at;

  entity bpmn_lane,
    owns uid @key,
    owns name,
    owns assignee_agent_id,
    owns created_at;

  # ── BPMN 2.0 Relations ───────────────────────────────────────────────
  relation workflow_contains_element,
    relates wf_container,
    relates wf_contained;

  relation workflow_contains_flow,
    relates wff_container,
    relates wff_contained;

  relation workflow_contains_pool,
    relates wfp_container,
    relates wfp_contained;

  relation pool_contains_lane,
    relates pl_container,
    relates pl_contained;

  relation lane_contains_element,
    relates le_container,
    relates le_contained;

  relation flow_connects,
    relates flow_source,
    relates flow_target,
    relates flow_edge;

  relation goal_has_workflow,
    relates gh_goal,
    relates gh_workflow;

  relation project_has_workflow,
    relates ph_project,
    relates ph_workflow;

  # ── BPMN Role-Playing Declarations ───────────────────────────────────
  bpmn_workflow plays agent_owns:owned;
  bpmn_element plays agent_owns:owned;
  bpmn_flow plays agent_owns:owned;
  bpmn_pool plays agent_owns:owned;
  bpmn_lane plays agent_owns:owned;

  bpmn_workflow plays workflow_contains_element:wf_container;
  bpmn_element plays workflow_contains_element:wf_contained;

  bpmn_workflow plays workflow_contains_flow:wff_container;
  bpmn_flow plays workflow_contains_flow:wff_contained;

  bpmn_workflow plays workflow_contains_pool:wfp_container;
  bpmn_pool plays workflow_contains_pool:wfp_contained;

  bpmn_pool plays pool_contains_lane:pl_container;
  bpmn_lane plays pool_contains_lane:pl_contained;

  bpmn_lane plays lane_contains_element:le_container;
  bpmn_element plays lane_contains_element:le_contained;

  bpmn_element plays flow_connects:flow_source;
  bpmn_element plays flow_connects:flow_target;
  bpmn_flow plays flow_connects:flow_edge;

  goal plays goal_has_workflow:gh_goal;
  bpmn_workflow plays goal_has_workflow:gh_workflow;

  bpmn_workflow plays project_has_workflow:ph_workflow;`;
}
