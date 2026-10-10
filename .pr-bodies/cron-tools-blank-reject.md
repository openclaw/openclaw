## What Problem This Solves

Fixes: `openclaw cron add/edit --tools ''` (or whitespace-only) silently persists `toolsAllow: []`, stripping every tool from the job. Omitting `--tools` correctly defaults to `["*"]`.

## User Impact

User impact: an explicit blank `--tools` is rejected before the Gateway write, so a typo or empty shell variable cannot create a tool-less automation. Omitting `--tools` still defaults to unrestricted `["*"]`; nonempty lists are unchanged.

## Why This Change Was Made

`parseCronStringList("")` returned `[]`, and the add/edit paths persisted that empty grant. Empty arrays are truthy, so the omit-vs-blank distinction was lost. The fix rejects blank string lists (with `--tools` / `--fallbacks` flags) before Gateway access, matching other cron blank guards (`--script`, `--command-cwd`).

## Evidence

- Changed: `src/cli/cron-cli/shared.ts`, `register.cron-add.ts`, `register.cron-edit.ts`, `register.cron-edit-options.ts`; colocated tests
- Packaged CLI against live Gateway `ws://127.0.0.1:18991`: base RED (`toolsAllow: []`, job created) / head GREEN (exit 1, `--tools must not be blank`, no job)
- Unit: `src/cli/cron-cli/shared.test.ts`, `cron-cli.test.ts`, `register.cron-edit.test.ts` — 189 passed
- Dedup: no open PR owning blank `--tools` / `parseCronStringList` empty-list rejection

## Real behavior proof

### Behavior or issue addressed

Explicit blank `--tools` must not persist `toolsAllow: []`; omit `--tools` must still default to `["*"]`; nonempty `--tools read` must still work.

### Canonical reachability path

Packaged `openclaw cron add … --tools ''` → `parseCronStringList` → `CronCliError` before `cron.add` Gateway RPC.

### Shared helper / provider constraint check

Only `parseCronStringList` (cron CLI). Callers: cron add/edit `--tools` and `--fallbacks`. No change to Gateway tool-policy defaults.

### Real environment tested

CLI via `node --import ./scripts/tsx.mjs src/entry.ts` against Gateway on `ws://127.0.0.1:18991` with temporary state `/tmp/ochunt-gw1`.

### Exact steps or command run after this patch

```bash
export OPENCLAW_STATE_DIR=/tmp/ochunt-gw1 OPENCLAW_CONFIG_PATH=/tmp/ochunt-gw1/openclaw.json
CLI=(node --import ./scripts/tsx.mjs src/entry.ts)
URL=(--url ws://127.0.0.1:18991 --token "$TOKEN")
"${CLI[@]}" cron add "p1-green-blank" --cron "0 * * * *" --message "hello" --tools '' --json "${URL[@]}"; echo rc=$?
"${CLI[@]}" cron add "p1-green-omit" --cron "0 * * * *" --message "hello" --json "${URL[@]}"
"${CLI[@]}" cron add "p1-green-read" --cron "0 * * * *" --message "hello" --tools read --json "${URL[@]}"
"${CLI[@]}" cron list --json "${URL[@]}"  # readback: no p1-green-blank; omit/read present
```

### Evidence after fix

```text
--- blank --tools
{"ok":false,"error":{"type":"cli_error","message":"--tools must not be blank"}}
rc=1
readback: has p1-green-blank False
--- omit --tools
toolsAllow ['*']  (job created)
--- --tools read
toolsAllow ['read']  (job created)
```
