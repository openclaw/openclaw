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

    return `insert
  $fact isa spo_fact,
    has uid ${JSON.stringify(fact.id)},
    has subject ${JSON.stringify(fact.subject)},
    has predicate ${JSON.stringify(fact.predicate)},
    has object_value ${JSON.stringify(fact.object)},
    has confidence ${fact.confidence},
    has source ${JSON.stringify(fact.source)}${validFromClause}${validUntilClause}${ruleClause},
    has created_at ${JSON.stringify(new Date().toISOString())},
    has updated_at ${JSON.stringify(new Date().toISOString())};
  $agent isa agent, has uid ${JSON.stringify(agentId)};
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

    return `insert
  $rule isa knowledge_rule,
    has uid ${JSON.stringify(rule.id)},
    has name ${JSON.stringify(rule.name)},
    has description ${JSON.stringify(rule.description)},
    has rule_type ${JSON.stringify(rule.type)},
    has condition_count ${rule.conditionCount},
    has confidence_factor ${rule.confidenceFactor},
    has enabled ${rule.enabled}${domainClause},
    has created_at ${JSON.stringify(new Date().toISOString())};
  $agent isa agent, has uid ${JSON.stringify(agentId)};
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

    return `insert
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
  $agent isa agent, has uid ${JSON.stringify(agentId)};
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
    return `insert
  $case isa cbr_case,
    has uid ${JSON.stringify(caseData.id)},
    has situation ${JSON.stringify(caseData.situation)},
    has solution ${JSON.stringify(caseData.solution)},
    has outcome ${JSON.stringify(caseData.outcome)},
    has domain ${JSON.stringify(caseData.domain)},
    has created_at ${JSON.stringify(new Date().toISOString())};
  $agent isa agent, has uid ${JSON.stringify(agentId)};
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
    owns commitment_strategy,
    owns status,
    owns plan_ref,
    owns deadline,
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
    owns decision_type,
    owns options_count,
    owns chosen_option,
    owns impact_level,
    owns urgency_level,
    owns resolved,
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
  goal plays decision_resolves_goal:resolved_goal;`;
}
