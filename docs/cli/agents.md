---
summary: "CLI reference for `mullusi agents` (list/add/delete/bindings/bind/unbind/set identity)"
read_when:
  - You want multiple isolated agents (workspaces + routing + auth)
title: "agents"
---

# `mullusi agents`

Manage isolated agents (workspaces + auth + routing).

Related:

- Multi-agent routing: [Multi-Agent Routing](/concepts/multi-agent)
- Agent workspace: [Agent workspace](/concepts/agent-workspace)
- Skill visibility config: [Skills config](/tools/skills-config)

## Examples

```bash
mullusi agents list
mullusi agents list --bindings
mullusi agents add work --workspace ~/.mullusi/workspace-work
mullusi agents add ops --workspace ~/.mullusi/workspace-ops --bind telegram:ops --non-interactive
mullusi agents bindings
mullusi agents bind --agent work --bind telegram:ops
mullusi agents unbind --agent work --bind telegram:ops
mullusi agents set-identity --workspace ~/.mullusi/workspace --from-identity
mullusi agents set-identity --agent main --avatar avatars/mullusi.png
mullusi agents delete work
```

## Routing bindings

Use routing bindings to pin inbound channel traffic to a specific agent.

If you also want different visible skills per agent, configure
`agents.defaults.skills` and `agents.list[].skills` in `mullusi.json`. See
[Skills config](/tools/skills-config) and
[Configuration Reference](/gateway/configuration-reference#agentsdefaultsskills).

List bindings:

```bash
mullusi agents bindings
mullusi agents bindings --agent work
mullusi agents bindings --json
```

Add bindings:

```bash
mullusi agents bind --agent work --bind telegram:ops --bind discord:guild-a
```

If you omit `accountId` (`--bind <channel>`), Mullusi resolves it from channel defaults and plugin setup hooks when available.

If you omit `--agent` for `bind` or `unbind`, Mullusi targets the current default agent.

### Binding scope behavior

- A binding without `accountId` matches the channel default account only.
- `accountId: "*"` is the channel-wide fallback (all accounts) and is less specific than an explicit account binding.
- If the same agent already has a matching channel binding without `accountId`, and you later bind with an explicit or resolved `accountId`, Mullusi upgrades that existing binding in place instead of adding a duplicate.

Example:

```bash
# initial channel-only binding
mullusi agents bind --agent work --bind telegram

# later upgrade to account-scoped binding
mullusi agents bind --agent work --bind telegram:ops
```

After the upgrade, routing for that binding is scoped to `telegram:ops`. If you also want default-account routing, add it explicitly (for example `--bind telegram:default`).

Remove bindings:

```bash
mullusi agents unbind --agent work --bind telegram:ops
mullusi agents unbind --agent work --all
```

`unbind` accepts either `--all` or one or more `--bind` values, not both.

## Command surface

### `agents`

Running `mullusi agents` with no subcommand is equivalent to `mullusi agents list`.

### `agents list`

Options:

- `--json`
- `--bindings`: include full routing rules, not only per-agent counts/summaries

### `agents add [name]`

Options:

- `--workspace <dir>`
- `--model <id>`
- `--agent-dir <dir>`
- `--bind <channel[:accountId]>` (repeatable)
- `--non-interactive`
- `--json`

Notes:

- Passing any explicit add flags switches the command into the non-interactive path.
- Non-interactive mode requires both an agent name and `--workspace`.
- `main` is reserved and cannot be used as the new agent id.

### `agents bindings`

Options:

- `--agent <id>`
- `--json`

### `agents bind`

Options:

- `--agent <id>` (defaults to the current default agent)
- `--bind <channel[:accountId]>` (repeatable)
- `--json`

### `agents unbind`

Options:

- `--agent <id>` (defaults to the current default agent)
- `--bind <channel[:accountId]>` (repeatable)
- `--all`
- `--json`

### `agents delete <id>`

Options:

- `--force`
- `--json`

Notes:

- `main` cannot be deleted.
- Without `--force`, interactive confirmation is required.
- Workspace, agent state, and session transcript directories are moved to Trash, not hard-deleted.

## Identity files

Each agent workspace can include an `IDENTITY.md` at the workspace root:

- Example path: `~/.mullusi/workspace/IDENTITY.md`
- `set-identity --from-identity` reads from the workspace root (or an explicit `--identity-file`)

Avatar paths resolve relative to the workspace root.

## Set identity

`set-identity` writes fields into `agents.list[].identity`:

- `name`
- `theme`
- `emoji`
- `avatar` (workspace-relative path, http(s) URL, or data URI)

Options:

- `--agent <id>`
- `--workspace <dir>`
- `--identity-file <path>`
- `--from-identity`
- `--name <name>`
- `--theme <theme>`
- `--emoji <emoji>`
- `--avatar <value>`
- `--json`

Notes:

- `--agent` or `--workspace` can be used to select the target agent.
- If you rely on `--workspace` and multiple agents share that workspace, the command fails and asks you to pass `--agent`.
- When no explicit identity fields are provided, the command reads identity data from `IDENTITY.md`.

Load from `IDENTITY.md`:

```bash
mullusi agents set-identity --workspace ~/.mullusi/workspace --from-identity
```

Override fields explicitly:

```bash
mullusi agents set-identity --agent main --name "Mullusi" --emoji "🦞" --avatar avatars/mullusi.png
```

Config sample:

```json5
{
  agents: {
    list: [
      {
        id: "main",
        identity: {
          name: "Mullusi",
          theme: "space mullusi",
          emoji: "🦞",
          avatar: "avatars/mullusi.png",
        },
      },
    ],
  },
}
```
