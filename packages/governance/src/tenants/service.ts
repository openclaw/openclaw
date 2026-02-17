/**
 * Tenant Service — CRUD for tenants, projects, and agent roster management.
 *
 * Entity-type-driven: selecting an entity type at creation scaffolds
 * intelligent defaults for governance, agent roster, maturity levels,
 * and multi-sig configuration.
 *
 * In-memory for MVP. Production: backed by Postgres or content store.
 */

import type {
  EntityType,
  EntityConfig,
  Tenant,
  Agent,
  Project,
  Human,
  MaturityConfig,
  MaturityLevel,
  FunctionCategory,
  AgentTemplate,
  TenantTemplate,
  ModelAssignment,
} from "../types.js";
import { generateDID } from "../identity/did.js";
import { getTemplateWithOverrides } from "./templates.js";

// ── Types ────────────────────────────────────────────────────────────────────

/** Input for creating a new tenant. */
export interface CreateTenantInput {
  name: string;
  entityType: EntityType;
  entityConfig?: EntityConfig;
  /** Override the template defaults if needed. */
  overrides?: {
    isolation?: "hard" | "soft";
    multiSigRequired?: boolean;
    multiSigThreshold?: number;
    defaultMaturity?: MaturityConfig;
  };
}

/** Input for adding an agent to a tenant. */
export interface AddAgentInput {
  name: string;
  role: string;
  model?: ModelAssignment;
  maturity?: Partial<Record<FunctionCategory, MaturityLevel>>;
  skills?: string[];
  /** Assign to a project instead of tenant scope. */
  projectId?: string;
}

/** Input for creating a project within a tenant. */
export interface CreateProjectInput {
  name: string;
  description?: string;
}

/** Input for adding a human to a tenant. */
export interface AddHumanInput {
  name: string;
  contact?: {
    signal?: string;
    sms?: string;
    email?: string;
  };
}

/** Configuration for the TenantService. */
export interface TenantServiceConfig {
  /** Default model assignment for new agents. */
  defaultModel?: ModelAssignment;
}

// ── Service ─────────────────────────────────────────────────────────────────

export class TenantService {
  private tenants = new Map<string, Tenant>();
  private defaultModel: ModelAssignment;

  constructor(config: TenantServiceConfig = {}) {
    this.defaultModel = config.defaultModel ?? {
      provider: "ollama",
      model: "llama3.1:8b",
      server: "localhost",
    };
  }

  /**
   * Create a new tenant from an entity type.
   *
   * 1. Looks up the template for the entity type
   * 2. Applies entity-config-driven overrides
   * 3. Applies user overrides
   * 4. Generates a DID for the tenant
   * 5. Scaffolds the tenant with suggested agents
   */
  create(input: CreateTenantInput): Tenant {
    const config = input.entityConfig ?? {};
    const template = getTemplateWithOverrides(input.entityType, {
      memberStructure: config.memberStructure,
      memberCount: config.memberCount,
      partnerCount: config.partnerCount,
      franchiseRole: config.franchiseRole,
    });

    // Apply user overrides on top of template
    const overrides = input.overrides ?? {};

    const tenantIdentity = generateDID();
    const now = new Date().toISOString();

    const tenant: Tenant = {
      id: tenantIdentity.did.slice(-12), // short ID from DID
      did: tenantIdentity.did,
      name: input.name,
      entityType: input.entityType,
      entityConfig: config,
      isolation: overrides.isolation ?? template.isolation,
      multiSigRequired: overrides.multiSigRequired ?? template.multiSigRequired,
      multiSigThreshold: overrides.multiSigThreshold ?? template.multiSigThreshold,
      defaultMaturity: overrides.defaultMaturity ?? template.defaultMaturity,
      agents: [],
      projects: [],
      humans: [],
      createdAt: now,
      updatedAt: now,
    };

    // Scaffold suggested agents from template
    for (const agentTemplate of template.suggestedAgents) {
      const agent = this.createAgentFromTemplate(agentTemplate, tenant);
      tenant.agents.push(agent);
    }

    this.tenants.set(tenant.id, tenant);
    return tenant;
  }

