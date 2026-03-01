import type { PgClient } from "../db/postgres.js";

export async function createInvoice(
  pg: PgClient,
  params: { customer_id: string; line_items?: unknown[]; due_date?: string; currency?: string },
) {
  const lineItems = params.line_items ?? [];
  const amount = (lineItems as Array<{ quantity: number; unit_price: number }>).reduce(
    (sum, item) => sum + (item.quantity ?? 1) * (item.unit_price ?? 0),
    0,
  );
  const result = await pg.query(
    `INSERT INTO erp.invoices (id, customer_id, status, amount, currency, due_date, line_items)
     VALUES (gen_random_uuid(), $1, 'draft', $2, $3, $4, $5) RETURNING *`,
    [
      params.customer_id,
      amount,
      params.currency ?? "USD",
      params.due_date ?? null,
      JSON.stringify(lineItems),
    ],
  );
  return result.rows[0];
}

export async function getInvoice(pg: PgClient, id: string) {
  const result = await pg.query("SELECT * FROM erp.invoices WHERE id = $1", [id]);
  return result.rows[0] ?? null;
}

export async function listInvoices(
  pg: PgClient,
  params: { status?: string; customer_id?: string; limit?: number },
) {
  const conditions: string[] = [];
  const values: unknown[] = [];
  let idx = 1;
  if (params.status) {
    conditions.push(`i.status = $${idx++}`);
    values.push(params.status);
  }
  if (params.customer_id) {
    conditions.push(`i.customer_id = $${idx++}`);
    values.push(params.customer_id);
  }
  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  const result = await pg.query(
    `SELECT i.*, c.name AS customer_name
     FROM erp.invoices i
     LEFT JOIN erp.contacts c ON i.customer_id = c.id
     ${where} ORDER BY i.created_at DESC LIMIT $${idx}`,
    [...values, params.limit ?? 50],
  );
  return result.rows;
}

export async function recordPayment(
  pg: PgClient,
  params: { invoice_id: string; amount: number; method?: string },
) {
  const result = await pg.query(
    `INSERT INTO erp.payments (id, invoice_id, amount, method, status, processed_at)
     VALUES (gen_random_uuid(), $1, $2, $3, 'completed', now()) RETURNING *`,
    [params.invoice_id, params.amount, params.method ?? null],
  );
  // Update invoice status if fully paid
  await pg.query(
    `UPDATE erp.invoices SET status = CASE
       WHEN (SELECT COALESCE(SUM(amount), 0) FROM erp.payments WHERE invoice_id = $1 AND status = 'completed') >= amount THEN 'paid'
       ELSE 'partial'
     END WHERE id = $1`,
    [params.invoice_id],
  );
  return result.rows[0];
}

export async function postLedgerEntry(
  pg: PgClient,
  params: {
    debit_account?: string;
    credit_account?: string;
    account_id?: string;
    debit?: number;
    credit?: number;
    amount?: number;
    description?: string;
    reference_type?: string;
    reference_id?: string;
  },
) {
  // Simple single-entry if account_id provided
  if (params.account_id) {
    const result = await pg.query(
      `INSERT INTO erp.ledger_entries (id, account_id, debit, credit, description, reference_type, reference_id)
       VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6) RETURNING *`,
      [
        params.account_id,
        params.debit ?? 0,
        params.credit ?? 0,
        params.description ?? null,
        params.reference_type ?? null,
        params.reference_id ?? null,
      ],
    );
    return result.rows[0];
  }
  // Double-entry: debit one account, credit another
  const amount = params.amount ?? 0;
  if (params.debit_account) {
    await pg.query(
      `INSERT INTO erp.ledger_entries (id, account_id, debit, credit, description, reference_type, reference_id)
       VALUES (gen_random_uuid(), (SELECT id FROM erp.accounts WHERE name = $1 LIMIT 1), $2, 0, $3, $4, $5)`,
      [
        params.debit_account,
        amount,
        params.description ?? null,
        params.reference_type ?? null,
        params.reference_id ?? null,
      ],
    );
  }
  if (params.credit_account) {
    await pg.query(
      `INSERT INTO erp.ledger_entries (id, account_id, debit, credit, description, reference_type, reference_id)
       VALUES (gen_random_uuid(), (SELECT id FROM erp.accounts WHERE name = $1 LIMIT 1), 0, $2, $3, $4, $5)`,
      [
        params.credit_account,
        amount,
        params.description ?? null,
        params.reference_type ?? null,
        params.reference_id ?? null,
      ],
    );
  }
  return { success: true };
}

export async function getAccountBalance(pg: PgClient, accountId: string) {
  const result = await pg.query("SELECT * FROM erp.accounts WHERE id = $1", [accountId]);
  return result.rows[0] ?? null;
}

export async function profitLoss(pg: PgClient, from: string, to: string) {
  const revenue = await pg.query(
    "SELECT COALESCE(SUM(credit - debit), 0) as total FROM erp.ledger_entries WHERE posted_at >= $1 AND posted_at <= $2",
    [from, to],
  );
  return { from, to, net: revenue.rows[0]?.total ?? 0 };
}

export async function listAccounts(pg: PgClient, params: { type?: string; limit?: number }) {
  const conditions: string[] = [];
  const values: unknown[] = [];
  let idx = 1;
  if (params.type) {
    conditions.push(`type = $${idx++}`);
    values.push(params.type);
  }
  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  const result = await pg.query(
    `SELECT * FROM erp.accounts ${where} ORDER BY name ASC LIMIT $${idx}`,
    [...values, params.limit ?? 50],
  );
  return result.rows;
}

export async function createAccount(
  pg: PgClient,
  params: { name: string; type: string; currency?: string; parent_id?: string },
) {
  const result = await pg.query(
    `INSERT INTO erp.accounts (id, name, type, currency, parent_id)
     VALUES (gen_random_uuid(), $1, $2, $3, $4) RETURNING *`,
    [params.name, params.type, params.currency ?? "USD", params.parent_id ?? null],
  );
  return result.rows[0];
}
