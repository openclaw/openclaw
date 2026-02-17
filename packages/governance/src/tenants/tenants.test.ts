import { describe, it, expect } from "vitest";
import { TenantService } from "./service.js";
import {
  getTemplate,
  getTemplateWithOverrides,
  listEntityTypes,
  ENTITY_TYPE_LABELS,
} from "./templates.js";

// ── Template Tests ──────────────────────────────────────────────────────────

describe("Templates", () => {
  it("lists all 7 entity types", () => {
    const types = listEntityTypes();
    expect(types).toHaveLength(7);
    expect(types).toContain("personal");
    expect(types).toContain("sole-proprietor");
    expect(types).toContain("partnership");
    expect(types).toContain("llc");
    expect(types).toContain("s-corp");
    expect(types).toContain("franchise");
    expect(types).toContain("non-profit");
  });

  it("has labels for all entity types", () => {
    const types = listEntityTypes();
    for (const t of types) {
      expect(ENTITY_TYPE_LABELS[t]).toBeDefined();
      expect(typeof ENTITY_TYPE_LABELS[t]).toBe("string");
    }
  });

  it("getTemplate returns deep copies", () => {
    const t1 = getTemplate("personal");
    const t2 = getTemplate("personal");
    expect(t1).toEqual(t2);
    t1.suggestedAgents.push({
      name: "Hacker",
      role: "hack",
      skills: [],
    });
    expect(t2.suggestedAgents).not.toContainEqual(expect.objectContaining({ name: "Hacker" }));
  });

  describe("entity-type defaults", () => {
    it("personal: soft isolation, no multi-sig, 1 agent", () => {
      const t = getTemplate("personal");
      expect(t.isolation).toBe("soft");
      expect(t.multiSigRequired).toBe(false);
      expect(t.suggestedAgents).toHaveLength(1);
      expect(t.suggestedAgents[0].role).toBe("general-assistant");
    });

    it("sole-proprietor: soft isolation, no multi-sig, 2 agents", () => {
      const t = getTemplate("sole-proprietor");
      expect(t.isolation).toBe("soft");
      expect(t.multiSigRequired).toBe(false);
      expect(t.suggestedAgents).toHaveLength(2);
    });

    it("partnership: hard isolation, multi-sig required, threshold 2", () => {
      const t = getTemplate("partnership");
      expect(t.isolation).toBe("hard");
      expect(t.multiSigRequired).toBe(true);
      expect(t.multiSigThreshold).toBe(2);
    });

    it("llc: hard isolation, multi-sig off by default", () => {
      const t = getTemplate("llc");
      expect(t.isolation).toBe("hard");
      expect(t.multiSigRequired).toBe(false);
    });

    it("s-corp: hard isolation, full C-suite (6 agents)", () => {
      const t = getTemplate("s-corp");
      expect(t.isolation).toBe("hard");
      expect(t.multiSigRequired).toBe(true);
      expect(t.suggestedAgents).toHaveLength(6);
      const roles = t.suggestedAgents.map((a) => a.role);
      expect(roles).toContain("legal-compliance");
      expect(roles).toContain("security");
    });

    it("franchise: soft isolation, location agents", () => {
      const t = getTemplate("franchise");
      expect(t.isolation).toBe("soft");
      expect(t.suggestedAgents).toHaveLength(2);
      expect(t.suggestedAgents[0].role).toBe("location-manager");
    });

    it("non-profit: hard isolation, multi-sig, board governance", () => {
      const t = getTemplate("non-profit");
      expect(t.isolation).toBe("hard");
      expect(t.multiSigRequired).toBe(true);
      expect(t.multiSigThreshold).toBe(2);
    });
  });

  describe("entity-config overrides", () => {
    it("multi-member LLC enables multi-sig", () => {
      const t = getTemplateWithOverrides("llc", {
        memberStructure: "multi",
        memberCount: 3,
      });
      expect(t.multiSigRequired).toBe(true);
      expect(t.multiSigThreshold).toBe(3);
      expect(t.escalationTiers).toBe(3);
    });

    it("multi-member LLC caps threshold at 3", () => {
      const t = getTemplateWithOverrides("llc", {
        memberStructure: "multi",
        memberCount: 10,
      });
      expect(t.multiSigThreshold).toBe(3);
    });

    it("single-member LLC relaxes maturity and escalation", () => {
      const t = getTemplateWithOverrides("llc", {
        memberStructure: "single",
      });
      expect(t.escalationTiers).toBe(1);
      // Finance stays conservative
      expect(t.defaultMaturity.finance).toBe(1);
      // Other functions relax
      expect(t.defaultMaturity.research).toBe(2);
    });

    it("partnership threshold scales with partner count", () => {
      const t = getTemplateWithOverrides("partnership", {
        partnerCount: 5,
      });
      // ceil(5/2) = 3
      expect(t.multiSigThreshold).toBe(3);
    });

    it("partnership threshold minimum is 2", () => {
      const t = getTemplateWithOverrides("partnership", {
        partnerCount: 2,
      });
      // ceil(2/2) = 1, but minimum is 2
      expect(t.multiSigThreshold).toBe(2);
    });

    it("franchisor gets full C-suite and hard isolation", () => {
      const t = getTemplateWithOverrides("franchise", {
        franchiseRole: "franchisor",
      });
      expect(t.isolation).toBe("hard");
      expect(t.multiSigRequired).toBe(true);
      expect(t.suggestedAgents).toHaveLength(4); // STANDARD_AGENTS
      expect(t.escalationTiers).toBe(3);
    });

    it("franchisee keeps default location agents", () => {
      const t = getTemplateWithOverrides("franchise", {
        franchiseRole: "franchisee",
      });
      expect(t.isolation).toBe("soft");
      expect(t.suggestedAgents).toHaveLength(2);
    });
  });
});