  /**
   * Get a tenant by ID.
   */
  get(tenantId: string): Tenant | null {
    return this.tenants.get(tenantId) ?? null;
  }

  /**
   * List all tenants.
   */
  list(): Tenant[] {
    return Array.from(this.tenants.values());
  }

  /**
   * Update tenant metadata.
   */
  update(
    tenantId: string,
    updates: Partial<
      Pick<Tenant, "name" | "defaultMaturity" | "multiSigRequired" | "multiSigThreshold">
    >,
  ): Tenant | null {
    const tenant = this.tenants.get(tenantId);
    if (!tenant) {
      return null;
    }

    if (updates.name !== undefined) {
      tenant.name = updates.name;
    }
    if (updates.defaultMaturity !== undefined) {
      tenant.defaultMaturity = updates.defaultMaturity;
    }
    if (updates.multiSigRequired !== undefined) {
      tenant.multiSigRequired = updates.multiSigRequired;
    }
    if (updates.multiSigThreshold !== undefined) {
      tenant.multiSigThreshold = updates.multiSigThreshold;
    }
    tenant.updatedAt = new Date().toISOString();

    return tenant;
  }

  /**
   * Delete a tenant.
   */
  delete(tenantId: string): boolean {
    return this.tenants.delete(tenantId);
  }

  // ── Agent Management ──────────────────────────────────────────────────────

  /**
   * Add an agent to a tenant.
   *
   * If projectId is specified, the agent is project-scoped.
   * Otherwise, it's tenant-scoped.
   */
  addAgent(tenantId: string, input: AddAgentInput): Agent | null {
    const tenant = this.tenants.get(tenantId);
    if (!tenant) {
      return null;
    }

    const identity = generateDID();
    const agent: Agent = {
      id: identity.did.slice(-12),
      did: identity.did,
      tenantId,
      assignment: input.projectId
        ? { scope: "project", projectId: input.projectId }
        : { scope: "tenant", tenantId },
      name: input.name,
      role: input.role,
      model: input.model ?? this.defaultModel,
      maturity: input.maturity ?? tenant.defaultMaturity,
      skills: input.skills ?? [],
      workspace: {
        identityMd: "",
        soulMd: "",
        agentsMd: "",
      },
      status: "active",
    };

    if (input.projectId) {
      const project = tenant.projects.find((p) => p.id === input.projectId);
      if (!project) {
        return null;
      }
      project.agents.push(agent);
    } else {
      tenant.agents.push(agent);
    }

    tenant.updatedAt = new Date().toISOString();
    return agent;
  }

  /**
   * Remove an agent from a tenant.
   */
  removeAgent(tenantId: string, agentId: string): boolean {
    const tenant = this.tenants.get(tenantId);
    if (!tenant) {
      return false;
    }

    // Check tenant-scoped agents
    const tenantIdx = tenant.agents.findIndex((a) => a.id === agentId);
    if (tenantIdx !== -1) {
      tenant.agents.splice(tenantIdx, 1);
      tenant.updatedAt = new Date().toISOString();
      return true;
    }

    // Check project-scoped agents
    for (const project of tenant.projects) {
      const projIdx = project.agents.findIndex((a) => a.id === agentId);
      if (projIdx !== -1) {
        project.agents.splice(projIdx, 1);
        tenant.updatedAt = new Date().toISOString();
        return true;
      }
    }

    return false;
  }

  /**
   * Get an agent by ID across all scopes within a tenant.
   */
  getAgent(tenantId: string, agentId: string): Agent | null {
    const tenant = this.tenants.get(tenantId);
    if (!tenant) {
      return null;
    }

    const tenantAgent = tenant.agents.find((a) => a.id === agentId);
    if (tenantAgent) {
      return tenantAgent;
    }

    for (const project of tenant.projects) {
      const projAgent = project.agents.find((a) => a.id === agentId);
      if (projAgent) {
        return projAgent;
      }
    }

    return null;
  }

