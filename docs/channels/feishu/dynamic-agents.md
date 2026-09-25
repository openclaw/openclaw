---
summary: "Per-user agent isolation for Feishu, giving each DM user their own workspace and agent"
read_when:
  - Running a public Feishu bot where each user needs a private assistant
  - Configuring `dynamicAgentCreation` or `session.dmScope`
title: "Feishu dynamic agents"
sidebarTitle: "Dynamic agents"
---

Per-user agent isolation: give every Feishu DM sender their own workspace, bootstrap files, and conversation history.

## Per-user agent isolation (Dynamic Agent Creation)

Enable `dynamicAgentCreation` to automatically create **isolated agent instances** for each DM user. Each user gets their own:

- Independent workspace directory
- Separate `USER.md` / `SOUL.md` / `MEMORY.md`
- Private conversation history
- Isolated skills and state

This is essential for public bots where you want each user to have their own private AI assistant experience.

<Note>
Dynamic bindings include the normalized Feishu `accountId`, so default and named accounts route each sender to the correct dynamic agent.

If a named account created an unscoped dynamic agent on an older release, that legacy agent still counts toward `maxAgents`. Confirm that it is not used by the default account before removing it, or temporarily increase `maxAgents`; OpenClaw cannot safely infer which account owns ambiguous legacy state.
</Note>

### Quick setup

```json5
{
  channels: {
    feishu: {
      dmPolicy: "open",
      allowFrom: ["*"],
      dynamicAgentCreation: {
        enabled: true,
        workspaceTemplate: "~/.openclaw/workspace-{agentId}",
        agentDirTemplate: "~/.openclaw/agents/{agentId}/agent",
      },
    },
  },
  session: {
    // Critical: makes each user's DM their "main session"
    // Automatically loads USER.md / SOUL.md / MEMORY.md
    // For stronger isolation, use "per-channel-peer" instead
    dmScope: "main",
  },
}
```

### How it works

When a new user sends their first DM:

1. The channel generates a unique `agentId`: `feishu-{user_open_id}` for the default account, or a bounded account-prefixed identity digest for a named account
2. Creates a new workspace at `workspaceTemplate` path
3. Registers the agent and creates a binding for this user
4. The workspace helper ensures bootstrap files (`AGENTS.md`, `SOUL.md`, `USER.md`, etc.) on first access
5. Routes all future messages from this user to their dedicated agent

### Configuration options

| Setting                                                  | Description                                | Default                              |
| -------------------------------------------------------- | ------------------------------------------ | ------------------------------------ |
| `channels.feishu.dynamicAgentCreation.enabled`           | Enable automatic per-user agent creation   | `false`                              |
| `channels.feishu.dynamicAgentCreation.workspaceTemplate` | Path template for dynamic agent workspaces | `~/.openclaw/workspace-{agentId}`    |
| `channels.feishu.dynamicAgentCreation.agentDirTemplate`  | Agent directory name template              | `~/.openclaw/agents/{agentId}/agent` |
| `channels.feishu.dynamicAgentCreation.maxAgents`         | Maximum number of dynamic agents to create | unlimited                            |

Template variables:

- `{agentId}` - the generated agent ID (e.g., `feishu-ou_xxxxxx` or `feishu-support-<identity_digest>`)
- `{userId}` - the sender's Feishu open_id (e.g., `ou_xxxxxx`)

### Session scope

`session.dmScope` controls how direct messages are mapped to agent sessions. This is a **global setting** that affects all channels.

| Value                        | Behavior                                                            | Best for                                                           |
| ---------------------------- | ------------------------------------------------------------------- | ------------------------------------------------------------------ |
| `"main"`                     | Each user's DM maps to their agent's main session                   | Single-user bots where you want `USER.md` / `SOUL.md` to auto-load |
| `"per-peer"`                 | Each peer gets a separate session (regardless of channel)           | Isolation keyed by sender identity only                            |
| `"per-channel-peer"`         | Each (channel + user) combination gets a separate session           | Public multi-user bots needing stronger isolation                  |
| `"per-account-channel-peer"` | Each (account + channel + user) combination gets a separate session | Multi-account bots needing account-level session isolation         |

**Tradeoff**: Using `"main"` enables automatic bootstrap file loading (`USER.md`, `SOUL.md`, `MEMORY.md`), but means all DMs across all channels share the same session key pattern. For public multi-user bots where isolation matters more than bootstrap auto-loading, consider `"per-channel-peer"` and manage bootstrap files manually.

<Note>
Use `"per-account-channel-peer"` when named Feishu accounts should keep separate sessions for the same sender. Dynamic bindings preserve the account scope.
</Note>

### Typical multi-user deployment

```json5
{
  channels: {
    feishu: {
      appId: "cli_xxx",
      appSecret: "xxx",
      dmPolicy: "open",
      allowFrom: ["*"],
      groupPolicy: "open",
      requireMention: true,
      dynamicAgentCreation: {
        enabled: true,
        workspaceTemplate: "~/.openclaw/workspace-{agentId}",
        agentDirTemplate: "~/.openclaw/agents/{agentId}/agent",
      },
    },
  },
  session: {
    // Choose dmScope based on your isolation needs:
    // "main" for bootstrap auto-loading, "per-channel-peer" for stronger isolation
    dmScope: "main",
  },
  bindings: [], // Empty - dynamic agents auto-bind
}
```

### Verification

Check gateway logs to confirm dynamic creation is working:

```text
feishu: creating dynamic agent "feishu-ou_xxxxxx" for user ou_xxxxxx
  workspace: /home/user/.openclaw/workspace-feishu-ou_xxxxxx
  agentDir: /home/user/.openclaw/agents/feishu-ou_xxxxxx/agent
```

List all created workspaces:

```bash
ls -la ~/.openclaw/workspace-*
```

### Notes

- **Workspace isolation**: Each user gets their own workspace directory and agent instance. Users cannot see each other's conversation history or files within the normal messaging flow.
- **Security boundary**: This is a messaging-context isolation mechanism, not a hostile co-tenant security boundary. The agent process and host environment are shared.
- **Config writes must stay enabled**: Dynamic agent creation writes agents and bindings into the config; it is skipped when `channels.feishu.configWrites` is `false` (default: enabled).
- **`bindings` should be empty**: Dynamic agents auto-register their own bindings
- **Upgrade path**: Existing manual bindings continue to work alongside dynamic agents
- **`session.dmScope` is global**: This affects all channels, not just Feishu
