---
summary: "Customizing skills, per-task models, subagents, cron jobs, and background runs"
title: "Skills and automation"
read_when:
  - You are customizing, loading, or installing skills
  - A cron job, reminder, or subagent did not behave
---

## Skills and automation

<AccordionGroup>
  <Accordion title="How do I customize skills without keeping the repo dirty?">
    Use managed overrides instead of editing the repo copy. Put changes in `~/.openclaw/skills/<name>/SKILL.md` (or add a folder via `skills.load.extraDirs` in `~/.openclaw/openclaw.json`). Precedence: `<workspace>/skills` -> `<workspace>/.agents/skills` -> `~/.agents/skills` -> `~/.openclaw/skills` -> bundled -> `skills.load.extraDirs`, so managed overrides win over bundled skills without touching git. To install globally but limit visibility to some agents, keep the shared copy in `~/.openclaw/skills` and control visibility with `agents.defaults.skills` / `agents.entries.*.skills`. Only upstream-worthy edits should go out as PRs against the repo copy.
  </Accordion>

  <Accordion title="Can I load skills from a custom folder?">
    Yes: add directories via `skills.load.extraDirs` in `~/.openclaw/openclaw.json` (lowest precedence in the order above). `clawhub` installs into `./skills` by default, which OpenClaw treats as `<workspace>/skills` on the next session. To limit visibility to certain agents, pair with `agents.defaults.skills` or `agents.entries.*.skills`.
  </Accordion>

  <Accordion title="How can I use different models or settings for different tasks?">
    Supported patterns:

    - **Cron jobs**: isolated jobs can set a `model` override per job.
    - **Agents**: route tasks to separate agents with different default models, thinking levels, and stream params.
    - **Current session only**: `/model <model> -s` (or `--session`) leaves configured defaults unchanged.
    - **Agent default + current session**: Owner/admin `/model <model> -a` (or `--agent`) updates the selected agent.
    - **Global default + current session**: Owner/admin `/model <model> -g` (or `--global`) updates `agents.defaults.model`.

    Bare `/model <model>` keeps owner/admin configured-default persistence unless
    you set the optional [model selection scope](/gateway/config-agents/models#agentsdefaultsmodelselectionscope).

    Example - same model, different per-agent settings:

    ```json5
    {
      agents: {
        ownership: "explicit",
        entries: {
          coder: {
            model: "xiaomi/mimo-v2.5-pro",
            thinkingDefault: "high",
            params: { temperature: 0.1 },
          },
          chat: {
            model: "xiaomi/mimo-v2.5-pro",
            thinkingDefault: "off",
            params: { temperature: 0.8 },
          },
        },
      },
    }
    ```

    Put shared per-model defaults in `agents.defaults.models["provider/model"].params`. Use `agents.entries.*.models["provider/model"].params` when one agent needs different settings for that model. Flat `agents.entries.*.params` applies across that agent's models and wins over both per-model layers.

    See [Cron jobs](/automation/cron-jobs), [Multi-Agent Routing](/concepts/multi-agent), [Configuration](/gateway/config-agents), [Slash commands](/tools/slash-commands).

  </Accordion>

  <Accordion title="The bot freezes while doing heavy work. How do I offload that?">
    Use **sub-agents** for long or parallel tasks: they run in their own session, return a summary, and keep your main chat responsive. Ask the bot to "spawn a sub-agent for this task," or use `/subagents`. Use `/status` to see whether the Gateway is currently busy.

    Long tasks and sub-agents both consume tokens; set a cheaper model for sub-agents via `agents.defaults.subagents.model` if cost matters.

    Docs: [Sub-agents](/tools/subagents), [Background Tasks](/automation/tasks).

  </Accordion>

  <Accordion title="How do thread-bound subagent sessions work on Discord?">
    Bind a Discord thread to a subagent or session target so follow-up messages there stay on that bound session.

    - Spawn with `sessions_spawn` using `thread: true` (optionally `mode: "session"` for persistent follow-up).
    - `/agents` inspects binding state.
    - `/session idle <duration|off>` and `/session max-age <duration|off>` control automatic expiry.
    - `/session unbind` detaches the thread without closing the agent session.

    Config: `session.threadBindings.enabled` (global switch), `session.threadBindings.idleHours` (default `24`, `0` disables), `session.threadBindings.maxAgeHours` (default `0` = no hard cap), and `session.threadBindings.spawnSessions` for auto-bind on spawn (default `true`).

    Docs: [Sub-agents](/tools/subagents), [Discord](/channels/discord), [Configuration Reference](/gateway/configuration-reference), [Slash commands](/tools/slash-commands).

  </Accordion>

  <Accordion title="A subagent finished, but the completion update went to the wrong place or never posted. What should I check?">
    Check the resolved requester route:

    - Completion-mode subagent delivery prefers a bound thread or conversation route when one exists.
    - If the completion origin only carries a channel, OpenClaw falls back to the requester session's stored route (`lastChannel` / `lastTo` / `lastAccountId`) so direct delivery can still succeed.
    - No bound route and no usable stored route: direct delivery can fail and the result falls back to queued session delivery instead of posting immediately.
    - Invalid or stale targets can also force queue fallback or final delivery failure.
    - If the child's last visible assistant reply is exactly `NO_REPLY` / `no_reply` or `ANNOUNCE_SKIP`, OpenClaw intentionally suppresses the announce instead of posting stale earlier progress.

    Debug: `openclaw tasks show <lookup>` where `<lookup>` is a task id, run id, or session key.

    Docs: [Sub-agents](/tools/subagents), [Background Tasks](/automation/tasks), [Session Tools](/concepts/session-tool).

  </Accordion>

  <Accordion title="Cron or reminders do not fire. What should I check?">
    Cron runs inside the Gateway process; it does not fire if the Gateway is not running continuously.

    - Confirm cron is enabled (`cron.enabled`) and `OPENCLAW_SKIP_CRON` is not set.
    - Confirm the Gateway is running 24/7 (no sleep/restarts).
    - Verify job timezone (`--tz` vs host timezone).

    Debug:
    ```bash
    openclaw automations run <jobId>
    openclaw automations runs <jobId> --limit 50
    ```

    Docs: [Cron jobs](/automation/cron-jobs), [Automation](/automation).

  </Accordion>

  <Accordion title="Cron fired, but nothing was sent to the channel. Why?">
    Check the delivery mode:

    - `--no-deliver` / `delivery.mode: "none"`: no runner fallback send is expected.
    - Missing or invalid announce target (`channel` / `to`): the runner skipped outbound delivery.
    - Channel auth failures (`unauthorized`, `Forbidden`): the runner tried to deliver but credentials blocked it.
    - A silent isolated result (`NO_REPLY` / `no_reply` only) is treated as intentionally non-deliverable, so queued fallback delivery is also suppressed.

    For isolated cron jobs, the agent can still send directly with the `message` tool when a chat route is available. `--announce` only controls runner fallback delivery for final text the agent did not already send itself.

    Debug:
    ```bash
    openclaw automations runs <jobId> --limit 50
    openclaw tasks show <lookup>
    ```

    Docs: [Cron jobs](/automation/cron-jobs), [Background Tasks](/automation/tasks).

  </Accordion>

  <Accordion title="Why did an isolated cron run switch models or retry once?">
    That is the live model-switch path, not duplicate scheduling. Isolated cron persists a runtime model handoff and retries when the active run throws `LiveSessionModelSwitchError`, keeping the switched provider/model (and any switched auth-profile override) before retrying.

    Model-selection precedence: Gmail hook model override (`hooks.gmail.model`) first, then per-job `model`, then any stored cron-session model override, then normal agent/default model selection.

    The retry loop is bounded to the initial attempt plus 2 switch retries; cron then aborts instead of looping forever.

    Debug:
    ```bash
    openclaw automations runs <jobId> --limit 50
    ```

    Docs: [Cron jobs](/automation/cron-jobs), [cron CLI](/cli/cron).

  </Accordion>

  <Accordion title="How do I install skills on Linux?">
    Use native `openclaw skills` commands or drop skills into your workspace; the macOS Skills UI is not available on Linux. Browse skills at [https://clawhub.ai](https://clawhub.ai).

    ```bash
    openclaw skills search "calendar"
    openclaw skills search --limit 20
    openclaw skills install @owner/<skill-slug>
    openclaw skills install @owner/<skill-slug> --version <version>
    openclaw skills install @owner/<skill-slug> --force
    openclaw skills install @owner/<skill-slug> --global
    openclaw skills update --all
    openclaw skills update --all --global
    openclaw skills list --eligible
    openclaw skills check
    ```

    Native `openclaw skills install` writes into the active workspace `skills/` directory by default. Add `--global` to install into the shared managed skills directory for all local agents. Install the separate `clawhub` CLI only to publish or sync your own skills. Use `agents.defaults.skills` or `agents.entries.*.skills` to narrow which agents see shared skills.

  </Accordion>

  <Accordion title="Can OpenClaw run tasks on a schedule or continuously in the background?">
    Yes, via the Gateway scheduler:

    - **Cron jobs** for scheduled or recurring tasks (persist across restarts).
    - **Heartbeat** for main-session periodic checks.
    - **Isolated jobs** for autonomous agents that post summaries or deliver to chats.

    Docs: [Cron jobs](/automation/cron-jobs), [Automation](/automation), [Heartbeat](/gateway/heartbeat).

  </Accordion>

  <Accordion title="Can I run Apple macOS-only skills from Linux?">
    Not directly. macOS skills are gated by `metadata.openclaw.os` plus required binaries, and only load when eligible on the **Gateway host**. On Linux, `darwin`-only skills (`apple-notes`, `apple-reminders`, `things-mac`) will not load unless you override the gating.

    Three supported patterns:

    **Option A - run the Gateway on a Mac (simplest)**. Run the Gateway where the macOS binaries exist, then connect from Linux in [remote mode](/help/faq/gateway-ports-and-remote-mode#gateway-ports-already-running-and-remote-mode) or over Tailscale. Skills load normally because the Gateway host is macOS.

    **Option B - use a macOS node (no SSH)**. Run the Gateway on Linux, pair a macOS node (menubar app), and set **Node Run Commands** to "Always Ask" or "Always Allow" on the Mac. OpenClaw treats macOS-only skills as eligible when required binaries exist on the node; the agent runs them via the `nodes` tool. With "Always Ask," approving "Always Allow" in the prompt adds that command to the allowlist.

    **Option C - proxy macOS binaries over SSH (advanced)**. Keep the Gateway on Linux, but make the required CLI binaries resolve to SSH wrappers that run on a Mac, then override the skill to allow Linux so it stays eligible.

    1. Create an SSH wrapper for the binary (example: `memo` for Apple Notes):
       ```bash
       #!/usr/bin/env bash
       set -euo pipefail
       exec ssh -T user@mac-host /opt/homebrew/bin/memo "$@"
       ```
    2. Put the wrapper on `PATH` on the Linux host (for example `~/bin/memo`).
    3. Override the skill metadata (workspace or `~/.openclaw/skills`) to allow Linux:
       ```markdown
       ---
       name: apple-notes
       description: Manage Apple Notes via the memo CLI on macOS.
       metadata: { "openclaw": { "os": ["darwin", "linux"], "requires": { "bins": ["memo"] } } }
       ---
       ```
    4. Start a new session so the skills snapshot refreshes.

  </Accordion>

  <Accordion title="Do you have a Notion or HeyGen integration?">
    Not built in today. Options:

    - **Custom skill / plugin**: best for reliable API access (both have APIs).
    - **Browser automation**: works without code but is slower and more fragile.

    For agency-style per-client context: keep one Notion page per client (context + preferences + active work) and ask the agent to fetch that page at the start of a session.

    For a native integration, open a feature request or build a skill against those APIs.

    ```bash
    openclaw skills install @owner/<skill-slug>
    openclaw skills update --all
    ```

    Native installs land in the active workspace `skills/` directory; use `--global` for all local agents, or configure `agents.defaults.skills` / `agents.entries.*.skills` to limit visibility. Some skills expect Homebrew-installed binaries; on Linux that means Linuxbrew.

    See [Skills](/tools/skills), [Skills config](/tools/skills-config), [ClawHub](/clawhub).

  </Accordion>

  <Accordion title="How do I use my existing signed-in Chrome with OpenClaw?">
    Use the built-in `user` browser profile, which attaches through Chrome DevTools MCP:

    ```bash
    openclaw browser --browser-profile user tabs
    openclaw browser --browser-profile user snapshot
    ```

    For a custom name, create an explicit MCP profile:

    ```bash
    openclaw browser create-profile --name chrome-live --driver existing-session
    openclaw browser --browser-profile chrome-live tabs
    ```

    This can use the local host browser or a connected browser node. If the Gateway runs elsewhere, run a node host on the browser machine, or use remote CDP instead.

    Current limits on `existing-session` / `user` profiles versus the managed `openclaw` profile:

    - `click`, `type`, `hover`, `scrollIntoView`, `drag`, and `select` require snapshot refs, not CSS selectors.
    - Upload hooks require `ref` or `inputRef`, one file at a time, no CSS `element`.
    - `responsebody`, PDF export, download interception, and batch actions still require the managed browser path.

    See [Browser](/tools/browser/existing-session#existing-session-via-chrome-devtools-mcp) for the full comparison.

  </Accordion>
</AccordionGroup>
