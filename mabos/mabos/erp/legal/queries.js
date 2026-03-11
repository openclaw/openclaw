export async function createContract(pg, params) {
    const result = await pg.query(`INSERT INTO erp.contracts (id, title, counterparty, type, value, currency, status, start_date, end_date, terms)
     VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, 'draft', $6, $7, $8) RETURNING *`, [
        params.title,
        params.counterparty,
        params.type,
        params.value ?? null,
        params.currency ?? null,
        params.start_date ?? null,
        params.end_date ?? null,
        params.terms ?? null,
    ]);
    return result.rows[0];
}
export async function getContract(pg, id) {
    const result = await pg.query("SELECT * FROM erp.contracts WHERE id = $1", [id]);
    return result.rows[0] ?? null;
}
export async function listContracts(pg, params) {
    const conditions = [];
    const values = [];
    let idx = 1;
    if (params.status) {
        conditions.push(`status = $${idx++}`);
        values.push(params.status);
    }
    if (params.counterparty) {
        conditions.push(`counterparty = $${idx++}`);
        values.push(params.counterparty);
    }
    if (params.type) {
        conditions.push(`type = $${idx++}`);
        values.push(params.type);
    }
    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    const result = await pg.query(`SELECT * FROM erp.contracts ${where} ORDER BY created_at DESC LIMIT $${idx}`, [...values, params.limit ?? 50]);
    return result.rows;
}
export async function updateContract(pg, id, params) {
    const keys = Object.keys(params).filter((k) => params[k] !== undefined);
    if (keys.length === 0)
        return null;
    const setClauses = keys.map((k, i) => `${k} = $${i + 2}`).join(", ");
    const values = keys.map((k) => params[k]);
    const result = await pg.query(`UPDATE erp.contracts SET ${setClauses}, updated_at = now() WHERE id = $1 RETURNING *`, [id, ...values]);
    return result.rows[0] ?? null;
}
export async function expiringContracts(pg, withinDays) {
    const result = await pg.query(`SELECT * FROM erp.contracts
     WHERE end_date <= now() + make_interval(days => $1)
       AND end_date >= now()
       AND status = 'active'
     ORDER BY end_date ASC`, [withinDays]);
    return result.rows;
}
export async function createCase(pg, params) {
    const result = await pg.query(`INSERT INTO erp.legal_cases (id, title, case_type, status, priority, assigned_to, description, filed_date)
     VALUES (gen_random_uuid(), $1, $2, 'open', $3, $4, $5, $6) RETURNING *`, [
        params.title,
        params.case_type,
        params.priority ?? "medium",
        params.assigned_to ?? null,
        params.description ?? null,
        params.filed_date ?? null,
    ]);
    return result.rows[0];
}
export async function getCase(pg, id) {
    const result = await pg.query("SELECT * FROM erp.legal_cases WHERE id = $1", [id]);
    return result.rows[0] ?? null;
}
export async function listCases(pg, params) {
    const conditions = [];
    const values = [];
    let idx = 1;
    if (params.status) {
        conditions.push(`status = $${idx++}`);
        values.push(params.status);
    }
    if (params.case_type) {
        conditions.push(`case_type = $${idx++}`);
        values.push(params.case_type);
    }
    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    const result = await pg.query(`SELECT * FROM erp.legal_cases ${where} ORDER BY created_at DESC LIMIT $${idx}`, [...values, params.limit ?? 50]);
    return result.rows;
}
export async function updateCase(pg, id, params) {
    const keys = Object.keys(params).filter((k) => params[k] !== undefined);
    if (keys.length === 0)
        return null;
    const setClauses = keys.map((k, i) => `${k} = $${i + 2}`).join(", ");
    const values = keys.map((k) => params[k]);
    const result = await pg.query(`UPDATE erp.legal_cases SET ${setClauses}, updated_at = now() WHERE id = $1 RETURNING *`, [id, ...values]);
    return result.rows[0] ?? null;
}
// ── New Legal Queries (Redesign) ─────────────────────────────
// Partnership Contracts
export async function listPartnershipContracts(pg, params) {
    const conditions = [];
    const values = [];
    let idx = 1;
    if (params.status) {
        conditions.push(`status = $${idx++}`);
        values.push(params.status);
    }
    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    const result = await pg.query(`SELECT * FROM erp.partnership_contracts ${where} ORDER BY created_at DESC LIMIT $${idx}`, [...values, params.limit ?? 50]);
    return result.rows;
}
export async function createPartnershipContract(pg, params) {
    const result = await pg.query(`INSERT INTO erp.partnership_contracts (id, partner_name, partner_type, ownership_pct, revenue_share_pct, status, start_date, end_date, terms, document_url)
     VALUES (gen_random_uuid(), $1, $2, $3, $4, 'draft', $5, $6, $7, $8) RETURNING *`, [
        params.partner_name,
        params.partner_type ?? null,
        params.ownership_pct ?? null,
        params.revenue_share_pct ?? null,
        params.start_date ?? null,
        params.end_date ?? null,
        params.terms ?? null,
        params.document_url ?? null,
    ]);
    return result.rows[0];
}
// Freelancer Contracts
export async function listFreelancerContracts(pg, params) {
    const conditions = [];
    const values = [];
    let idx = 1;
    if (params.status) {
        conditions.push(`status = $${idx++}`);
        values.push(params.status);
    }
    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    const result = await pg.query(`SELECT * FROM erp.freelancer_contracts ${where} ORDER BY created_at DESC LIMIT $${idx}`, [...values, params.limit ?? 50]);
    return result.rows;
}
export async function createFreelancerContract(pg, params) {
    const result = await pg.query(`INSERT INTO erp.freelancer_contracts (id, contractor_name, scope_of_work, rate_type, rate_amount, currency, status, start_date, end_date, deliverables, document_url)
     VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, 'draft', $6, $7, $8, $9) RETURNING *`, [
        params.contractor_name,
        params.scope_of_work ?? null,
        params.rate_type ?? "hourly",
        params.rate_amount,
        params.currency ?? "USD",
        params.start_date ?? null,
        params.end_date ?? null,
        JSON.stringify(params.deliverables ?? []),
        params.document_url ?? null,
    ]);
    return result.rows[0];
}
// Corporate Documents
export async function listCorporateDocuments(pg, params) {
    const conditions = [];
    const values = [];
    let idx = 1;
    if (params.doc_type) {
        conditions.push(`doc_type = $${idx++}`);
        values.push(params.doc_type);
    }
    if (params.status) {
        conditions.push(`status = $${idx++}`);
        values.push(params.status);
    }
    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    const result = await pg.query(`SELECT * FROM erp.corporate_documents ${where} ORDER BY filing_date DESC NULLS LAST LIMIT $${idx}`, [...values, params.limit ?? 50]);
    return result.rows;
}
// Legal Structure
export async function getLegalStructure(pg) {
    const result = await pg.query("SELECT * FROM erp.legal_structure ORDER BY created_at ASC LIMIT 1");
    return result.rows[0] ?? null;
}
// Compliance Guardrails
export async function listComplianceGuardrails(pg, params) {
    const conditions = [];
    const values = [];
    let idx = 1;
    if (params.active !== undefined) {
        conditions.push(`active = $${idx++}`);
        values.push(params.active);
    }
    if (params.category) {
        conditions.push(`category = $${idx++}`);
        values.push(params.category);
    }
    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    const result = await pg.query(`SELECT * FROM erp.compliance_guardrails ${where} ORDER BY severity DESC, name ASC LIMIT $${idx}`, [...values, params.limit ?? 50]);
    return result.rows;
}
//# sourceMappingURL=queries.js.map