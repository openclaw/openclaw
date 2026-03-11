import type { PgClient } from "../db/postgres.js";
export declare function createInvoice(pg: PgClient, params: {
    customer_id: string;
    line_items?: unknown[];
    due_date?: string;
    currency?: string;
}): Promise<any>;
export declare function getInvoice(pg: PgClient, id: string): Promise<any>;
export declare function listInvoices(pg: PgClient, params: {
    status?: string;
    customer_id?: string;
    limit?: number;
}): Promise<any[]>;
export declare function recordPayment(pg: PgClient, params: {
    invoice_id: string;
    amount: number;
    method?: string;
}): Promise<any>;
export declare function postLedgerEntry(pg: PgClient, params: {
    debit_account?: string;
    credit_account?: string;
    account_id?: string;
    debit?: number;
    credit?: number;
    amount?: number;
    description?: string;
    reference_type?: string;
    reference_id?: string;
}): Promise<any>;
export declare function getAccountBalance(pg: PgClient, accountId: string): Promise<any>;
export declare function profitLoss(pg: PgClient, from: string, to: string): Promise<{
    from: string;
    to: string;
    net: any;
}>;
export declare function listAccounts(pg: PgClient, params: {
    type?: string;
    limit?: number;
}): Promise<any[]>;
export declare function balanceSheet(pg: PgClient): Promise<{
    as_of: string;
    assets: {
        id: string;
        name: string;
        balance: number;
    }[];
    liabilities: {
        id: string;
        name: string;
        balance: number;
    }[];
    equity: {
        id: string;
        name: string;
        balance: number;
    }[];
    totals: {
        assets: number;
        liabilities: number;
        equity: number;
    };
}>;
export declare function cashFlowStatement(pg: PgClient, from: string, to: string): Promise<{
    from: string;
    to: string;
    operating: {
        items: {
            description: string;
            amount: number;
            date: string;
        }[];
        total: number;
    };
    investing: {
        items: {
            description: string;
            amount: number;
            date: string;
        }[];
        total: number;
    };
    financing: {
        items: {
            description: string;
            amount: number;
            date: string;
        }[];
        total: number;
    };
    net_change: number;
}>;
export declare function expenseReport(pg: PgClient, from: string, to: string): Promise<{
    from: string;
    to: string;
    categories: {
        name: string;
        items: {
            description: string;
            amount: number;
            date: string;
        }[];
        total: number;
    }[];
    grand_total: number;
}>;
export declare function budgetVsActual(pg: PgClient, from: string, to: string): Promise<{
    from: string;
    to: string;
    lines: {
        account_name: any;
        account_type: any;
        budgeted: number;
        actual: number;
        variance: number;
        variance_pct: number;
    }[];
    totals: {
        budgeted: number;
        actual: number;
        variance: number;
    };
}>;
export declare function createAccount(pg: PgClient, params: {
    name: string;
    type: string;
    currency?: string;
    parent_id?: string;
}): Promise<any>;
//# sourceMappingURL=queries.d.ts.map