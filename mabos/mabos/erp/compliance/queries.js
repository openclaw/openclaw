export async function createPolicy(pg, params) {
    const result = await pg.query(`INSERT INTO erp.policies (id, title, category, version, status, effective_date, content)
     VALUES (gen_random_uuid(), $1, $2, $3, 'draft', $4, $5) RETURNING *`, [
        params.title,
        params.category,
        params.version ?? "1.0",
        params.effective_date ?? null,
        params.content ?? null,
    ]);
    return result.rows[0];
}
export async function getPolicy(pg, id) {
    const result = await pg.query("SELECT * FROM erp.policies WHERE id = $1", [id]);
    return result.rows[0] ?? null;
}
export async function listPolicies(pg, params) {
    const conditions = [];
    const values = [];
    let idx = 1;
    if (params.status) {
        conditions.push(`status = $${idx++}`);
        values.push(params.status);
    }
    if (params.category) {
        conditions.push(`category = $${idx++}`);
        values.push(params.category);
    }
    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    const result = await pg.query(`SELECT * FROM erp.policies ${where} ORDER BY created_at DESC LIMIT $${idx}`, [...values, params.limit ?? 50]);
    return result.rows;
}
export async function updatePolicy(pg, id, params) {
    const keys = Object.keys(params).filter((k) => params[k] !== undefined);
    if (keys.length === 0)
        return null;
    const setClauses = keys.map((k, i) => `${k} = $${i + 2}`).join(", ");
    const values = keys.map((k) => params[k]);
    const result = await pg.query(`UPDATE erp.policies SET ${setClauses}, updated_at = now() WHERE id = $1 RETURNING *`, [id, ...values]);
    return result.rows[0] ?? null;
}
export async function reportViolation(pg, params) {
    const result = await pg.query(`INSERT INTO erp.violations (id, policy_id, severity, status, description, reported_by)
     VALUES (gen_random_uuid(), $1, $2, 'open', $3, $4) RETURNING *`, [params.policy_id ?? null, params.severity, params.description, params.reported_by ?? null]);
    return result.rows[0];
}
export async function getViolation(pg, id) {
    const result = await pg.query("SELECT * FROM erp.violations WHERE id = $1", [id]);
    return result.rows[0] ?? null;
}
export async function listViolations(pg, params) {
    const conditions = [];
    const values = [];
    let idx = 1;
    if (params.status) {
        conditions.push(`status = $${idx++}`);
        values.push(params.status);
    }
    if (params.severity) {
        conditions.push(`severity = $${idx++}`);
        values.push(params.severity);
    }
    if (params.policy_id) {
        conditions.push(`policy_id = $${idx++}`);
        values.push(params.policy_id);
    }
    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    const result = await pg.query(`SELECT * FROM erp.violations ${where} ORDER BY created_at DESC LIMIT $${idx}`, [...values, params.limit ?? 50]);
    return result.rows;
}
export async function resolveViolation(pg, id, resolution) {
    const result = await pg.query(`UPDATE erp.violations SET status = 'resolved', resolved_at = now(), resolution_notes = $2, updated_at = now()
     WHERE id = $1 RETURNING *`, [id, resolution]);
    return result.rows[0] ?? null;
}
//# sourceMappingURL=queries.js.map