---
title: Slash Commands
summary: "Operator1's /command system — unified, discoverable actions in web chat."
---

# Slash Commands

Operator1 provides a first-class `/commands` system that allows both users and agents to trigger unified, discoverable actions directly from the chat interface.

## Command Types

The system distinguishes between three types of executable actions:

| Type            | User-Invocable (`/` menu) | Agent Auto-Invocable | Purpose                                              |
| :-------------- | :-----------------------: | :------------------: | :--------------------------------------------------- |
| **Command**     |          ✅ Yes           |        ❌ No         | User-facing utilities (e.g., `/status`, `/logs`).    |
| **Full Skill**  |          ✅ Yes           |        ✅ Yes        | High-level tasks (e.g., `/commit`, `/deploy`).       |
| **Agent Skill** |           ❌ No           |        ✅ Yes        | Internal tools used by agents (e.g., `code-review`). |

## Built-in Commands

Operator1 comes seeded with several core system commands:

- **`/status`**: Check the current health of the gateway, providers, and channels.
- **`/agents`**: List all active agents in the Matrix and their current status.
- **`/logs`**: Fetch recent gateway logs (e.g., `/logs lines=50`) for debugging.
- **`/build`**: Trigger a project build at the current workspace root.
- **`/help`**: Display this documentation and list of available commands.

## Using Commands

To trigger a command, simply type `/` in the chat input. An autocomplete menu will appear, allowing you to browse and select from the available registry.

### Arguments

Commands support typed arguments using the `key=value` or `{{key}}` syntax.
Example: `/logs lines=100`

## Management UI

You can manage your custom commands through the **Control Panel**:

1. Navigate to **Commands** in the sidebar.
2. Browse the registry (grouped by category).
3. Create new commands from `.md` templates.
4. View invocation logs (original message vs. expanded instruction).

## Storage & Registry

Commands are stored as Markdown files in `~/.openclaw/commands/`. The **SQL-first state model** indexes these files in the `op1_commands` table (Migration v11) for fast discovery and metadata management in the UI.
