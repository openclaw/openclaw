import { writeAuditLog } from "../shared/audit.js";
import { createErpDomainTool } from "../shared/tool-factory.js";
import type { ErpAction } from "../shared/tool-factory.js";
import * as q from "./queries.js";

const actions: ErpAction[] = [
  {
    name: "create_contract",
    description: "Draft a new contract",
    params: {},
    handler: async (params, ctx) => {
      const contract = await q.createContract(ctx.pg, params as any);
      await writeAuditLog(ctx.pg, {
        domain: "legal",
        entityType: "contract",
        entityId: contract.id,
        action: "create",
        agentId: ctx.agentId,
        payload: params as any,
      });
      return { success: true, data: contract };
    },
  },
  {
    name: "get_contract",
    description: "Retrieve a contract by ID",
    params: {},
    handler: async (params, ctx) => {
      const contract = await q.getContract(ctx.pg, (params as any).id);
      return contract ? { success: true, data: contract } : { error: "Contract not found" };
    },
  },
  {
    name: "list_contracts",
    description: "List contracts with optional status, counterparty, and type filters",
    params: {},
    handler: async (params, ctx) => {
      return { success: true, data: await q.listContracts(ctx.pg, params as any) };
    },
  },
  {
    name: "update_contract",
    description: "Update an existing contract",
    params: {},
    handler: async (params, ctx) => {
      const { id, ...rest } = params as any;
      const contract = await q.updateContract(ctx.pg, id, rest);
      if (!contract) return { error: "Contract not found or no changes" };
      await writeAuditLog(ctx.pg, {
        domain: "legal",
        entityType: "contract",
        entityId: id,
        action: "update",
        agentId: ctx.agentId,
        payload: rest,
      });
      return { success: true, data: contract };
    },
  },
  {
    name: "expiring_contracts",
    description: "List contracts expiring within a given number of days",
    params: {},
    handler: async (params, ctx) => {
      const withinDays = (params as any).within_days ?? 30;
      const contracts = await q.expiringContracts(ctx.pg, withinDays);
      return { success: true, data: contracts };
    },
  },
  {
    name: "create_case",
    description: "Open a new legal case",
    params: {},
    handler: async (params, ctx) => {
      const legalCase = await q.createCase(ctx.pg, params as any);
      await writeAuditLog(ctx.pg, {
        domain: "legal",
        entityType: "legal_case",
        entityId: legalCase.id,
        action: "create",
        agentId: ctx.agentId,
        payload: params as any,
      });
      return { success: true, data: legalCase };
    },
  },
  {
    name: "get_case",
    description: "Retrieve a legal case by ID",
    params: {},
    handler: async (params, ctx) => {
      const legalCase = await q.getCase(ctx.pg, (params as any).id);
      return legalCase ? { success: true, data: legalCase } : { error: "Case not found" };
    },
  },
  {
    name: "list_cases",
    description: "List legal cases with optional status and case type filters",
    params: {},
    handler: async (params, ctx) => {
      return { success: true, data: await q.listCases(ctx.pg, params as any) };
    },
  },
  {
    name: "update_case",
    description: "Update an existing legal case",
    params: {},
    handler: async (params, ctx) => {
      const { id, ...rest } = params as any;
      const legalCase = await q.updateCase(ctx.pg, id, rest);
      if (!legalCase) return { error: "Case not found or no changes" };
      await writeAuditLog(ctx.pg, {
        domain: "legal",
        entityType: "legal_case",
        entityId: id,
        action: "update",
        agentId: ctx.agentId,
        payload: rest,
      });
      return { success: true, data: legalCase };
    },
  },

  // ── New Legal Redesign Actions ─────────────────────────────

  {
    name: "list_partnership_contracts",
    description: "List partnership contracts with optional status filter",
    params: {},
    handler: async (params, ctx) => {
      return { success: true, data: await q.listPartnershipContracts(ctx.pg, params as any) };
    },
  },
  {
    name: "create_partnership_contract",
    description: "Create a new partnership contract",
    params: {},
    handler: async (params, ctx) => {
      const contract = await q.createPartnershipContract(ctx.pg, params as any);
      await writeAuditLog(ctx.pg, {
        domain: "legal",
        entityType: "partnership_contract",
        entityId: contract.id,
        action: "create",
        agentId: ctx.agentId,
        payload: params as any,
      });
      return { success: true, data: contract };
    },
  },
  {
    name: "list_freelancer_contracts",
    description: "List freelancer contracts with optional status filter",
    params: {},
    handler: async (params, ctx) => {
      return { success: true, data: await q.listFreelancerContracts(ctx.pg, params as any) };
    },
  },
  {
    name: "create_freelancer_contract",
    description: "Create a new freelancer contract",
    params: {},
    handler: async (params, ctx) => {
      const contract = await q.createFreelancerContract(ctx.pg, params as any);
      await writeAuditLog(ctx.pg, {
        domain: "legal",
        entityType: "freelancer_contract",
        entityId: contract.id,
        action: "create",
        agentId: ctx.agentId,
        payload: params as any,
      });
      return { success: true, data: contract };
    },
  },
  {
    name: "list_corporate_documents",
    description: "List corporate documents with optional doc_type and status filters",
    params: {},
    handler: async (params, ctx) => {
      return { success: true, data: await q.listCorporateDocuments(ctx.pg, params as any) };
    },
  },
  {
    name: "get_legal_structure",
    description: "Get the business legal structure (entity type, EIN, etc.)",
    params: {},
    handler: async (_params, ctx) => {
      const structure = await q.getLegalStructure(ctx.pg);
      return structure
        ? { success: true, data: structure }
        : { error: "No legal structure configured" };
    },
  },
  {
    name: "list_compliance_guardrails",
    description: "List compliance guardrails with optional active and category filters",
    params: {},
    handler: async (params, ctx) => {
      return { success: true, data: await q.listComplianceGuardrails(ctx.pg, params as any) };
    },
  },
];

export const legalTool = createErpDomainTool({
  domain: "legal",
  description:
    "Legal management - contracts, legal cases, expiration tracking, and case management",
  actions,
});
