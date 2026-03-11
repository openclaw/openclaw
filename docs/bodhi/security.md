# OpenBodhi Security Notes

This document covers known upstream vulnerabilities in OpenClaw that affect OpenBodhi deployments, their severity for a self-hosted single-user instance, and the recommended mitigations or update cadence.

---

## Upstream Dependency Vulnerabilities

OpenBodhi runs on OpenClaw. Dependabot tracks vulnerabilities in OpenClaw's dependency tree. The items below require attention for any self-hosted deployment.

### HIGH Severity

**fetch-guard: Auth header forwarding on redirect**
- Affected package: `fetch-guard` (transitive)
- Risk: If the OpenClaw gateway follows an HTTP redirect, bearer tokens are forwarded to the redirect target. For OpenBodhi this means your Anthropic API key or SiYuan token could be forwarded to an unexpected host if any upstream endpoint redirects.
- Mitigation: Ensure `ANTHROPIC_BASE_URL` and `SIYUAN_API_URL` point to stable, trusted hosts that do not issue redirects. Do not proxy either through an intermediary that may redirect. Update when OpenClaw ships a patched version.

**Dashboard: Gateway auth leak via URL / localStorage**
- Affected component: OpenClaw admin dashboard (if enabled)
- Risk: Gateway credentials may appear in browser URL history or localStorage when using the dashboard UI.
- Mitigation: Do not expose the dashboard port publicly. Restrict access via firewall or Tailscale-only routing. For OpenBodhi single-user deployments, disabling the dashboard entirely is the safest option if it is not needed.

**node-tar: Symlink path traversal (×2)**
- Affected package: `node-tar` (transitive, used during install/plugin extraction)
- Risk: A crafted tar archive can escape the target directory via symlink chains, potentially overwriting files outside the workspace.
- Mitigation: Only install plugins from trusted sources. Do not run `npm install` on untrusted packages. Update to a patched `node-tar` version when available upstream.

---

### MEDIUM Severity

**system.run sandbox bypass variants (×4)**
- Affected component: OpenClaw `system.run` tool available to skills
- Risk: Malformed skill inputs or crafted SKILL.md content could escape the intended sandbox restrictions and run arbitrary shell commands.
- Mitigation for OpenBodhi: All skills are in the repo under `skills/`. Never load third-party SKILL.md files from untrusted sources. The `allowFrom` whitelist in `openclaw.json` ensures only your own Telegram account can invoke skills. Review any new skill before adding it to `extraDirs`.

**Cross-account sender auth expansion**
- Affected component: OpenClaw `/allowlist` or sender auth expansion path
- Risk: Under specific conditions, a sender not on the allowlist may gain expanded permissions.
- Mitigation: The `dmPolicy: "allowlist"` setting in `openclaw.json` with a single-user `allowFrom` list is the correct configuration. Verify this is set correctly after every config change:
  ```json
  "channels": {
    "telegram": {
      "dmPolicy": "allowlist",
      "allowFrom": ["$BODHI_TELEGRAM_USER_ID"]
    }
  }
  ```

---

## OpenBodhi-Specific Notes

### Shell Execution in Skills

OpenClaw skills can execute bash commands. OpenBodhi SKILL.md files use Python one-liners for all file I/O. User input is passed via environment variables (not shell arguments) to prevent shell injection:

```bash
# Safe pattern used throughout OpenBodhi skills:
BODHI_DESC='<user input>' python3 -c "
import os
desc = os.environ.get('BODHI_DESC', '').strip()
"
```

Never modify skills to pass user input as shell arguments (e.g., `python3 script.py <user-input>`), as the shell interprets `$()`, backticks, and `&&` before Python receives the string.

### SiYuan Sync

`siyuan_sync.py` communicates with a SiYuan instance via HTTP. SQL queries use only validated notebook IDs (alphanumeric + hyphens, max 64 chars). The sync module is entirely disabled when `SIYUAN_API_TOKEN` is unset — vault writes never depend on SiYuan availability.

### Secrets Management

The following must never be committed to the repository:

| File | Contains |
|------|----------|
| `.env` | `ANTHROPIC_API_KEY`, `TELEGRAM_BOT_TOKEN`, `SIYUAN_API_TOKEN` |
| `~/.openclaw/budget-state.json` | Live spend data |
| `~/.openclaw/pm-memory.md` | Personal PM notes |
| `~/.openclaw/personal-baseline.json` | Health baseline data |
| `~/.openclaw/tasks.md` | Personal task list |

All are covered by `.gitignore`.

---

## Update Cadence

1. Check for OpenClaw upstream releases monthly: `git fetch upstream && git log upstream/main --oneline -20`
2. After merging upstream: run `bun install` and check Dependabot alerts on the fork
3. Review any new HIGH/CRITICAL alerts before deploying to your instance
4. No automatic updates — manual review preserves stability of a personal health data system

---

## Reporting Issues

This is a public repo. If you discover a security issue:
1. Do not open a public GitHub issue
2. Email the maintainer directly (see profile)
3. Allow 14 days for a patch before public disclosure
