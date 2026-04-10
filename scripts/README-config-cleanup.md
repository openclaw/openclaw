# OpenClaw Config Cleanup Utility

A Node.js utility script to migrate or remove deprecated configuration keys from your OpenClaw `openclaw.json` configuration file.

## What This Script Does

This script scans your OpenClaw configuration file for deprecated keys and either:
- **Migrates** them to their new locations/formats
- **Removes** them if they're no longer needed
- **Creates a backup** before making any changes

## Why You Need This

Deprecated configuration keys can cause:
- **Bootstrap errors** when starting OpenClaw
- **Unexpected behavior** in agents and channels
- **Configuration validation failures**

## Deprecated Keys Handled

The script handles **9 deprecated configuration keys**:

| # | Deprecated Key | Description | Action |
|---|----------------|-------------|--------|
| 1 | `talk.voiceId` / `talk.apiKey` | Voice configuration moved to `talk.provider` | Migrated to `talk.provider.voiceId` and `talk.provider.apiKey` |
| 2 | `browser.ssrfPolicy.allowPrivateNetwork` | SSR private network policy removed | Deleted |
| 3 | `agents.*.sandbox.perSession` | Per-session sandbox setting deprecated | Deleted from all agents |
| 4 | `tools.web.x_search.*` | X search tools moved to plugins | Migrated to `plugins.entries.xai.config.xSearch` |
| 5 | `tools.web.fetch.firecrawl.*` | Firecrawl config moved to plugins | Migrated to `plugins.entries.firecrawl.config.webFetch` |
| 6 | `browser.driver: "extension"` | Extension driver deprecated, using managed browser | Deleted |
| 7 | `hooks.internal.handlers` | Internal hooks handlers deprecated | Deleted |
| 8 | `channels.*.dm.policy` | DM policy moved to `channels.*.dmPolicy` | Migrated to new key |
| 9 | `memory-root` | Global memory-root deprecated | Deleted (use per-agent `memory-root-<agent>`) |

## Usage

### Interactive Mode (Recommended)

```bash
node scripts/config-cleanup.js
```

You will be prompted for each deprecated key:
- `[m]` - Migrate the key to its new location
- `[d]` - Delete the key
- `[r]` - Review each key individually
- `[c]` - Cancel without making changes

### Automatic Migration (All Keys)

```bash
echo "m" | node scripts/config-cleanup.js
```

### Automatic Deletion (All Keys)

```bash
echo "d" | node scripts/config-cleanup.js
```

## Requirements

- Node.js 18+ installed
- OpenClaw configuration at `~/.openclaw/openclaw.json`

## Backup

The script **automatically creates a backup** at:
```
~/.openclaw/backups/openclaw-backup-{timestamp}.json
```

## Safety First

1. Always review changes before applying them
2. Backups are created automatically
3. You can restore from the backup if something goes wrong
4. Run the script with `c` (cancel) first to see what would be changed

## Example Output

```
🔧 OpenClaw Config Cleanup

Found 3 deprecated key(s):

  1. talk.voiceId/talk.apiKey
     Voice configuration moved to talk.provider

  2. browser.ssrfPolicy.allowPrivateNetwork
     SSR private network policy removed

  3. memory-root
     Global memory-root deprecated, use per-agent memory-root-<agent>

Choose action: [m]igrate all, [d]elete all, [r]eview each, [c]ancel: m

💾 Backup created: /Users/you/.openclaw/backups/openclaw-backup-2025-04-10T12-00-00-000Z.json
  ✅ Migrated
  ✅ Migrated
  ✅ Migrated

✅ Config saved to: /Users/you/.openclaw/openclaw.json

📋 Summary of Changes:
============================================================

🔄 Migrated:
  • talk.voiceId/talk.apiKey
    - talk.voiceId
    - talk.apiKey
    + talk.provider

🗑️  Deleted:
  • browser.ssrfPolicy.allowPrivateNetwork
  • memory-root

============================================================

💾 Backup available at: /Users/you/.openclaw/backups/openclaw-backup-2025-04-10T12-00-00-000Z.json

✨ Config cleanup complete!
```

## Troubleshooting

### "Config file not found"
Make sure OpenClaw is installed and has created its configuration file at `~/.openclaw/openclaw.json`.

### "Failed to parse config"
Your config file may have JSON syntax errors. Fix them manually before running this script.

### Changes not taking effect
Restart OpenClaw after running the cleanup script for changes to take effect.

## Related Issues

This script helps resolve configuration-related issues that may appear in:
- Bootstrap errors on startup
- Configuration validation warnings
- Migration guides from older OpenClaw versions

## License

Part of the OpenClaw project. See LICENSE in the repository root.
