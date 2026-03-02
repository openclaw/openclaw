---
summary: "Deep troubleshooting runbook for gateway, channels, automation, nodes, and browser"
read_when:
  - The troubleshooting hub pointed you here for deeper diagnosis
  - You need stable symptom based runbook sections with exact commands
title: "Troubleshooting"
---

# Gateway troubleshooting

This page is the deep runbook.
Start at [/help/troubleshooting](/help/troubleshooting) if you want the fast triage flow first.

## Command ladder

Run these first, in this order:

```bash
openclaw status
openclaw gateway status
openclaw logs --follow
openclaw doctor
openclaw channels status --probe
```

Expected healthy signals:

- `openclaw gateway status` shows `Runtime: running` and `RPC probe: ok`.
- `openclaw doctor` reports no blocking config/service issues.
- `openclaw channels status --probe` shows connected/ready channels.

## No replies

If channels are up but nothing answers, check routing and policy before reconnecting anything.

```bash
openclaw status
openclaw channels status --probe
openclaw pairing list --channel <channel> [--account <id>]
openclaw config get channels
openclaw logs --follow
```

Look for:

- Pairing pending for DM senders.
- Group mention gating (`requireMention`, `mentionPatterns`).
- Channel/group allowlist mismatches.

Common signatures:

- `drop guild message (mention required` → group message ignored until mention.
- `pairing request` → sender needs approval.
- `blocked` / `allowlist` → sender/channel was filtered by policy.

Related:

- [/channels/troubleshooting](/channels/troubleshooting)
- [/channels/pairing](/channels/pairing)
- [/channels/groups](/channels/groups)

## Dashboard control ui connectivity

When dashboard/control UI will not connect, validate URL, auth mode, and secure context assumptions.

```bash
openclaw gateway status
openclaw status
openclaw logs --follow
openclaw doctor
openclaw gateway status --json
```

Look for:

- Correct probe URL and dashboard URL.
- Auth mode/token mismatch between client and gateway.
- HTTP usage where device identity is required.

Common signatures:

- `device identity required` → non-secure context or missing device auth.
- `device nonce required` / `device nonce mismatch` → client is not completing the
  challenge-based device auth flow (`connect.challenge` + `device.nonce`).
- `device signature invalid` / `device signature expired` → client signed the wrong
  payload (or stale timestamp) for the current handshake.
- `unauthorized` / reconnect loop → token/password mismatch.
- `gateway connect failed:` → wrong host/port/url target.

Device auth v2 migration check:

```bash
openclaw --version
openclaw doctor
openclaw gateway status
```

If logs show nonce/signature errors, update the connecting client and verify it:

1. waits for `connect.challenge`
2. signs the challenge-bound payload
3. sends `connect.params.device.nonce` with the same challenge nonce

Related:

- [/web/control-ui](/web/control-ui)
- [/gateway/authentication](/gateway/authentication)
- [/gateway/remote](/gateway/remote)

## Gateway service not running

Use this when service is installed but process does not stay up.

```bash
openclaw gateway status
openclaw status
openclaw logs --follow
openclaw doctor
openclaw gateway status --deep
```

Look for:

- `Runtime: stopped` with exit hints.
- Service config mismatch (`Config (cli)` vs `Config (service)`).
- Port/listener conflicts.

Common signatures:

- `Gateway start blocked: set gateway.mode=local` → local gateway mode is not enabled. Fix: set `gateway.mode="local"` in your config (or run `openclaw configure`). If you are running OpenClaw via Podman using the dedicated `openclaw` user, the config lives at `~openclaw/.openclaw/openclaw.json`.
- `refusing to bind gateway ... without auth` → non-loopback bind without token/password.
- `another gateway instance is already listening` / `EADDRINUSE` → port conflict.

Related:

- [/gateway/background-process](/gateway/background-process)
- [/gateway/configuration](/gateway/configuration)
- [/gateway/doctor](/gateway/doctor)

## Channel connected messages not flowing

