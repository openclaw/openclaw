---
summary: "Clarity Layer roadmap notes"
draft: true
---

# Clarity Layer Protocols (Automation Draft)

These are the standards we want upstream OpenClaw to adopt. Each protocol turns a recurring pain point into a deterministic workflow.

## 1. Credential Auto-Sync Protocol

- **Origin:** Case 1 -- Subagent Auth Desync.
- **Problem:** Subagents boot inside their own `~/.openclaw/agents/<agentId>/agent/` tree. If their `auth-profiles.json` diverges from the main agent, launches fail with `No API key found for provider "anthropic"` even though the root config is correct.
- **Standard definition:**
  1. On every subagent boot (CLI spawn, `sessions_spawn`, cron, etc.), compute the SHA-256 of the parent `~/.openclaw/agents/main/agent/auth-profiles.json` and compare it with the child copy.
  2. If hashes differ or the file is missing, automatically copy/sync the main profile before any agent code runs.
  3. Only emit a warning if the sync succeeds; escalate to error only if the copy fails. Never leave the subagent in a half-initialized state.
- **Implementation blueprint:**
  - Add a bootstrap hook (e.g., `agents.bootstrap.syncAuthProfiles`) that runs prior to tool init.
  - Support opt-out via config for advanced users, default to `on` for all first-party agents.
  - Include telemetry: record `authSyncStatus={"agentId":"<id>","result":"copied"|"skipped"|"failed"}` in gateway logs.
- **Success criteria:**
  - Operators never see `No API key` on first launch if the main agent has creds.
  - `openclaw doctor` gains a check that asserts `synced=true` for every configured subagent.

## 2. Safe-Reload Protocol

- **Origin:** Case 3 -- JSON Schema Suicide.
- **Problem:** Editing `~/.openclaw/openclaw.json` with invalid keys causes the gateway to restart in a tight loop. There is no safety net; operators watch "gateway restarting" forever.
- **Standard definition:**
  1. Before applying any hot-reload, run a dry-run validator (`openclaw config lint --no-apply`).
  2. If validation fails, keep the previous config in memory, continue serving requests, and surface a blocking alert (Control UI, CLI, `openclaw doctor`).
  3. Only write the new config to disk snapshots after validation passes. Provide an automatic rollback pointer (`~/.openclaw/openclaw.json.bak`).
- **Implementation blueprint:**
  - Extend the gateway watcher: when the file changes, fork a validator process. Apply changes only on success.
  - Emit a structured event (`configReloadStatus`) with `source=file|cli|ui`, `result=applied|rejected`, `errorPath`.
  - CLI command `openclaw config apply` should accept `--dry-run` and `--revert-last` flags for deterministic recovery.
- **Success criteria:**
  - No more gateway crash loops from syntax errors; the running config stays healthy.
  - Control UI shows a red banner with the exact invalid path/value so an operator can fix it without tailing logs.

## 3. Execution Path Integrity Protocol

- **Origin:** Case 2 -- Docker Path Shadowing.
- **Problem:** Operators often run `docker compose` from `~/.openclaw` (data dir) instead of the repo root where `docker-compose.yml` lives. Today this fails with `command not found` or cryptic mount errors.
- **Standard definition:**
  1. Whenever `openclaw docker <cmd>` or helper scripts detect the current working directory is inside `~/.openclaw`, abort and print the correct repo path (last cloned checkout or `OPENCLAW_REPO_PATH`).
  2. Provide an auto-navigation prompt: `Run cd ~/openclaw && docker compose ...? [Y/n]` with safe defaults.
  3. For direct `docker compose` invocations, ship a wrapper (`clawdock` or `openclaw compose`) that resolves the intended compose file set before delegating.
- **Implementation blueprint:**
  - Teach the CLI to read `~/.openclaw/state.json` (or similar) to remember the repo root used during onboarding.
  - Add a shell-safe guard script that can be sourced in `~/.zshrc`/`~/.bashrc`, intercepting `docker compose` when `PWD` is misaligned.
  - Provide structured error code `PATH_SHADOWED` so scripts/CI can detect misuse.
- **Success criteria:**
  - Users never waste time running compose from the wrong tree; the CLI course-corrects proactively.
  - Support docs can simply say "type `openclaw compose up`."

## 4. Visual Health Dashboard Protocol

- **Origin:** Field install feedback -- operators panic because install state is a black box (`health: starting`).
- **Problem:** Current Control UI shows binary status (connected/disconnected). There is no shared view of Docker progress vs. Gateway readiness vs. API reachability.
- **Standard definition:**
  1. Gateway must expose a `/health/graph` endpoint returning structured phases: Docker daemon, gateway process, auth status, API readiness, sandbox availability.
  2. Control UI (and CLI `openclaw health`) render this as a progress bar / checklist with realtime percentages.
  3. Provide suggested wait times and next steps; if a phase stalls, link directly to the relevant Status Playbook entry.
- **Implementation blueprint:**
  - Instrument gateway startup to emit phase timestamps; persist the last-known state.
  - Extend Control UI with a compact "Visual Health" dock visible during onboarding and in Settings.
  - CLI fallback: `openclaw health --graph` prints ASCII bars.
- **Success criteria:**
  - Operators know exactly which layer is slow (Docker build vs. config validation vs. auth), reducing install anxiety.
  - Support can ask for a screenshot of the dashboard instead of parsing logs.

---

### Patch -> native mapping

| Protocol                 | Temporary patch (docs stopgap / tooling prototypes)                                                                    | Native change (what upstream must implement)                                                                         |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| Credential Auto-Sync     | Status Playbook + upcoming `auth-sync-check.sh` reminding users to copy/sync profiles.                                 | Subagent bootstrap hook that hashes + auto-syncs `auth-profiles.json` before launch, with telemetry + doctor checks. |
| Safe-Reload              | Install guide tells users to run `jq` + `openclaw doctor` manually; a tooling prototype will provide `config-lint.sh`. | Gateway watcher enforces dry-run + rollback, Control UI surfaces blocking alerts, CLI gains `--dry-run/--revert`.    |
| Execution Path Integrity | Docs warn about repo/data split; the tooling prototype will ship a `claw-path-guard` shell snippet to detect `PWD`.    | CLI + docker helpers detect misaligned `PWD`, auto navigate or block compose calls globally.                         |
| Visual Health Dashboard  | Clarity Layer + Status Playbook provide human-readable interpretations.                                                | Gateway exposes a structured health graph API + Control UI/CLI renders realtime progress + stall hints.              |

---

**Next steps:** finalize wording and start implementing the temporary patches while preparing upstream issue drafts referencing these protocols.
