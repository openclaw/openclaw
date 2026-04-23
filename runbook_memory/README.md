# Runbook Memory Backend

Local-first runbook memory backend for OpenClaw.

## Layout

- `runbooks/` canonical runbook tree
- `runbooks/templates/machine_style_guide.md` machine-first authoring contract
- `runbooks/templates/runbook_template.md` authoring scaffold, intentionally excluded from indexing
- `runbook_memory/` backend code, DB, tests, reports, and CLI

## Bootstrap

```bash
cd /home/ebatter1/openclaw-upstream
python3 -m runbook_memory.tools.runbook_cli init
python3 -m runbook_memory.tools.runbook_cli migrate --source-root /home/ebatter1/Documents
python3 -m runbook_memory.tools.runbook_cli search "plugin name or error code"
```

## Default paths

- Database: `runbook_memory/db/runbook_memory.sqlite3`
- Canonical runbooks: `runbooks/`
- Reports: `runbook_memory/reports/`

## Maintenance

```bash
python3 -m runbook_memory.tools.runbook_cli maintenance changed-docs --source-root /home/ebatter1/Documents
python3 -m runbook_memory.tools.runbook_cli maintenance stale-doc-queue
python3 -m runbook_memory.tools.runbook_cli maintenance duplicate-scan
python3 -m runbook_memory.tools.runbook_cli maintenance health-report
python3 -m runbook_memory.tools.runbook_cli maintenance hotset-index --write-report
python3 -m runbook_memory.tools.runbook_cli maintenance transcript-eval-set --history-path ~/.codex/history.jsonl
python3 -m runbook_memory.tools.runbook_cli maintenance eval-suite
python3 -m runbook_memory.tools.runbook_cli maintenance eval-suite --eval-set runbook_memory/reports/real_agent_queries_eval_set.jsonl --top-k 5
python3 -m runbook_memory.tools.runbook_cli maintenance eval-labels --limit 20 --top-k 5
python3 -m runbook_memory.tools.runbook_cli maintenance eval-labels --query-id eval_001 --expected-doc-id rbk_oh_my_codex_install
python3 -m runbook_memory.tools.runbook_cli maintenance eval-labels --query-id eval_005 --needs-runbook
```

If you manage the OpenClaw gateway from this machine, run service commands in the
logged-in user session that owns the user bus. For the `openclaw` service account
on this host, that means using:

```bash
sudo -u openclaw -H env XDG_RUNTIME_DIR=/run/user/996 HOME=/var/lib/openclaw \
  /var/lib/openclaw/.openclaw/bin/openclaw gateway install
sudo -u openclaw -H env XDG_RUNTIME_DIR=/run/user/996 HOME=/var/lib/openclaw \
  systemctl --user enable --now openclaw-gateway.service
```

The service account is `nologin`, so `sudo -iu openclaw` will not work. Lingering
must remain enabled for the gateway to survive logouts and reboots:

```bash
sudo loginctl enable-linger openclaw
```

On this host the persistent gateway owner is the `openclaw` user service, not the
system service. Keep only one service enabled for port `18789`:

```bash
systemctl --user -M openclaw@ status openclaw-gateway.service
systemctl status openclaw.service
ss -lptn 'sport = :18789'
```

Expected state after the 2026-04-07 Signal group onboarding fix:

- `openclaw-gateway.service` under the `openclaw` user bus is `enabled` and `active`.
- `openclaw.service` system unit is `disabled` and `inactive`.
- `127.0.0.1:18789` is owned by a single `openclaw-gateway` process.

If live TypeScript/JS bundle fixes are deployed manually, sync the full matching
`dist/` tree into the live install rather than copying a single hashed bundle.
Hashed runtime chunks import sibling hashed files; partial copies can crash the
gateway with `ERR_MODULE_NOT_FOUND`.

When syncing backend `dist/` manually, do not leave the live tree owned by the
operator shell user. After the sync, restore live ownership for the service
account:

```bash
sudo chown -R openclaw:openclaw /var/lib/openclaw/.openclaw/lib/node_modules/openclaw/dist
```

The live gateway now serves Control UI assets from
`/var/lib/openclaw/control-ui` via `gateway.controlUi.root`, so backend-only
package syncs can no longer delete the browser UI. When refreshing the UI
bundle, rebuild it in the source checkout and sync it into that persistent
directory:

```bash
pnpm -C /home/ebatter1/openclaw-upstream ui:build
sudo rsync -a --delete \
  /home/ebatter1/openclaw-upstream/dist/control-ui/ \
  /var/lib/openclaw/control-ui/
sudo chown -R openclaw:openclaw /var/lib/openclaw/control-ui
```

If Signal groups go silent after config or prompt changes, confirm whether the
message is dropped before the model or whether the model returns `NO_REPLY`.
The 2026-04-07 incident was not a Signal transport failure: group messages
reached the model, but stale group-chat instructions in the live workspace
`AGENTS.md` and the generated always-on group intro told the model to stay
silent unless directly addressed. Fix the prompt first, then expire only the
Signal group sessions so the new system prompt is sent:

```bash
node <<'NODE'
const fs = require("fs");
const p = "/var/lib/openclaw/.openclaw/agents/main/sessions/sessions.json";
const backup = `${p}.bak-${new Date().toISOString().replace(/[:.]/g, "-")}`;
fs.copyFileSync(p, backup);
const store = JSON.parse(fs.readFileSync(p, "utf8"));
let changed = 0;
for (const [key, entry] of Object.entries(store)) {
  if (!key.startsWith("agent:main:signal:group:") || !entry || typeof entry !== "object") continue;
  entry.updatedAt = 0;
  entry.systemSent = false;
  entry.abortedLastRun = false;
  delete entry.skillsSnapshot;
  delete entry.cliSessionIds;
  delete entry.cliSessionBindings;
  delete entry.claudeCliSessionId;
  changed += 1;
}
fs.writeFileSync(p, JSON.stringify(store, null, 2) + "\n");
console.log({ backup, changed });
NODE
sudo chown openclaw:openclaw /var/lib/openclaw/.openclaw/agents/main/sessions/sessions.json
systemctl --user -M openclaw@ restart openclaw-gateway.service
```

