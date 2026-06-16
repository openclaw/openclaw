---
summary: "Community MCP bridge to run Claude Code on your local machine from Claude Cowork"
read_when:
  - You want Claude Cowork (cloud) to execute code on your local machine
  - You want to use Claude Code without separate API keys or billing
  - You want to connect cloud chat to your local repos, shell, and MCPs
title: "Cowork-to-Code Bridge"
---

**cowork-to-code-bridge** is a community tool that connects Claude Cowork (cloud) to Claude Code (local). It allows you to run real execution workflows—building code, running tests, git operations, and shell inspection—on your own machine directly from a cloud chat, without needing API keys or separate billing.

<Warning>
This is a community tool and is not officially supported by Anthropic or OpenClaw. The bridge relies on Claude Code "channels", which are currently in research preview. You must run Claude Code with the `--dangerously-load-development-channels server:intercom` flag.
</Warning>

## Why use this?

| Approach | Cost route | Best for |
|---|---|---|
| Anthropic API | Pay per token through Claude Console or cloud | Production apps, shared automation, volume |
| Cowork-to-Code Bridge | Claude Code / `claude -p` plan and credit rules | Escalating cloud tasks to your local machine |

If your workflow requires real execution (compiling, running tests, shell commands) and you want to use your existing Claude subscription without managing separate API billing, this bridge provides a secure, file-based way to hand tasks from the cloud down to your local machine.

## How it works

```text
Claude Cowork → cowork-to-code-bridge → Claude Code CLI → Your Machine
 (Cloud Agent)     (File-based queue)    (Local Agent)      (Shell/Repos)
```

The bridge:

1. Uses a shared file folder as an asynchronous queue (no network ports opened).
2. Cowork writes a task to the folder.
3. A local daemon picks up the task and runs Claude Code locally.
4. Claude Code executes the task and writes the result back through the bridge.

## Getting started

<Steps>
  <Step title="Install the bridge">
    Install the bridge on your local machine (macOS/Linux/WSL2).

    **macOS / Linux / WSL2 (curl):**
    ```bash
    curl -fsSL https://raw.githubusercontent.com/abhinaykrupa/cowork-to-code-bridge/main/install.sh | bash
    ```

    **Manual installation (GitHub):**
    ```bash
    git clone https://github.com/abhinaykrupa/cowork-to-code-bridge.git
    cd cowork-to-code-bridge
    bun install
    ```
  </Step>

  <Step title="Connect from Cowork">
    The installer will print a connect line. Paste it into your Claude Cowork chat:

    ```text
    Connect to my machine via the cowork-to-code bridge at ~/.cowork-to-code-bridge — mount that folder, read its CLAUDE.md, and confirm the bridge is live.
    ```
  </Step>

  <Step title="Test the connection">
    Approve Cowork's request to read the folder. Once it confirms `BRIDGE LIVE`, ask it to run a task:

    > *"build me a small web app on my machine"*
    > *"run my tests and fix what fails"*
    > *"check my machine's health"*
  </Step>
</Steps>

## Notes

- This is a **community tool**, not officially supported by Anthropic or OpenClaw
- Opens **no network ports** and never uses `sudo`
- Runs only approved scripts and is gated by a secret token
- Survives crashes: every task is journaled and marked in-flight

<Note>
For native Anthropic integration with Claude CLI or API keys, see [Anthropic provider](/providers/anthropic). To learn about OpenClaw's own MCP server capabilities, see [MCP](/cli/mcp).
</Note>

## Related

<CardGroup cols={2}>
  <Card title="Anthropic provider" href="/providers/anthropic" icon="bolt">
    Native OpenClaw integration with Claude CLI or API keys.
  </Card>
  <Card title="Claude Max API Proxy" href="/providers/claude-max-api-proxy" icon="server">
    Community proxy for OpenAI-compatible tools.
  </Card>
  <Card title="MCP" href="/cli/mcp" icon="network-wired">
    Expose OpenClaw channel conversations over MCP.
  </Card>
  <Card title="Configuration" href="/gateway/configuration" icon="gear">
    Full config reference.
  </Card>
</CardGroup>
