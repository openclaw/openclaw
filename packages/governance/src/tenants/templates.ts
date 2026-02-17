/**
 * Tenant templates — entity-type-driven defaults.
 *
 * Each entity type maps to a TenantTemplate with pre-configured:
 * - Isolation type (hard/soft)
 * - Multi-sig requirements
 * - Default maturity levels per function
 * - Suggested agent roster
 * - Meeting cadence
 * - Escalation chain depth
 *
 * These are starting points. Users customize during onboarding.
 */

import type {
  EntityType,
  TenantTemplate,
  AgentTemplate,
  MaturityConfig,
  MaturityLevel,
} from "../types.js";

// ── Agent Roster Templates ──────────────────────────────────────────────────

const ASSISTANT_AGENTS: AgentTemplate[] = [
  {
    name: "Assistant",
    role: "general-assistant",
    skills: ["web_search", "web_fetch", "memory_search"],
  },
];

const SMALL_BUSINESS_AGENTS: AgentTemplate[] = [
  {
    name: "CEO",
    role: "chief-executive",
    skills: ["web_search", "memory_search", "sessions_send"],
  },
  {
    name: "COO",
    role: "chief-operations",
    skills: ["web_search", "memory_search", "sessions_send"],
  },
];

const STANDARD_AGENTS: AgentTemplate[] = [
  {
    name: "CEO",
    role: "chief-executive",
    skills: ["web_search", "memory_search", "sessions_send"],
  },
  {
    name: "COO",
    role: "chief-operations",
    skills: ["web_search", "memory_search", "sessions_send"],
  },
  {
    name: "CFO",
    role: "chief-financial",
    skills: ["web_search", "memory_search", "sessions_send"],
  },
  { name: "Research", role: "research", skills: ["web_search", "web_fetch", "memory_search"] },
];

const FULL_CSUITE_AGENTS: AgentTemplate[] = [
  ...STANDARD_AGENTS,
  { name: "Legal", role: "legal-compliance", skills: ["web_search", "memory_search"] },
  { name: "Security", role: "security", skills: ["web_search", "memory_search"] },
];

const FRANCHISE_LOCATION_AGENTS: AgentTemplate[] = [
  {
    name: "Manager",
    role: "location-manager",
    skills: ["web_search", "memory_search", "sessions_send"],
  },
  { name: "Operations", role: "operations", skills: ["memory_search", "sessions_send"] },
];

// ── Maturity Presets ────────────────────────────────────────────────────────

function maturityAll(level: MaturityLevel): MaturityConfig {
  return {
    communications: level,
    research: level,
    finance: level,
    content: level,
    "code-execution": level,
    infrastructure: level,
    "external-api": level,
  };
}

function maturityMixed(
  defaults: MaturityLevel,
  overrides: Partial<MaturityConfig>,
): MaturityConfig {
  return { ...maturityAll(defaults), ...overrides };
}

// ── Templates ───────────────────────────────────────────────────────────────