Do not reset direct-message sessions for this incident class unless the DM is
also showing stale prompt behavior.

Convenience wrappers:

```bash
runbook_memory/scripts/runbook-indexer.sh
runbook_memory/scripts/runbook-librarian.sh
```

Systemd unit templates:

- `runbook_memory/config/systemd/runbook-indexer.service`
- `runbook_memory/config/systemd/runbook-indexer.timer`
- `runbook_memory/config/systemd/runbook-librarian.service`
- `runbook_memory/config/systemd/runbook-librarian.timer`

## OpenClaw plugin wrapper

This repo also includes an OpenClaw extension wrapper at `extensions/runbook-memory/` that exposes:

- `runbook_search`
- `runbook_get`
- `runbook_create`
- `runbook_update`
- `runbook_review_queue`
- `runbook_reindex`

The extension shells out to `runbook_memory/tools/runbook_cli.py` in machine mode.

On this host, the live OpenClaw deployment is wired to:

- CLI: `/var/lib/openclaw/.openclaw/runbook_memory/tools/runbook_cli.py`
- DB: `/var/lib/openclaw/state/runbook_memory.sqlite3`
- Runbooks root: `/var/lib/openclaw/workspace/runbooks`

When deploying backend or runbook corpus changes, sync the backend without the
repo-local SQLite DB, rebuild the live index from the live runbooks root, and
restart the gateway if plugin config or skill text changed because
`gateway.reload.mode` is `off`.

## Notes

- `sentence-transformers` is optional. If it is not installed, the backend falls back to lexical retrieval plus explainable heuristic boosts.
- `PyYAML` is used when available. A small fallback parser is included.
- Use `python3`, not `python`, on this machine.
- Retrieval-aware optional frontmatter fields are `aliases` plus `retrieval.synopsis`, `retrieval.hints`, `retrieval.not_for`, and `retrieval.commands`.
- The indexer skips files named `runbook_template.md`; templates are authoring aids and must not create searchable runbook documents.
- Freshness ranking uses validation dates and review windows; stale docs rank lower unless the query explicitly asks for older material.
- `review-queue` now includes `low_confidence_queries` from recent retrieval logs in addition to stale docs and duplicate candidates.
- `maintenance eval-suite` reads JSONL query cases and scores labeled cases when they include `expected_doc_ids` or `expected_doc_id`; unlabeled cases still return top retrieved docs for review. Eval searches do not write `retrieval_logs` and do not use the hotset prior, so benchmark runs stay repeatable.
- `maintenance eval-labels` lists unlabeled eval queries with current top docs and can write labels back to the JSONL file by `query_id`. Label review searches use the same non-mutating, no-hotset path as `eval-suite`.
- `runbook_reindex` supports targeted `doc_ids` in machine mode, so agents can rebuild one known runbook without broad-scanning the full source corpus.
- Runbook search is hybrid when embeddings are configured: FTS candidates are preserved, vector candidates are merged in, and the final ranking remains explainable through `why_matched`.
- `cron_reminder` uses a stable internal idempotency key on `cron.add`, so repeating the same structured reminder or retrying a failed Signal turn returns the existing job instead of creating a duplicate.
- `cron_reminder` now preserves the caller `sessionKey` when it creates the main-session cron job, so Signal reminders stay bound to the originating chat/session instead of falling back to an ambiguous delivery target.
- Known operator issue: Control UI cron failures can be caused by browser/device pairing state, not the cron API itself. If the browser gets a new device identity or metadata pin after an update, the gateway may ask for `openclaw devices approve --latest` again before `cron.add` works from the web UI.
- Known Signal group onboarding state as of 2026-04-07: `/addchat` from a trusted Signal sender can add the current group to `channels.signal.groupAllowFrom`; normal messages from trusted senders are temporarily not allowed to bootstrap new groups. Trusted group senders are resolved from both `channels.signal.allowFrom` and `channels.signal.groupAllowFrom` because this deployment stores Evan/Jackie UUIDs in `groupAllowFrom`.
- Known Signal group reply behavior as of 2026-04-07: most allowlisted Signal groups have `requireMention: false`; only `Jackie, rune and evan` is intended to require mentions. If allowlisted non-mention groups return `NO_REPLY` to presence checks like `hello?`, inspect `~/.openclaw/workspace/AGENTS.md`, the generated group intro in `src/auto-reply/reply/groups.ts`, and cached Signal group session state before debugging transport.

## Local CLI helper

The helper script `~/.local/bin/openclawuser` wraps `sudo -u openclaw -H env XDG_RUNTIME_DIR=/run/user/996 HOME=/var/lib/openclaw /var/lib/openclaw/.openclaw/bin/openclaw` so you never need to type that whole invocation. Ensure `~/.local/bin` is on your `PATH` (for example, `export PATH="$HOME/.local/bin:$PATH"` in your shell rc) and then run:

```
openclawuser gateway run
openclawuser dashboard
```

Any flags you pass after the command are forwarded to the OpenClaw CLI (e.g., `openclawuser gateway run --bind lan` or `openclawuser dashboard --no-open`). Use `openclawuser` whenever a CLI call must execute under the `openclaw` service account and user bus.
