# RUNBOOK.md -- Verification and Operations Runbook
**Version:** v1.0
**Date:** 2026-02-06
**Owner:** Andrew (Founder)
**Status:** Active. Use this to verify work and diagnose issues.

---

## 0) Purpose

This runbook defines how to safely verify that the system is working correctly. It is used by both humans and agents after making changes.

---

## 1) How to Start Dev

### 1.1 Prerequisites

- Node.js 22+
- pnpm installed
- `.env` file at repo root with at least `MOONSHOT_API_KEY` (for cloud provider)

### 1.2 Start

```bash
pnpm dev:up
```

Expected output:

- Gateway starts on `ws://127.0.0.1:19001`
- TUI launches and connects
- READY banner printed with URLs
- `.env` loaded from repo root

### 1.3 Start with Reset (if wrong model shows)

```bash
pnpm dev:up:reset
```

This clears cached model config before starting.

### 1.4 Stop

```bash
pnpm dev:down
```

Or: Ctrl+C in the terminal running `dev:up`.

### 1.5 Failure: Port Already in Use

```bash
pnpm dev:down
# If still stuck:
lsof -i :19001 -t | xargs kill -9
```

---

## 2) How to Verify Model Selection

### 2.1 Check TUI Header

After `pnpm dev:up`, the TUI header should display:

```
moonshot / kimi-k2-0905-preview
```

This confirms the correct provider and model are selected.

### 2.2 Check Gateway Health

The gateway health endpoint confirms provider status. Look for startup logs containing:

```
Agent model: moonshot / kimi-k2-0905-preview
```

### 2.3 When Model Is Wrong

If TUI shows `ollama / llama3:chat` when `MOONSHOT_API_KEY` is set:

1. Run `pnpm dev:up:reset`
2. Or manually delete `~/.clawdbot-dev/agents/main/agent/models.json`
3. Restart with `pnpm dev:up`

### 2.4 Verify Environment Variable Loading

Look for this line in startup output:

```
[dev-up] API keys present: MOONSHOT_API_KEY
```

If absent, check `.env` at repo root.

---

## 3) How to Run Smoke Tests

### 3.1 Moonshot Smoke Test

```bash
pnpm moltbot moonshot:smoke
```

Expected output:

```
PASS moonshot:ping
Moonshot provider reachable (model: kimi-k2-0905-preview)
```

### 3.2 What Smoke Test Verifies

- `MOONSHOT_API_KEY` is present and valid
- Moonshot API endpoint is reachable
- Model ID resolves correctly
- Basic completion works

### 3.3 Smoke Test Failure

If smoke test fails:

- Check `MOONSHOT_API_KEY` in `.env` (no quotes, no trailing whitespace)
- Check network connectivity to `api.moonshot.cn`
- Check for 401 errors (invalid key)

---

## 4) How to Run Full Verification

### 4.1 Lint

```bash
pnpm lint
```

Must exit 0 with no errors.

### 4.2 Tests

```bash
pnpm test
```

Must exit 0. All tests pass.

### 4.3 Build

```bash
pnpm build
```

Must exit 0. TypeScript compilation succeeds.

### 4.4 Full Gate (All Three)

```bash
pnpm lint && pnpm test && pnpm build
```

Run this before every commit. If any step fails, do not commit.

---

## 5) How to Verify No Regressions

### 5.1 After Any Code Change

1. Run `pnpm lint && pnpm test && pnpm build`
2. Start dev: `pnpm dev:up`
3. Verify TUI shows correct model
4. Verify Ctrl+C shuts down cleanly
5. Stop dev: `pnpm dev:down`

### 5.2 After Model-Related Changes

1. Run the full verification above
2. Run `pnpm moltbot moonshot:smoke`
3. Verify no static `DEFAULT_PROVIDER` or `DEFAULT_MODEL` constants in Gateway paths
4. Check `src/agents/defaults.ts` for dynamic resolver usage

### 5.3 After Prompt-Related Changes

1. Run the full verification above
2. Verify prompt manifest contains hashes (not raw content)
3. Verify base prompt is not disclosed when asked
4. Check logs for absence of raw prompt text

### 5.4 After Security-Related Changes

1. Run the full verification above
2. Verify no secrets in logs
3. Verify no raw prompts in logs
4. Verify tool authority matrix is enforced
5. Verify approval gates are intact

---

## 6) What Logs Matter vs Noise

### 6.1 Logs That Matter (Investigate These)

- `ERROR` -- any error log during startup or operation
- `WARN Moonshot provider unreachable` -- expected when Moonshot is down, but investigate if unexpected
- `Agent model:` line -- must match expected provider/model
- `OverBudgetError` -- context window exceeded (expected during testing, not during normal operation)
- `TOOL_AUTHORITY_DENIED` -- gate blocked an action (expected behavior, review if unexpected)
- `Missing MOONSHOT_API_KEY` -- auth failure (check `.env`)

