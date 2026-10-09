---
summary: "Fresh sessions, context truncation, full resets, groups, and multi-agent setups"
title: "Sessions and multiple chats"
read_when:
  - You are managing sessions, resets, or context limits
  - You run multiple chats, groups, or bots
---

## Sessions and multiple chats

<AccordionGroup>
  <Accordion title="How do I start a fresh conversation?">
    Send `/new` or `/reset` as a standalone message. See [Session management](/concepts/session).
  </Accordion>

  <Accordion title="Do sessions reset automatically if I never send /new?">
    No, not by default. Sessions keep the same `sessionId`, and compaction bounds the active model context as conversations grow. `/new` and `/reset` remain available, or you can opt into automatic resets with `mode: "daily"` or `mode: "idle"`. Daily mode rolls over at `session.reset.atHour` (default `4`, 0-23) on the gateway host; idle mode uses `session.reset.idleMinutes` since the last real interaction, not heartbeat/cron/exec system events.

    ```json5
    {
      session: {
        reset: { mode: "daily", atHour: 4 },
        resetByType: {
          group: { mode: "idle", idleMinutes: 120 },
          thread: { mode: "daily", atHour: 6 },
        },
        resetByChannel: {
          discord: { mode: "idle", idleMinutes: 10080 },
        },
      },
    }
    ```

    `resetByType` supports `direct`, `group`, and `thread`. Doctor migrates legacy `dm` entries to `direct`; the schema rejects `dm`. Legacy top-level `session.idleMinutes` still works as a compatibility alias for an idle-mode default when no `session.reset`/`resetByType` block is set. See [Session management](/concepts/session) for the full lifecycle.

  </Accordion>

  <Accordion title="Is there a way to make a team of OpenClaw instances (one CEO and many agents)?">
    Yes, via **multi-agent routing** and **sub-agents**: one coordinator agent plus several worker agents with their own workspaces and models.

    This is best seen as a fun experiment - it is token-heavy and often less efficient than one bot with separate sessions. The typical model is one bot you talk to, with different sessions for parallel work, spawning sub-agents when needed.

    Docs: [Multi-agent routing](/concepts/multi-agent), [Sub-agents](/tools/subagents), [Agents CLI](/cli/agents).

  </Accordion>

  <Accordion title="Why did context get truncated mid-task? How do I prevent it?">
    Session context is limited by the model window. Long chats, large tool outputs, or many files can trigger compaction or truncation.

    - Ask the bot to summarize current state and write it to a file.
    - Use `/compact` before long tasks, `/new` when switching topics.
    - Keep important context in the workspace and ask the bot to read it back.
    - Use sub-agents for long or parallel work so the main chat stays smaller.
    - Pick a model with a larger context window if this happens often.

  </Accordion>

  <Accordion title="How do I completely reset OpenClaw but keep it installed?">
    ```bash
    openclaw reset
    ```

    Non-interactive full reset:

    ```bash
    openclaw reset --scope full --yes --non-interactive
    ```

    Then re-run setup:

    ```bash
    openclaw onboard --install-daemon
    ```

    To reset and immediately re-run onboarding, pass `openclaw onboard --reset`; reset is a command flag, not a **Setup mode** menu choice. See [Onboarding (CLI)](/start/wizard). If you used profiles (`--profile` / `OPENCLAW_PROFILE`), reset each state dir (default `~/.openclaw-<profile>`). Dev-only reset: `openclaw gateway --dev --reset` wipes dev config, credentials, sessions, and workspace.

  </Accordion>

  <Accordion title='I am getting "context too large" errors - how do I reset or compact?'>
    - **Compact** (keeps the conversation, summarizes older turns): `/compact` or `/compact <instructions>` to guide the summary.
    - **Reset** (fresh session ID for the same chat key): `/new` or `/reset`.

    If it keeps happening, tune **session pruning** (`agents.defaults.contextPruning`) to trim old tool output, or use a model with a larger context window.

    Docs: [Compaction](/concepts/compaction), [Session pruning](/concepts/session-pruning), [Session management](/concepts/session).

  </Accordion>

  <Accordion title='Why am I seeing "LLM request rejected: messages.content.tool_use.input field required"?'>
    Provider validation error: the model emitted a `tool_use` block without the required `input`. Usually means the session history is stale or corrupted (often after long threads or a tool/schema change).

    Fix: start a fresh session with `/new` (standalone message).

  </Accordion>

  <Accordion title="Why am I getting heartbeat messages every 30 minutes?">
    Heartbeats run every **30m** by default, or **1h** when the resolved auth mode is Anthropic OAuth/token auth (including Claude CLI reuse) and `heartbeat.every` is unset. Tune or disable:

    ```json5
    {
      agents: {
        defaults: {
          heartbeat: {
            every: "2h", // or "0m" to disable recurring cadence
          },
        },
      },
    }
    ```

    Heartbeat instructions live in the monitor's cron scratch. Effectively empty scratch skips the heartbeat run to save API calls; without scratch, the heartbeat still runs and the model decides what to do. `0m` does not block targeted event-driven wakes, such as a background exec completion follow-up; those can still run one agent turn without enabling recurring cadence.

    Per-agent overrides use `agents.entries.*.heartbeat`. Docs: [Heartbeat](/gateway/heartbeat).

  </Accordion>

  <Accordion title='Do I need to add a "bot account" to a WhatsApp group?'>
    No. OpenClaw runs on **your own account** - if you are in the group, OpenClaw can see it. By default, group replies are blocked until you allow senders (`groupPolicy: "allowlist"`).

    To restrict group replies to only you:

    ```json5
    {
      channels: {
        whatsapp: {
          groupPolicy: "allowlist",
          groupAllowFrom: ["+15551234567"],
        },
      },
    }
    ```

  </Accordion>

  <Accordion title="How do I get the JID of a WhatsApp group?">
    Fastest: tail logs and send a test message in the group.

    ```bash
    openclaw logs --follow --json
    ```

    Look for `chatId` (or `from`) ending in `@g.us`, like `1234567890-1234567890@g.us`.

    If already configured/allowlisted, list groups from config:

    ```bash
    openclaw directory groups list --channel whatsapp
    ```

    Docs: [WhatsApp](/channels/whatsapp), [Directory](/cli/directory), [Logs](/cli/logs).

  </Accordion>

  <Accordion title="Why does OpenClaw not reply in a group?">
    Two common causes: mention gating is on by default (you must @mention the bot, or match `mentionPatterns`), or you configured `channels.whatsapp.groups` without `"*"` and the group is not allowlisted.

    See [Groups](/channels/groups) and [Group messages](/channels/group-messages).

  </Accordion>

  <Accordion title="Do groups/threads share context with DMs?">
    Direct chats collapse to the main session by default. Groups/channels get their own session keys unless a route binding sets `session.groupScope: "main"` to merge that room into the main session; Telegram topics / Discord threads are separate sessions. See [Groups](/channels/groups) and [Group messages](/channels/group-messages).
  </Accordion>

  <Accordion title="How many workspaces and agents can I create?">
    No hard limits - dozens or even hundreds are fine, but watch:

    - **Disk growth**: active sessions and transcripts live in the per-agent SQLite database; legacy/archive artifacts can still accumulate under `~/.openclaw/agents/<agentId>/sessions/`.
    - **Token cost**: more agents means more concurrent model usage.
    - **Ops overhead**: per-agent auth profiles, workspaces, and channel routing.

    Keep one **active** workspace per agent (`agents.defaults.workspace`), prune old sessions with `openclaw sessions cleanup` if disk grows (do not edit active SQLite state by hand), and use `openclaw doctor` to spot stray workspaces and profile mismatches.

  </Accordion>

  <Accordion title="Can I run multiple bots or chats at the same time (Slack), and how should I set that up?">
    Yes, via **Multi-Agent Routing**: run multiple isolated agents and route inbound messages by channel/account/peer. Slack is supported as a channel and can be bound to specific agents.

    Browser access is powerful but not "do anything a human can" - anti-bot, CAPTCHAs, and MFA can still block automation. For the most reliable control, use local Chrome MCP on the host, or CDP on the machine that actually runs the browser.

    Best-practice setup: always-on Gateway host (VPS/Mac mini), one agent per role (bindings), Slack channel(s) bound to those agents, and local browser via Chrome MCP or a node when needed.

    Docs: [Multi-Agent Routing](/concepts/multi-agent), [Slack](/channels/slack), [Browser](/tools/browser), [Nodes](/nodes).

  </Accordion>
</AccordionGroup>