  /**
   * List all agents in a tenant (both tenant-scoped and project-scoped).
   */
  listAgents(tenantId: string): Agent[] {
    const tenant = this.tenants.get(tenantId);
    if (!tenant) {
      return [];
    }

    const all = [...tenant.agents];
    for (const project of tenant.projects) {
      all.push(...project.agents);
    }
    return all;
  }

  /**
   * Update an agent's maturity level for a specific function.
   */
  setAgentMaturity(
    tenantId: string,
    agentId: string,
    fn: FunctionCategory,
    level: MaturityLevel,
  ): boolean {
    const agent = this.getAgent(tenantId, agentId);
    if (!agent) {
      return false;
    }

    agent.maturity[fn] = level;
    const tenant = this.tenants.get(tenantId);
    if (tenant) {
      tenant.updatedAt = new Date().toISOString();
    }
    return true;
  }

  // ── Project Management ────────────────────────────────────────────────────

  /**
   * Create a project within a tenant.
   */
  createProject(tenantId: string, input: CreateProjectInput): Project | null {
    const tenant = this.tenants.get(tenantId);
    if (!tenant) {
      return null;
    }

    const projectIdentity = generateDID();
    const project: Project = {
      id: projectIdentity.did.slice(-12),
      tenantId,
      name: input.name,
      description: input.description,
      agents: [],
      ledgerId: `ledger-${projectIdentity.did.slice(-8)}`,
      status: "active",
      createdAt: new Date().toISOString(),
    };

    tenant.projects.push(project);
    tenant.updatedAt = new Date().toISOString();
    return project;
  }

  /**
   * Get a project by ID within a tenant.
   */
  getProject(tenantId: string, projectId: string): Project | null {
    const tenant = this.tenants.get(tenantId);
    if (!tenant) {
      return null;
    }
    return tenant.projects.find((p) => p.id === projectId) ?? null;
  }

  /**
   * List all projects in a tenant.
   */
  listProjects(tenantId: string): Project[] {
    const tenant = this.tenants.get(tenantId);
    if (!tenant) {
      return [];
    }
    return tenant.projects;
  }

  // ── Human Management ──────────────────────────────────────────────────────

  /**
   * Add a human operator to a tenant.
   */
  addHuman(tenantId: string, input: AddHumanInput): Human | null {
    const tenant = this.tenants.get(tenantId);
    if (!tenant) {
      return null;
    }

    const identity = generateDID();
    const human: Human = {
      id: identity.did.slice(-12),
      did: identity.did,
      tenantId,
      name: input.name,
      contact: input.contact ?? {},
      devices: [],
      grants: [],
      status: "active",
    };

    tenant.humans.push(human);
    tenant.updatedAt = new Date().toISOString();
    return human;
  }

  /**
   * List all humans in a tenant.
   */
  listHumans(tenantId: string): Human[] {
    const tenant = this.tenants.get(tenantId);
    if (!tenant) {
      return [];
    }
    return tenant.humans;
  }

  // ── Template Access ───────────────────────────────────────────────────────

  /**
   * Preview what a tenant would look like for an entity type
   * without actually creating it.
   */
  preview(entityType: EntityType, config?: EntityConfig): TenantTemplate {
    return getTemplateWithOverrides(entityType, {
      memberStructure: config?.memberStructure,
      memberCount: config?.memberCount,
      partnerCount: config?.partnerCount,
      franchiseRole: config?.franchiseRole,
    });
  }

  /** Number of tenants. */
  get size(): number {
    return this.tenants.size;
  }

  // ── Private ───────────────────────────────────────────────────────────────

  private createAgentFromTemplate(template: AgentTemplate, tenant: Tenant): Agent {
    const identity = generateDID();
    return {
      id: identity.did.slice(-12),
      did: identity.did,
      tenantId: tenant.id,
      assignment: { scope: "tenant", tenantId: tenant.id },
      name: template.name,
      role: template.role,
      model: template.suggestedModel
        ? { provider: "ollama", model: template.suggestedModel, server: "localhost" }
        : this.defaultModel,
      maturity: { ...tenant.defaultMaturity },
      skills: [...template.skills],
      workspace: {
        identityMd: "",
        soulMd: "",
        agentsMd: "",
      },
      status: "active",
    };
  }
}
