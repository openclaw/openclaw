---
name: hermes-agent
description: "Inspect, configure, and recover Hermes Agent installs."
metadata: { "openclaw": { "homepage": "https://github.com/NousResearch/hermes-agent" } }
---

# Hermes Agent

Use this skill when OpenClaw needs to inspect, configure, recover, or restart a Hermes Agent installation. Prefer Hermes CLI commands and official Nous Research documentation over direct edits to `~/.hermes` files.

This skill is for operational configuration and recovery. For full import from Hermes into OpenClaw, use OpenClaw's bundled `migrate-hermes` provider instead of manually copying files.

## Rules

- Use official Hermes docs only: start from `https://hermes-agent.nousresearch.com/docs/llms.txt`, then read the specific docs page or `https://github.com/NousResearch/hermes-agent`.
- Start read-only. Do not mutate config, restart services, or apply migration until the current state is known.
- Keep Hermes state under `~/.hermes` and OpenClaw state under `~/.openclaw`; do not blend the two except through documented migration commands.
- Do not print or move raw secret values. Use Hermes auth, `.env`, or OpenClaw migration credential prompts as documented.
- Use exact commands and report exact outcomes.

## Read-Only Checks

```bash
hermes --version
hermes status --all
hermes doctor
hermes config path
hermes config
hermes skills list
hermes tools list
hermes gateway status
```

Useful paths:

- Config: `~/.hermes/config.yaml`
- Local environment: `~/.hermes/.env`
- Logs: `~/.hermes/logs/`
- Skills: `~/.hermes/skills/`
- Sessions and memory: under `~/.hermes/`

If profiles may be involved:

```bash
hermes profile list
hermes profile show <name>
hermes --profile <name> status --all
```

## Configuration

Prefer Hermes commands for changes:

```bash
hermes setup
hermes setup model
hermes setup gateway
hermes model
hermes config set <key> <value>
hermes config migrate
```

Use `hermes config edit` only when the requested change cannot be expressed through `hermes config set`, and inspect the diff before and after editing. Capture `hermes doctor` output before applying any documented fix.

## Skills

Hermes skills live in `~/.hermes/skills/` and can also come from configured external directories.

```bash
hermes skills list
hermes skills inspect <id-or-name>
hermes skills install <id-or-url>
hermes skills config
hermes skills check
hermes skills update
```

Use skill config settings for non-secret paths and preferences. Use required environment variables or Hermes auth flows for secrets.

## Gateway and Wakeups

Use these when Hermes appears asleep, unavailable from chat, or stale after config changes:

```bash
hermes status --all
hermes gateway status
hermes gateway restart
hermes cron status
hermes doctor
```

If the gateway is managed by a service, prefer Hermes gateway commands over killing processes by hand.

## Migration Into OpenClaw

If the user wants to import a Hermes installation into OpenClaw, do not run ad hoc config commands from this skill. Use OpenClaw's bundled Hermes migration provider and the official migration docs at `https://docs.openclaw.ai/install/migrating-hermes`. Always dry-run first, review conflicts and credential choices, then verify with OpenClaw doctor and status checks after any apply.

## Procedure

1. Identify the active Hermes home, profile, config path, and gateway status.
2. Read the relevant official Hermes docs page if the requested setting or command is version-sensitive.
3. Inspect current config and health with read-only commands.
4. Choose the smallest documented command that makes the requested change.
5. If migration is requested, switch to OpenClaw's official Hermes migration docs and provider flow before applying anything.
6. Restart Hermes or OpenClaw only when the changed component requires it.
7. Verify both sides separately when the task affects interop.

## Pitfalls

- Do not assume the default profile is active. Check profiles when commands behave inconsistently.
- Do not manually copy `~/.hermes/config.yaml` into OpenClaw. The migration provider maps compatible fields and archives unsafe state for review.
- Do not treat Hermes plugins, sessions, logs, cron state, MCP tokens, or state databases as directly executable OpenClaw config.
- Do not apply doctor fixes without first capturing `hermes doctor` output and confirming the fix is documented.
- Do not restart both agents blindly. Restart the component whose config changed, then verify.
- Do not add unverified command flags. If a command is not in official Hermes docs or `hermes --help`, point to the docs instead of inventing syntax.

## Verification

For Hermes:

```bash
hermes status --all
hermes doctor
hermes skills list
```

For OpenClaw after any interop or migration work:

```bash
openclaw doctor
openclaw status
openclaw skills list
```
