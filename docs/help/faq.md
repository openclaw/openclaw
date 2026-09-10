---
summary: "Frequently asked questions about OpenClaw setup, configuration, and usage"
read_when:
  - Answering common setup, install, onboarding, or runtime support questions
  - Triaging user-reported issues before deeper debugging
title: "FAQ"
---

Quick answers plus deeper troubleshooting for real-world setups (local dev, VPS, multi-agent, OAuth/API keys, model failover). For runtime diagnostics, see [Troubleshooting](/gateway/troubleshooting). For the full config reference, see [Configuration](/gateway/configuration).

This page is an index. The day-to-day FAQ is split across thirteen pages, one per
topic. The triage ladder stays on this page; open the page that matches your question.

| Page                                                                                       | Read it when                                                                    |
| ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------- |
| [What is OpenClaw?](/help/faq/what-is-openclaw)                                            | You are evaluating OpenClaw, or explaining what it is and who funds it.         |
| [Skills and automation](/help/faq/skills-and-automation)                                   | You are customizing skills, or a cron job, reminder, or subagent misbehaved.    |
| [Sandboxing and memory](/help/faq/sandboxing-and-memory)                                   | You are tuning the sandbox, or memory is not persisting.                        |
| [Where things live on disk](/help/faq/where-things-live-on-disk)                           | You need to find, back up, move, or remove OpenClaw data.                       |
| [Config basics](/help/faq/config-basics)                                                   | You are editing config, enabling web search, or recovering from `config.apply`. |
| [Remote gateways and nodes](/help/faq/remote-gateways-and-nodes)                           | You run the Gateway on a VPS or another machine, or you are adding a node.      |
| [Env vars and .env loading](/help/faq/env-vars)                                            | You are setting keys through env or `.env`, or the service lost them.           |
| [Sessions and multiple chats](/help/faq/sessions-and-chats)                                | You are managing sessions, resets, context limits, groups, or several bots.     |
| [Gateway ports, already running, and remote mode](/help/faq/gateway-ports-and-remote-mode) | The Gateway will not bind, says it is already running, or you want remote mode. |
| [Logging and debugging](/help/faq/logging-and-debugging)                                   | You need logs or a service restart, or replies never arrive.                    |
| [Media and attachments](/help/faq/media-and-attachments)                                   | A skill produced an image or PDF but nothing was sent.                          |
| [Security and access control](/help/faq/security-and-access-control)                       | You are exposing OpenClaw to inbound messages or judging plugin risk.           |
| [Chat commands, aborting tasks, and stopping a run](/help/faq/chat-commands-and-stopping)  | A task will not stop, or you are tuning slash commands and the queue.           |

## First 60 seconds if something is broken

<Steps>
  <Step title="Quick status">
    ```bash
    openclaw status
    ```
    Fast local summary: OS + update, gateway/service reachability, agents/sessions, provider config + runtime issues (when the gateway is reachable).
  </Step>
  <Step title="Pasteable report (safe to share)">
    ```bash
    openclaw status --all
    ```
    Read-only diagnosis with a log tail (tokens redacted).
  </Step>
  <Step title="Daemon + port state">
    ```bash
    openclaw gateway status
    ```
    Shows supervisor runtime vs RPC reachability, the probe target URL, and which config the service likely used.
  </Step>
  <Step title="Deep probes">
    ```bash
    openclaw status --deep
    ```
    Live gateway health probe, including channel probes when supported (requires a reachable gateway). See [Health](/gateway/health).
  </Step>
  <Step title="Tail the latest log">
    ```bash
    openclaw logs --follow
    ```
    If RPC is down, fall back to:
    ```bash
    tail -f "/tmp/openclaw/openclaw-$(date +%F).log"
    # Named profile example:
    tail -f "/tmp/openclaw/openclaw-dev-$(date +%F).log"
    ```
    File logs are separate from service logs; see [Logging](/logging) and [Troubleshooting](/gateway/troubleshooting).
  </Step>
  <Step title="Run the doctor (repairs)">
    ```bash
    openclaw doctor
    ```
    Repairs/migrates config and state, then runs health checks. See [Doctor](/gateway/doctor).
  </Step>
  <Step title="Gateway snapshot (WS-only)">
    ```bash
    openclaw health --json
    openclaw health --verbose   # shows the target URL + config path on errors
    ```
    Asks the running gateway for a full snapshot. See [Health](/gateway/health).
  </Step>
