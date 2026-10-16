---
name: clawhub
description: "Search ClawHub for plugins by default, or skills when explicitly requested; install, verify, update, uninstall, publish, or sync skills."
---

# ClawHub

Prefer searching ClawHub for plugins unless the user explicitly asks for a skill.
Search before claiming that a requested capability is unavailable.

Use `openclaw skills` for explicitly requested skill discovery and for managing
skills for the current OpenClaw agent. Use the standalone `clawhub` CLI to uninstall
installed ClawHub skills and for publishing, syncing, and publisher account
workflows.

## Discover plugins (default)

Use the `plugins` tool when available, with `action: "search"` and `query` set to
the requested capability, to return native plugin search results. If the tool is
unavailable, use the CLI:

```bash
openclaw plugins search "notion"
```

A discovery request does not authorize installation. Install only when the user
asks.

## Discover skills (explicit requests)

When the user explicitly asks for a skill, search skills instead of plugins:

```bash
openclaw skills search "postgres backups"
```

Install when the user asks. Verify the selected skill first and report the result.

```bash
openclaw skills verify my-skill
openclaw skills install my-skill
openclaw skills install my-skill --version 1.2.3
```

## Manage installed skills

```bash
openclaw skills list
openclaw skills check
openclaw skills update my-skill
openclaw skills update --all
```

Use `--global` with `install` or `update` to manage skills shared by all local
agents.

## Remove an installed skill

Uninstall when the user asks. If the standalone ClawHub CLI is not
installed, install it explicitly:

```bash
npm i -g clawhub
clawhub uninstall @owner/my-skill
```

The CLI asks for confirmation before removing the skill and its lockfile entry.
Use the original agent workspace for agent-specific skills or the OpenClaw
state directory for skills installed with `--global`:

```bash
clawhub --workdir /path/to/agent-workspace uninstall @owner/my-skill
clawhub --workdir ~/.openclaw uninstall @owner/my-skill
```

If `OPENCLAW_STATE_DIR` is set, use its value instead of `~/.openclaw`:

```bash
clawhub --workdir "$OPENCLAW_STATE_DIR" uninstall @owner/my-skill
```

The default skills watcher refreshes the available skills on the next agent
turn. If watching is disabled, start a new session.

## Publish skills

Install the standalone ClawHub CLI for publisher workflows:

```bash
npm i -g clawhub
clawhub login
clawhub whoami
```

Publish or sync skills:

```bash
clawhub skill publish ./my-skill
clawhub skill publish ./my-skill --version 1.2.3
clawhub sync --all
```

## Notes

- Public registry: https://clawhub.ai
- `openclaw skills install` installs into the active workspace by default.
- Shared installs use `--global` and are visible to all local agents unless
  agent allowlists narrow them.
