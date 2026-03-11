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

export async function balanceSheet(pg: PgClient) {
  const result = await pg.query(
    `SELECT id, name, type, currency, balance
     FROM erp.accounts
     WHERE type IN ('asset', 'liability', 'equity')
     ORDER BY type, name`,
  );
  const grouped: Record<string, Array<{ id: string; name: string; balance: number }>> = {
    asset: [],
    liability: [],
    equity: [],
  };
  const totals = { assets: 0, liabilities: 0, equity: 0 };
  for (const row of result.rows) {
    const bal = Number(row.balance);
    grouped[row.type]?.push({ id: row.id, name: row.name, balance: bal });
    if (row.type === "asset") totals.assets += bal;
    else if (row.type === "liability") totals.liabilities += bal;
    else if (row.type === "equity") totals.equity += bal;
  }
  return {
    as_of: new Date().toISOString(),
    assets: grouped.asset,
    liabilities: grouped.liability,
    equity: grouped.equity,
    totals,
  };
}

export async function cashFlowStatement(pg: PgClient, from: string, to: string) {
  const cashId = "e0000001-0001-4000-8000-000000000006";
  const result = await pg.query(
    `SELECT debit, credit, description, reference_type, posted_at
     FROM erp.ledger_entries
     WHERE account_id = $1 AND posted_at >= $2 AND posted_at <= $3
     ORDER BY posted_at`,
    [cashId, from, to],
  );

  const sections: Record<string, Array<{ description: string; amount: number; date: string }>> = {
    operating: [],
    investing: [],
    financing: [],
  };
  const sectionTotals = { operating: 0, investing: 0, financing: 0 };

  for (const row of result.rows) {
    const amount = Number(row.debit) - Number(row.credit);
    const refType = row.reference_type || "expense";
    let section: "operating" | "investing" | "financing" = "operating";
    if (refType === "investment") section = "investing";
    else if (refType === "financing") section = "financing";

    sections[section].push({
      description: row.description,
      amount,
      date: row.posted_at,
    });
    sectionTotals[section] += amount;
  }

  return {
    from,
    to,
    operating: { items: sections.operating, total: sectionTotals.operating },
    investing: { items: sections.investing, total: sectionTotals.investing },
    financing: { items: sections.financing, total: sectionTotals.financing },
    net_change: sectionTotals.operating + sectionTotals.investing + sectionTotals.financing,
  };
}

export async function expenseReport(pg: PgClient, from: string, to: string) {
  const result = await pg.query(
    `SELECT le.debit, le.description, le.posted_at, a.name AS category
     FROM erp.ledger_entries le
     JOIN erp.accounts a ON le.account_id = a.id
     WHERE a.type = 'expense' AND le.debit > 0
       AND le.posted_at >= $1 AND le.posted_at <= $2
     ORDER BY a.name, le.posted_at`,
    [from, to],
  );

  const categoryMap = new Map<
    string,
    { items: Array<{ description: string; amount: number; date: string }>; total: number }
  >();

  for (const row of result.rows) {
    const amount = Number(row.debit);
    if (!categoryMap.has(row.category)) {
      categoryMap.set(row.category, { items: [], total: 0 });
    }
    const cat = categoryMap.get(row.category)!;
    cat.items.push({ description: row.description, amount, date: row.posted_at });
    cat.total += amount;
  }

  const categories = Array.from(categoryMap.entries()).map(([name, data]) => ({
    name,
    items: data.items,
    total: data.total,
  }));

  const grand_total = categories.reduce((s, c) => s + c.total, 0);
  return { from, to, categories, grand_total };
}

export async function budgetVsActual(pg: PgClient, from: string, to: string) {
  const result = await pg.query(
    `SELECT b.id, a.name AS account_name, a.type AS account_type,
            b.budgeted_amount,
            COALESCE(SUM(
              CASE WHEN a.type = 'revenue' THEN le.credit - le.debit
                   ELSE le.debit - le.credit END
            ), 0) AS actual
     FROM erp.budgets b
     JOIN erp.accounts a ON b.account_id = a.id
     LEFT JOIN erp.ledger_entries le
       ON le.account_id = b.account_id
       AND le.posted_at >= b.period_start
       AND le.posted_at <= b.period_end
     WHERE b.period_start >= $1 AND b.period_end <= $2
     GROUP BY b.id, a.name, a.type, b.budgeted_amount
     ORDER BY a.type DESC, a.name`,
    [from, to],
  );

  const lines = result.rows.map((row) => {
    const budgeted = Number(row.budgeted_amount);
    const actual = Number(row.actual);
    const variance = actual - budgeted;
    const variance_pct = budgeted !== 0 ? (variance / budgeted) * 100 : 0;
    return {
      account_name: row.account_name,
      account_type: row.account_type,
      budgeted,
      actual,
      variance,
      variance_pct: Math.round(variance_pct * 100) / 100,
    };
  });

  const totals = lines.reduce(
    (acc, l) => ({
      budgeted: acc.budgeted + l.budgeted,
      actual: acc.actual + l.actual,
      variance: acc.variance + l.variance,
    }),
    { budgeted: 0, actual: 0, variance: 0 },
  );

  return { from, to, lines, totals };
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