If channel state is connected but message flow is dead, focus on policy, permissions, and channel specific delivery rules.

```bash
openclaw channels status --probe
openclaw pairing list --channel <channel> [--account <id>]
openclaw status --deep
openclaw logs --follow
openclaw config get channels
```

Look for:

- DM policy (`pairing`, `allowlist`, `open`, `disabled`).
- Group allowlist and mention requirements.
- Missing channel API permissions/scopes.

Common signatures:

- `mention required` → message ignored by group mention policy.
- `pairing` / pending approval traces → sender is not approved.
- `missing_scope`, `not_in_channel`, `Forbidden`, `401/403` → channel auth/permissions issue.

Related:

- [/channels/troubleshooting](/channels/troubleshooting)
- [/channels/whatsapp](/channels/whatsapp)
- [/channels/telegram](/channels/telegram)
- [/channels/discord](/channels/discord)

## Cron and heartbeat delivery

If cron or heartbeat did not run or did not deliver, verify scheduler state first, then delivery target.

```bash
openclaw cron status
openclaw cron list
openclaw cron runs --id <jobId> --limit 20
openclaw system heartbeat last
openclaw logs --follow
```

Look for:

- Cron enabled and next wake present.
- Job run history status (`ok`, `skipped`, `error`).
- Heartbeat skip reasons (`quiet-hours`, `requests-in-flight`, `alerts-disabled`).

Common signatures:

- `cron: scheduler disabled; jobs will not run automatically` → cron disabled.
- `cron: timer tick failed` → scheduler tick failed; check file/log/runtime errors.
- `heartbeat skipped` with `reason=quiet-hours` → outside active hours window.
- `heartbeat: unknown accountId` → invalid account id for heartbeat delivery target.
- `heartbeat skipped` with `reason=dm-blocked` → heartbeat target resolved to a DM-style destination while `agents.defaults.heartbeat.directPolicy` (or per-agent override) is set to `block`.

Related:

- [/automation/troubleshooting](/automation/troubleshooting)
- [/automation/cron-jobs](/automation/cron-jobs)
- [/gateway/heartbeat](/gateway/heartbeat)

## Node paired tool fails

If a node is paired but tools fail, isolate foreground, permission, and approval state.

```bash
openclaw nodes status
openclaw nodes describe --node <idOrNameOrIp>
openclaw approvals get --node <idOrNameOrIp>
openclaw logs --follow
openclaw status
```

Look for:

- Node online with expected capabilities.
- OS permission grants for camera/mic/location/screen.
- Exec approvals and allowlist state.

Common signatures:

- `NODE_BACKGROUND_UNAVAILABLE` → node app must be in foreground.
- `*_PERMISSION_REQUIRED` / `LOCATION_PERMISSION_REQUIRED` → missing OS permission.
- `SYSTEM_RUN_DENIED: approval required` → exec approval pending.
- `SYSTEM_RUN_DENIED: allowlist miss` → command blocked by allowlist.

Related:

- [/nodes/troubleshooting](/nodes/troubleshooting)
- [/nodes/index](/nodes/index)
- [/tools/exec-approvals](/tools/exec-approvals)

## Browser tool fails

Use this when browser tool actions fail even though the gateway itself is healthy.

```bash
openclaw browser status
openclaw browser start --browser-profile openclaw
openclaw browser profiles
openclaw logs --follow
openclaw doctor
```

Look for:

- Valid browser executable path.
- CDP profile reachability.
- Extension relay tab attachment for `profile="chrome"`.

Common signatures:

- `Failed to start Chrome CDP on port` → browser process failed to launch.
- `browser.executablePath not found` → configured path is invalid.
- `Chrome extension relay is running, but no tab is connected` → extension relay not attached.
- `Browser attachOnly is enabled ... not reachable` → attach-only profile has no reachable target.

Related:

- [/tools/browser-linux-troubleshooting](/tools/browser-linux-troubleshooting)
- [/tools/chrome-extension](/tools/chrome-extension)
- [/tools/browser](/tools/browser)

