# Local Patches

These are patches applied on top of upstream OpenClaw that should be preserved across updates.

## Patch Commits

| Commit      | Description                                 | File(s)                                                |
| ----------- | ------------------------------------------- | ------------------------------------------------------ |
| `ea6df49df` | Discord EventQueue timeout 30s → 5min       | `src/discord/monitor/provider.ts`                      |
| `5ffd36cb9` | Auth profile rateLimit config (rpm/tpm/rph) | `src/config/types.auth.ts`, `src/config/zod-schema.ts` |

## Quick Rebase

When a new release drops:

```bash
# Option 1: Use the helper script
./rebase-patches.sh origin/main

# Option 2: Manual cherry-pick
git fetch origin
git checkout -B my-branch origin/main
git cherry-pick ea6df49df
git cherry-pick 5ffd36cb9
```

## Config Example

After the rate limit patch is applied, you can configure Anthropic throttling:

```yaml
auth:
  profiles:
    anthropic:claude-cli:
      provider: anthropic
      mode: oauth
      rateLimit:
        rpm: 100
        tpm: 40000
```

## Checking Applied Patches

```bash
git log --oneline -5
# Should show your patches at the top
```
