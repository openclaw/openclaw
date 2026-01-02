---
summary: "Doctor command: health checks, config migrations, and repair steps"
read_when:
  - Adding or modifying doctor migrations
  - Introducing breaking config changes
---
# Doctor

`clawdis doctor` is the repair + migration tool for Clawdis. It runs a quick health check, audits skills, and can migrate deprecated config entries to the new schema.

## What it does
- Runs a health check and offers to restart the gateway if it looks unhealthy.
- Prints a skills status summary (eligible/missing/blocked).
- Detects deprecated config keys and offers to migrate them.

## Legacy config migrations
When the config contains deprecated keys, other commands will refuse to run and ask you to run `clawdis doctor`.
Doctor will:
- Explain which legacy keys were found.
- Show the migration it applied.
- Rewrite `~/.clawdis/clawdis.json` with the updated schema.

Current migrations:
- `routing.allowFrom` → `whatsapp.allowFrom`

## Usage

```bash
clawdis doctor
```

If you want to review changes before writing, open the config file first:

```bash
cat ~/.clawdis/clawdis.json
```
