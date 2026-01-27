# Personal Scripts

Personal automation scripts managed via git. **This folder is the source of truth.**

Scripts are synced to `~/.clawd/scripts/` by the `sync-skills` cron job.

## Script Guidelines

1. **Output rules**:
   - Output meaningful text (with emoji) for actions taken
   - Output **nothing** for no-action (silent acknowledgment)
   - Never output `HEARTBEAT_OK` (only works for heartbeat runs, not cron)

2. **Credentials**:
   - Never hardcode API keys or secrets
   - Use moltbot.json `skills.entries.*.env` variables
   - For missing credentials, agent uses 1Password via `op-safe` session

3. **Media attachments**: Use `MEDIA:/path/to/file.ext` format