// ── Tenant Service ──────────────────────────────────────────────────────────

describe("TenantService", () => {
  function createService() {
    return new TenantService();
  }

  describe("create", () => {
    it("creates a tenant with DID", () => {
      const svc = createService();
      const tenant = svc.create({
        name: "NerdPlanet",
        entityType: "llc",
      });

      expect(tenant.id).toBeDefined();
      expect(tenant.did).toMatch(/^did:key:z/);
      expect(tenant.name).toBe("NerdPlanet");
      expect(tenant.entityType).toBe("llc");
    });

    it("scaffolds agents from template", () => {
      const svc = createService();
      const tenant = svc.create({
        name: "NerdPlanet",
        entityType: "llc",
      });

      // LLC gets STANDARD_AGENTS (4)
      expect(tenant.agents).toHaveLength(4);
      const names = tenant.agents.map((a) => a.name);
      expect(names).toContain("CEO");
      expect(names).toContain("COO");
      expect(names).toContain("CFO");
      expect(names).toContain("Research");
    });

    it("each agent gets its own DID", () => {
      const svc = createService();
      const tenant = svc.create({
        name: "NerdPlanet",
        entityType: "llc",
      });

      const dids = tenant.agents.map((a) => a.did);
      const unique = new Set(dids);
      expect(unique.size).toBe(tenant.agents.length);
      for (const did of dids) {
        expect(did).toMatch(/^did:key:z/);
      }
    });

    it("personal tenant gets 1 assistant agent", () => {
      const svc = createService();
      const tenant = svc.create({
        name: "My Assistant",
        entityType: "personal",
      });

      expect(tenant.agents).toHaveLength(1);
      expect(tenant.agents[0].role).toBe("general-assistant");
      expect(tenant.isolation).toBe("soft");
      expect(tenant.multiSigRequired).toBe(false);
    });

    it("s-corp gets full C-suite with 6 agents", () => {
      const svc = createService();
      const tenant = svc.create({
        name: "Acme Corp",
        entityType: "s-corp",
      });

      expect(tenant.agents).toHaveLength(6);
      const roles = tenant.agents.map((a) => a.role);
      expect(roles).toContain("legal-compliance");
      expect(roles).toContain("security");
      expect(tenant.multiSigRequired).toBe(true);
    });

    it("applies entity config overrides", () => {
      const svc = createService();
      const tenant = svc.create({
        name: "Multi LLC",
        entityType: "llc",
        entityConfig: {
          memberStructure: "multi",
          memberCount: 3,
        },
      });

      expect(tenant.multiSigRequired).toBe(true);
      expect(tenant.multiSigThreshold).toBe(3);
    });

    it("applies user overrides on top of template", () => {
      const svc = createService();
      const tenant = svc.create({
        name: "Custom LLC",
        entityType: "llc",
        overrides: {
          isolation: "soft",
          multiSigRequired: true,
          multiSigThreshold: 5,
        },
      });

      expect(tenant.isolation).toBe("soft");
      expect(tenant.multiSigRequired).toBe(true);
      expect(tenant.multiSigThreshold).toBe(5);
    });

    it("stores tenant for retrieval", () => {
      const svc = createService();
      const tenant = svc.create({
        name: "Test Co",
        entityType: "partnership",
      });

      expect(svc.size).toBe(1);
      expect(svc.get(tenant.id)).toEqual(tenant);
    });
  });

  describe("CRUD", () => {
    it("get returns null for unknown ID", () => {
      const svc = createService();
      expect(svc.get("nonexistent")).toBeNull();
    });

    it("list returns all tenants", () => {
      const svc = createService();
      svc.create({ name: "A", entityType: "personal" });
      svc.create({ name: "B", entityType: "llc" });
      svc.create({ name: "C", entityType: "s-corp" });

      expect(svc.list()).toHaveLength(3);
    });

    it("update modifies tenant metadata", () => {
      const svc = createService();
      const tenant = svc.create({
        name: "Old Name",
        entityType: "llc",
      });

      const updated = svc.update(tenant.id, { name: "New Name" });
      expect(updated?.name).toBe("New Name");
      expect(svc.get(tenant.id)?.name).toBe("New Name");
    });

    it("update returns null for unknown tenant", () => {
      const svc = createService();
      expect(svc.update("fake", { name: "X" })).toBeNull();
    });

    it("delete removes tenant", () => {
      const svc = createService();
      const tenant = svc.create({
        name: "Doomed",
        entityType: "personal",
      });

      expect(svc.delete(tenant.id)).toBe(true);
      expect(svc.get(tenant.id)).toBeNull();
      expect(svc.size).toBe(0);
    });

    it("delete returns false for unknown tenant", () => {
      const svc = createService();
      expect(svc.delete("fake")).toBe(false);
    });
  });

  describe("agent management", () => {
    it("addAgent to tenant scope", () => {
      const svc = createService();
      const tenant = svc.create({ name: "T", entityType: "personal" });

      const agent = svc.addAgent(tenant.id, {
        name: "Analyst",
        role: "data-analyst",
        skills: ["web_search"],
      });

      expect(agent).not.toBeNull();
      expect(agent!.did).toMatch(/^did:key:z/);
      expect(agent!.assignment.scope).toBe("tenant");
      // 1 from template + 1 added
      expect(svc.listAgents(tenant.id)).toHaveLength(2);
    });

    it("addAgent to project scope", () => {
      const svc = createService();
      const tenant = svc.create({ name: "T", entityType: "llc" });
      const project = svc.createProject(tenant.id, {
        name: "Black Hole Registry",
      });

      const agent = svc.addAgent(tenant.id, {
        name: "DevBot",
        role: "developer",
        projectId: project!.id,
      });

      expect(agent).not.toBeNull();
      expect(agent!.assignment.scope).toBe("project");
      expect(project!.agents).toHaveLength(1);
    });

    it("addAgent returns null for unknown tenant", () => {
      const svc = createService();
      expect(svc.addAgent("fake", { name: "X", role: "y" })).toBeNull();
    });

    it("addAgent returns null for unknown project", () => {
      const svc = createService();
      const tenant = svc.create({ name: "T", entityType: "personal" });

      expect(
        svc.addAgent(tenant.id, {
          name: "X",
          role: "y",
          projectId: "fake-project",
        }),
      ).toBeNull();
    });

    it("removeAgent from tenant scope", () => {
      const svc = createService();
      const tenant = svc.create({ name: "T", entityType: "personal" });
      const agentId = tenant.agents[0].id;

      expect(svc.removeAgent(tenant.id, agentId)).toBe(true);
      expect(svc.listAgents(tenant.id)).toHaveLength(0);
    });

    it("removeAgent from project scope", () => {
      const svc = createService();
      const tenant = svc.create({ name: "T", entityType: "llc" });
      const project = svc.createProject(tenant.id, { name: "P" });
      const agent = svc.addAgent(tenant.id, {
        name: "DevBot",
        role: "dev",
        projectId: project!.id,
      });

      expect(svc.removeAgent(tenant.id, agent!.id)).toBe(true);
      expect(project!.agents).toHaveLength(0);
    });

    it("removeAgent returns false for unknown agent", () => {
      const svc = createService();
      const tenant = svc.create({ name: "T", entityType: "personal" });
      expect(svc.removeAgent(tenant.id, "fake")).toBe(false);
    });

    it("getAgent finds tenant-scoped agent", () => {
      const svc = createService();
      const tenant = svc.create({ name: "T", entityType: "llc" });
      const agentId = tenant.agents[0].id;

      const found = svc.getAgent(tenant.id, agentId);
      expect(found).not.toBeNull();
      expect(found!.id).toBe(agentId);
    });

    it("getAgent finds project-scoped agent", () => {
      const svc = createService();
      const tenant = svc.create({ name: "T", entityType: "llc" });
      const project = svc.createProject(tenant.id, { name: "P" });
      const agent = svc.addAgent(tenant.id, {
        name: "DevBot",
        role: "dev",
        projectId: project!.id,
      });

      const found = svc.getAgent(tenant.id, agent!.id);
      expect(found).not.toBeNull();
      expect(found!.name).toBe("DevBot");
    });

    it("getAgent returns null for unknown agent", () => {
      const svc = createService();
      const tenant = svc.create({ name: "T", entityType: "personal" });
      expect(svc.getAgent(tenant.id, "fake")).toBeNull();
    });

    it("listAgents includes both tenant and project agents", () => {
      const svc = createService();
      const tenant = svc.create({ name: "T", entityType: "personal" }); // 1 agent
      const project = svc.createProject(tenant.id, { name: "P" });
      svc.addAgent(tenant.id, {
        name: "ProjBot",
        role: "dev",
        projectId: project!.id,
      });

      // 1 from template + 1 project agent
      expect(svc.listAgents(tenant.id)).toHaveLength(2);
    });

    it("setAgentMaturity updates function level", () => {
      const svc = createService();
      const tenant = svc.create({ name: "T", entityType: "llc" });
      const agentId = tenant.agents[0].id;

      const result = svc.setAgentMaturity(tenant.id, agentId, "finance", 3);

      expect(result).toBe(true);
      const agent = svc.getAgent(tenant.id, agentId);
      expect(agent!.maturity.finance).toBe(3);
    });

    it("setAgentMaturity returns false for unknown agent", () => {
      const svc = createService();
      const tenant = svc.create({ name: "T", entityType: "llc" });
      expect(svc.setAgentMaturity(tenant.id, "fake", "finance", 3)).toBe(false);
    });

    it("agents inherit default model from service config", () => {
      const svc = new TenantService({
        defaultModel: {
          provider: "ollama",
          model: "qwen2.5:14b",
          server: "maximus",
        },
      });
      const tenant = svc.create({ name: "T", entityType: "personal" });
      expect(tenant.agents[0].model.model).toBe("qwen2.5:14b");
      expect(tenant.agents[0].model.server).toBe("maximus");
    });
  });

  describe("project management", () => {
    it("createProject within a tenant", () => {
      const svc = createService();
      const tenant = svc.create({ name: "T", entityType: "llc" });

      const project = svc.createProject(tenant.id, {
        name: "Black Hole Registry",
        description: "Catalog and monitor black holes",
      });

      expect(project).not.toBeNull();
      expect(project!.name).toBe("Black Hole Registry");
      expect(project!.description).toBe("Catalog and monitor black holes");
      expect(project!.agents).toHaveLength(0);
      expect(project!.ledgerId).toMatch(/^ledger-/);
      expect(project!.status).toBe("active");
    });

    it("createProject returns null for unknown tenant", () => {
      const svc = createService();
      expect(svc.createProject("fake", { name: "P" })).toBeNull();
    });

    it("getProject finds project by ID", () => {
      const svc = createService();
      const tenant = svc.create({ name: "T", entityType: "llc" });
      const project = svc.createProject(tenant.id, { name: "P" });

      const found = svc.getProject(tenant.id, project!.id);
      expect(found).not.toBeNull();
      expect(found!.name).toBe("P");
    });

    it("getProject returns null for unknown project", () => {
      const svc = createService();
      const tenant = svc.create({ name: "T", entityType: "llc" });
      expect(svc.getProject(tenant.id, "fake")).toBeNull();
    });

    it("listProjects returns all projects", () => {
      const svc = createService();
      const tenant = svc.create({ name: "T", entityType: "llc" });
      svc.createProject(tenant.id, { name: "P1" });
      svc.createProject(tenant.id, { name: "P2" });

      expect(svc.listProjects(tenant.id)).toHaveLength(2);
    });

    it("listProjects returns empty for unknown tenant", () => {
      const svc = createService();
      expect(svc.listProjects("fake")).toHaveLength(0);
    });
  });

  describe("human management", () => {
    it("addHuman to tenant", () => {
      const svc = createService();
      const tenant = svc.create({ name: "T", entityType: "llc" });

      const human = svc.addHuman(tenant.id, {
        name: "Titus",
        contact: {
          signal: "+1234567890",
          email: "titus@lefthands.ec",
        },
      });

      expect(human).not.toBeNull();
      expect(human!.did).toMatch(/^did:key:z/);
      expect(human!.name).toBe("Titus");
      expect(human!.contact.signal).toBe("+1234567890");
      expect(human!.status).toBe("active");
    });

    it("addHuman returns null for unknown tenant", () => {
      const svc = createService();
      expect(svc.addHuman("fake", { name: "X" })).toBeNull();
    });

    it("listHumans returns all humans", () => {
      const svc = createService();
      const tenant = svc.create({ name: "T", entityType: "llc" });
      svc.addHuman(tenant.id, { name: "Alice" });
      svc.addHuman(tenant.id, { name: "Bob" });

      expect(svc.listHumans(tenant.id)).toHaveLength(2);
    });

    it("listHumans returns empty for unknown tenant", () => {
      const svc = createService();
      expect(svc.listHumans("fake")).toHaveLength(0);
    });
  });

  describe("preview", () => {
    it("previews template without creating tenant", () => {
      const svc = createService();
      const preview = svc.preview("s-corp");

      expect(preview.entityType).toBe("s-corp");
      expect(preview.suggestedAgents).toHaveLength(6);
      expect(svc.size).toBe(0); // nothing created
    });

    it("previews with entity config overrides", () => {
      const svc = createService();
      const preview = svc.preview("llc", {
        memberStructure: "multi",
        memberCount: 3,
      });

      expect(preview.multiSigRequired).toBe(true);
      expect(preview.multiSigThreshold).toBe(3);
      expect(svc.size).toBe(0);
    });
  });

  describe("full lifecycle", () => {
    it("creates tenant, adds humans, creates project, assigns agents", () => {
      const svc = createService();

      // 1. Create tenant
      const tenant = svc.create({
        name: "NerdPlanet LLC",
        entityType: "llc",
        entityConfig: { memberStructure: "multi", memberCount: 2 },
      });
      expect(tenant.agents).toHaveLength(4); // CEO, COO, CFO, Research
      expect(tenant.multiSigRequired).toBe(true);

      // 2. Add humans
      const _titus = svc.addHuman(tenant.id, {
        name: "Titus",
        contact: { signal: "+1111111111" },
      });
      const _colleen = svc.addHuman(tenant.id, {
        name: "Colleen",
        contact: { signal: "+2222222222" },
      });
      expect(svc.listHumans(tenant.id)).toHaveLength(2);

      // 3. Create project
      const project = svc.createProject(tenant.id, {
        name: "Black Hole Registry",
        description: "Catalog black holes for NerdPlanet",
      });
      expect(project).not.toBeNull();

      // 4. Add project-scoped agent
      const devBot = svc.addAgent(tenant.id, {
        name: "DevBot",
        role: "developer",
        skills: ["code_execution", "web_search"],
        projectId: project!.id,
      });
      expect(devBot!.assignment.scope).toBe("project");

      // 5. Verify roster
      const allAgents = svc.listAgents(tenant.id);
      expect(allAgents).toHaveLength(5); // 4 tenant + 1 project
      expect(project!.agents).toHaveLength(1);

      // 6. Progress agent maturity
      const ceoId = tenant.agents.find((a) => a.name === "CEO")!.id;
      svc.setAgentMaturity(tenant.id, ceoId, "communications", 3);
      const ceo = svc.getAgent(tenant.id, ceoId);
      expect(ceo!.maturity.communications).toBe(3);
    });
  });
});
