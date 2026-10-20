# Grok Bot Migration

Move Grok Bot configuration into OpenClaw through the same one-time migration
workflow as Hermes:

```bash
openclaw migrate grok --dry-run
openclaw migrate apply grok
```

The provider combines local settings with authenticated reads of your owned bots.
It also accepts a recipe file, migration snapshot, or Grok marketplace/share URL
with `--from`. A recipe contains one bot, not the entire account.

Supported data includes agent identity and icons, instructions, complete exported memory,
skills, timezone, compatible MCP connections, supported scheduled automations,
and curated setup guidance for known integrations. Credentials and private cloud
memory are not copied. Unsupported settings, integrations, incomplete memory, and
reconnect steps appear in the report; `--include-secrets` does not change this.

See [Migrating from Grok Bot](https://docs.openclaw.ai/install/migrating-grok)
for source formats, coverage, and conflict handling.