### 6.2 Logs That Are Noise (Ignore These)

- `Skipping local discovery` -- normal when `CLAWDBOT_SKIP_LOCAL_DISCOVERY=1`
- `Skipping channel initialization` -- normal when `CLAWDBOT_SKIP_CHANNELS=1`
- `Health: OK` -- normal heartbeat
- Node.js deprecation warnings -- non-blocking

### 6.3 Log Locations

- Gateway logs: stdout during `pnpm dev:up`
- Provider logs: `~/.clawdbot/logs/<provider>/`
- Gateway logs: `~/.clawdbot/logs/gateway/`

---

## 7) Skip Flags for Testing

These environment variables disable specific subsystems for isolated testing:

| Variable | Effect |
|----------|--------|
| `CLAWDBOT_SKIP_STARTUP_VALIDATION=1` | Skip model validation at startup |
| `CLAWDBOT_SKIP_LOCAL_DISCOVERY=1` | Skip Ollama/LM Studio discovery |
| `CLAWDBOT_SKIP_CHANNELS=1` | Skip channel initialization |
| `CLAWDBOT_SKIP_CRON=1` | Skip cron job initialization |
| `CLAWDBOT_SKIP_CANVAS_HOST=1` | Skip canvas host server |
| `CLAWDBOT_SKIP_BROWSER_CONTROL_SERVER=1` | Skip browser control server |
| `CLAWDBOT_SKIP_GMAIL_WATCHER=1` | Skip Gmail watcher |

---

## 8) Emergency Procedures

### 8.1 System Unresponsive

```bash
pnpm dev:down
# If that fails:
lsof -i :19001 -t | xargs kill -9
```

### 8.2 Wrong Model in Production

1. Stop the system
2. Delete persisted model config: `rm ~/.clawdbot-dev/agents/main/agent/models.json`
3. Verify `.env` has correct `MOONSHOT_API_KEY`
4. Restart with `pnpm dev:up:reset`
5. Verify TUI header shows correct model

### 8.3 Suspected Security Issue

1. Stop the system immediately
2. Rotate all API keys
3. Check logs for unexpected tool calls or outbound requests
4. Review recent commits for unauthorized changes
5. See `docs/_sophie_devpack/04_SECURITY/security_threat_model_sophie_moltbot_solo_founder.md` section 7

### 8.4 Agent Ran Amok

1. Stop the agent
2. Review all uncommitted changes: `git status` and `git diff`
3. Review all recent commits: `git log --oneline -20`
4. Revert any unauthorized changes
5. Check `TASK_QUEUE.md` for unexpected status changes
6. Review agent logs for what it attempted

---

## 9) Cross-References

| Document | Purpose |
|----------|---------|
| `CLAUDE.md` | Agent authority and constraints |
| `AGENT_WORK_CONTRACT.md` | Allowed/forbidden task types |
| `TASK_QUEUE.md` | Active work items |
| `docs/_sophie_devpack/07_OPERATIONS/dev_startup.md` | Detailed dev startup guide |
| `docs/_sophie_devpack/06_COOKBOOKS/clawdbot_moltbot_developer_handoff.md` | System state and recent fixes |

---

## 10) File Ingestion (`ingest_local_file`)

### 10.1 Overview

Sophie can ingest local `.md` and `.txt` files into her memory index via the `ingest_local_file` tool. Files are copied into the memory sync pipeline and indexed automatically.

### 10.2 Usage

- **Tool:** `ingest_local_file`
- **Parameters:**
  - `path` (required) — absolute path to the source file
  - `target_name` (optional) — custom filename for the indexed copy
  - `metadata` (optional) — YAML front-matter to include (e.g., `source: email`)
- **Supported file types:** `.md`, `.txt`
- **Allowlist root:** `SOPHIE_INGEST_ROOT` env var (default: `~/Documents/SOPHIE_INGEST/`, created if missing)

### 10.3 How It Works

1. Tool validates the file exists and is within the allowlist
2. Generates a unique `ingest_id` token
3. Copies the file to `{workspaceDir}/memory/ingest/{filename}.md` with front-matter containing the `ingest_id`
4. Polls `memory_search` for the `ingest_id` (~1.75s max)
5. Returns `INDEXED` if found, otherwise `QUEUED`

### 10.4 Verify Indexing Completed

- If the tool returns `{ status: "INDEXED" }`, the file is searchable
- If the tool returns `{ status: "QUEUED" }`, use `memory_search` with the returned `ingest_id` to check later
- Files are typically indexed within a few seconds

### 10.5 Destination

Files are copied to: `{workspaceDir}/memory/ingest/{filename}.md`

For the default "main" agent: `~/clawd/memory/ingest/`

---

**End of runbook.**
