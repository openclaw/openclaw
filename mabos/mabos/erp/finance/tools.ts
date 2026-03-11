import { writeAuditLog } from "../shared/audit.js";
import { createErpDomainTool } from "../shared/tool-factory.js";
import type { ErpAction } from "../shared/tool-factory.js";
import * as q from "./queries.js";

const actions: ErpAction[] = [
  {
    name: "create_invoice",
    description: "Create a new invoice for a customer",
    params: {},
    handler: async (params, ctx) => {
      const invoice = await q.createInvoice(ctx.pg, params as any);
      await writeAuditLog(ctx.pg, {
        domain: "finance",
        entityType: "invoice",
        entityId: invoice.id,
        action: "create",
        agentId: ctx.agentId,
        payload: params as any,
      });
      await ctx.syncEngine?.syncErpToBdi({
        agentDir: ctx.agentDir,
        agentId: ctx.agentId,
        domain: "finance",
        entityType: "invoice",
        trigger: "create",
        record: invoice,
      });
      return { success: true, data: invoice };
    },
  },
  {
    name: "get_invoice",
    description: "Retrieve an invoice by ID",
    params: {},
    handler: async (params, ctx) => {
      const invoice = await q.getInvoice(ctx.pg, (params as any).id);
      return invoice ? { success: true, data: invoice } : { error: "Invoice not found" };
    },
  },
  {
    name: "list_invoices",
    description: "List invoices with optional filters",
    params: {},
    handler: async (params, ctx) => {
      return { success: true, data: await q.listInvoices(ctx.pg, params as any) };
    },
  },
  {
    name: "record_payment",
    description: "Record a payment against an invoice",
    params: {},
    handler: async (params, ctx) => {
      const payment = await q.recordPayment(ctx.pg, params as any);
      await q.postLedgerEntry(ctx.pg, {
        debit_account: "accounts-receivable",
        credit_account: "cash",
        amount: (params as any).amount,
        reference_type: "payment",
        reference_id: payment.id,
      });
      await writeAuditLog(ctx.pg, {
        domain: "finance",
        entityType: "payment",
        entityId: payment.id,
        action: "create",
        agentId: ctx.agentId,
        payload: params as any,
      });
      return { success: true, data: payment };
    },
  },
  {
    name: "get_balance",
    description: "Get current balance of a financial account",
    params: {},
    handler: async (params, ctx) => {
      const account = await q.getAccountBalance(ctx.pg, (params as any).account_id);
      return account ? { success: true, data: account } : { error: "Account not found" };
    },
  },
  {
    name: "profit_loss",
    description: "Generate profit and loss summary for a date range",
    params: {},
    handler: async (params, ctx) => {
      return {
        success: true,
        data: await q.profitLoss(ctx.pg, (params as any).from, (params as any).to),
      };
    },
  },
  {
    name: "create_account",
    description: "Create a new financial account",
    params: {},
    handler: async (params, ctx) => {
      const account = await q.createAccount(ctx.pg, params as any);
      await writeAuditLog(ctx.pg, {
        domain: "finance",
        entityType: "account",
        entityId: account.id,
        action: "create",
        agentId: ctx.agentId,
        payload: params as any,
      });
      return { success: true, data: account };
    },
  },
  {
    name: "post_ledger_entry",
    description: "Post a manual ledger entry",
    params: {},
    handler: async (params, ctx) => {
      const entry = await q.postLedgerEntry(ctx.pg, params as any);
      await writeAuditLog(ctx.pg, {
        domain: "finance",
        entityType: "ledger_entry",
        entityId: (entry as any)?.id ?? "manual",
        action: "create",
        agentId: ctx.agentId,
        payload: params as any,
      });
      return { success: true, data: entry };
    },
  },
];

export const financeTool = createErpDomainTool({
  domain: "finance",
  description: "Financial management - invoices, payments, ledger, accounts, P&L reporting",
  actions,
});