</Steps>

## Quick start and first-run setup

First-run Q&A - install, onboard, auth routes, subscriptions, initial failures - lives on the [First-run FAQ](/help/faq-first-run).

## Models, failover, and auth profiles

Model Q&A - defaults, selection, aliases, switching, failover, auth profiles - lives on the [Models FAQ](/help/faq-models).

## Miscellaneous

<AccordionGroup>
  <Accordion title='What is the default model for Anthropic with an API key?'>
    Credentials and model selection are separate. Setting `ANTHROPIC_API_KEY` (or storing an Anthropic API key in auth profiles) enables authentication, but the actual default model is whatever you configure in `agents.defaults.model.primary` (for example `anthropic/claude-sonnet-4-6` or `anthropic/claude-opus-4-6`). `No credentials found for profile "anthropic:default"` means the Gateway could not find Anthropic credentials in the SQLite auth stores available to the running agent.
  </Accordion>
</AccordionGroup>

---

Still stuck? Ask in [Discord](https://discord.com/invite/clawd) or use the [GitHub issue chooser](https://github.com/openclaw/openclaw/issues/new/choose).

## Where each section moved

Every question heading from the previous single-page version keeps its anchor
here, so an existing link such as `/help/faq#where-things-live-on-disk` still
resolves. Each entry points at the page that now holds the answer.

- <a id="what-is-openclaw%3F" /><a id="what-is-openclaw" />[What is OpenClaw?](/help/faq/what-is-openclaw#what-is-openclaw)
- <a id="what-is-openclaw-in-one-paragraph" />[What is OpenClaw, in one paragraph?](/help/faq/what-is-openclaw#what-is-openclaw-in-one-paragraph)
- <a id="can-my-team-share-one-openclaw" />[Can my team share one OpenClaw?](/help/faq/what-is-openclaw#can-my-team-share-one-openclaw)
- <a id="value-proposition" />[Value proposition](/help/faq/what-is-openclaw#value-proposition)
- <a id="i-just-set-it-up-what-should-i-do-first" />[I just set it up - what should I do first?](/help/faq/what-is-openclaw#i-just-set-it-up-what-should-i-do-first)
- <a id="what-are-the-top-five-everyday-use-cases-for-openclaw" />[What are the top five everyday use cases for OpenClaw?](/help/faq/what-is-openclaw#what-are-the-top-five-everyday-use-cases-for-openclaw)
- <a id="can-openclaw-help-with-lead-gen-outreach-ads-and-blogs-for-a-saas" />[Can OpenClaw help with lead gen, outreach, ads, and blogs for a SaaS?](/help/faq/what-is-openclaw#can-openclaw-help-with-lead-gen-outreach-ads-and-blogs-for-a-saas)
- <a id="is-openclaw-owned-by-openai" />[Is OpenClaw owned by OpenAI?](/help/faq/what-is-openclaw#is-openclaw-owned-by-openai)
- <a id="what-does-openclaw-send-to-the-foundation" />[What does OpenClaw send to the Foundation?](/help/faq/what-is-openclaw#what-does-openclaw-send-to-the-foundation)
- <a id="how-is-openclaw-funded-and-how-does-that-compare" />[How is OpenClaw funded, and how does that compare?](/help/faq/what-is-openclaw#how-is-openclaw-funded-and-how-does-that-compare)
- <a id="what-are-the-advantages-vs-claude-code-for-web-development" />[What are the advantages vs Claude Code for web development?](/help/faq/what-is-openclaw#what-are-the-advantages-vs-claude-code-for-web-development)
- <a id="skills-and-automation" />[Skills and automation](/help/faq/skills-and-automation#skills-and-automation)
- <a id="how-do-i-customize-skills-without-keeping-the-repo-dirty" />[How do I customize skills without keeping the repo dirty?](/help/faq/skills-and-automation#how-do-i-customize-skills-without-keeping-the-repo-dirty)
- <a id="can-i-load-skills-from-a-custom-folder" />[Can I load skills from a custom folder?](/help/faq/skills-and-automation#can-i-load-skills-from-a-custom-folder)
- <a id="how-can-i-use-different-models-or-settings-for-different-tasks" />[How can I use different models or settings for different tasks?](/help/faq/skills-and-automation#how-can-i-use-different-models-or-settings-for-different-tasks)
- <a id="the-bot-freezes-while-doing-heavy-work-how-do-i-offload-that" />[The bot freezes while doing heavy work. How do I offload that?](/help/faq/skills-and-automation#the-bot-freezes-while-doing-heavy-work-how-do-i-offload-that)
- <a id="how-do-thread-bound-subagent-sessions-work-on-discord" />[How do thread-bound subagent sessions work on Discord?](/help/faq/skills-and-automation#how-do-thread-bound-subagent-sessions-work-on-discord)
- <a id="a-subagent-finished-but-the-completion-update-went-to-the-wrong-place-or-never-posted-what-should-i-check" />[A subagent finished, but the completion update went to the wrong place or never posted. What should I check?](/help/faq/skills-and-automation#a-subagent-finished-but-the-completion-update-went-to-the-wrong-place-or-never-posted-what-should-i-check)
- <a id="cron-or-reminders-do-not-fire-what-should-i-check" />[Cron or reminders do not fire. What should I check?](/help/faq/skills-and-automation#cron-or-reminders-do-not-fire-what-should-i-check)
- <a id="cron-fired-but-nothing-was-sent-to-the-channel-why" />[Cron fired, but nothing was sent to the channel. Why?](/help/faq/skills-and-automation#cron-fired-but-nothing-was-sent-to-the-channel-why)
- <a id="why-did-an-isolated-cron-run-switch-models-or-retry-once" />[Why did an isolated cron run switch models or retry once?](/help/faq/skills-and-automation#why-did-an-isolated-cron-run-switch-models-or-retry-once)
- <a id="how-do-i-install-skills-on-linux" />[How do I install skills on Linux?](/help/faq/skills-and-automation#how-do-i-install-skills-on-linux)
- <a id="can-openclaw-run-tasks-on-a-schedule-or-continuously-in-the-background" />[Can OpenClaw run tasks on a schedule or continuously in the background?](/help/faq/skills-and-automation#can-openclaw-run-tasks-on-a-schedule-or-continuously-in-the-background)
- <a id="can-i-run-apple-macos-only-skills-from-linux" />[Can I run Apple macOS-only skills from Linux?](/help/faq/skills-and-automation#can-i-run-apple-macos-only-skills-from-linux)
- <a id="do-you-have-a-notion-or-heygen-integration" />[Do you have a Notion or HeyGen integration?](/help/faq/skills-and-automation#do-you-have-a-notion-or-heygen-integration)
- <a id="how-do-i-use-my-existing-signed-in-chrome-with-openclaw" />[How do I use my existing signed-in Chrome with OpenClaw?](/help/faq/skills-and-automation#how-do-i-use-my-existing-signed-in-chrome-with-openclaw)
- <a id="sandboxing-and-memory" />[Sandboxing and memory](/help/faq/sandboxing-and-memory#sandboxing-and-memory)
- <a id="is-there-a-dedicated-sandboxing-doc" />[Is there a dedicated sandboxing doc?](/help/faq/sandboxing-and-memory#is-there-a-dedicated-sandboxing-doc)
- <a id="docker-feels-limited-how-do-i-enable-full-features" />[Docker feels limited - how do I enable full features?](/help/faq/sandboxing-and-memory#docker-feels-limited-how-do-i-enable-full-features)
- <a id="can-i-keep-dms-personal-but-make-groups-public-sandboxed-with-one-agent" />[Can I keep DMs personal but make groups public/sandboxed with one agent?](/help/faq/sandboxing-and-memory#can-i-keep-dms-personal-but-make-groups-public-sandboxed-with-one-agent)
- <a id="how-do-i-bind-a-host-folder-into-the-sandbox" />[How do I bind a host folder into the sandbox?](/help/faq/sandboxing-and-memory#how-do-i-bind-a-host-folder-into-the-sandbox)
- <a id="how-does-memory-work" />[How does memory work?](/help/faq/sandboxing-and-memory#how-does-memory-work)
- <a id="memory-keeps-forgetting-things-how-do-i-make-it-stick" />[Memory keeps forgetting things. How do I make it stick?](/help/faq/sandboxing-and-memory#memory-keeps-forgetting-things-how-do-i-make-it-stick)
- <a id="does-memory-persist-forever-what-are-the-limits" />[Does memory persist forever? What are the limits?](/help/faq/sandboxing-and-memory#does-memory-persist-forever-what-are-the-limits)
- <a id="does-semantic-memory-search-require-an-openai-api-key" />[Does semantic memory search require an OpenAI API key?](/help/faq/sandboxing-and-memory#does-semantic-memory-search-require-an-openai-api-key)
- <a id="where-things-live-on-disk" />[Where things live on disk](/help/faq/where-things-live-on-disk#where-things-live-on-disk)
- <a id="is-all-data-used-with-openclaw-saved-locally" />[Is all data used with OpenClaw saved locally?](/help/faq/where-things-live-on-disk#is-all-data-used-with-openclaw-saved-locally)
- <a id="where-does-openclaw-store-its-data" />[Where does OpenClaw store its data?](/help/faq/where-things-live-on-disk#where-does-openclaw-store-its-data)
- <a id="where-should-agents-md-soul-md-user-md-memory-md-live" />[Where should AGENTS.md / SOUL.md / USER.md / MEMORY.md live?](/help/faq/where-things-live-on-disk#where-should-agents-md-soul-md-user-md-memory-md-live)
- <a id="can-i-make-soul-md-bigger" />[Can I make SOUL.md bigger?](/help/faq/where-things-live-on-disk#can-i-make-soul-md-bigger)
- <a id="recommended-backup-strategy" />[Recommended backup strategy](/help/faq/where-things-live-on-disk#recommended-backup-strategy)
- <a id="how-do-i-completely-uninstall-openclaw" />[How do I completely uninstall OpenClaw?](/help/faq/where-things-live-on-disk#how-do-i-completely-uninstall-openclaw)
- <a id="can-agents-work-outside-the-workspace" />[Can agents work outside the workspace?](/help/faq/where-things-live-on-disk#can-agents-work-outside-the-workspace)
- <a id="remote-mode-where-is-the-session-store" />[Remote mode: where is the session store?](/help/faq/where-things-live-on-disk#remote-mode-where-is-the-session-store)
- <a id="config-basics" />[Config basics](/help/faq/config-basics#config-basics)
- <a id="what-format-is-the-config-where-is-it" />[What format is the config? Where is it?](/help/faq/config-basics#what-format-is-the-config-where-is-it)
- <a id="i-set-gateway-bind-lan-or-tailnet-and-now-nothing-listens-the-ui-says-unauthorized" />[I set gateway.bind: "lan" (or "tailnet") and now nothing listens / the UI says unauthorized](/help/faq/config-basics#i-set-gateway-bind-lan-or-tailnet-and-now-nothing-listens-the-ui-says-unauthorized)
- <a id="why-do-i-need-a-token-on-localhost-now" />[Why do I need a token on localhost now?](/help/faq/config-basics#why-do-i-need-a-token-on-localhost-now)
- <a id="do-i-have-to-restart-after-changing-config" />[Do I have to restart after changing config?](/help/faq/config-basics#do-i-have-to-restart-after-changing-config)
- <a id="how-do-i-enable-web-search-and-web-fetch" />[How do I enable web search (and web fetch)?](/help/faq/config-basics#how-do-i-enable-web-search-and-web-fetch)
- <a id="config-apply-wiped-my-config-how-do-i-recover-and-avoid-this" />[config.apply wiped my config. How do I recover and avoid this?](/help/faq/config-basics#config-apply-wiped-my-config-how-do-i-recover-and-avoid-this)
- <a id="how-do-i-run-a-central-gateway-with-specialized-workers-across-devices" />[How do I run a central Gateway with specialized workers across devices?](/help/faq/config-basics#how-do-i-run-a-central-gateway-with-specialized-workers-across-devices)
- <a id="can-the-openclaw-browser-run-headless" />[Can the OpenClaw browser run headless?](/help/faq/config-basics#can-the-openclaw-browser-run-headless)
- <a id="how-do-i-use-brave-for-browser-control" />[How do I use Brave for browser control?](/help/faq/config-basics#how-do-i-use-brave-for-browser-control)
- <a id="remote-gateways-and-nodes" />[Remote gateways and nodes](/help/faq/remote-gateways-and-nodes#remote-gateways-and-nodes)
- <a id="how-do-commands-propagate-between-telegram-the-gateway-and-nodes" />[How do commands propagate between Telegram, the gateway, and nodes?](/help/faq/remote-gateways-and-nodes#how-do-commands-propagate-between-telegram-the-gateway-and-nodes)
- <a id="how-can-my-agent-access-my-computer-if-the-gateway-is-hosted-remotely" />[How can my agent access my computer if the Gateway is hosted remotely?](/help/faq/remote-gateways-and-nodes#how-can-my-agent-access-my-computer-if-the-gateway-is-hosted-remotely)
- <a id="tailscale-is-connected-but-i-get-no-replies-what-now" />[Tailscale is connected but I get no replies. What now?](/help/faq/remote-gateways-and-nodes#tailscale-is-connected-but-i-get-no-replies-what-now)
- <a id="can-two-openclaw-instances-talk-to-each-other-local-vps" />[Can two OpenClaw instances talk to each other (local + VPS)?](/help/faq/remote-gateways-and-nodes#can-two-openclaw-instances-talk-to-each-other-local-vps)
- <a id="do-i-need-separate-vpses-for-multiple-agents" />[Do I need separate VPSes for multiple agents?](/help/faq/remote-gateways-and-nodes#do-i-need-separate-vpses-for-multiple-agents)
- <a id="is-there-a-benefit-to-using-a-node-on-my-personal-laptop-instead-of-ssh-from-a-vps" />[Is there a benefit to using a node on my personal laptop instead of SSH from a VPS?](/help/faq/remote-gateways-and-nodes#is-there-a-benefit-to-using-a-node-on-my-personal-laptop-instead-of-ssh-from-a-vps)
- <a id="do-nodes-run-a-gateway-service" />[Do nodes run a gateway service?](/help/faq/remote-gateways-and-nodes#do-nodes-run-a-gateway-service)
- <a id="is-there-an-api-rpc-way-to-apply-config" />[Is there an API / RPC way to apply config?](/help/faq/remote-gateways-and-nodes#is-there-an-api-rpc-way-to-apply-config)
- <a id="minimal-sane-config-for-a-first-install" />[Minimal sane config for a first install](/help/faq/remote-gateways-and-nodes#minimal-sane-config-for-a-first-install)
- <a id="how-do-i-set-up-tailscale-on-a-vps-and-connect-from-my-mac" />[How do I set up Tailscale on a VPS and connect from my Mac?](/help/faq/remote-gateways-and-nodes#how-do-i-set-up-tailscale-on-a-vps-and-connect-from-my-mac)
- <a id="how-do-i-connect-a-mac-node-to-a-remote-gateway-tailscale-serve" />[How do I connect a Mac node to a remote Gateway (Tailscale Serve)?](/help/faq/remote-gateways-and-nodes#how-do-i-connect-a-mac-node-to-a-remote-gateway-tailscale-serve)
- <a id="should-i-install-on-a-second-laptop-or-just-add-a-node" />[Should I install on a second laptop or just add a node?](/help/faq/remote-gateways-and-nodes#should-i-install-on-a-second-laptop-or-just-add-a-node)
- <a id="env-vars-and-.env-loading" /><a id="env-vars-and-env-loading" />[Env vars and .env loading](/help/faq/env-vars#env-vars-and-env-loading)
- <a id="how-does-openclaw-load-environment-variables" />[How does OpenClaw load environment variables?](/help/faq/env-vars#how-does-openclaw-load-environment-variables)
- <a id="i-started-the-gateway-via-the-service-and-my-env-vars-disappeared-what-now" />[I started the Gateway via the service and my env vars disappeared. What now?](/help/faq/env-vars#i-started-the-gateway-via-the-service-and-my-env-vars-disappeared-what-now)
- <a id="i-set-copilot-github-token-but-models-status-shows-shell-env-off-why" />[I set COPILOT_GITHUB_TOKEN, but models status shows "Shell env: off." Why?](/help/faq/env-vars#i-set-copilot-github-token-but-models-status-shows-shell-env-off-why)
- <a id="sessions-and-multiple-chats" />[Sessions and multiple chats](/help/faq/sessions-and-chats#sessions-and-multiple-chats)
- <a id="how-do-i-start-a-fresh-conversation" />[How do I start a fresh conversation?](/help/faq/sessions-and-chats#how-do-i-start-a-fresh-conversation)
- <a id="do-sessions-reset-automatically-if-i-never-send-new" />[Do sessions reset automatically if I never send /new?](/help/faq/sessions-and-chats#do-sessions-reset-automatically-if-i-never-send-new)
- <a id="is-there-a-way-to-make-a-team-of-openclaw-instances-one-ceo-and-many-agents" />[Is there a way to make a team of OpenClaw instances (one CEO and many agents)?](/help/faq/sessions-and-chats#is-there-a-way-to-make-a-team-of-openclaw-instances-one-ceo-and-many-agents)
- <a id="why-did-context-get-truncated-mid-task-how-do-i-prevent-it" />[Why did context get truncated mid-task? How do I prevent it?](/help/faq/sessions-and-chats#why-did-context-get-truncated-mid-task-how-do-i-prevent-it)
- <a id="how-do-i-completely-reset-openclaw-but-keep-it-installed" />[How do I completely reset OpenClaw but keep it installed?](/help/faq/sessions-and-chats#how-do-i-completely-reset-openclaw-but-keep-it-installed)
- <a id="i-am-getting-context-too-large-errors-how-do-i-reset-or-compact" />[I am getting "context too large" errors - how do I reset or compact?](/help/faq/sessions-and-chats#i-am-getting-context-too-large-errors-how-do-i-reset-or-compact)
- <a id="why-am-i-seeing-llm-request-rejected-messages-content-tool-use-input-field-required" />[Why am I seeing "LLM request rejected: messages.content.tool_use.input field required"?](/help/faq/sessions-and-chats#why-am-i-seeing-llm-request-rejected-messages-content-tool-use-input-field-required)
- <a id="why-am-i-getting-heartbeat-messages-every-30-minutes" />[Why am I getting heartbeat messages every 30 minutes?](/help/faq/sessions-and-chats#why-am-i-getting-heartbeat-messages-every-30-minutes)
- <a id="do-i-need-to-add-a-bot-account-to-a-whatsapp-group" />[Do I need to add a "bot account" to a WhatsApp group?](/help/faq/sessions-and-chats#do-i-need-to-add-a-bot-account-to-a-whatsapp-group)
- <a id="how-do-i-get-the-jid-of-a-whatsapp-group" />[How do I get the JID of a WhatsApp group?](/help/faq/sessions-and-chats#how-do-i-get-the-jid-of-a-whatsapp-group)
- <a id="why-does-openclaw-not-reply-in-a-group" />[Why does OpenClaw not reply in a group?](/help/faq/sessions-and-chats#why-does-openclaw-not-reply-in-a-group)
- <a id="do-groups-threads-share-context-with-dms" />[Do groups/threads share context with DMs?](/help/faq/sessions-and-chats#do-groups-threads-share-context-with-dms)
- <a id="how-many-workspaces-and-agents-can-i-create" />[How many workspaces and agents can I create?](/help/faq/sessions-and-chats#how-many-workspaces-and-agents-can-i-create)
- <a id="can-i-run-multiple-bots-or-chats-at-the-same-time-slack-and-how-should-i-set-that-up" />[Can I run multiple bots or chats at the same time (Slack), and how should I set that up?](/help/faq/sessions-and-chats#can-i-run-multiple-bots-or-chats-at-the-same-time-slack-and-how-should-i-set-that-up)
- <a id="gateway%3A-ports%2C-%22already-running%22%2C-and-remote-mode" /><a id="gateway-ports-already-running-and-remote-mode" />[Gateway: ports, "already running", and remote mode](/help/faq/gateway-ports-and-remote-mode#gateway-ports-already-running-and-remote-mode)
- <a id="what-port-does-the-gateway-use" />[What port does the Gateway use?](/help/faq/gateway-ports-and-remote-mode#what-port-does-the-gateway-use)
- <a id="why-does-openclaw-gateway-status-say-runtime-running-but-connectivity-probe-failed" />[Why does openclaw gateway status say "Runtime: running" but "Connectivity probe: failed"?](/help/faq/gateway-ports-and-remote-mode#why-does-openclaw-gateway-status-say-runtime-running-but-connectivity-probe-failed)
- <a id="why-does-openclaw-gateway-status-show-config-cli-and-config-service-different" />[Why does openclaw gateway status show "Config (cli)" and "Config (service)" different?](/help/faq/gateway-ports-and-remote-mode#why-does-openclaw-gateway-status-show-config-cli-and-config-service-different)
- <a id="what-does-another-gateway-instance-is-already-listening-mean" />[What does "another gateway instance is already listening" mean?](/help/faq/gateway-ports-and-remote-mode#what-does-another-gateway-instance-is-already-listening-mean)
- <a id="how-do-i-run-openclaw-in-remote-mode-client-connects-to-a-gateway-elsewhere" />[How do I run OpenClaw in remote mode (client connects to a Gateway elsewhere)?](/help/faq/gateway-ports-and-remote-mode#how-do-i-run-openclaw-in-remote-mode-client-connects-to-a-gateway-elsewhere)
- <a id="the-control-ui-says-unauthorized-or-keeps-reconnecting-what-now" />[The Control UI says "unauthorized" (or keeps reconnecting). What now?](/help/faq/gateway-ports-and-remote-mode#the-control-ui-says-unauthorized-or-keeps-reconnecting-what-now)
- <a id="i-set-gateway-bind-tailnet-but-it-listens-only-on-loopback" />[I set gateway.bind tailnet but it listens only on loopback](/help/faq/gateway-ports-and-remote-mode#i-set-gateway-bind-tailnet-but-it-listens-only-on-loopback)
- <a id="can-i-run-multiple-gateways-on-the-same-host" />[Can I run multiple Gateways on the same host?](/help/faq/gateway-ports-and-remote-mode#can-i-run-multiple-gateways-on-the-same-host)
- <a id="what-does-invalid-handshake-code-1008-mean" />[What does "invalid handshake" / code 1008 mean?](/help/faq/gateway-ports-and-remote-mode#what-does-invalid-handshake-code-1008-mean)
- <a id="logging-and-debugging" />[Logging and debugging](/help/faq/logging-and-debugging#logging-and-debugging)
- <a id="where-are-logs" />[Where are logs?](/help/faq/logging-and-debugging#where-are-logs)
- <a id="how-do-i-start-stop-restart-the-gateway-service" />[How do I start/stop/restart the Gateway service?](/help/faq/logging-and-debugging#how-do-i-start-stop-restart-the-gateway-service)
- <a id="i-closed-my-terminal-on-windows-how-do-i-restart-openclaw" />[I closed my terminal on Windows - how do I restart OpenClaw?](/help/faq/logging-and-debugging#i-closed-my-terminal-on-windows-how-do-i-restart-openclaw)
- <a id="the-gateway-is-up-but-replies-never-arrive-what-should-i-check" />[The Gateway is up but replies never arrive. What should I check?](/help/faq/logging-and-debugging#the-gateway-is-up-but-replies-never-arrive-what-should-i-check)
- <a id="disconnected-from-gateway-no-reason-what-now" />["Disconnected from gateway: no reason" - what now?](/help/faq/logging-and-debugging#disconnected-from-gateway-no-reason-what-now)
- <a id="telegram-setmycommands-fails-what-should-i-check" />[Telegram setMyCommands fails. What should I check?](/help/faq/logging-and-debugging#telegram-setmycommands-fails-what-should-i-check)
- <a id="tui-shows-no-output-what-should-i-check" />[TUI shows no output. What should I check?](/help/faq/logging-and-debugging#tui-shows-no-output-what-should-i-check)
- <a id="how-do-i-completely-stop-then-start-the-gateway" />[How do I completely stop then start the Gateway?](/help/faq/logging-and-debugging#how-do-i-completely-stop-then-start-the-gateway)
- <a id="eli5-openclaw-gateway-restart-vs-openclaw-gateway" />[ELI5: openclaw gateway restart vs openclaw gateway](/help/faq/logging-and-debugging#eli5-openclaw-gateway-restart-vs-openclaw-gateway)
- <a id="fastest-way-to-get-more-details-when-something-fails" />[Fastest way to get more details when something fails](/help/faq/logging-and-debugging#fastest-way-to-get-more-details-when-something-fails)
- <a id="media-and-attachments" />[Media and attachments](/help/faq/media-and-attachments#media-and-attachments)
- <a id="my-skill-generated-an-image-pdf-but-nothing-was-sent" />[My skill generated an image/PDF, but nothing was sent](/help/faq/media-and-attachments#my-skill-generated-an-image-pdf-but-nothing-was-sent)
- <a id="security-and-access-control" />[Security and access control](/help/faq/security-and-access-control#security-and-access-control)
- <a id="is-it-safe-to-expose-openclaw-to-inbound-dms" />[Is it safe to expose OpenClaw to inbound DMs?](/help/faq/security-and-access-control#is-it-safe-to-expose-openclaw-to-inbound-dms)
- <a id="is-prompt-injection-only-a-concern-for-public-bots" />[Is prompt injection only a concern for public bots?](/help/faq/security-and-access-control#is-prompt-injection-only-a-concern-for-public-bots)
- <a id="is-openclaw-less-safe-because-it-uses-typescript-node-instead-of-rust-wasm" />[Is OpenClaw less safe because it uses TypeScript/Node instead of Rust/WASM?](/help/faq/security-and-access-control#is-openclaw-less-safe-because-it-uses-typescript-node-instead-of-rust-wasm)
- <a id="i-saw-reports-about-exposed-openclaw-instances-what-should-i-check" />[I saw reports about exposed OpenClaw instances. What should I check?](/help/faq/security-and-access-control#i-saw-reports-about-exposed-openclaw-instances-what-should-i-check)
- <a id="are-clawhub-skills-and-third-party-plugins-safe-to-install" />[Are ClawHub skills and third-party plugins safe to install?](/help/faq/security-and-access-control#are-clawhub-skills-and-third-party-plugins-safe-to-install)
- <a id="should-my-bot-have-its-own-email-github-account-or-phone-number" />[Should my bot have its own email, GitHub account, or phone number?](/help/faq/security-and-access-control#should-my-bot-have-its-own-email-github-account-or-phone-number)
- <a id="can-i-give-it-autonomy-over-my-text-messages-and-is-that-safe" />[Can I give it autonomy over my text messages and is that safe?](/help/faq/security-and-access-control#can-i-give-it-autonomy-over-my-text-messages-and-is-that-safe)
- <a id="can-i-use-cheaper-models-for-personal-assistant-tasks" />[Can I use cheaper models for personal assistant tasks?](/help/faq/security-and-access-control#can-i-use-cheaper-models-for-personal-assistant-tasks)
- <a id="i-ran-start-in-telegram-but-did-not-get-a-pairing-code" />[I ran /start in Telegram but did not get a pairing code](/help/faq/security-and-access-control#i-ran-start-in-telegram-but-did-not-get-a-pairing-code)
- <a id="whatsapp-will-it-message-my-contacts-how-does-pairing-work" />[WhatsApp: will it message my contacts? How does pairing work?](/help/faq/security-and-access-control#whatsapp-will-it-message-my-contacts-how-does-pairing-work)
- <a id="chat-commands%2C-aborting-tasks%2C-and-%22it-will-not-stop%22" /><a id="chat-commands-aborting-tasks-and-it-will-not-stop" />[Chat commands, aborting tasks, and "it will not stop"](/help/faq/chat-commands-and-stopping#chat-commands-aborting-tasks-and-it-will-not-stop)
- <a id="how-do-i-stop-internal-system-messages-from-showing-in-chat" />[How do I stop internal system messages from showing in chat?](/help/faq/chat-commands-and-stopping#how-do-i-stop-internal-system-messages-from-showing-in-chat)
- <a id="how-do-i-stop-cancel-a-running-task" />[How do I stop/cancel a running task?](/help/faq/chat-commands-and-stopping#how-do-i-stop-cancel-a-running-task)
- <a id="how-do-i-send-a-discord-message-from-telegram-cross-context-messaging-denied" />[How do I send a Discord message from Telegram? ("Cross-context messaging denied")](/help/faq/chat-commands-and-stopping#how-do-i-send-a-discord-message-from-telegram-cross-context-messaging-denied)
- <a id="why-does-it-feel-like-the-bot-ignores-rapid-fire-messages" />[Why does it feel like the bot "ignores" rapid-fire messages?](/help/faq/chat-commands-and-stopping#why-does-it-feel-like-the-bot-ignores-rapid-fire-messages)

## Related

- [First-run FAQ](/help/faq-first-run) - install, onboard, auth, subscriptions, early failures
- [Models FAQ](/help/faq-models) - model selection, failover, auth profiles
- [Troubleshooting](/help/troubleshooting) - symptom-first triage
