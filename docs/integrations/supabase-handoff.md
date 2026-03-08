# OpenClaw ↔ Supabase Handoff

This handoff explains exactly how Supabase is wired in this workspace, how to configure it, and how to diagnose failures quickly.

## Integration status

Current integration is **minimal, fetch-based, and zero-dependency**.

- Runtime: Node.js built-in `fetch` (Node >= 18)
- Auth: Supabase service role key (or service key)
- API path used: `/rest/v1/<table>`
- Scope: insert/select helper + CLI test script

## Source map (where things live)

- Helper module: `extensions/supabase/src/index.js`
- Quick test script: `scripts/supabase_test.mjs`
- Basic usage docs: `extensions/supabase/README.md`

## Wiring details

### 1) Environment variables

The helper reads these env vars at runtime:

- `SUPABASE_URL` (required)
- `SUPABASE_SERVICE_ROLE` **or** `SUPABASE_SERVICE_KEY` (required)

Notes:

- `SUPABASE_URL` should look like `https://<project-ref>.supabase.co`
- Service key must have permission for the target table operations.
- Keep keys in secrets files or shell env; do not commit them.

### 2) Helper contract

`extensions/supabase/src/index.js` exports:

- `insertRow(table, row)`
- `selectRows(table, opts)`

Both functions:

- Build endpoint URL as `${SUPABASE_URL}/rest/v1/${table}`
- Send `apikey` and `Authorization: Bearer <key>` headers
- Throw rich errors with `status` and `body` when API calls fail

### 3) Test flow

`scripts/supabase_test.mjs`:

1. Imports helper directly from `extensions/supabase/src/index.js`
2. Tries insert first
3. If insert fails, tries select to expose permission/table issues

Run example (PowerShell):

```powershell
$env:SUPABASE_URL = 'https://your-project.supabase.co'
$env:SUPABASE_SERVICE_ROLE = 'your-service-role-key'
node scripts/supabase_test.mjs my_table '{"name":"test"}'
```

## Common failures and fixes

### Error: missing env vars

Symptoms:

- `Missing SUPABASE_URL in environment`
- `Missing SUPABASE_SERVICE_ROLE or SUPABASE_SERVICE_KEY in environment`

Fix:

- Export the env vars in the active shell before running node scripts.

### Error: table not found / schema cache

Symptoms:

- `Could not find the table 'public.<table_name>' in the schema cache`

Fix:

- Confirm table exists in Supabase database.
- Confirm exact table name (case/underscores).
- Confirm schema is `public` or use proper PostgREST exposure.
- Retry after table creation/migration completes.

### Error: 401/403 permission denied

Symptoms:

- HTTP 401/403 from PostgREST.

Fix:

- Use service role key for admin-style operations.
- Verify RLS policies if using anon/authenticated keys.

### Error: network/DNS unreachable

Symptoms:

- `ENOTFOUND` / DNS errors / timeout.

Fix:

- Validate internet/DNS from host machine.
- Retry from a network that can reach `*.supabase.co`.

## Agent operating checklist (for future support)

When user asks for Supabase integration help, do this in order:

1. Confirm env vars are present in the same shell/session running the script.
2. Run `node scripts/supabase_test.mjs <table> '{"ping":"ok"}'`.
3. If failing, classify by type:
   - env issue,
   - table/schema issue,
   - permission/RLS issue,
   - network issue.
4. Apply smallest fix first (env/table name/policy/network).
5. Re-run test and report exact outcome.

## Security notes

- Never paste full secrets into chat/logs.
- Rotate keys if exposed.
- Prefer local secrets files (outside git) or OS-level secret stores.

## Optional future upgrade path

If needed later, migrate to official client `@supabase/supabase-js` for richer features (auth/storage/realtime), but keep this fetch helper for lightweight scripts and minimal dependencies.

## Incident log: Telegram gateway offline (2026-03-03)

This incident affected OpenClaw message delivery through Telegram and should be used as a repeatable troubleshooting runbook.

### What happened

- User reported Telegram channel appeared offline (messages not getting responses).
- `openclaw gateway health` intermittently showed Telegram OK, but scheduled-task restart path was unstable.
- `openclaw gateway restart` timed out waiting for port `18789` health.
- `openclaw gateway status` showed service runtime `stopped` / `Queued`.
- Manual `openclaw gateway run` successfully initialized Telegram provider (`@GTeezy_bot`).

### Root cause (observed)

- Windows Scheduled Task startup path became unreliable and dropped the gateway process.
- Gateway could run manually, so config and Telegram provider wiring were valid.
- Operationally this was a **service supervision/runtime issue**, not a Telegram credential/config schema issue.

### Recovery steps that worked

1. Verify outage state:
   - `openclaw gateway status`
   - `openclaw gateway health`
2. Start gateway directly (manual process) when scheduled task is unstable:
   - `openclaw gateway run`
3. Re-check health:
   - `openclaw gateway health`
4. Verify outbound Telegram send with correct message flag:
   - `openclaw message send --channel telegram -t 7073743637 -m "OpenClaw is back online. Reply with any text to test."`

### Important command notes

- Use `-m` or `--message` for message text.
- `--text` is not valid for `openclaw message send`.
- Telegram provider does not support `openclaw message read` action in this setup.

### Prevention checklist (to reduce repeats)

- Prefer monitoring with `openclaw gateway status` + `openclaw gateway health` after any restart.
- If scheduled task restart times out, immediately switch to manual `openclaw gateway run` and validate health.
- Keep `channels.telegram.dmPolicy` and `channels.telegram.allowFrom` aligned with active user IDs.
- Keep a live log tail available during incidents:
  - `Get-Content C:\Users\gmone\gateway-log.txt -Wait | Select-String telegram`
- After recovery, always send a known-good probe message and confirm new message ID.

### Fast triage sequence for future incidents

1. `openclaw gateway health`
2. `openclaw gateway status`
3. If service is stopped/queued: `openclaw gateway run`
4. `openclaw gateway health`
5. `openclaw message send --channel telegram -t <chat_id> -m "probe"`

If step 3 succeeds and step 5 sends, Telegram is operational and the fault is in service orchestration, not channel wiring.
