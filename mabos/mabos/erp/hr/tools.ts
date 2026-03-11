import { writeAuditLog } from "../shared/audit.js";
import { createErpDomainTool } from "../shared/tool-factory.js";
import type { ErpAction } from "../shared/tool-factory.js";
import * as q from "./queries.js";

const actions: ErpAction[] = [
  {
    name: "onboard_employee",
    description: "Create/onboard a new employee",
    params: {},
    handler: async (params, ctx) => {
      const employee = await q.createEmployee(ctx.pg, params as any);
      await writeAuditLog(ctx.pg, {
        domain: "hr",
        entityType: "employee",
        entityId: employee.id,
        action: "create",
        agentId: ctx.agentId,
        payload: params as any,
      });
      return { success: true, data: employee };
    },
  },
  {
    name: "get",
    description: "Get employee by ID",
    params: {},
    handler: async (params, ctx) => {
      const employee = await q.getEmployee(ctx.pg, (params as any).id);
      return employee ? { success: true, data: employee } : { error: "Employee not found" };
    },
  },
  {
    name: "list",
    description: "List employees with filters",
    params: {},
    handler: async (params, ctx) => {
      return { success: true, data: await q.listEmployees(ctx.pg, params as any) };
    },
  },
  {
    name: "update",
    description: "Update employee fields",
    params: {},
    handler: async (params, ctx) => {
      const { id, ...fields } = params as any;
      const employee = await q.updateEmployee(ctx.pg, id, fields);
      if (!employee) return { error: "Employee not found" };
      await writeAuditLog(ctx.pg, {
        domain: "hr",
        entityType: "employee",
        entityId: id,
        action: "update",
        agentId: ctx.agentId,
        payload: fields,
      });
      return { success: true, data: employee };
    },
  },
  {
    name: "delete",
    description: "Archive an employee (soft delete)",
    params: {},
    handler: async (params, ctx) => {
      const employee = await q.deleteEmployee(ctx.pg, (params as any).id);
      if (!employee) return { error: "Employee not found" };
      await writeAuditLog(ctx.pg, {
        domain: "hr",
        entityType: "employee",
        entityId: (params as any).id,
        action: "archive",
        agentId: ctx.agentId,
      });
      return { success: true, data: employee };
    },
  },
  {
    name: "run_payroll",
    description: "Process payroll for an employee",
    params: {},
    handler: async (params, ctx) => {
      const payroll = await q.runPayroll(ctx.pg, params as any);
      await writeAuditLog(ctx.pg, {
        domain: "hr",
        entityType: "payroll",
        entityId: payroll.id,
        action: "create",
        agentId: ctx.agentId,
        payload: params as any,
      });
      return { success: true, data: payroll };
    },
  },
];

export const hrTool = createErpDomainTool({
  domain: "hr",
  description: "Human resources - employees, roles, departments, onboarding, payroll",
  actions,
});
