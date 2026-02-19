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
  uid sub attribute, value string;
  name sub attribute, value string;
  description sub attribute, value string;
  confidence sub attribute, value double;
  source sub attribute, value string;
  created_at sub attribute, value string;
  updated_at sub attribute, value string;
  subject sub attribute, value string;
  predicate sub attribute, value string;
  object_value sub attribute, value string;
  valid_from sub attribute, value string;
  valid_until sub attribute, value string;
  rule_id sub attribute, value string;
  rule_type sub attribute, value string;
  condition_count sub attribute, value long;
  confidence_factor sub attribute, value double;
  enabled sub attribute, value boolean;
  domain sub attribute, value string;
  content sub attribute, value string;
  memory_type sub attribute, value string;
  importance sub attribute, value double;
  store_name sub attribute, value string;
  access_count sub attribute, value long;
  accessed_at sub attribute, value string;
  tag sub attribute, value string;
  situation sub attribute, value string;
  solution sub attribute, value string;
  outcome sub attribute, value string;

  agent sub entity,
    owns uid @key,
    owns name;

  spo_fact sub entity,
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

  knowledge_rule sub entity,
    owns uid @key,
    owns name,
    owns description,
    owns rule_type,
    owns condition_count,
    owns confidence_factor,
    owns enabled,
    owns domain,
    owns created_at;

  memory_item sub entity,
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

  cbr_case sub entity,
    owns uid @key,
    owns situation,
    owns solution,
    owns outcome,
    owns domain,
    owns created_at;

  agent_owns sub relation,
    relates owner,
    relates owned;

  agent plays agent_owns:owner;
  spo_fact plays agent_owns:owned;
  knowledge_rule plays agent_owns:owned;
  memory_item plays agent_owns:owned;
  cbr_case plays agent_owns:owned;`;
}