const TEMPLATES: Record<EntityType, TenantTemplate> = {
  /**
   * Personal Assistant
   * - 1 human, 1-2 agents
   * - No multi-sig, high maturity, minimal governance
   */
  personal: {
    entityType: "personal",
    isolation: "soft",
    multiSigRequired: false,
    multiSigThreshold: 0,
    defaultMaturity: maturityAll(3),
    suggestedAgents: ASSISTANT_AGENTS,
    meetingCadence: [],
    escalationTiers: 1,
  },

  /**
   * Sole Proprietor
   * - 1 owner, 2-4 agents
   * - No multi-sig, moderate maturity, light governance
   */
  "sole-proprietor": {
    entityType: "sole-proprietor",
    isolation: "soft",
    multiSigRequired: false,
    multiSigThreshold: 0,
    defaultMaturity: maturityMixed(2, { finance: 1 }),
    suggestedAgents: SMALL_BUSINESS_AGENTS,
    meetingCadence: ["weekly-summary"],
    escalationTiers: 1,
  },

  /**
   * Partnership (LLP)
   * - 2+ partners, multi-sig required
   * - Hard isolation, low maturity start, formal governance
   */
  partnership: {
    entityType: "partnership",
    isolation: "hard",
    multiSigRequired: true,
    multiSigThreshold: 2,
    defaultMaturity: maturityMixed(1, { research: 2 }),
    suggestedAgents: STANDARD_AGENTS,
    meetingCadence: ["daily-standup", "weekly-planning", "monthly-retrospective"],
    escalationTiers: 3,
  },

  /**
   * Private LLC
   * - 1+ members, multi-sig optional (required if multi-member)
   * - Hard isolation, standard governance
   */
  llc: {
    entityType: "llc",
    isolation: "hard",
    multiSigRequired: false, // overridden to true for multi-member
    multiSigThreshold: 0,
    defaultMaturity: maturityMixed(1, { research: 2, communications: 2 }),
    suggestedAgents: STANDARD_AGENTS,
    meetingCadence: ["daily-standup", "weekly-planning", "quarterly-review"],
    escalationTiers: 2,
  },

  /**
   * S-Corp
   * - Shareholder/director separation, multi-sig required
   * - Hard isolation, strict governance, full C-suite
   */
  "s-corp": {
    entityType: "s-corp",
    isolation: "hard",
    multiSigRequired: true,
    multiSigThreshold: 2,
    defaultMaturity: maturityAll(1),
    suggestedAgents: FULL_CSUITE_AGENTS,
    meetingCadence: ["daily-standup", "weekly-planning", "monthly-board", "quarterly-review"],
    escalationTiers: 3,
  },

  /**
   * Franchise / Location
   * - Parent sets templates, locations inherit
   * - Soft isolation per location, moderate maturity (template-driven)
   */
  franchise: {
    entityType: "franchise",
    isolation: "soft",
    multiSigRequired: false,
    multiSigThreshold: 0,
    defaultMaturity: maturityMixed(2, { finance: 1, infrastructure: 1 }),
    suggestedAgents: FRANCHISE_LOCATION_AGENTS,
    meetingCadence: ["daily-standup", "weekly-summary"],
    escalationTiers: 2,
  },

  /**
   * Non-Profit
   * - Board governance, multi-sig required
   * - Hard isolation, strict financial controls
   */
  "non-profit": {
    entityType: "non-profit",
    isolation: "hard",
    multiSigRequired: true,
    multiSigThreshold: 2,
    defaultMaturity: maturityMixed(1, { research: 2, communications: 2 }),
    suggestedAgents: STANDARD_AGENTS,
    meetingCadence: ["weekly-planning", "monthly-board", "quarterly-review"],
    escalationTiers: 3,
  },
};

// ── Public API ──────────────────────────────────────────────────────────────

/**
 * Get the template for an entity type.
 *
 * Returns a deep copy so callers can modify without affecting the originals.
 */
export function getTemplate(entityType: EntityType): TenantTemplate {
  const template = TEMPLATES[entityType];
  return JSON.parse(JSON.stringify(template)) as TenantTemplate;
}

/**
 * Get a template with entity-config-driven overrides applied.
 *
 * For example, a multi-member LLC gets multi-sig enabled automatically.
 * A franchise franchisee inherits from parent tenant template.
 */
export function getTemplateWithOverrides(
  entityType: EntityType,
  config: {
    memberStructure?: "single" | "multi";
    memberCount?: number;
    partnerCount?: number;
    franchiseRole?: "franchisor" | "franchisee";
  } = {},
): TenantTemplate {
  const template = getTemplate(entityType);

  // LLC: multi-member enables multi-sig
  if (entityType === "llc" && config.memberStructure === "multi") {
    template.multiSigRequired = true;
    template.multiSigThreshold = Math.min(config.memberCount ?? 2, 3);
    template.escalationTiers = 3;
  }

  // LLC: single-member is closer to sole proprietor
  if (entityType === "llc" && config.memberStructure === "single") {
    template.defaultMaturity = maturityMixed(2, { finance: 1 });
    template.escalationTiers = 1;
  }

  // Partnership: threshold scales with partner count
  if (entityType === "partnership" && config.partnerCount) {
    // Majority threshold: ceil(N/2) but at least 2
    template.multiSigThreshold = Math.max(2, Math.ceil(config.partnerCount / 2));
  }

  // Franchise: franchisor gets full C-suite, franchisee gets location agents
  if (entityType === "franchise" && config.franchiseRole === "franchisor") {
    template.suggestedAgents = STANDARD_AGENTS;
    template.isolation = "hard";
    template.multiSigRequired = true;
    template.multiSigThreshold = 2;
    template.meetingCadence = ["daily-standup", "weekly-planning", "monthly-board"];
    template.escalationTiers = 3;
  }

  return template;
}

/** List all available entity types. */
export function listEntityTypes(): EntityType[] {
  return Object.keys(TEMPLATES) as EntityType[];
}

/** Human-readable labels for entity types. */
export const ENTITY_TYPE_LABELS: Record<EntityType, string> = {
  personal: "Personal Assistant",
  "sole-proprietor": "Sole Proprietor",
  partnership: "Partnership (LLP)",
  llc: "Private LLC",
  "s-corp": "S-Corporation",
  franchise: "Franchise / Location",
  "non-profit": "Non-Profit",
};
