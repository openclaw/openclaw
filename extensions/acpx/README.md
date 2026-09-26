# @openclaw/acpx

Official ACP runtime backend for OpenClaw.

ACPx lets OpenClaw run external coding harnesses through the Agent Client Protocol while OpenClaw still owns sessions, channels, delivery, permissions, and Gateway state.

## Install

```bash
openclaw plugins install @openclaw/acpx
```

Restart the Gateway after installing or updating the plugin.

## What it provides

- ACP-backed agent runtime sessions.
- Built-in ACPX harness targets, including `grok-build` for the Grok Build CLI.
- Plugin-owned session and transport management.
- MCP bridge helpers for OpenClaw tools and plugin tools.
- Static runtime assets used by the ACP process bridge.

## Native agents in the model picker

Install GitHub Copilot CLI, Kilo Code, OpenCode, Pi ACP, or Qwen Code and complete its login on the Gateway host,
then refresh the model catalog. Choose one of its models to use that agent in ordinary chat.
The agent owns its credentials; OpenClaw keeps the conversation transcript and asks for approval
when the agent requests permission. Pi does not request tool approval unless an extension adds it.
The same selection works in the web app and channels.

The runtime and provider IDs are `acp-copilot`, `acp-kilocode`, `acp-opencode`, `acp-pi`, and `acp-qwen`.
Each model keeps its native ID, including any slashes. Configured ACP agent commands take
precedence over installed defaults. Catalog refresh uses installed commands and does not install
missing agents. Explicit ACP commands and bindings keep their existing agent names.

Models settings lists detected agents on the Gateway machine. Turn each native agent on or off
there, or set `plugins.entries.acpx.config.nativeAgents.<id>` to `false` (`copilot`, `kilocode`,
`opencode`, `pi`, or `qwen`). Missing flags are enabled. Disabling an agent prevents new native turns
and catalog discovery without interrupting a running turn or deleting history. Classic ACP
commands and `acp.allowedAgents` keep their existing behavior. Detection checks installed
executables; it does not prove that an agent is logged in or can serve a model.

For GitHub Copilot CLI, run `copilot login` under the Gateway's OS account before refreshing
the catalog. Copilot owns GitHub authentication, model access, and plan usage. Its explicitly
configured BYOK providers remain CLI-owned and can incur separate API charges; OpenClaw does
not select a BYOK route for it. See the
[Copilot setup and billing notes](https://docs.openclaw.ai/tools/acp-agents-setup#github-copilot-cli-in-native-chat).

Native picker runtimes run on the Gateway host and use the native app's permissions.
OpenClaw checks that execution choice before dispatching a chat turn; ACP runners do not
implement OpenClaw sandboxing or workspace-only filesystem confinement.

When optional chat restrictions cannot be enforced, an administrator can choose
**Continue for this chat** to use the native app's permissions. This grants Full Access
and turns off optional sandboxing for that chat only; agent-wide and global settings
stay unchanged. After a refused message, confirmation retries that message once.
Confirming a model selection without a pending message does not send anything.

A creator-role-required sandbox cannot be removed, and remote execution placement
is not supported. Choose a compatible runtime when those boundaries must remain.
OpenClaw's Read Only, Guarded, and Workspace permission modes are not supported
by these native runtimes.

Native tool permission requests still require their one-shot approval. Once approved,
delegated filesystem writes do not encounter a second ACPX terminal approval gate.
Classic ACP sessions keep their configured `permissionMode`. The ACP client's
delegated filesystem remains rooted at its session cwd; this is not a sandbox for
the native process's own filesystem access.

Catalog refresh closes its local connection. The native agent owns any history it creates.
Reset and deletion close the local session and prevent its reuse, including after a Gateway restart.
Native history stays with the agent; these operations do not delete it.

## Configure

Use the ACP docs for harness-specific setup, permission modes, and model/runtime selection:

- https://docs.openclaw.ai/tools/acp-agents-setup
- https://docs.openclaw.ai/tools/acp-agents

`grok-build` is an agent target (`agentId: "grok-build"`), not the xAI model id
`xai/grok-build-0.1`. The target launches the installed Grok Build CLI through
`grok agent stdio`.

## Package

- Plugin id: `acpx`
- Package: `@openclaw/acpx`
- Minimum OpenClaw host: `2026.4.25`
