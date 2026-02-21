# Cron store path ignores OPENCLAW_STATE_DIR environment variable

## Issue Description

The cron store path (`~/.openclaw/cron/jobs.json`) is always used regardless of the `OPENCLAW_STATE_DIR` environment variable. This prevents proper isolation when running multiple OpenClaw Gateway instances with different state directories.

## Related Issues

- #9866 - Device identity ignores OPENCLAW_STATE_DIR (similar root cause)
- #8793 - Discord handler uses hardcoded /root/.openclaw path

## Steps to Reproduce

1. Set `OPENCLAW_STATE_DIR` to a custom path:

   ```bash
   export OPENCLAW_STATE_DIR="$HOME/openclaw-rescue"
   ```

2. Run openclaw and add a cron job:

   ```bash
   openclaw cron add --name "test-job" --schedule "0 * * * *" ...
   ```

3. Observe that the cron job is stored in `~/.openclaw/cron/jobs.json` instead of `$OPENCLAW_STATE_DIR/cron/jobs.json`.

## Expected Behavior

When `OPENCLAW_STATE_DIR` is set, the cron store should use `${OPENCLAW_STATE_DIR}/cron/jobs.json` instead of the hardcoded `~/.openclaw/cron/jobs.json`.

## Actual Behavior

The cron store always uses `~/.openclaw/cron/jobs.json`, ignoring the `OPENCLAW_STATE_DIR` environment variable.

## Root Cause Analysis

In `src/cron/store.ts`:

```typescript
export const DEFAULT_CRON_DIR = path.join(CONFIG_DIR, "cron");
```

While `CONFIG_DIR` is resolved using `resolveConfigDir()` which respects `OPENCLAW_STATE_DIR`, the actual issue is that when a custom `storePath` is not explicitly configured in the config file, it falls back to `DEFAULT_CRON_STORE_PATH` which uses the initial `CONFIG_DIR` value at module load time, not the runtime environment variable.

## Proposed Fix

Modify `resolveCronStorePath` to check for `OPENCLAW_STATE_DIR` at runtime:

```typescript
export function resolveCronStorePath(storePath?: string): string {
  // Explicit config path takes precedence
  if (storePath?.trim()) {
    const raw = storePath.trim();
    if (raw.startsWith("~")) {
      return path.resolve(expandHomePrefix(raw));
    }
    return path.resolve(raw);
  }

  // Check for OPENCLAW_STATE_DIR environment variable
  const stateDir = process.env.OPENCLAW_STATE_DIR?.trim() || process.env.CLAWDBOT_STATE_DIR?.trim();
  if (stateDir) {
    return path.join(path.resolve(expandHomePrefix(stateDir)), "cron", "jobs.json");
  }

  // Fall back to default
  return DEFAULT_CRON_STORE_PATH;
}
```

## Impact

This fix is critical for:

- Running multiple isolated OpenClaw Gateway instances (e.g., main + rescue bot)
- Containerized deployments with custom state directories
- Users who want to relocate their OpenClaw data

## Environment

- OpenClaw version: 2026.2.6-3
- OS: macOS / Linux
- Node.js: v25.5.0

## Checklist

- [x] I have searched existing issues to ensure this is not a duplicate
- [x] I have provided clear reproduction steps
- [x] I have proposed a concrete fix