## If you upgraded and something suddenly broke

Most post-upgrade breakage is config drift or stricter defaults now being enforced.

### 1) Auth and URL override behavior changed

```bash
openclaw gateway status
openclaw config get gateway.mode
openclaw config get gateway.remote.url
openclaw config get gateway.auth.mode
```

What to check:

- If `gateway.mode=remote`, CLI calls may be targeting remote while your local service is fine.
- Explicit `--url` calls do not fall back to stored credentials.

Common signatures:

- `gateway connect failed:` → wrong URL target.
- `unauthorized` → endpoint reachable but wrong auth.

### 2) Bind and auth guardrails are stricter

```bash
openclaw config get gateway.bind
openclaw config get gateway.auth.token
openclaw gateway status
openclaw logs --follow
```

What to check:

- Non-loopback binds (`lan`, `tailnet`, `custom`) need auth configured.
- Old keys like `gateway.token` do not replace `gateway.auth.token`.

Common signatures:

- `refusing to bind gateway ... without auth` → bind+auth mismatch.
- `RPC probe: failed` while runtime is running → gateway alive but inaccessible with current auth/url.

### 3) Pairing and device identity state changed

```bash
openclaw devices list
openclaw pairing list --channel <channel> [--account <id>]
openclaw logs --follow
openclaw doctor
```

What to check:

- Pending device approvals for dashboard/nodes.
- Pending DM pairing approvals after policy or identity changes.

Common signatures:

- `device identity required` → device auth not satisfied.
- `pairing required` → sender/device must be approved.

If the service config and runtime still disagree after checks, reinstall service metadata from the same profile/state directory:

```bash
openclaw gateway install --force
openclaw gateway restart
```

Related:

- [/gateway/pairing](/gateway/pairing)
- [/gateway/authentication](/gateway/authentication)
- [/gateway/background-process](/gateway/background-process)

## CLI and Configuration

### CLI device token mismatch

**Symptom**: CLI commands fail with "device token mismatch" error.

**Root Cause**: Gateway uses project config/state, but CLI commands are not pointing to the same config/state directory.

**Solution**:
```bash
# Source the environment script before running CLI commands
source scripts/openclaw-env.sh

# Or use the wrapper script
./scripts/oc <command>

# If still failing, rotate the token
openclaw gateway token rotate
openclaw gateway restart
```

### CLI config drift after Gateway update

**Symptom**: CLI behavior differs from Gateway after updating OpenClaw.

**Root Cause**: Gateway was updated but CLI wasn't restarted, or they're using different config files.

**Solution**:
```bash
# Verify Gateway and CLI are aligned
openclaw gateway status
openclaw --version

# Force reinstall if needed
openclaw gateway install --force
```

## Agent Behavior

### Agent outputs internal reasoning to user

**Symptom**: User receives two messages—one short, another containing the model's internal reasoning.

**Root Cause**: Model outputs reasoning block or writes reasoning into the response body, which gets delivered to the user.

**Solution**:
In SOUL.md, add a clear约定:
> "只输出面向用户的那句话，不把内部推理、步骤说明写进回复。"

Configure the model to use `thinking: off` or limit thinking output.

### Group reply routed to wrong agent

**Symptom**: In a group, replying to a message results in the wrong agent handling it (e.g., main instead of the bound agent).

**Root Cause**: OpenClaw routes by "group → bound agent", not by "replied message sender".

**Solution**:
In group chats, send a new message and @ the bot—don't use the "reply" feature.

### Heartbeat log entries appear out of order

**Symptom**: Heartbeat logs are interleaved or out of sequence.

**Root Cause**: Writing logs inserts at the wrong position in the file.

**Solution**:
Always append new log entries to the end of the file:
1. Read the entire file
2. Append new content to the end
3. Write the full file back

### Edit tool fails on multi-line files

**Symptom**: Editing multi-line files fails with "Could not find the exact text".

