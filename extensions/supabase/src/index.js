// Supabase helper using built-in fetch (Node >=18/22)
// No external dependencies required.
// Exports ESM functions: insertRow, selectRows

function getSupabaseHeaders() {
  const key = process.env.SUPABASE_SERVICE_ROLE || process.env.SUPABASE_SERVICE_KEY;
  if (!key) throw new Error('Missing SUPABASE_SERVICE_ROLE or SUPABASE_SERVICE_KEY in environment');
  return {
    'apikey': key,
    'Authorization': `Bearer ${key}`,
    'Content-Type': 'application/json',
  };
}

function getBaseUrl() {
  const url = process.env.SUPABASE_URL;
  if (!url) throw new Error('Missing SUPABASE_URL in environment');
  return url.replace(/\/$/, '');
}

export async function insertRow(table, row) {
  const base = getBaseUrl();
  const headers = getSupabaseHeaders();
  const res = await fetch(`${base}/rest/v1/${encodeURIComponent(table)}`, {
    method: 'POST',
    headers: headers,
    body: JSON.stringify(row),
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch (e) { json = text; }
  if (!res.ok) {
    const err = new Error('Supabase insert failed');
    err.status = res.status;
    err.body = json;
    throw err;
  }
  return json;
}

export async function selectRows(table, opts = {}) {
  const base = getBaseUrl();
  const headers = getSupabaseHeaders();
  const params = new URLSearchParams();
  if (opts.select) params.set('select', opts.select);
  if (opts.limit) params.set('limit', String(opts.limit));
  const url = `${base}/rest/v1/${encodeURIComponent(table)}${params.toString() ? '?' + params.toString() : ''}`;
  const res = await fetch(url, { method: 'GET', headers });
  const json = await res.json();
  if (!res.ok) {
    const err = new Error('Supabase select failed');
    err.status = res.status;
    err.body = json;
    throw err;
  }
  return json;
}

export default {
  insertRow,
  selectRows,
};
