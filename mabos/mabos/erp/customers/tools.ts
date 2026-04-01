import { writeAuditLog } from "../shared/audit.js";
import { createErpDomainTool } from "../shared/tool-factory.js";
import type { ErpAction } from "../shared/tool-factory.js";
import * as q from "./queries.js";

const actions: ErpAction[] = [
  {
    name: "create",
    description: "Create a new contact",
    params: {},
    handler: async (params, ctx) => {
      const contact = await q.createContact(ctx.pg, params);
      await writeAuditLog(ctx.pg, {
        domain: "customers",
        entityType: "contact",
        entityId: contact.id,
        action: "create",
        agentId: ctx.agentId,
        payload: params,
      });
      await ctx.syncEngine?.syncErpToBdi({
        agentDir: ctx.agentDir,
        agentId: ctx.agentId,
        domain: "customers",
        entityType: "contact",
        trigger: "create",
        record: contact,
      });
      return { success: true, data: contact };
    },
  },
  {
    name: "get",
    description: "Get contact by ID",
    params: {},
    handler: async (params, ctx) => {
      const contact = await q.getContact(ctx.pg, params.id);
      return contact ? { success: true, data: contact } : { error: "Contact not found" };
    },
  },
  {
    name: "list",
    description: "List contacts with filters",
    params: {},
    handler: async (params, ctx) => {
      return { success: true, data: await q.listContacts(ctx.pg, params) };
    },
  },
  {
    name: "search",
    description: "Search contacts by name/email/company",
    params: {},
    handler: async (params, ctx) => {
      return {
        success: true,
        data: await q.searchContacts(ctx.pg, params.query, params.limit),
      };
    },
  },
  {
    name: "update",
    description: "Update contact fields",
    params: {},
    handler: async (params, ctx) => {
      const { id, ...fields } = params;
      const contact = await q.updateContact(ctx.pg, id, fields);
      if (!contact) {
        return { error: "Contact not found" };
      }
      await writeAuditLog(ctx.pg, {
        domain: "customers",
        entityType: "contact",
        entityId: id,
        action: "update",
        agentId: ctx.agentId,
        payload: fields,
      });
      return { success: true, data: contact };
    },
  },
  {
    name: "delete",
    description: "Archive a contact (soft delete)",
    params: {},
    handler: async (params, ctx) => {
      const contact = await q.deleteContact(ctx.pg, params.id);
      if (!contact) {
        return { error: "Contact not found" };
      }
      await writeAuditLog(ctx.pg, {
        domain: "customers",
        entityType: "contact",
        entityId: params.id,
        action: "archive",
        agentId: ctx.agentId,
      });
      return { success: true, data: contact };
    },
  },
  {
    name: "log_interaction",
    description: "Log a customer interaction",
    params: {},
    handler: async (params, ctx) => {
      const interaction = await q.logInteraction(ctx.pg, params);
      await writeAuditLog(ctx.pg, {
        domain: "customers",
        entityType: "interaction",
        entityId: interaction.id,
        action: "create",
        agentId: ctx.agentId,
        payload: params,
      });
      return { success: true, data: interaction };
    },
  },
];

export const customersTool = createErpDomainTool({
  domain: "customers",
  description: "CRM - contacts, accounts, segments, interactions, lifecycle management",
  actions,
});