**Root Cause**: The edit tool requires exact text matching. Multi-line files with inconsistent line breaks often fail to match.

**Solution**:
For larger changes to plan files, use read + write instead of edit:
1. Read the entire file
2. Modify content in memory
3. Write the full file back

## Documentation Best Practices

### Update docs before marking as done

**Symptom**: Changes get documented but never verified, making docs unreliable for troubleshooting.

**Root Cause**: Documentation updated before verification, or no smoke test performed.

**Solution**:
1. Complete smoke test and verify the fix works
2. Then update CHANGELOG-RUNNING / DECISIONS / NOW / CLAUDE.md
3. If fixing a bug or correcting behavior, add an entry to CLAUDE.md

### Cursor Rules not auto-applied

**Symptom**: Rules in `.cursor/rules/*.mdc` exist but are never injected into agent context.

**Root Cause**: `.mdc` files without frontmatter are not recognized as auto-apply rules.

**Solution**:
Add frontmatter to the top of all rule files:
```markdown
---
description: Rule description
globs:
alwaysApply: true
---
```

Always add frontmatter first when creating new rules—never write content bare.

### AGENTS.md MEMORY.md rule doesn't work in group sessions

**Symptom**: MEMORY.md has full context, but agent in Feishu group acts like first meeting.

**Root Cause**: AGENTS.md default rule is "Only read MEMORY.md in MAIN SESSION". Feishu groups are group sessions and never read MEMOR

**Solution**:
For agents that primarily work in group chats, modify AGENTS.md rule 5 to:
> "每次都读 MEMORY.md" (read MEMORY.md every time)

Don't add "If in MAIN SESSION" condition.

## SKILL and Rule Paths

### SKILL.md paths must use {baseDir}, not absolute paths

**Symptom**: Skills break when moving to a different computer or path changes.

**Root Cause**: SKILL.md files contain hardcoded absolute paths like `/Users/dada/openclaw-work/...`.

**Solution**:
In SKILL.md, always use `{baseDir}` placeholder instead of absolute paths:
```bash
# Wrong:
/Users/dada/openclaw-work/scripts/xhs_evaluate.py

# Correct:
{baseDir}/scripts/xhs_evaluate.py
```

For cross-skill references:
```bash
{baseDir}/../other-skill/scripts/xxx.py
```

### Cursor Rules and SKILLS-CATALOG.md禁止绝对路径

**Symptom**: knowledge-base-first.mdc and other files fail on different machines.

**Root Cause**: Hand-written files contain hardcoded paths like `/Users/dada/...`.

**Solution**:
- In Cursor Rules / SKILLS-CATALOG.md: Use relative paths for project files (`knowledge-base/`), use `~` for user-level paths
- In OpenClaw SKILL.md: Use `{baseDir}` placeholder
- In Python/Shell scripts: Use `os.path.dirname(__file__)` for dynamic paths

Quality check: `python3 scripts/generate-skills-catalog.py --check-only` detects absolute paths.

## Memory and Skills Sync

### SOUL.md "我能做的事" must sync with AGENTS.md Tools

**Symptom**: User asks for a skill that exists in AGENTS.md, but agent says "I don't have that skill".

**Root Cause**: SOUL.md lists only old skills. New skills added to AGENTS.md weren't synced to SOUL.md. Model reads SOUL.md and forms self-image of "I only have these 4 skills".

**Solution**:
Every time you add a new skill, update **three places** (all required):
1. Run `python3 scripts/generate-skills-catalog.py` to update SKILLS-CATALOG.md
2. Update the workspace's AGENTS.md Tools section (trigger rules + usage)
3. Update the workspace's SOUL.md "我能做的事" list

### New skill requires three-way sync

**Symptom**: New skill doesn't appear in skill catalog, or agent doesn't know about it.

**Root Cause**: Adding a skill is multi-step; often only step 1 is done.

**Solution**:
After adding a new skill, complete all three syncs:
1. Generate skills catalog
2. Update AGENTS.md Tools
3. Update SOUL.md capabilities list
