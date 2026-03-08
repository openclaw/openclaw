# Supabase integration (minimal)

This folder contains a small, **zero-dependency** helper that uses the Supabase REST API via built-in `fetch`.

For full setup/wiring/troubleshooting handoff, see:

- `docs/integrations/supabase-handoff.md`

Files:

- `src/index.js` — ESM module exposing `insertRow(table, row)` and `selectRows(table, opts)`.
- `../../scripts/supabase_test.mjs` — quick CLI script to test insert/select.

Environment variables required:

- `SUPABASE_URL` — your Supabase project URL (e.g. `https://xyz.supabase.co`).
- `SUPABASE_SERVICE_ROLE` or `SUPABASE_SERVICE_KEY` — service role or service key with appropriate permissions.

Usage example (PowerShell / cmd):

```powershell
$env:SUPABASE_URL = 'https://your-project.supabase.co'
$env:SUPABASE_SERVICE_ROLE = 'your-service-role-key'
node scripts/supabase_test.mjs my_table '{"name":"test"}'
```

Notes:

- No npm install needed — uses the built-in `fetch` in Node >=18.
- Calls the PostgREST endpoint at `/rest/v1/<table>` and requires that the table exists and the service key has appropriate permissions.
- If you'd prefer the official `@supabase/supabase-js` client instead, let me know and I can switch back.
