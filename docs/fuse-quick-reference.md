# FUSE Quick Reference

## For OpenClaw Maintainers

### Emergency Stop All Cron Jobs

Edit `FUSE.txt` on main branch:

```
HOLD Emergency maintenance in progress
```

**Effect:** All cron jobs suspended immediately (except users with `missionCritical: true`)

### Push an Upgrade

Edit `FUSE.txt` on main branch:

```
UPGRADE v2.1.0
```

**Effect:**

- Users with `manualUpgrade: false` (default): Auto-upgrade to v2.1.0 and restart
- Users with `manualUpgrade: true`: See notification message only

**Important:** Downgrades are automatically prevented. If a user already has v2.1.0 or newer locally, the upgrade will be skipped with the message: `Upgrade skipped: tag v2.1.0 already exists locally (forward upgrades only)`.

### Force an Upgrade (Override Downgrade Protection)

To force an upgrade even if the tag already exists locally (for example, to force a re-installation or intentional downgrade):

```
UPGRADE v2.0.0!
```

**Effect:**

- The `!` suffix disables downgrade protection
- Upgrade proceeds even if the tag already exists locally
- You'll see: `Force upgrade requested (version ends with '!'), skipping downgrade protection`
- Use with caution: this can downgrade users and potentially break data migrations

**When to use:**

- Re-installing a version to fix corrupted installations
- Intentional rollback during incident response
- Testing upgrade process for a specific version

### Send an Announcement

Edit `FUSE.txt` on main branch:

```
ANNOUNCE New memory system available in v2.1.0!
```

**Effect:** Message appears in all gateway logs

### Resume Normal Operations

Edit `FUSE.txt` on main branch:

```
(empty file or delete all content)
```

**Effect:** All restrictions lifted

## For OpenClaw Users

### Check If Affected by HOLD

Look in gateway logs for:

```
Processing suspended for maintenance
```

### Override HOLD (Mission-Critical)

Add to your `config.yaml`:

```yaml
update:
  missionCritical: true
```

**Effect:** Your cron jobs continue even during HOLD

### Disable Auto-Upgrade

Add to your `config.yaml`:

```yaml
update:
  manualUpgrade: true
```

**Effect:** You'll see upgrade notifications but no automatic installation

### Opt Out of All Remote Control (Mission-Critical + Manual Upgrade)

Add to your `config.yaml`:

```yaml
update:
  missionCritical: true
  manualUpgrade: true
```

**Effect:**

- FUSE.txt is not fetched at all (no network calls)
- HOLD commands are ignored (cron jobs always run)
- UPGRADE commands are ignored (no auto-upgrades or notifications)
- ANNOUNCE commands are not displayed
- Complete independence from central remote control

**Use when:**

- Running in air-gapped or restricted network environments
- Maximum performance required (eliminate FUSE fetch overhead)
- Complete control over upgrades and maintenance windows
- Compliance requirements prevent external remote control

### Check Upgrade Status

**Successful auto-upgrade:**

```
Starting upgrade to v2.0.0...
[1/5] git fetch...
[2/5] git checkout...
[3/5] pnpm install...
[4/5] build...
[5/5] verify...
Upgrade to v2.0.0 completed successfully
Restarting gateway in 2 seconds...
```

**Manual upgrade mode:**

```
Upgrade v2.0.0 available. Type openclaw upgrade v2.0.0 into terminal.
```

**Downgrade prevented:**

```
Upgrade skipped: tag v2.0.0 already exists locally (forward upgrades only)
```

**Forced upgrade (with ! suffix):**

```
Force upgrade requested (version ends with '!'), skipping downgrade protection
Starting upgrade to v2.0.0...
[1/5] git fetch...
...
Upgrade to v2.0.0 completed successfully
Restarting gateway in 2 seconds...
```

**Failed upgrade:**

```
Starting upgrade to v2.0.0...
[1/5] git fetch...
[2/5] git checkout...
[3/5] pnpm install failed
Upgrade failed: pnpm install: dependency resolution error
```

## FUSE URL

By default, the FUSE file is fetched from:

```
https://raw.githubusercontent.com/openclaw/openclaw/refs/heads/main/FUSE.txt
```

You can customize this URL in your `config.yaml`:

```yaml
update:
  fuseUrl: https://example.com/custom-fuse.txt
```

This allows you to:

- Host your own FUSE file for private deployments
- Use a different branch or fork of OpenClaw
- Implement custom remote control mechanisms
- Test FUSE locally using `file://` URLs

## Timing

- FUSE is checked only when cron jobs are about to execute
- No continuous polling or background checks
- Zero overhead when no cron jobs are scheduled
- If both `missionCritical: true` and `manualUpgrade: true` are set, FUSE is never fetched (zero network overhead)

## Fail-Safe Behavior

If FUSE.txt cannot be fetched (network error, GitHub down, etc.):

- Cron jobs proceed normally
- No errors logged
- System continues operating

This "fail-open" behavior ensures network issues don't prevent cron execution.

## Testing FUSE Locally

You can test FUSE behavior using a local file with `file://` URLs:

**Create a test FUSE file:**

```bash
echo "HOLD Testing FUSE locally" > /tmp/test-fuse.txt
```

**Configure it in your `config.yaml`:**

```yaml
update:
  fuseUrl: file:///tmp/test-fuse.txt
```

**Run the test suite:**

```bash
npm test src/cron/service/fuse.test.ts
```

This is useful for:

- Testing FUSE commands before deploying to production
- Running integration tests
- Developing custom FUSE implementations

## Advanced Features

### Downgrade Protection

UPGRADE commands automatically prevent downgrades for safety:

**How it works:**

- Before upgrading, the system checks if the specified git tag already exists locally
- If the tag exists, the upgrade is skipped (prevents accidental rollback)
- You'll see: `Upgrade skipped: tag v2.0.0 already exists locally (forward upgrades only)`

**Force upgrade override:**

You can bypass downgrade protection by adding `!` to the version:

```
UPGRADE v2.0.0!
```

- The `!` suffix disables the tag existence check
- Allows intentional downgrades or re-installations
- You'll see: `Force upgrade requested (version ends with '!'), skipping downgrade protection`
- The `!` is stripped before passing to git checkout (e.g., `v2.0.0!` becomes `v2.0.0`)

**Manual downgrade (alternative method):**

1. Manually checkout the desired version: `git checkout v1.9.0`
2. Rebuild: `pnpm install && pnpm build`
3. Restart the gateway manually

**Why this matters:**

- Prevents accidentally rolling back security fixes
- Protects against malicious or compromised FUSE.txt pushing old versions
- Ensures data migrations and schema changes only move forward
- Force upgrade (`!`) provides emergency rollback capability when needed

**HTTP Headers:**

- FUSE requests include `User-Agent: openclaw-gateway` header
- This helps identify OpenClaw traffic in server logs
- Can be used for analytics or rate limiting by FUSE server operators

**First-Line Processing:**

- Only the first line of FUSE.txt is processed
- All subsequent lines are completely ignored
- This allows you to add comments, documentation, or version history after the first line

**Cron Integration:**

FUSE is checked at three points:

1. Before finding due jobs in the regular timer tick
2. Before running missed jobs after gateway restart
3. Before immediate job execution via API

If FUSE returns HOLD, all three skip processing until the hold is lifted.

## Command Syntax Rules

### HOLD

```
HOLD[space]reason
```

- Reason is optional
- Everything after "HOLD " is the reason
- Displays as: "Processing suspended{reason}"

### UPGRADE

```
UPGRADE[space]version[!]
```

- Version is required and cannot be empty
- Can be: v2.0.0, v2.0.0-beta.1, latest, beta, stable
- Optional `!` suffix forces upgrade, bypassing downgrade protection
- Space after UPGRADE is required
- Invalid formats (e.g., "UPGRADE" or "UPGRADE ") will be rejected with error message
- Downgrades are automatically prevented (tag existence check) unless `!` suffix is used

**Examples:**

- `UPGRADE v2.1.0` - Normal upgrade with downgrade protection
- `UPGRADE v2.0.0!` - Force upgrade, skip downgrade protection

### ANNOUNCE

```
ANNOUNCE[space]message
```

- Message is required and cannot be empty
- Everything after "ANNOUNCE " is displayed
- Space after ANNOUNCE is required
- Invalid formats (e.g., "ANNOUNCE" or "ANNOUNCE ") will be rejected with error message

### Unknown Commands

Any line not starting with HOLD, UPGRADE, or ANNOUNCE is ignored.

### Validation Errors

Invalid commands are logged but do not prevent cron execution:

| Invalid Command | Error Message                                                |
| --------------- | ------------------------------------------------------------ |
| `UPGRADE`       | Invalid UPGRADE command: expected format 'UPGRADE version'   |
| `UPGRADE `      | Invalid UPGRADE command: no version specified                |
| `ANNOUNCE`      | Invalid ANNOUNCE command: expected format 'ANNOUNCE message' |
| `ANNOUNCE `     | Invalid ANNOUNCE command: no message specified               |

Cron jobs continue normally when validation errors occur.

## Examples

### Planned Maintenance

```
HOLD for planned maintenance window (30 minutes)
```

### Urgent Security Update

```
UPGRADE v2.0.1
```

### Force Rollback During Incident

```
UPGRADE v2.0.0!
```

**Note:** The `!` suffix forces the upgrade even if v2.0.0 already exists locally, enabling intentional downgrades during emergencies.

### Feature Launch

```
ANNOUNCE Check out the new agent memory system - see docs for details
```

### Multiple Messages (Invalid)

```
HOLD for maintenance
UPGRADE v2.0.0
```

**Result:** Only the first line (HOLD) is processed. The UPGRADE line is ignored.

**Important:** FUSE.txt processes ONLY the first line. All subsequent lines are completely ignored.

### Comments and Documentation

```
HOLD for maintenance
# This is a comment explaining the hold
# Maintenance window: 2pm-4pm EST
```

**Result:** Only "HOLD for maintenance" is processed. Comments on lines 2-3 are safely ignored.

**Benefit:** You can add documentation, notes, or version history on subsequent lines without affecting FUSE behavior.

### Testing Before Production

```
ANNOUNCE [TEST] This is a test announcement - please ignore
# Testing FUSE before deploying actual HOLD
# Will remove this line and add real HOLD at 2pm EST
```

**Result:** The test announcement is displayed, allowing you to verify FUSE is working before deploying an actual HOLD or UPGRADE command.

### Force Re-installation

```
UPGRADE v2.1.0!
# Force all users to re-install v2.1.0 to fix corrupted node_modules
# The ! bypasses "tag already exists" check
```

**Result:** Users on v2.1.0 will re-install instead of seeing "Upgrade skipped". Useful for fixing broken installations without bumping version numbers.
