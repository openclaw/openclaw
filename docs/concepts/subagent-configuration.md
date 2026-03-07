# Subagent Configuration and Allowlist

This guide addresses the common `sessions_spawn` error and provides the correct configuration structure for allowing sub-agent creation.

## The `sessions_spawn` Error

When attempting to spawn a sub-agent session (e.g., using `sessions_spawn` or when an agent attempts to spawn another agent), you may encounter the following error:

```json
{"status": "forbidden", "error": "agentId is not allowed for sessions_spawn (allowed: none)"}
```

This error means your current agent's configuration is missing the necessary policy to grant permissions for spawning child sessions.

## Configuration Fix

Permissions for spawning sub-agents are managed under the primary agent's configuration within the `openclaw.json` or equivalent configuration file. The control is defined in the `subagents` block of the `agents.list` array.

You must specify the `allowAgents` list to explicitly permit agents to be spawned.

### Example 1: Allow All Agents

To allow the agent to spawn *any* other agent (including custom-named, non-configured agents), use the `allowAny: true` flag.

```json
{
  "agents": {
    "list": [
      {
        "id": "main",
        "subagents": {
          "allowAny": true
        }
      }
    ]
  }
}
```

### Example 2: Allow Specific Agents Only

To restrict spawning to a list of defined agent IDs, use the `allowAgents` array.

```json
{
  "agents": {
    "list": [
      {
        "id": "main",
        "subagents": {
          "allowAgents": ["Agent 🌲 Bodhi", "Agent 🛡️ Warden", "Agent 🏹 Scout"]
        }
      }
    ]
  }
}
```

### Example 3: Deny All Spawning (Default Behavior)

If the `subagents` block is missing or empty, spawning is denied:

```json
{
  "agents": {
    "list": [
      {
        "id": "main"
        // subagents block is missing
      }
    ]
  }
}
```

## Troubleshooting and Best Practices

*   **Check the Agent ID:** Ensure the `agentId` you are using in `sessions_spawn` matches an ID in the `allowAgents` list or that `allowAny` is `true`.
*   **Restart OpenClaw:** Policy changes require a Gateway restart to take effect (`openclaw gateway restart`).
*   **Use `agents_list` Tool:** Your agent can inspect its own spawning capabilities by calling the `agents_list` tool. The output will explicitly list the allowed agent IDs or confirm if `allowAny` is true.
*   **Security:** Using `allowAny: true` grants broad permissions. For high-security environments, it is best practice to explicitly list all approved sub-agents in `allowAgents`.
