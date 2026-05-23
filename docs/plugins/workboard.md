---
summary: "Optional dashboard workboard for agent-owned cards and session handoff"
read_when:
  - You want a Kanban-style workboard in the Control UI
  - You are enabling or disabling the bundled Workboard plugin
  - You want to track planned agent work without an external project manager
title: "Workboard plugin"
---

The Workboard plugin adds an optional Kanban-style board to the
[Control UI](/web/control-ui). Use it to collect agent-sized work cards, assign
them to agents, and jump from a card into the linked dashboard session.

Workboard is intentionally small. It tracks local operating work for an
OpenClaw Gateway; it is not a replacement for GitHub Issues, Linear, Jira, or
other team project management systems.

## Default state

Workboard is a bundled plugin and is disabled by default unless you enable it
in plugin config.

Enable it with:

```bash
openclaw plugins enable workboard
openclaw gateway restart
```

Then open the dashboard:

```bash
openclaw dashboard
```

The Workboard tab appears in the dashboard navigation. If the tab is visible
but the plugin is disabled or blocked by `plugins.allow` / `plugins.deny`, the
view shows a plugin-unavailable state instead of local card data.

## What cards contain

Each card stores:

- title and notes
- status: `backlog`, `todo`, `running`, `review`, `blocked`, or `done`
- priority: `low`, `normal`, `high`, or `urgent`
- labels
- optional agent id
- optional linked session, run, task, or source URL

Cards are stored in the plugin's Gateway state. They are local to the Gateway
state directory and move with the rest of that Gateway's OpenClaw state.

## Dashboard workflow

1. Open the Workboard tab in the Control UI.
2. Create a card with a title, notes, priority, labels, and optional agent.
3. Drag the card between columns or use the column controls.
4. Start work from the card to create or reuse a dashboard session.
5. Open the linked session from the card while the agent works.
6. Move the card to review, blocked, or done as the work changes state.

Starting a card uses normal Gateway sessions. The Workboard plugin only stores
card metadata and links; the conversation transcript, model selection, and run
lifecycle stay owned by the regular session system.

## Permissions

The plugin registers Gateway RPC methods under the `workboard.*` namespace:

- `workboard.cards.list` requires `operator.read`
- create, update, move, and delete methods require `operator.write`

Browsers connected with read-only operator access can inspect the board but
cannot mutate cards.

## Configuration

Workboard has no plugin-specific config today. Enable or disable it with the
standard plugin entry:

```json5
{
  plugins: {
    entries: {
      workboard: {
        enabled: true,
        config: {},
      },
    },
  },
}
```

Disable it again with:

```bash
openclaw plugins disable workboard
openclaw gateway restart
```

## Troubleshooting

### The tab says Workboard is unavailable

Check plugin policy:

```bash
openclaw plugins inspect workboard --runtime --json
```

If `plugins.allow` is configured, add `workboard` to that allowlist. If
`plugins.deny` contains `workboard`, remove it before enabling the plugin.

### Cards do not save

Confirm the browser connection has `operator.write` access. Read-only operator
sessions can list cards but cannot create, edit, move, or delete them.

### Starting a card does not open the expected session

Workboard creates links to normal dashboard sessions. Check the card's agent id
and linked session, then open the Sessions or Chat view to inspect the actual
run state.

## Related

- [Control UI](/web/control-ui)
- [Plugins](/tools/plugin)
- [Manage plugins](/plugins/manage-plugins)
- [Sessions](/concepts/session)
