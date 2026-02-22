---
summary: "OpenClaw ကို တပ်ဆင်ခြင်း၊ ဖွဲ့စည်းပြင်ဆင်ခြင်းနှင့် အသုံးပြုနည်းများအကြောင်း မေးလေ့ရှိသော မေးခွန်းများ"
title: "FAQ"
---

# FAQ

လက်တွေ့အသုံးချ setup များအတွက် (local dev, VPS, multi-agent, OAuth/API keys, model failover) အမြန်အဖြေများနှင့် ပိုမိုနက်ရှိုင်းသော troubleshooting များ။ runtime diagnostics အတွက် [Troubleshooting](/gateway/troubleshooting) ကို ကြည့်ပါ။ config အပြည့်အစုံအတွက် [Configuration](/gateway/configuration) ကို ကြည့်ပါ။

## အကြောင်းအရာဇယား

- [Quick start and first-run setup]
  - [Im stuck whats the fastest way to get unstuck?](#im-stuck-whats-the-fastest-way-to-get-unstuck)
  - [What's the recommended way to install and set up OpenClaw?](#whats-the-recommended-way-to-install-and-set-up-openclaw)
  - [How do I open the dashboard after onboarding?](#how-do-i-open-the-dashboard-after-onboarding)
  - [How do I authenticate the dashboard (token) on localhost vs remote?](#how-do-i-authenticate-the-dashboard-token-on-localhost-vs-remote)
  - [What runtime do I need?](#what-runtime-do-i-need)
  - [Does it run on Raspberry Pi?](#does-it-run-on-raspberry-pi)
  - [Any tips for Raspberry Pi installs?](#any-tips-for-raspberry-pi-installs)
  - ["wake up my friend" မှာပဲ ပိတ်မိနေပြီး onboarding မဖွင့်နိုင်ပါ။ ဘာလုပ်ရမလဲ?](#it-is-stuck-on-wake-up-my-friend-onboarding-will-not-hatch-what-now)
  - [Can I migrate my setup to a new machine (Mac mini) without redoing onboarding?](#can-i-migrate-my-setup-to-a-new-machine-mac-mini-without-redoing-onboarding)
  - [Where do I see what is new in the latest version?](#where-do-i-see-what-is-new-in-the-latest-version)
  - [I can't access docs.openclaw.ai (SSL error). What now?](#i-cant-access-docsopenclawai-ssl-error-what-now)
  - [What's the difference between stable and beta?](#whats-the-difference-between-stable-and-beta)
  - [How do I install the beta version, and what's the difference between beta and dev?](#how-do-i-install-the-beta-version-and-whats-the-difference-between-beta-and-dev)
  - [How do I try the latest bits?](#how-do-i-try-the-latest-bits)
  - [How long does install and onboarding usually take?](#how-long-does-install-and-onboarding-usually-take)
  - [Installer stuck? How do I get more feedback?](#installer-stuck-how-do-i-get-more-feedback)
  - [Windows install says git not found or openclaw not recognized](#windows-install-says-git-not-found-or-openclaw-not-recognized)
  - [The docs didn't answer my question - how do I get a better answer?](#the-docs-didnt-answer-my-question-how-do-i-get-a-better-answer)
  - [How do I install OpenClaw on Linux?](#how-do-i-install-openclaw-on-linux)
  - [How do I install OpenClaw on a VPS?](#how-do-i-install-openclaw-on-a-vps)
  - [Where are the cloud/VPS install guides?](#where-are-the-cloudvps-install-guides)
  - [Can I ask OpenClaw to update itself?](#can-i-ask-openclaw-to-update-itself)
  - [What does the onboarding wizard actually do?](#what-does-the-onboarding-wizard-actually-do)
  - [Do I need a Claude or OpenAI subscription to run this?](#do-i-need-a-claude-or-openai-subscription-to-run-this)
  - [Can I use Claude Max subscription without an API key](#can-i-use-claude-max-subscription-without-an-api-key)
  - [How does Anthropic "setup-token" auth work?](#how-does-anthropic-setuptoken-auth-work)
  - [Where do I find an Anthropic setup-token?](#where-do-i-find-an-anthropic-setuptoken)
  - [Do you support Claude subscription auth (Claude Pro or Max)?](#do-you-support-claude-subscription-auth-claude-pro-or-max)
  - [Why am I seeing `HTTP 429: rate_limit_error` from Anthropic?](#why-am-i-seeing-http-429-ratelimiterror-from-anthropic)
  - [Is AWS Bedrock supported?](#is-aws-bedrock-supported)
  - [How does Codex auth work?](#how-does-codex-auth-work)
  - [Do you support OpenAI subscription auth (Codex OAuth)?](#do-you-support-openai-subscription-auth-codex-oauth)
  - [How do I set up Gemini CLI OAuth](#how-do-i-set-up-gemini-cli-oauth)
  - [Is a local model OK for casual chats?](#is-a-local-model-ok-for-casual-chats)
  - [How do I keep hosted model traffic in a specific region?](#how-do-i-keep-hosted-model-traffic-in-a-specific-region)
  - [Do I have to buy a Mac Mini to install this?](#do-i-have-to-buy-a-mac-mini-to-install-this)
  - [Do I need a Mac mini for iMessage support?](#do-i-need-a-mac-mini-for-imessage-support)
  - [If I buy a Mac mini to run OpenClaw, can I connect it to my MacBook Pro?](#if-i-buy-a-mac-mini-to-run-openclaw-can-i-connect-it-to-my-macbook-pro)
  - [Can I use Bun?](#can-i-use-bun)
  - [Telegram: what goes in `allowFrom`?](#telegram-what-goes-in-allowfrom)
  - [Can multiple people use one WhatsApp number with different OpenClaw instances?](#can-multiple-people-use-one-whatsapp-number-with-different-openclaw-instances)
  - [Can I run a "fast chat" agent and an "Opus for coding" agent?](#can-i-run-a-fast-chat-agent-and-an-opus-for-coding-agent)
  - [Does Homebrew work on Linux?](#does-homebrew-work-on-linux)
  - [What's the difference between the hackable (git) install and npm install?](#whats-the-difference-between-the-hackable-git-install-and-npm-install)
  - [Can I switch between npm and git installs later?](#can-i-switch-between-npm-and-git-installs-later)
  - [Should I run the Gateway on my laptop or a VPS?](#should-i-run-the-gateway-on-my-laptop-or-a-vps)
  - [How important is it to run OpenClaw on a dedicated machine?](#how-important-is-it-to-run-openclaw-on-a-dedicated-machine)
  - [What are the minimum VPS requirements and recommended OS?](#what-are-the-minimum-vps-requirements-and-recommended-os)
  - [Can I run OpenClaw in a VM and what are the requirements](#can-i-run-openclaw-in-a-vm-and-what-are-the-requirements)
- [What is OpenClaw?](#what-is-openclaw)
  - [What is OpenClaw, in one paragraph?](#what-is-openclaw-in-one-paragraph)
  - [What's the value proposition?](#whats-the-value-proposition)
  - [I just set it up what should I do first](#i-just-set-it-up-what-should-i-do-first)
  - [What are the top five everyday use cases for OpenClaw](#what-are-the-top-five-everyday-use-cases-for-openclaw)
  - [Can OpenClaw help with lead gen outreach ads and blogs for a SaaS](#can-openclaw-help-with-lead-gen-outreach-ads-and-blogs-for-a-saas)
  - [What are the advantages vs Claude Code for web development?](#what-are-the-advantages-vs-claude-code-for-web-development)
- [Skills and automation](#skills-and-automation)
  - [How do I customize skills without keeping the repo dirty?](#how-do-i-customize-skills-without-keeping-the-repo-dirty)
  - [Can I load skills from a custom folder?](#can-i-load-skills-from-a-custom-folder)
  - [How can I use different models for different tasks?](#how-can-i-use-different-models-for-different-tasks)
  - [The bot freezes while doing heavy work. How do I offload that?](#the-bot-freezes-while-doing-heavy-work-how-do-i-offload-that)
  - [Cron or reminders do not fire. What should I check?](#cron-or-reminders-do-not-fire-what-should-i-check)
  - [How do I install skills on Linux?](#how-do-i-install-skills-on-linux)
  - [Can OpenClaw run tasks on a schedule or continuously in the background?](#can-openclaw-run-tasks-on-a-schedule-or-continuously-in-the-background)
  - [Can I run Apple macOS-only skills from Linux?](#can-i-run-apple-macos-only-skills-from-linux)
  - [Do you have a Notion or HeyGen integration?](#do-you-have-a-notion-or-heygen-integration)
  - [How do I install the Chrome extension for browser takeover?](#how-do-i-install-the-chrome-extension-for-browser-takeover)
- [Sandboxing and memory](#sandboxing-and-memory)
  - [Is there a dedicated sandboxing doc?](#is-there-a-dedicated-sandboxing-doc)
  - [How do I bind a host folder into the sandbox?](#how-do-i-bind-a-host-folder-into-the-sandbox)
  - [How does memory work?](#how-does-memory-work)
  - [Memory keeps forgetting things. How do I make it stick?](#memory-keeps-forgetting-things-how-do-i-make-it-stick)
  - [Does memory persist forever? What are the limits?](#does-memory-persist-forever-what-are-the-limits)
  - [Does semantic memory search require an OpenAI API key?](#does-semantic-memory-search-require-an-openai-api-key)
- [Where things live on disk](#where-things-live-on-disk)
  - [Is all data used with OpenClaw saved locally?](#is-all-data-used-with-openclaw-saved-locally)
  - [Where does OpenClaw store its data?](#where-does-openclaw-store-its-data)
  - [Where should AGENTS.md / SOUL.md / USER.md / MEMORY.md live?](#where-should-agentsmd-soulmd-usermd-memorymd-live)
  - [What's the recommended backup strategy?](#whats-the-recommended-backup-strategy)
  - [How do I completely uninstall OpenClaw?](#how-do-i-completely-uninstall-openclaw)
  - [Can agents work outside the workspace?](#can-agents-work-outside-the-workspace)
  - [I'm in remote mode - where is the session store?](#im-in-remote-mode-where-is-the-session-store)
- [Config basics](#config-basics)
  - [What format is the config? Where is it?](#what-format-is-the-config-where-is-it)
  - [I set `gateway.bind: "lan"` (or `"tailnet"`) and now nothing listens / the UI says unauthorized](#i-set-gatewaybind-lan-or-tailnet-and-now-nothing-listens-the-ui-says-unauthorized)
  - [Why do I need a token on localhost now?](#why-do-i-need-a-token-on-localhost-now)
  - [Do I have to restart after changing config?](#do-i-have-to-restart-after-changing-config)
  - [How do I enable web search (and web fetch)?](#how-do-i-enable-web-search-and-web-fetch)
  - [config.apply wiped my config. How do I recover and avoid this?](#configapply-wiped-my-config-how-do-i-recover-and-avoid-this)
  - [How do I run a central Gateway with specialized workers across devices?](#how-do-i-run-a-central-gateway-with-specialized-workers-across-devices)
  - [Can the OpenClaw browser run headless?](#can-the-openclaw-browser-run-headless)
  - [How do I use Brave for browser control?](#how-do-i-use-brave-for-browser-control)
- [Remote gateways and nodes](#remote-gateways-and-nodes)
  - [How do commands propagate between Telegram, the gateway, and nodes?](#how-do-commands-propagate-between-telegram-the-gateway-and-nodes)
  - [How can my agent access my computer if the Gateway is hosted remotely?](#how-can-my-agent-access-my-computer-if-the-gateway-is-hosted-remotely)
  - [Tailscale is connected but I get no replies. What now?](#tailscale-is-connected-but-i-get-no-replies-what-now)
  - [Can two OpenClaw instances talk to each other (local + VPS)?](#can-two-openclaw-instances-talk-to-each-other-local-vps)
  - [Do I need separate VPSes for multiple agents](#do-i-need-separate-vpses-for-multiple-agents)
  - [Is there a benefit to using a node on my personal laptop instead of SSH from a VPS?](#is-there-a-benefit-to-using-a-node-on-my-personal-laptop-instead-of-ssh-from-a-vps)
  - [Do nodes run a gateway service?](#do-nodes-run-a-gateway-service)
  - [Is there an API / RPC way to apply config?](#is-there-an-api-rpc-way-to-apply-config)
  - [What's a minimal "sane" config for a first install?](#whats-a-minimal-sane-config-for-a-first-install)
  - [How do I set up Tailscale on a VPS and connect from my Mac?](#how-do-i-set-up-tailscale-on-a-vps-and-connect-from-my-mac)
  - [How do I connect a Mac node to a remote Gateway (Tailscale Serve)?](#how-do-i-connect-a-mac-node-to-a-remote-gateway-tailscale-serve)
  - [Should I install on a second laptop or just add a node?](#should-i-install-on-a-second-laptop-or-just-add-a-node)
- [Env vars and .env loading](#env-vars-and-env-loading)
  - [How does OpenClaw load environment variables?](#how-does-openclaw-load-environment-variables)
  - ["I started the Gateway via the service and my env vars disappeared." What now?](#i-started-the-gateway-via-the-service-and-my-env-vars-disappeared-what-now)
  - [I set `COPILOT_GITHUB_TOKEN`, but models status shows "Shell env: off." Why?](#i-set-copilotgithubtoken-but-models-status-shows-shell-env-off-why)
- [Sessions and multiple chats](#sessions-and-multiple-chats)
  - [How do I start a fresh conversation?](#how-do-i-start-a-fresh-conversation)
  - [Do sessions reset automatically if I never send `/new`?](#do-sessions-reset-automatically-if-i-never-send-new)
  - [Is there a way to make a team of OpenClaw instances one CEO and many agents](#is-there-a-way-to-make-a-team-of-openclaw-instances-one-ceo-and-many-agents)
  - [Why did context get truncated mid-task? How do I prevent it?](#why-did-context-get-truncated-midtask-how-do-i-prevent-it)
  - [How do I completely reset OpenClaw but keep it installed?](#how-do-i-completely-reset-openclaw-but-keep-it-installed)
  - [I'm getting "context too large" errors - how do I reset or compact?](#im-getting-context-too-large-errors-how-do-i-reset-or-compact)
  - [Why am I seeing "LLM request rejected: messages.N.content.X.tool_use.input: Field required"?](#why-am-i-seeing-llm-request-rejected-messagesncontentxtooluseinput-field-required)
  - [Why am I getting heartbeat messages every 30 minutes?](#why-am-i-getting-heartbeat-messages-every-30-minutes)
  - [Do I need to add a "bot account" to a WhatsApp group?](#do-i-need-to-add-a-bot-account-to-a-whatsapp-group)
  - [How do I get the JID of a WhatsApp group?](#how-do-i-get-the-jid-of-a-whatsapp-group)
  - [Why doesn't OpenClaw reply in a group?](#why-doesnt-openclaw-reply-in-a-group)
  - [Do groups/threads share context with DMs?](#do-groupsthreads-share-context-with-dms)
  - [How many workspaces and agents can I create?](#how-many-workspaces-and-agents-can-i-create)
  - [Can I run multiple bots or chats at the same time (Slack), and how should I set that up?](#can-i-run-multiple-bots-or-chats-at-the-same-time-slack-and-how-should-i-set-that-up)
- [Models: defaults, selection, aliases, switching](#models-defaults-selection-aliases-switching)
  - [What is the "default model"?](#what-is-the-default-model)
  - [What model do you recommend?](#what-model-do-you-recommend)
  - [How do I switch models without wiping my config?](#how-do-i-switch-models-without-wiping-my-config)
  - [Can I use self-hosted models (llama.cpp, vLLM, Ollama)?](#can-i-use-selfhosted-models-llamacpp-vllm-ollama)
  - [What do OpenClaw, Flawd, and Krill use for models?](#what-do-openclaw-flawd-and-krill-use-for-models)
  - [How do I switch models on the fly (without restarting)?](#how-do-i-switch-models-on-the-fly-without-restarting)
  - [Can I use GPT 5.2 for daily tasks and Codex 5.3 for coding](#can-i-use-gpt-52-for-daily-tasks-and-codex-53-for-coding)
  - [Why do I see "Model … is not allowed" and then no reply?](#why-do-i-see-model-is-not-allowed-and-then-no-reply)
  - [Why do I see "Unknown model: minimax/MiniMax-M2.1"?](#why-do-i-see-unknown-model-minimaxminimaxm21)
  - [Can I use MiniMax as my default and OpenAI for complex tasks?](#can-i-use-minimax-as-my-default-and-openai-for-complex-tasks)
  - [Are opus / sonnet / gpt built-in shortcuts?](#are-opus-sonnet-gpt-builtin-shortcuts)
  - [How do I define/override model shortcuts (aliases)?](#how-do-i-defineoverride-model-shortcuts-aliases)
  - [How do I add models from other providers like OpenRouter or Z.AI?](#how-do-i-add-models-from-other-providers-like-openrouter-or-zai)
- [Model failover and "All models failed"](#model-failover-and-all-models-failed)
  - [How does failover work?](#how-does-failover-work)
  - [What does this error mean?](#what-does-this-error-mean)
  - [Fix checklist for `No credentials found for profile "anthropic:default"`](#fix-checklist-for-no-credentials-found-for-profile-anthropicdefault)
  - [Why did it also try Google Gemini and fail?](#why-did-it-also-try-google-gemini-and-fail)
- [Auth profiles: what they are and how to manage them](#auth-profiles-what-they-are-and-how-to-manage-them)
  - [What is an auth profile?](#what-is-an-auth-profile)
  - [What are typical profile IDs?](#what-are-typical-profile-ids)
  - [Can I control which auth profile is tried first?](#can-i-control-which-auth-profile-is-tried-first)
  - [OAuth vs API key: what's the difference?](#oauth-vs-api-key-whats-the-difference)
- [Gateway: ports, "already running", and remote mode](#gateway-ports-already-running-and-remote-mode)
  - [What port does the Gateway use?](#what-port-does-the-gateway-use)
  - [Why does `openclaw gateway status` say `Runtime: running` but `RPC probe: failed`?](#why-does-openclaw-gateway-status-say-runtime-running-but-rpc-probe-failed)
  - [Why does `openclaw gateway status` show `Config (cli)` and `Config (service)` different?](#why-does-openclaw-gateway-status-show-config-cli-and-config-service-different)
  - [What does "another gateway instance is already listening" mean?](#what-does-another-gateway-instance-is-already-listening-mean)
  - [How do I run OpenClaw in remote mode (client connects to a Gateway elsewhere)?](#how-do-i-run-openclaw-in-remote-mode-client-connects-to-a-gateway-elsewhere)
  - Control UI တွင် "unauthorized" ဟု ပြသပါသလား (သို့မဟုတ် အမြဲပြန်လည်ချိတ်ဆက်နေပါသလား)။
    What now?
  - [I set `gateway.bind: "tailnet"` but it can't bind / nothing listens](#i-set-gatewaybind-tailnet-but-it-cant-bind-nothing-listens)
  - [Can I run multiple Gateways on the same host?](#can-i-run-multiple-gateways-on-the-same-host)
  - [What does "invalid handshake" / code 1008 mean?](#what-does-invalid-handshake-code-1008-mean)
- [Logging and debugging](#logging-and-debugging)
  - [Where are logs?](#where-are-logs)
  - [How do I start/stop/restart the Gateway service?](#how-do-i-startstoprestart-the-gateway-service)
  - [I closed my terminal on Windows - how do I restart OpenClaw?](#i-closed-my-terminal-on-windows-how-do-i-restart-openclaw)
  - [The Gateway is up but replies never arrive. ဘာကို စစ်ဆေးသင့်ပါသလဲ?](#the-gateway-is-up-but-replies-never-arrive-what-should-i-check)
  - ["Disconnected from gateway: no reason" - what now?](#disconnected-from-gateway-no-reason-what-now)
  - [Telegram setMyCommands fails with network errors. What should I check?](#telegram-setmycommands-fails-with-network-errors-what-should-i-check)
  - [TUI shows no output. What should I check?](#tui-shows-no-output-what-should-i-check)
  - [How do I completely stop then start the Gateway?](#how-do-i-completely-stop-then-start-the-gateway)
  - [ELI5: `openclaw gateway restart` vs `openclaw gateway`](#eli5-openclaw-gateway-restart-vs-openclaw-gateway)
  - [What's the fastest way to get more details when something fails?](#whats-the-fastest-way-to-get-more-details-when-something-fails)
- [Media and attachments](#media-and-attachments)
  - [My skill generated an image/PDF, but nothing was sent](#my-skill-generated-an-imagepdf-but-nothing-was-sent)
- [Security and access control](#security-and-access-control)
  - [Is it safe to expose OpenClaw to inbound DMs?](#is-it-safe-to-expose-openclaw-to-inbound-dms)
  - [Is prompt injection only a concern for public bots?](#is-prompt-injection-only-a-concern-for-public-bots)
  - [Should my bot have its own email GitHub account or phone number](#should-my-bot-have-its-own-email-github-account-or-phone-number)
  - [Can I give it autonomy over my text messages and is that safe](#can-i-give-it-autonomy-over-my-text-messages-and-is-that-safe)
  - [Can I use cheaper models for personal assistant tasks?](#can-i-use-cheaper-models-for-personal-assistant-tasks)
  - [I ran `/start` in Telegram but didn't get a pairing code](#i-ran-start-in-telegram-but-didnt-get-a-pairing-code)
  - [WhatsApp: will it message my contacts? How does pairing work?](#whatsapp-will-it-message-my-contacts-how-does-pairing-work)
- [Chat commands, aborting tasks, and "it won't stop"](#chat-commands-aborting-tasks-and-it-wont-stop)
  - [How do I stop internal system messages from showing in chat](#how-do-i-stop-internal-system-messages-from-showing-in-chat)
  - [How do I stop/cancel a running task?](#how-do-i-stopcancel-a-running-task)
  - [How do I send a Discord message from Telegram? ("Cross-context messaging denied")](#how-do-i-send-a-discord-message-from-telegram-crosscontext-messaging-denied)
  - [Why does it feel like the bot "ignores" rapid-fire messages?](#why-does-it-feel-like-the-bot-ignores-rapidfire-messages)

## First 60 seconds if something's broken

1. **အမြန်အခြေအနေ (ပထမစစ်ဆေးရန်)**

   ```bash
   openclaw status
   ```

   အမြန် local အကျဉ်းချုပ်: OS + update, gateway/service ရရှိနိုင်မှု, agents/sessions, provider config + runtime ပြဿနာများ (gateway ရရှိနိုင်ပါက)။

2. **မျှဝေနိုင်သော အစီရင်ခံစာ (အန္တရာယ်ကင်း)**

   ```bash
   openclaw status --all
   ```

   Read-only စစ်ဆေးချက်နှင့် log tail (tokens မပါဝင်)။

3. **Daemon + port အခြေအနေ**

   ```bash
   openclaw gateway status
   ```

   Supervisor runtime နှင့် RPC ရရှိနိုင်မှု၊ probe target URL နှင့် service သုံးထားနိုင်သည့် config ကိုပြသည်။

4. **နက်ရှိုင်းသော စစ်ဆေးမှုများ**

   ```bash
   openclaw status --deep
   ```

   Runs gateway health checks + provider probes (requires a reachable gateway). See [Health](/gateway/health).

5. **နောက်ဆုံး log ကို tail လုပ်ရန်**

   ```bash
   openclaw logs --follow
   ```

   RPC မရပါက အစားထိုးအသုံးပြုပါ—

   ```bash
   tail -f "$(ls -t /tmp/openclaw/openclaw-*.log | head -1)"
   ```

   File logs သည် service logs နှင့် သီးခြားဖြစ်သည်; [Logging](/logging) နှင့် [Troubleshooting](/gateway/troubleshooting) ကိုကြည့်ပါ။

6. **Doctor ကို run လုပ်ရန် (ပြုပြင်ခြင်း)**

   ```bash
   openclaw doctor
   ```

   Repairs/migrates config/state + runs health checks. See [Doctor](/gateway/doctor).

7. **Gateway snapshot**

   ```bash
   openclaw health --json
   openclaw health --verbose   # shows the target URL + config path on errors
   ```

   Asks the running gateway for a full snapshot (WS-only). See [Health](/gateway/health).

## Quick start and first-run setup

### Im stuck whats the fastest way to get unstuck

Use a local AI agent that can **see your machine**. That is far more effective than asking
in Discord, because most "I'm stuck" cases are **local config or environment issues** that
remote helpers cannot inspect.

- **Claude Code**: [https://www.anthropic.com/claude-code/](https://www.anthropic.com/claude-code/)
- **OpenAI Codex**: [https://openai.com/codex/](https://openai.com/codex/)

These tools can read the repo, run commands, inspect logs, and help fix your machine-level
setup (PATH, services, permissions, auth files). Give them the **full source checkout** via
the hackable (git) install:

```bash
curl -fsSL https://openclaw.ai/install.sh | bash -s -- --install-method git
```

This installs OpenClaw **from a git checkout**, so the agent can read the code + docs and
reason about the exact version you are running. You can always switch back to stable later
by re-running the installer without `--install-method git`.

1. အကြံပြုချက်: ပြင်ဆင်မှုကို **အစီအစဉ်ချပြီး စောင့်ကြည့်စစ်ဆေး** (အဆင့်လိုက်) ခိုင်းစေပြီး၊ ထို့နောက် လိုအပ်သည့် command များကိုသာ အကောင်အထည်ဖော်ပါ။ 2. အဲဒီလိုလုပ်ခြင်းက ပြောင်းလဲမှုတွေကို သေးငယ်စေပြီး စစ်ဆေးရလွယ်ကူစေပါတယ်။

တကယ့် bug သို့မဟုတ် fix ကို တွေ့ရှိပါက GitHub issue တင်ပါ သို့မဟုတ် PR ပို့ပါ—
[https://github.com/openclaw/openclaw/issues](https://github.com/openclaw/openclaw/issues)
[https://github.com/openclaw/openclaw/pulls](https://github.com/openclaw/openclaw/pulls)

အကူအညီတောင်းသည့်အခါ output များကို မျှဝေရန် အောက်ပါ commands များဖြင့် စတင်ပါ—

```bash
openclaw status
openclaw models status
openclaw doctor
```

၎င်းတို့၏ လုပ်ဆောင်ချက်များ—

- `openclaw status`: gateway/agent health + အခြေခံ config ကို အမြန် snapshot ရယူသည်။
- `openclaw models status`: provider auth + model ရရှိနိုင်မှုကို စစ်ဆေးသည်။
- `openclaw doctor`: အများဆုံးတွေ့ရသော config/state ပြဿနာများကို စစ်ဆေးပြီး ပြုပြင်သည်။

အသုံးဝင်သော CLI စစ်ဆေးချက်များ— `openclaw status --all`, `openclaw logs --follow`,
`openclaw gateway status`, `openclaw health --verbose`။

3. အမြန် debug လုပ်ရန်: [တစ်ခုခု ပျက်နေတယ်ဆိုရင် ပထမ ၆၀ စက္ကန့်](#first-60-seconds-if-somethings-broken)။
4. Install စာရွက်စာတမ်းများ: [Install](/install), [Installer flags](/install/installer), [Updating](/install/updating)။

### 5. OpenClaw ကို install လုပ်ပြီး set up လုပ်ရန် အကြံပြုထားသော နည်းလမ်းက ဘာလဲ

6. repo မှ source မှ run လုပ်ပြီး onboarding wizard ကို အသုံးပြုရန် အကြံပြုထားပါတယ်:

```bash
7. curl -fsSL https://openclaw.ai/install.sh | bash
openclaw onboard --install-daemon
```

8. wizard က UI assets တွေကိုလည်း အလိုအလျောက် build လုပ်ပေးနိုင်ပါတယ်။ 9. onboarding ပြီးသွားပြီးနောက် သင်က Gateway ကို ပုံမှန်အားဖြင့် port **18789** ပေါ်မှာ run လုပ်ပါလိမ့်မယ်။

9. Source မှ (contributors/dev များအတွက်):

```bash
11. git clone https://github.com/openclaw/openclaw.git
cd openclaw
pnpm install
pnpm build
pnpm ui:build # auto-installs UI deps on first run
openclaw onboard
```

12. အကယ်၍ global install မရှိသေးပါက `pnpm openclaw onboard` နဲ့ run လုပ်ပါ။

### 13. onboarding ပြီးပြီးနောက် dashboard ကို ဘယ်လိုဖွင့်ရမလဲ

14. wizard က onboarding ပြီးချင်း သင့် browser ကို clean (token မပါသော) dashboard URL နဲ့ အလိုအလျောက် ဖွင့်ပေးပြီး summary ထဲမှာလည်း လင့်ခ်ကို ပုံနှိပ်ပြထားပါတယ်။ 15. အဲဒီ tab ကို ဖွင့်ထားပါ; မဖွင့်လာခဲ့ရင် တူညီတဲ့ machine ပေါ်မှာ ပုံနှိပ်ပြထားတဲ့ URL ကို copy/paste လုပ်ပါ။

### 16. localhost နဲ့ remote အတွက် dashboard token ကို ဘယ်လို authenticate လုပ်ရမလဲ

17. **Localhost (တူညီတဲ့ machine):**

- 18. `http://127.0.0.1:18789/` ကို ဖွင့်ပါ။
- 19. auth တောင်းလာရင် `gateway.auth.token` (သို့မဟုတ် `OPENCLAW_GATEWAY_TOKEN`) ထဲက token ကို Control UI settings ထဲမှာ paste လုပ်ပါ။
- 20. gateway host ကနေ `openclaw config get gateway.auth.token` နဲ့ ရယူနိုင်ပါတယ် (သို့မဟုတ် `openclaw doctor --generate-gateway-token` နဲ့ generate လုပ်ပါ)။

21. **Localhost မဟုတ်ပါက:**

- 22. **Tailscale Serve** (အကြံပြု): loopback bind ကို ထားပြီး `openclaw gateway --tailscale serve` ကို run လုပ်ပါ၊ ပြီးရင် `https://<magicdns>/` ကို ဖွင့်ပါ။ `gateway.auth.allowTailscale` သည် `true` ဖြစ်ပါက identity headers များသည် auth ကို ဖြည့်ဆည်းပေးပါသည် (token မလိုအပ်)။
- 24. **Tailnet bind**: `openclaw gateway --bind tailnet --token "<token>"` ကို run လုပ်ပြီး `http://<tailscale-ip>:18789/` ကို ဖွင့်ပါ၊ ပြီးရင် dashboard settings ထဲမှာ token ကို paste လုပ်ပါ။
- 25. **SSH tunnel**: `ssh -N -L 18789:127.0.0.1:18789 user@host` ပြီးရင် `http://127.0.0.1:18789/` ကို ဖွင့်ပြီး Control UI settings ထဲမှာ token ကို paste လုပ်ပါ။

26. bind modes နဲ့ auth အသေးစိတ်များအတွက် [Dashboard](/web/dashboard) နဲ့ [Web surfaces](/web) ကို ကြည့်ပါ။

### 27. ဘယ် runtime လိုအပ်ပါသလဲ

28. Node **>= 22** လိုအပ်ပါတယ်။ 29. `pnpm` ကို အကြံပြုပါတယ်။ 30. Gateway အတွက် Bun ကို **မအကြံပြုပါ**။

### 31. Raspberry Pi ပေါ်မှာ run လုပ်နိုင်ပါသလား

Yes. 32. Gateway က ပေါ့ပါးပါတယ် — စာရွက်စာတမ်းတွေမှာ ကိုယ်ရေးကိုယ်တာ အသုံးအတွက် **512MB-1GB RAM**, **1 core**, နဲ့ disk **500MB** ခန့် လုံလောက်တယ်လို့ ဖော်ပြထားပြီး **Raspberry Pi 4 က run လုပ်နိုင်တယ်** လို့လည်း မှတ်ချက်ထားပါတယ်။

33. အပို headroom (logs, media, အခြား services) လိုချင်ရင် **2GB ကို အကြံပြုပါတယ်**၊ ဒါပေမယ့် အနည်းဆုံးလိုအပ်ချက် မဟုတ်ပါဘူး။

34. အကြံပြုချက်: Pi/VPS သေးသေးလေးတစ်ခုက Gateway ကို host လုပ်နိုင်ပြီး၊ သင့် laptop/phone ပေါ်မှာ **nodes** တွေကို pair လုပ်ပြီး local screen/camera/canvas သို့မဟုတ် command execution ကို အသုံးပြုနိုင်ပါတယ်။ 35. [Nodes](/nodes) ကို ကြည့်ပါ။

### 36. Raspberry Pi install အတွက် အကြံပြုချက်တွေ ရှိပါသလား

37. အကျဉ်းချုပ်: အလုပ်လုပ်ပါတယ်၊ ဒါပေမယ့် အခက်အခဲတွေ ရှိနိုင်ပါတယ်။

- 38. **64-bit** OS ကို သုံးပြီး Node >= 22 ကို ထိန်းသိမ်းထားပါ။
- 39. logs တွေကို ကြည့်နိုင်ပြီး အမြန် update လုပ်နိုင်ဖို့ **hackable (git) install** ကို ဦးစားပေးပါ။
- 40. channels/skills မပါဘဲ စတင်ပြီး တစ်ခုချင်းစီ ထည့်သွင်းပါ။
- 41. ထူးဆန်းတဲ့ binary ပြဿနာတွေ ကြုံရရင် အများအားဖြင့် **ARM compatibility** ပြဿနာ ဖြစ်တတ်ပါတယ်။

42. Docs: [Linux](/platforms/linux), [Install](/install)။

### 43. wake up my friend မှာ ပိတ်နေပြီး onboarding မ hatch လုပ်ပါဘူး — ဘာလုပ်ရမလဲ

44. အဲဒီ screen က Gateway ကို ရောက်နိုင်ပြီး authenticated ဖြစ်နေခြင်းပေါ် မူတည်ပါတယ်။ 45. TUI က ပထမဆုံး hatch မှာ
    "Wake up, my friend!" ကို အလိုအလျောက် ပို့ပါတယ်။ 46. အဲဒီစာကြောင်းကို **အဖြေမရှိဘဲ** တွေ့ရပြီး token တွေက 0 မှာပဲ ရှိနေရင် agent က မ run ဖြစ်ခဲ့ပါဘူး။

1. Gateway ကို ပြန်လည်စတင်ပါ:

```bash
openclaw gateway restart
```

2. 48. status + auth ကို စစ်ဆေးပါ:

```bash
49. openclaw status
openclaw models status
openclaw logs --follow
```

3. 50. မဆက်သွယ်နိုင်သေးရင် ဒီ command ကို run လုပ်ပါ:

```bash
openclaw doctor
```

1. Gateway က remote ဖြစ်နေရင် tunnel/Tailscale connection အလုပ်လုပ်နေကြောင်း သေချာစစ်ပြီး UI က Gateway မှန်ကို ညွှန်နေကြောင်း စစ်ဆေးပါ။ [Remote access](/gateway/remote) ကို ကြည့်ပါ။

### 2. onboarding ကို ပြန်မလုပ်ဘဲ Mac mini စက်အသစ်ကို ကျွန်တော့် setup ကို migrate လုပ်လို့ရမလား

Yes. 3. **state directory** နဲ့ **workspace** ကို copy လုပ်ပြီး Doctor ကို တစ်ခါ run လုပ်ပါ။ 4. ဒါက location နှစ်ခုလုံးကို copy လုပ်ထားသရွေ့ သင့် bot ကို "အတိအကျတူညီ" (memory, session history, auth, channel state) အဖြစ် ထိန်းထားပေးပါတယ်။

1. 5. စက်အသစ်ပေါ်မှာ OpenClaw ကို install လုပ်ပါ။
2. 6. စက်ဟောင်းကနေ `$OPENCLAW_STATE_DIR` (default: `~/.openclaw`) ကို copy လုပ်ပါ။
3. 7. သင့် workspace (default: `~/.openclaw/workspace`) ကို copy လုပ်ပါ။
4. 8. `openclaw doctor` ကို run လုပ်ပြီး Gateway service ကို restart လုပ်ပါ။

9) ဒါက config, auth profiles, WhatsApp creds, sessions နဲ့ memory ကို ထိန်းထားပေးပါတယ်။ 10. remote mode မှာဆိုရင် gateway host က session store နဲ့ workspace ကို ပိုင်ဆိုင်ထားတယ်ဆိုတာ သတိရပါ။

**အရေးကြီး:** workspace ကို GitHub သို့ commit/push လုပ်ထားပါက **memory + bootstrap files** ကိုသာ backup လုပ်ထားပြီး **session history သို့မဟုတ် auth** မပါဝင်ပါ။ 12. အဲဒါတွေက `~/.openclaw/` အောက်မှာ ရှိပါတယ် (ဥပမာ `~/.openclaw/agents/<agentId>/sessions/`)။

13. ဆက်စပ်: [Migrating](/install/migrating), [Where things live on disk](/help/faq#where-does-openclaw-store-its-data),
    [Agent workspace](/concepts/agent-workspace), [Doctor](/gateway/doctor),
    [Remote mode](/gateway/remote).

### 14. နောက်ဆုံး version မှာ အသစ်တွေကို ဘယ်မှာ ကြည့်ရမလဲ

GitHub changelog ကို စစ်ဆေးပါ:
[https://github.com/openclaw/openclaw/blob/main/CHANGELOG.md](https://github.com/openclaw/openclaw/blob/main/CHANGELOG.md)

16. နောက်ဆုံး entry တွေက အပေါ်ဆုံးမှာ ရှိပါတယ်။ 17. အပေါ်ဆုံး section ကို **Unreleased** လို့ မှတ်သားထားရင် နောက်ထပ် date ပါတဲ့ section က နောက်ဆုံး ထုတ်ထားတဲ့ version ဖြစ်ပါတယ်။ 18. Entry တွေကို **Highlights**, **Changes**, **Fixes** (လိုအပ်ရင် docs/other sections) အလိုက် စုထားပါတယ်။

### 19. docs.openclaw.ai ကို မဝင်နိုင်ပါဘူး SSL error တက်တယ် ဘာလုပ်ရမလဲ

20. Comcast/Xfinity connection တချို့က Xfinity Advanced Security ကြောင့် `docs.openclaw.ai` ကို မှားယွင်းစွာ block လုပ်ထားတတ်ပါတယ်။ 21. အဲဒါကို disable လုပ်ပါ ဒါမှမဟုတ် `docs.openclaw.ai` ကို allowlist ထဲထည့်ပြီး ပြန်ကြိုးစားပါ။ 22. အသေးစိတ်: [Troubleshooting](/help/troubleshooting#docsopenclawai-shows-an-ssl-error-comcastxfinity).
21. ဒီကို report လုပ်ပေးပြီး unblock ဖြစ်အောင် ကူညီပေးပါ: [https://spa.xfinity.com/check_url_status](https://spa.xfinity.com/check_url_status).

22. site ကို မရောက်သေးရင် docs တွေကို GitHub မှာ mirror လုပ်ထားပါတယ်:
    [https://github.com/openclaw/openclaw/tree/main/docs](https://github.com/openclaw/openclaw/tree/main/docs)

### 25. stable နဲ့ beta က ဘာကွာခြားလဲ

26. **Stable** နဲ့ **beta** က code line ခွဲထားတာ မဟုတ်ဘဲ **npm dist-tags** တွေပါ။

- 27. `latest` = stable
- 28. `beta` = စမ်းသပ်ဖို့ အစောပိုင်း build

29. build တွေကို **beta** ထဲ အရင်ထုတ်ပြီး စမ်းသပ်ပါတယ်၊ build က အဆင်ပြေရင် အဲဒီ version ကိုပဲ **`latest`** အဖြစ် promote လုပ်ပါတယ်။ 30. အဲ့ဒါကြောင့် beta နဲ့ stable က **တူညီတဲ့ version** ကို ညွှန်နေတာ ဖြစ်နိုင်ပါတယ်။

30. ဘာပြောင်းလဲသွားလဲ ကြည့်ရန်:
    [https://github.com/openclaw/openclaw/blob/main/CHANGELOG.md](https://github.com/openclaw/openclaw/blob/main/CHANGELOG.md)

### 32. beta version ကို ဘယ်လို install လုပ်ရမလဲ နဲ့ beta နဲ့ dev က ဘာကွာလဲ

33. **Beta** က npm dist-tag `beta` ပါ (တခါတလေ `latest` နဲ့ တူနိုင်ပါတယ်)။
34. **Dev** က `main` (git) ရဲ့ moving head ဖြစ်ပြီး publish လုပ်တဲ့အခါ npm dist-tag `dev` ကို သုံးပါတယ်။

One-liners (macOS/Linux):

```bash
36. curl -fsSL --proto '=https' --tlsv1.2 https://openclaw.ai/install.sh | bash -s -- --beta
```

```bash
37. curl -fsSL --proto '=https' --tlsv1.2 https://openclaw.ai/install.sh | bash -s -- --install-method git
```

38. Windows installer (PowerShell):
    [https://openclaw.ai/install.ps1](https://openclaw.ai/install.ps1)

39. အသေးစိတ်: [Development channels](/install/development-channels) နှင့် [Installer flags](/install/installer).

### 40. install နဲ့ onboarding က ပုံမှန်အားဖြင့် ဘယ်လောက်ကြာလဲ

41. ခန့်မှန်းလမ်းညွှန်:

- **Install:** ၂–၅ မိနစ်
- 43. **Onboarding:** channel/model ဘယ်လောက် configure လုပ်လဲပေါ်မူတည်ပြီး 5-15 မိနစ်

44. hang ဖြစ်နေရင် [Installer stuck](/help/faq#installer-stuck-how-do-i-get-more-feedback)
    နဲ့ [Im stuck](/help/faq#im-stuck--whats-the-fastest-way-to-get-unstuck) မှာ fast debug loop ကို သုံးပါ။

### 45. နောက်ဆုံး bits တွေကို ဘယ်လို စမ်းကြည့်ရမလဲ

ရွေးချယ်စရာ နှစ်ခု:

1. 47. **Dev channel (git checkout):**

```bash
48. openclaw update --channel dev
```

49. ဒါက `main` branch ကို ပြောင်းပြီး source ကနေ update လုပ်ပေးပါတယ်။

50. 50. **Hackable install (installer site မှ):**

```bash
curl -fsSL https://openclaw.ai/install.sh | bash -s -- --install-method git
```

That gives you a local repo you can edit, then update via git.

If you prefer a clean clone manually, use:

```bash
git clone https://github.com/openclaw/openclaw.git
cd openclaw
pnpm install
pnpm build
```

Docs: [Update](/cli/update), [Development channels](/install/development-channels),
[Install](/install).

### Installer stuck How do I get more feedback

Re-run the installer with **verbose output**:

```bash
curl -fsSL https://openclaw.ai/install.sh | bash -s -- --verbose
```

Beta install with verbose:

```bash
curl -fsSL https://openclaw.ai/install.sh | bash -s -- --beta --verbose
```

For a hackable (git) install:

```bash
curl -fsSL https://openclaw.ai/install.sh | bash -s -- --install-method git --verbose
```

More options: [Installer flags](/install/installer).

### Windows install says git not found or openclaw not recognized

Two common Windows issues:

**1) npm error spawn git / git not found**

- Install **Git for Windows** and make sure `git` is on your PATH.
- Close and reopen PowerShell, then re-run the installer.

**2) openclaw is not recognized after install**

- Your npm global bin folder is not on PATH.

- Check the path:

  ```powershell
  npm config get prefix
  ```

- Ensure `<prefix>\\bin` is on PATH (on most systems it is `%AppData%\\npm`).

- Close and reopen PowerShell after updating PATH.

If you want the smoothest Windows setup, use **WSL2** instead of native Windows.
Docs: [Windows](/platforms/windows).

### The docs didnt answer my question how do I get a better answer

Use the **hackable (git) install** so you have the full source and docs locally, then ask
your bot (or Claude/Codex) _from that folder_ so it can read the repo and answer precisely.

```bash
curl -fsSL https://openclaw.ai/install.sh | bash -s -- --install-method git
```

More detail: [Install](/install) and [Installer flags](/install/installer).

### How do I install OpenClaw on Linux

Short answer: follow the Linux guide, then run the onboarding wizard.

- Linux quick path + service install: [Linux](/platforms/linux).
- Full walkthrough: [Getting Started](/start/getting-started).
- Installer + updates: [Install & updates](/install/updating).

### How do I install OpenClaw on a VPS

Any Linux VPS works. Install on the server, then use SSH/Tailscale to reach the Gateway.

Guides: [exe.dev](/install/exe-dev), [Hetzner](/install/hetzner), [Fly.io](/install/fly).
Remote access: [Gateway remote](/gateway/remote).

### Where are the cloudVPS install guides

အများဆုံး အသုံးပြုနေသော provider များနှင့်အတူ **hosting hub** တစ်ခုကို ထားရှိထားသည်။ Pick one and follow the guide:

- [VPS hosting](/vps) (all providers in one place)
- [Fly.io](/install/fly)
- [Hetzner](/install/hetzner)
- [exe.dev](/install/exe-dev)

How it works in the cloud: the **Gateway runs on the server**, and you access it
from your laptop/phone via the Control UI (or Tailscale/SSH). Your state + workspace
live on the server, so treat the host as the source of truth and back it up.

You can pair **nodes** (Mac/iOS/Android/headless) to that cloud Gateway to access
local screen/camera/canvas or run commands on your laptop while keeping the
Gateway in the cloud.

Hub: [Platforms](/platforms). Remote access: [Gateway remote](/gateway/remote).
Nodes: [Nodes](/nodes), [Nodes CLI](/cli/nodes).

### 1. OpenClaw ကို ကိုယ်တိုင် update လုပ်ဖို့ တောင်းဆိုလို့ ရပါသလား

2. တိုတောင်းတဲ့ အဖြေ: **ဖြစ်နိုင်ပါတယ်၊ ဒါပေမယ့် မအကြံပြုပါ**။ 3. Update လုပ်တဲ့ လုပ်ငန်းစဉ်က Gateway ကို restart လုပ်နိုင်ပါတယ် (အလုပ်လုပ်နေတဲ့ session ပြတ်တောက်သွားနိုင်ပါတယ်)၊ clean git checkout လိုအပ်နိုင်ပြီး အတည်ပြုချက် တောင်းနိုင်ပါတယ်။ 4. ပိုပြီး လုံခြုံတာက operator အနေနဲ့ shell မှာတင် update လုပ်တာပါ။

3. CLI ကို သုံးပါ:

```bash
6. openclaw update
openclaw update status
openclaw update --channel stable|beta|dev
openclaw update --tag <dist-tag|version>
openclaw update --no-restart
```

7. Agent ကနေ အလိုအလျောက်လုပ်ရမယ်ဆိုရင်:

```bash
openclaw update --yes --no-restart
openclaw gateway restart
```

9. Docs: [Update](/cli/update), [Updating](/install/updating).

### 10. Onboarding wizard က တကယ် ဘာတွေ လုပ်ပေးသလဲ

11. `openclaw onboard` က အကြံပြုထားတဲ့ setup လမ်းကြောင်းပါ။ 12. **Local mode** မှာတော့ အောက်ပါအရာတွေကို အဆင့်ဆင့် လမ်းညွှန်ပေးပါတယ်:

- **Model/auth setup** (Claude subscription များအတွက် Anthropic **setup-token** ကို အကြံပြုပါသည်၊ OpenAI Codex OAuth ကို ထောက်ပံ့ထားသည်၊ API keys မဖြစ်မနေ မလိုအပ်ပါ၊ LM Studio local models ကိုလည်း ထောက်ပံ့ထားသည်)
- 14. **Workspace** တည်နေရာ + bootstrap files
- 15. **Gateway settings** (bind/port/auth/tailscale)
- 16. **Providers** (WhatsApp, Telegram, Discord, Mattermost (plugin), Signal, iMessage)
- 17. **Daemon install** (macOS မှာ LaunchAgent; Linux/WSL2 မှာ systemd user unit)
- 18. **Health checks** နဲ့ **skills** ရွေးချယ်မှု

19. သင့် configure လုပ်ထားတဲ့ model ကို မသိရှိရင် ဒါမှမဟုတ် auth မရှိရင်လည်း သတိပေးပါလိမ့်မယ်။

### 20. ဒါကို run ဖို့ Claude သို့မဟုတ် OpenAI subscription လိုအပ်ပါသလား

No. 21. OpenClaw ကို **API keys** (Anthropic/OpenAI/အခြား) နဲ့ သုံးနိုင်သလို **local-only models** နဲ့လည်း သုံးနိုင်ပြီး သင့်ဒေတာတွေကို ကိုယ်ပိုင်စက်ပေါ်မှာပဲ ထားနိုင်ပါတယ်။ 22. Subscriptions (Claude Pro/Max သို့မဟုတ် OpenAI Codex) က အဲဒီ provider တွေအတွက် authenticate လုပ်ဖို့ ရွေးချယ်စရာ နည်းလမ်းတွေ ဖြစ်ပြီး မဖြစ်မနေ မလိုအပ်ပါ။

23. Docs: [Anthropic](/providers/anthropic), [OpenAI](/providers/openai),
    [Local models](/gateway/local-models), [Models](/concepts/models).

### 24. API key မပါဘဲ Claude Max subscription ကို သုံးလို့ ရပါသလား

Yes. 25. API key အစား **setup-token** နဲ့ authenticate လုပ်နိုင်ပါတယ်။ 26. ဒါက subscription လမ်းကြောင်းပါ။

27. Claude Pro/Max subscriptions တွေမှာ **API key မပါဝင်ပါ**၊ ဒါကြောင့် subscription account တွေအတွက် ဒီနည်းလမ်းက မှန်ကန်ပါတယ်။ 28. အရေးကြီးချက်: ဒီအသုံးပြုမှုဟာ Anthropic ရဲ့ subscription policy နဲ့ စည်းမျဉ်းများအောက်မှာ ခွင့်ပြုထားတာ인지ကို Anthropic နဲ့ သေချာ အတည်ပြုရပါမယ်။
28. အလွန်ရှင်းလင်းပြီး support ရတဲ့ လမ်းကြောင်းကို လိုချင်ရင် Anthropic API key ကို သုံးပါ။

### 30. Anthropic setuptoken auth က ဘယ်လို အလုပ်လုပ်သလဲ

31. `claude setup-token` က Claude Code CLI ကနေ **token string** ကို ထုတ်ပေးပါတယ် (web console မှာ မရနိုင်ပါ)။ **မည်သည့် စက်ပေါ်တွင်မဆို** run လုပ်နိုင်ပါသည်။ 33. Wizard ထဲမှာ **Anthropic token (paste setup-token)** ကို ရွေးပါ သို့မဟုတ် `openclaw models auth paste-token --provider anthropic` နဲ့ paste လုပ်ပါ။ 34. ဒီ token ကို **anthropic** provider အတွက် auth profile အနေနဲ့ သိမ်းထားပြီး API key လိုပဲ အသုံးပြုပါတယ် (auto-refresh မရှိပါ)။ 35. ပိုမို အသေးစိတ်: [OAuth](/concepts/oauth).

### 36. Anthropic setuptoken ကို ဘယ်မှာ ရနိုင်ပါသလဲ

၎င်းသည် Anthropic Console ထဲတွင် **မရှိပါ**။ 38. Setup-token ကို **Claude Code CLI** က **ဘယ်စက်မှာမဆို** generate လုပ်ပေးပါတယ်:

```bash
claude setup-token
```

၎င်းထုတ်ပေးသော token ကို ကူးယူပြီး wizard ထဲတွင် **Anthropic token (paste setup-token)** ကို ရွေးချယ်ပါ။ gateway host ပေါ်တွင် run ချင်ပါက `openclaw models auth setup-token --provider anthropic` ကို အသုံးပြုပါ။ 41. `claude setup-token` ကို တခြားနေရာမှာ run လုပ်ပြီးသားဆိုရင် gateway host မှာ `openclaw models auth paste-token --provider anthropic` နဲ့ paste လုပ်ပါ။ 42. [Anthropic](/providers/anthropic) ကို ကြည့်ပါ။

### 43. Claude subscription auth (Claude Pro သို့မဟုတ် Max) ကို ထောက်ပံ့ပါသလား

44. ဟုတ်ပါတယ် - **setup-token** နဲ့ပါ။ 45. OpenClaw က Claude Code CLI OAuth tokens ကို ပြန်မသုံးတော့ပါဘူး; setup-token သို့မဟုတ် Anthropic API key ကို သုံးပါ။ 46. Token ကို ဘယ်နေရာမှာမဆို generate လုပ်ပြီး gateway host ပေါ်မှာ paste လုပ်ပါ။ 47. [Anthropic](/providers/anthropic) နဲ့ [OAuth](/concepts/oauth) ကို ကြည့်ပါ။

45. မှတ်ချက်: Claude subscription access ကို Anthropic ရဲ့ စည်းမျဉ်းများက ထိန်းချုပ်ထားပါတယ်။ 49. Production သို့မဟုတ် multi-user workloads အတွက်တော့ API keys ကို သုံးတာက ပိုပြီး လုံခြုံတတ်ပါတယ်။

### 50. Anthropic ကနေ HTTP 429 ratelimiterror ကို ဘာကြောင့် မြင်နေရတာလဲ

ဒါက လက်ရှိ window အတွက် သင်၏ **Anthropic quota/rate limit** ကို သုံးစွဲပြီးကုန်သွားပြီဆိုလိုပါတယ်။ **Claude subscription** (setup-token သို့မဟုတ် Claude Code OAuth) ကို အသုံးပြုနေပါက window ကို reset လုပ်သည့်အချိန် သို့မဟုတ် plan ကို upgrade လုပ်သည့်အချိန်အထိ စောင့်ပါ။ သင်က **Anthropic API key** ကို သုံးနေပါက Anthropic Console ထဲတွင် usage/billing ကို စစ်ဆေးပြီး လိုအပ်သလို limits ကို မြှင့်တင်ပါ။

အကြံပြုချက်: provider တစ်ခု rate-limit ဖြစ်နေချိန်에도 OpenClaw က ဆက်လက် ပြန်ကြားနိုင်ရန် **fallback model** ကို သတ်မှတ်ထားပါ။
[Models](/cli/models) နှင့် [OAuth](/concepts/oauth) ကို ကြည့်ပါ။

### AWS Bedrock ကို ထောက်ပံ့ထားပါသလား

ဟုတ်ပါတယ် — pi-ai ရဲ့ **Amazon Bedrock (Converse)** provider ကို **manual config** နဲ့ အသုံးပြုနိုင်ပါတယ်။ gateway host ပေါ်မှာ AWS credentials/region ကို ပံ့ပိုးပေးရမယ်၊ ပြီးရင် models config ထဲမှာ Bedrock provider entry တစ်ခု ထည့်ရပါမယ်။ [Amazon Bedrock](/providers/bedrock) နှင့် [Model providers](/providers/models) ကို ကြည့်ပါ။ managed key flow ကို သဘောကျပါက Bedrock ရှေ့မှာ OpenAI-compatible proxy တစ်ခု ထားသုံးတာလည်း အလုပ်ဖြစ်တဲ့ ရွေးချယ်မှုတစ်ခုပါ။

### Codex auth က ဘယ်လို အလုပ်လုပ်သလဲ

OpenClaw သည် OAuth (ChatGPT sign-in) ဖြင့် **OpenAI Code (Codex)** ကို ထောက်ပံ့ပါသည်။ သင့်လျော်သည့်အခါ wizard သည် OAuth flow ကို run လုပ်ပြီး default model ကို `openai-codex/gpt-5.3-codex` အဖြစ် သတ်မှတ်ပေးပါမည်။ [Model providers](/concepts/model-providers) နှင့် [Wizard](/start/wizard) ကို ကြည့်ပါ။

### OpenAI subscription auth Codex OAuth ကို ထောက်ပံ့ပါသလား

Yes. OpenClaw က **OpenAI Code (Codex) subscription OAuth** ကို အပြည့်အဝ ထောက်ပံ့ပါတယ်။ onboarding wizard သည် OAuth flow ကို သင့်အတွက် run လုပ်ပေးနိုင်ပါသည်။

[OAuth](/concepts/oauth), [Model providers](/concepts/model-providers), နှင့် [Wizard](/start/wizard) ကို ကြည့်ပါ။

### Gemini CLI OAuth ကို ဘယ်လို သတ်မှတ်ရမလဲ

Gemini CLI က `openclaw.json` ထဲမှာ client id သို့မဟုတ် secret ထည့်ရတာ မဟုတ်ဘဲ **plugin auth flow** ကို သုံးပါတယ်။

အဆင့်များ:

1. plugin ကို ဖွင့်ပါ: `openclaw plugins enable google-gemini-cli-auth`
2. Login: `openclaw models auth login --provider google-gemini-cli --set-default`

ဒီလိုလုပ်ရင် gateway host ပေါ်မှာ auth profiles အဖြစ် OAuth tokens ကို သိမ်းဆည်းပေးပါလိမ့်မယ်။ အသေးစိတ်: [Model providers](/concepts/model-providers)။

### ပေါ့ပေါ့ပါးပါး စကားပြောရန် local model သုံးလို့ ရပါသလား

ပုံမှန်အားဖြင့် မရပါဘူး။ OpenClaw ကို large context နဲ့ strong safety လိုအပ်ပါတယ်; card သေးသေးတွေက truncate ဖြစ်ပြီး leak ဖြစ်နိုင်ပါတယ်။ မဖြစ်မနေ သုံးရမယ်ဆိုရင် local (LM Studio) မှာ ရနိုင်သမျှ **အကြီးဆုံး** MiniMax M2.1 build ကို chạyပြီး [/gateway/local-models](/gateway/local-models) ကို ကြည့်ပါ။ သေးငယ်/quantized models တွေက prompt-injection risk ကို ပိုမြင့်စေပါတယ် — [Security](/gateway/security) ကို ကြည့်ပါ။

### hosted model traffic ကို region တစ်ခုထဲမှာပဲ ထားချင်ရင် ဘယ်လိုလုပ်ရမလဲ

region-pinned endpoints ကို ရွေးပါ။ OpenRouter က MiniMax, Kimi, နှင့် GLM အတွက် US-hosted options တွေ ပံ့ပိုးပါတယ်; data ကို region ထဲမှာပဲ ထားချင်ရင် US-hosted variant ကို ရွေးပါ။ ဒီအပြင် Anthropic/OpenAI ကိုလည်း `models.mode: "merge"` ကို သုံးပြီး စာရင်းထဲမှာ ထည့်ထားနိုင်ပါတယ် — အဲ့ဒီလိုလုပ်ရင် သင်ရွေးထားတဲ့ regioned provider ကို လေးစားထားပြီး fallbacks တွေကို ဆက်လက် အသုံးပြုနိုင်ပါတယ်။

### ဒီကို install လုပ်ဖို့ Mac Mini တစ်လုံး ဝယ်ရမလား

No. OpenClaw က macOS သို့မဟုတ် Linux (Windows က WSL2 မှတဆင့်) ပေါ်မှာ chạy ပါတယ်။ Mac mini က မလိုအပ်ပါဘူး — အချို့လူတွေက always-on host အဖြစ် ဝယ်ကြပေမယ့် VPS သေးသေး၊ အိမ်သုံး server၊ ဒါမှမဟုတ် Raspberry Pi-class box တစ်လုံးနဲ့လည်း အလုပ်လုပ်ပါတယ်။

macOS-only tools များအတွက်သာ Mac တစ်လုံး လိုအပ်ပါသည်။ iMessage အတွက်တော့ [BlueBubbles](/channels/bluebubbles) (အကြံပြု) ကို သုံးပါ — BlueBubbles server က မည်သည့် Mac ပေါ်မှာမဆို chạy နိုင်ပြီး Gateway ကိုတော့ Linux သို့မဟုတ် အခြားနေရာမှာ chạy လုပ်နိုင်ပါတယ်။ အခြား macOS-only tools တွေ လိုချင်ရင် Gateway ကို Mac ပေါ်မှာ chạy လုပ်ပါ သို့မဟုတ် macOS node တစ်ခုနဲ့ pair လုပ်ပါ။

Docs: [BlueBubbles](/channels/bluebubbles), [Nodes](/nodes), [Mac remote mode](/platforms/mac/remote)။

### iMessage ထောက်ပံ့မှုအတွက် Mac mini လိုအပ်ပါသလား

Messages ကို sign-in လုပ်ထားတဲ့ **macOS device တစ်ခုခု** လိုအပ်ပါတယ်။ Mac mini ဖြစ်စရာ မလိုပါဘူး — မည်သည့် Mac မဆို ရပါတယ်။ **[BlueBubbles](/channels/bluebubbles)** (အကြံပြု) ကို iMessage အတွက် သုံးပါ — BlueBubbles server က macOS ပေါ်မှာ chạy လုပ်ပြီး Gateway ကိုတော့ Linux သို့မဟုတ် အခြားနေရာမှာ chạy လုပ်နိုင်ပါတယ်။

ပုံမှန် setup များ:

- Gateway ကို Linux/VPS ပေါ်မှာ chạy လုပ်ပြီး Messages ကို sign-in လုပ်ထားတဲ့ မည်သည့် Mac ပေါ်မှာမဆို BlueBubbles server ကို chạy လုပ်ပါ။
- အရမ်းရိုးရှင်းတဲ့ single-machine setup ကို လိုချင်ရင် အားလုံးကို Mac ပေါ်မှာ chạy လုပ်ပါ။

Docs: [BlueBubbles](/channels/bluebubbles), [Nodes](/nodes),
[Mac remote mode](/platforms/mac/remote)။

### OpenClaw chạy ဖို့ Mac mini ဝယ်ခဲ့ရင် အဲ့ဒီကို MacBook Pro နဲ့ ချိတ်လို့ ရမလား

Yes. **Mac mini က Gateway ကို chạy လုပ်နိုင်ပြီး**, သင့် MacBook Pro ကတော့ **node** (companion device) အဖြစ် ချိတ်ဆက်နိုင်ပါတယ်။ Nodes don't run the Gateway - they provide extra
capabilities like screen/camera/canvas and `system.run` on that device.

Common pattern:

- Gateway on the Mac mini (always-on).
- MacBook Pro runs the macOS app or a node host and pairs to the Gateway.
- `openclaw nodes status` / `openclaw nodes list` ကို အသုံးပြုပြီး ကြည့်နိုင်ပါသည်။

စာရွက်စာတမ်းများ: [Nodes](/nodes), [Nodes CLI](/cli/nodes).

### Bun ကို သုံးလို့ရပါသလား

Bun is **not recommended**. အထူးသဖြင့် WhatsApp နှင့် Telegram တွင် runtime bugs များကို တွေ့ရပါသည်။
Use **Node** for stable gateways.

If you still want to experiment with Bun, do it on a non-production gateway
without WhatsApp/Telegram.

### Telegram မှာ allowFrom ထဲကို ဘာထည့်ရမလဲ

`channels.telegram.allowFrom` is **the human sender's Telegram user ID** (numeric, recommended) or `@username`. It is not the bot username.

ပိုမိုလုံခြုံ (third-party bot မလိုအပ်)-

- DM your bot, then run `openclaw logs --follow` and read `from.id`.

Official Bot API:

- သင့် bot ကို DM ပို့ပြီး `https://api.telegram.org/bot<bot_token>/getUpdates` ကို ခေါ်ကာ `message.from.id` ကို ဖတ်ပါ။

Third-party (privacy နည်း)-

- DM `@userinfobot` or `@getidsbot`.

See [/channels/telegram](/channels/telegram#access-control-dms--groups).

### Can multiple people use one WhatsApp number with different OpenClaw instances

Yes, via **multi-agent routing**. 9. sender တစ်ဦးချင်းစီ၏ WhatsApp **DM** (peer `kind: "direct"`, sender E.164 ကဲ့သို့ `+15551234567`) ကို `agentId` မတူညီစွာ ချိတ်ဆက်ပါ၊ ထိုသို့လုပ်ခြင်းဖြင့် လူတစ်ဦးချင်းစီတွင် ကိုယ်ပိုင် workspace နှင့် session store ရရှိပါသည်။ Replies still come from the **same WhatsApp account**, and DM access control (`channels.whatsapp.dmPolicy` / `channels.whatsapp.allowFrom`) is global per WhatsApp account. See [Multi-Agent Routing](/concepts/multi-agent) and [WhatsApp](/channels/whatsapp).

### Can I run a fast chat agent and an Opus for coding agent

Yes. multi-agent routing ကို အသုံးပြုပါ: agent တစ်ခုစီအတွက် default model ကို သတ်မှတ်ပြီး inbound routes (provider account သို့မဟုတ် specific peers) ကို agent တစ်ခုစီနှင့် ချိတ်ဆက်ပါ။ Example config lives in [Multi-Agent Routing](/concepts/multi-agent). See also [Models](/concepts/models) and [Configuration](/gateway/configuration).

### Does Homebrew work on Linux

Yes. Homebrew supports Linux (Linuxbrew). Quick setup:

```bash
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
echo 'eval "$(/home/linuxbrew/.linuxbrew/bin/brew shellenv)"' >> ~/.profile
eval "$(/home/linuxbrew/.linuxbrew/bin/brew shellenv)"
brew install <formula>
```

If you run OpenClaw via systemd, ensure the service PATH includes `/home/linuxbrew/.linuxbrew/bin` (or your brew prefix) so `brew`-installed tools resolve in non-login shells.
Recent builds also prepend common user bin dirs on Linux systemd services (for example `~/.local/bin`, `~/.npm-global/bin`, `~/.local/share/pnpm`, `~/.bun/bin`) and honor `PNPM_HOME`, `NPM_CONFIG_PREFIX`, `BUN_INSTALL`, `VOLTA_HOME`, `ASDF_DATA_DIR`, `NVM_DIR`, and `FNM_DIR` when set.

### What's the difference between the hackable git install and npm install

- **Hackable (git) install:** full source checkout, editable, best for contributors.
  You run builds locally and can patch code/docs.
- **npm install:** global CLI install, no repo, best for "just run it."
  Updates come from npm dist-tags.

Docs: [Getting started](/start/getting-started), [Updating](/install/updating).

### Can I switch between npm and git installs later

Yes. Install the other flavor, then run Doctor so the gateway service points at the new entrypoint.
This **does not delete your data** - it only changes the OpenClaw code install. Your state
(`~/.openclaw`) and workspace (`~/.openclaw/workspace`) stay untouched.

From npm → git:

```bash
git clone https://github.com/openclaw/openclaw.git
cd openclaw
pnpm install
pnpm build
openclaw doctor
openclaw gateway restart
```

From git → npm:

```bash
npm install -g openclaw@latest
openclaw doctor
openclaw gateway restart
```

Doctor detects a gateway service entrypoint mismatch and offers to rewrite the service config to match the current install (use `--repair` in automation).

Backup tips: see [Backup strategy](/help/faq#whats-the-recommended-backup-strategy).

### Should I run the Gateway on my laptop or a VPS

Short answer: **if you want 24/7 reliability, use a VPS**. If you want the
lowest friction and you're okay with sleep/restarts, run it locally.

**Laptop (local Gateway)**

- **Pros:** no server cost, direct access to local files, live browser window.
- **Cons:** sleep/network drops = disconnects, OS updates/reboots interrupt, must stay awake.

**VPS / cloud**

- **Pros:** always-on, stable network, no laptop sleep issues, easier to keep running.
- **Cons:** often run headless (use screenshots), remote file access only, you must SSH for updates.

**OpenClaw-specific note:** WhatsApp/Telegram/Slack/Mattermost (plugin)/Discord all work fine from a VPS. The only real trade-off is **headless browser** vs a visible window. See [Browser](/tools/browser).

**Recommended default:** VPS if you had gateway disconnects before. Local is great when you're actively using the Mac and want local file access or UI automation with a visible browser.

### How important is it to run OpenClaw on a dedicated machine

Not required, but **recommended for reliability and isolation**.

- **Dedicated host (VPS/Mac mini/Pi):** always-on, fewer sleep/reboot interruptions, cleaner permissions, easier to keep running.
- **Shared laptop/desktop:** totally fine for testing and active use, but expect pauses when the machine sleeps or updates.

If you want the best of both worlds, keep the Gateway on a dedicated host and pair your laptop as a **node** for local screen/camera/exec tools. See [Nodes](/nodes).
For security guidance, read [Security](/gateway/security).

### What are the minimum VPS requirements and recommended OS

OpenClaw is lightweight. For a basic Gateway + one chat channel:

- **Absolute minimum:** 1 vCPU, 1GB RAM, ~500MB disk.
- **Recommended:** 1-2 vCPU, 2GB RAM or more for headroom (logs, media, multiple channels). Node tools and browser automation can be resource hungry.

OS: use **Ubuntu LTS** (or any modern Debian/Ubuntu). The Linux install path is best tested there.

Docs: [Linux](/platforms/linux), [VPS hosting](/vps).

### Can I run OpenClaw in a VM and what are the requirements

Yes. Treat a VM the same as a VPS: it needs to be always on, reachable, and have enough
RAM for the Gateway and any channels you enable.

Baseline guidance:

- **Absolute minimum:** 1 vCPU, 1GB RAM.
- **Recommended:** 2GB RAM or more if you run multiple channels, browser automation, or media tools.
- **OS:** Ubuntu LTS or another modern Debian/Ubuntu.

If you are on Windows, **WSL2 is the easiest VM style setup** and has the best tooling
compatibility. See [Windows](/platforms/windows), [VPS hosting](/vps).
If you are running macOS in a VM, see [macOS VM](/install/macos-vm).

## OpenClaw ဆိုတာဘာလဲ?

### What is OpenClaw in one paragraph

OpenClaw is a personal AI assistant you run on your own devices. It replies on the messaging surfaces you already use (WhatsApp, Telegram, Slack, Mattermost (plugin), Discord, Google Chat, Signal, iMessage, WebChat) and can also do voice + a live Canvas on supported platforms. The **Gateway** is the always-on control plane; the assistant is the product.

### What's the value proposition

OpenClaw is not "just a Claude wrapper." It's a **local-first control plane** that lets you run a
capable assistant on **your own hardware**, reachable from the chat apps you already use, with
stateful sessions, memory, and tools - without handing control of your workflows to a hosted
SaaS.

Highlights—

- **Your devices, your data:** run the Gateway wherever you want (Mac, Linux, VPS) and keep the
  workspace + session history local.
- **Real channels, not a web sandbox:** WhatsApp/Telegram/Slack/Discord/Signal/iMessage/etc,
  plus mobile voice and Canvas on supported platforms.
- **Model-agnostic:** use Anthropic, OpenAI, MiniMax, OpenRouter, etc., with per-agent routing
  and failover.
- **Local-only option:** run local models so **all data can stay on your device** if you want.
- **Multi-agent routing:** separate agents per channel, account, or task, each with its own
  workspace and defaults.
- **Open source and hackable:** inspect, extend, and self-host without vendor lock-in.

Docs: [Gateway](/gateway), [Channels](/channels), [Multi-agent](/concepts/multi-agent),
[Memory](/concepts/memory).

### I just set it up what should I do first

Good first projects:

- ဝဘ်ဆိုက်တစ်ခု တည်ဆောက်ပါ (WordPress, Shopify သို့မဟုတ် ရိုးရှင်းသော static site တစ်ခု)။
- Prototype a mobile app (outline, screens, API plan).
- Organize files and folders (cleanup, naming, tagging).
- Connect Gmail and automate summaries or follow ups.

It can handle large tasks, but it works best when you split them into phases and
use sub agents for parallel work.

### What are the top five everyday use cases for OpenClaw

Everyday wins usually look like:

- **ကိုယ်ရေးကိုယ်တာ briefing များ:** သင့်အတွက် အရေးကြီးသော inbox, calendar နှင့် သတင်းများ၏ အကျဉ်းချုပ်များ။
- **Research and drafting:** quick research, summaries, and first drafts for emails or docs.
- **Reminders နှင့် follow ups:** cron သို့မဟုတ် heartbeat ဖြင့် မောင်းနှင်သော သတိပေးချက်များနှင့် checklist များ။
- **Browser automation:** filling forms, collecting data, and repeating web tasks.
- **Cross device coordination:** send a task from your phone, let the Gateway run it on a server, and get the result back in chat.

### Can OpenClaw help with lead gen outreach ads and blogs for a SaaS

Yes for **research, qualification, and drafting**. It can scan sites, build shortlists,
summarize prospects, and write outreach or ad copy drafts.

For **outreach or ad runs**, keep a human in the loop. Avoid spam, follow local laws and
platform policies, and review anything before it is sent. The safest pattern is to let
OpenClaw draft and you approve.

Docs: [Security](/gateway/security).

### What are the advantages vs Claude Code for web development

OpenClaw is a **personal assistant** and coordination layer, not an IDE replacement. Use
Claude Code or Codex for the fastest direct coding loop inside a repo. Use OpenClaw when you
want durable memory, cross-device access, and tool orchestration.

Advantages:

- **Persistent memory + workspace** across sessions
- **Multi-platform access** (WhatsApp, Telegram, TUI, WebChat)
- **Tool orchestration** (browser, files, scheduling, hooks)
- **Always-on Gateway** (run on a VPS, interact from anywhere)
- **Nodes** for local browser/screen/camera/exec

Showcase: [https://openclaw.ai/showcase](https://openclaw.ai/showcase)

## Skills and automation

### How do I customize skills without keeping the repo dirty

Use managed overrides instead of editing the repo copy. Put your changes in `~/.openclaw/skills/<name>/SKILL.md` (or add a folder via `skills.load.extraDirs` in `~/.openclaw/openclaw.json`). Precedence is `<workspace>/skills` > `~/.openclaw/skills` > bundled, so managed overrides win without touching git. Only upstream-worthy edits should live in the repo and go out as PRs.

### Can I load skills from a custom folder

Yes. Add extra directories via `skills.load.extraDirs` in `~/.openclaw/openclaw.json` (lowest precedence). Default precedence remains: `<workspace>/skills` → `~/.openclaw/skills` → bundled → `skills.load.extraDirs`. `clawhub` installs into `./skills` by default, which OpenClaw treats as `<workspace>/skills`.

### How can I use different models for different tasks

Today the supported patterns are:

- **Cron jobs**: isolated jobs can set a `model` override per job.
- **Sub-agents**: route tasks to separate agents with different default models.
- **On-demand switch**: use `/model` to switch the current session model at any time.

See [Cron jobs](/automation/cron-jobs), [Multi-Agent Routing](/concepts/multi-agent), and [Slash commands](/tools/slash-commands).

### The bot freezes while doing heavy work How do I offload that

1. ရှည်လျားသော သို့မဟုတ် အပြိုင်လုပ်ဆောင်ရမည့် အလုပ်များအတွက် **sub-agents** ကို အသုံးပြုပါ။ 2. Sub-agents များသည် ကိုယ်ပိုင် session အတွင်း လည်ပတ်ပြီး၊ အကျဉ်းချုပ်ကို ပြန်ပေးကာ သင့် main chat ကို အမြန်တုံ့ပြန်နိုင်အောင် ထိန်းထားပေးသည်။

2. သင့် bot ကို "spawn a sub-agent for this task" ဟု မေးမြန်းပါ သို့မဟုတ် `/subagents` ကို အသုံးပြုပါ။
3. Gateway က ယခုအချိန်တွင် ဘာလုပ်နေသည် (အလုပ်များနေပါသလား) ကို ကြည့်ရန် chat ထဲတွင် `/status` ကို အသုံးပြုပါ။

4. Token အကြံပြုချက်: ရှည်လျားသော အလုပ်များနှင့် sub-agents နှစ်ခုစလုံးသည် tokens ကို အသုံးပြုသည်။ ကုန်ကျစရိတ်ကို စဉ်းစားရပါက `agents.defaults.subagents.model` မှတဆင့် sub-agents များအတွက် စျေးသက်သာသော model ကို သတ်မှတ်ပါ။

5. စာရွက်စာတမ်းများ: [Sub-agents](/tools/subagents).

### 8. Cron သို့မဟုတ် reminders မဖွင့်သွားပါက ဘာကို စစ်ဆေးရမလဲ

9. Cron သည် Gateway process အတွင်းတွင် လည်ပတ်သည်။ 10. Gateway ကို ဆက်တိုက် မလည်ပတ်နေပါက scheduled jobs များ မလုပ်ဆောင်နိုင်ပါ။

Checklist:

- 11. cron ကို ဖွင့်ထားကြောင်း (`cron.enabled`) အတည်ပြုပြီး `OPENCLAW_SKIP_CRON` ကို မသတ်မှတ်ထားကြောင်း စစ်ဆေးပါ။
- 12. Gateway ကို ၂၄/၇ လည်ပတ်နေကြောင်း (sleep/restarts မရှိကြောင်း) စစ်ဆေးပါ။
- 13. အလုပ်အတွက် timezone သတ်မှတ်ချက်များကို စစ်ဆေးပါ (`--tz` နှင့် host timezone ကို နှိုင်းယှဉ်ပါ)။

14. Debug:

```bash
15. openclaw cron run <jobId> --force
openclaw cron runs --id <jobId> --limit 50
```

16. စာရွက်စာတမ်းများ: [Cron jobs](/automation/cron-jobs), [Cron vs Heartbeat](/automation/cron-vs-heartbeat).

### 17. Linux တွင် skills ကို မည်သို့ install လုပ်ရမလဲ

18. **ClawHub** (CLI) ကို အသုံးပြုပါ သို့မဟုတ် skills များကို သင့် workspace ထဲသို့ ထည့်ပါ။ 19. macOS Skills UI ကို Linux တွင် မရနိုင်ပါ။
19. skills များကို [https://clawhub.com](https://clawhub.com) တွင် ကြည့်ရှုနိုင်ပါသည်။

20. ClawHub CLI ကို install လုပ်ပါ (package manager တစ်ခုကို ရွေးချယ်ပါ):

```bash
npm i -g clawhub
```

```bash
pnpm add -g clawhub
```

### OpenClaw သည် schedule အတိုင်း သို့မဟုတ် background မှာ ဆက်တိုက် tasks များ run လုပ်နိုင်ပါသလား

Yes. 23. Gateway scheduler ကို အသုံးပြုပါ:

- 24. **Cron jobs** — အချိန်ဇယားသတ်မှတ်ထားသော သို့မဟုတ် ပြန်လည်ဖြစ်ပေါ်သော အလုပ်များအတွက် (restart များကို ဖြတ်သန်းပြီး ဆက်လက်တည်ရှိသည်)။
- 25. **Heartbeat** — "main session" အတွက် ကာလအလိုက် စစ်ဆေးမှုများ။
- 26. **Isolated jobs** — အကျဉ်းချုပ်များကို ပို့ပေးသည့် သို့မဟုတ် chats သို့ ပေးပို့သည့် autonomous agents များအတွက်။

27. စာရွက်စာတမ်းများ: [Cron jobs](/automation/cron-jobs), [Cron vs Heartbeat](/automation/cron-vs-heartbeat),
    [Heartbeat](/gateway/heartbeat).

### 28. Linux မှ Apple macOS-only skills များကို လည်ပတ်နိုင်ပါသလား

29. တိုက်ရိုက် မလုပ်နိုင်ပါ။ 30. macOS skills များကို `metadata.openclaw.os` နှင့် လိုအပ်သော binaries များဖြင့် ကန့်သတ်ထားပြီး၊ skills များသည် **Gateway host** ပေါ်တွင် သင့်လျော်သည့်အခါမှသာ system prompt ထဲတွင် ပေါ်လာပါသည်။ 31. Linux တွင် `darwin`-only skills များ (`apple-notes`, `apple-reminders`, `things-mac` စသည်) ကို gating ကို override မလုပ်ပါက load မလုပ်နိုင်ပါ။

30. ထောက်ခံထားသော ပုံစံ သုံးမျိုး ရှိပါသည်:

31. **Option A - Gateway ကို Mac ပေါ်တွင် လည်ပတ်စေခြင်း (အလွယ်ဆုံး).**
    macOS binaries များ ရှိသောနေရာတွင် Gateway ကို လည်ပတ်စေပြီး၊ Linux မှ [remote mode](#how-do-i-run-openclaw-in-remote-mode-client-connects-to-a-gateway-elsewhere) သို့မဟုတ် Tailscale ဖြင့် ချိတ်ဆက်ပါ။ 34. Gateway host သည် macOS ဖြစ်သောကြောင့် skills များသည် ပုံမှန်အတိုင်း load ဖြစ်ပါသည်။

32. **Option B - macOS node ကို အသုံးပြုခြင်း (SSH မလို).**
    Gateway ကို Linux တွင် လည်ပတ်စေပြီး macOS node (menubar app) ကို pair လုပ်ကာ Mac ပေါ်တွင် **Node Run Commands** ကို "Always Ask" သို့မဟုတ် "Always Allow" အဖြစ် သတ်မှတ်ပါ။ 36. လိုအပ်သော binaries များ node ပေါ်တွင် ရှိပါက OpenClaw သည် macOS-only skills များကို သင့်လျော်သူအဖြစ် သတ်မှတ်နိုင်ပါသည်။ 37. agent သည် ထို skills များကို `nodes` tool မှတစ်ဆင့် လည်ပတ်စေပါသည်။ 38. "Always Ask" ကို ရွေးထားပါက prompt ထဲတွင် "Always Allow" ကို အတည်ပြုခြင်းဖြင့် ထို command ကို allowlist ထဲသို့ ထည့်ပေးပါသည်။

33. **Option C - SSH ဖြင့် macOS binaries များကို proxy လုပ်ခြင်း (အဆင့်မြင့်).**
    Gateway ကို Linux ပေါ်တွင် ထားပြီး လိုအပ်သော CLI binaries များကို Mac ပေါ်တွင် လည်ပတ်စေသည့် SSH wrappers အဖြစ် ဖြေရှင်းစေပါ။ 40. ထို့နောက် skill ကို override လုပ်၍ Linux ကို ခွင့်ပြုသဖြင့် သင့်လျော်နေစေပါ။

34. 41. binary အတွက် SSH wrapper တစ်ခု ဖန်တီးပါ (ဥပမာ: Apple Notes အတွက် `memo`):

    ````bash
    42. ```#!/usr/bin/env bash
    set -euo pipefail
    exec ssh -T user@mac-host /opt/homebrew/bin/memo "$@"```
    ````

35. 43. wrapper ကို Linux host ၏ `PATH` ထဲသို့ ထည့်ပါ (ဥပမာ `~/bin/memo`)။

36. 44. skill metadata ကို (workspace သို့မဟုတ် `~/.openclaw/skills`) မှတစ်ဆင့် override လုပ်၍ Linux ကို ခွင့်ပြုပါ:

    ````markdown
    45. ````---
        name: apple-notes
        description: Manage Apple Notes via the memo CLI on macOS.
        metadata: { "openclaw": { "os": ["darwin", "linux"], "requires": { "bins": ["memo"] } } }
        ---```
        ````
    ````

37. 46. skills snapshot ကို ပြန်လည် refresh ဖြစ်စေရန် session အသစ်တစ်ခု စတင်ပါ။

### 47) Notion သို့မဟုတ် HeyGen integration ရှိပါသလား

48. ယနေ့အထိ built-in မရှိသေးပါ။

ရွေးချယ်စရာများ-

- 49. **Custom skill / plugin:** ယုံကြည်စိတ်ချရသော API access အတွက် အကောင်းဆုံးရွေးချယ်မှု (Notion/HeyGen နှစ်ခုစလုံးတွင် APIs ရှိသည်)။
- 50. **Browser automation:** code မလိုအပ်ဘဲ လုပ်ဆောင်နိုင်သော်လည်း နှေးကွေးပြီး ပိုမိုလွယ်ကူစွာ ပျက်နိုင်ပါသည်။

၁။ client တစ်ခုချင်းစီအလိုက် context ကို ထိန်းသိမ်းချင်ပါက (agency workflows) အတွက် ရိုးရှင်းတဲ့ pattern တစ်ခုကတော့ —

- client တစ်ဦးစီအတွက် Notion page တစ်ခု (context + preferences + active work)။
- ၃။ session စတင်ချိန်မှာ agent ကို အဲ့ဒီ page ကို fetch လုပ်ခိုင်းပါ။

၄။ native integration လိုချင်ရင် feature request ဖွင့်ပါ သို့မဟုတ် အဲ့ဒီ APIs ကို target လုပ်တဲ့ skill တစ်ခု တည်ဆောက်ပါ။

၅။ skills ကို install လုပ်ရန် —

```bash
clawhub install <skill-slug>
clawhub update --all
```

၇။ ClawHub က သင့်ရဲ့ လက်ရှိ directory အောက်ရှိ `./skills` ထဲကို install လုပ်ပေးပါတယ် (သို့မဟုတ် သင် configure လုပ်ထားတဲ့ OpenClaw workspace ကို fallback လုပ်ပါတယ်)။ OpenClaw က နောက် session မှာ အဲ့ဒါကို `<workspace>/skills` အဖြစ် သတ်မှတ်အသုံးပြုပါတယ်။ ၈။ agents အကြား shared skills များအတွက် `~/.openclaw/skills/<name>/SKILL.md` ထဲမှာ ထားပါ။ skill အချို့သည် Homebrew မှတဆင့် binaries များကို install လုပ်ထားရန် လိုအပ်ပါသည်။ Linux တွင်ဆိုပါက Linuxbrew ကို ဆိုလိုပါသည် (အပေါ်တွင် ဖော်ပြထားသော Homebrew Linux FAQ entry ကို ကြည့်ပါ)။ ၁၀။ [Skills](/tools/skills) နဲ့ [ClawHub](/tools/clawhub) ကို ကြည့်ပါ။

### browser takeover အတွက် Chrome extension ကို ဘယ်လို install လုပ်ရမလဲ

၁၂။ built-in installer ကို အသုံးပြုပြီး install လုပ်ပါ၊ ပြီးရင် unpacked extension ကို Chrome ထဲမှာ load လုပ်ပါ —

```bash
openclaw browser extension install
openclaw browser extension path
```

၁၃။ ပြီးရင် Chrome → `chrome://extensions` → "Developer mode" ကို enable လုပ် → "Load unpacked" → အဲ့ဒီ folder ကို ရွေးပါ။

၁၄။ လမ်းညွှန်အပြည့်အစုံ (remote Gateway + security notes အပါအဝင်): [Chrome extension](/tools/chrome-extension)

Gateway သည် Chrome နှင့် စက်တစ်လုံးတည်းပေါ်တွင် run နေပါက (default setup) အများအားဖြင့် အပိုဆောင်း အရာမလိုအပ်ပါ။
Gateway သည် အခြားနေရာတွင် လည်ပတ်နေပါက Gateway သည် ဘရောက်ဇာ လုပ်ဆောင်ချက်များကို proxy လုပ်နိုင်ရန်
ဘရောက်ဇာ စက်ပေါ်တွင် node host ကို လည်ပတ်စေပါ။
၁၆။ သင်ထိန်းချင်တဲ့ tab ပေါ်မှာ extension button ကို ကိုယ်တိုင်နှိပ်ရပါသေးတယ် (auto-attach မလုပ်ပါ)။

## Sandboxing နှင့် memory

### ၁၈။ sandboxing အတွက် သီးသန့် doc တစ်ခု ရှိလား

Yes. ၁၉။ [Sandboxing](/gateway/sandboxing) ကို ကြည့်ပါ။ ၂၀။ Docker အထူးပြု setup (Docker ထဲမှာ full gateway သို့မဟုတ် sandbox images) အတွက် [Docker](/install/docker) ကို ကြည့်ပါ။

### ၂၁။ Docker က ကန့်သတ်ချက်များများရှိသလို ခံစားရတယ်။ full features ကို ဘယ်လို enable လုပ်မလဲ

၂၂။ default image က security-first ဖြစ်ပြီး `node` user နဲ့ run လုပ်တာကြောင့် system packages, Homebrew သို့မဟုတ် bundled browsers မပါဝင်ပါဘူး။ ၂၃။ ပိုပြည့်စုံတဲ့ setup အတွက် —

- ၂၄။ cache များ ဆက်လက်ရှိနေစေရန် `/home/node` ကို `OPENCLAW_HOME_VOLUME` နဲ့ persist လုပ်ပါ။
- ၂၅။ `OPENCLAW_DOCKER_APT_PACKAGES` ကို အသုံးပြုပြီး system dependencies များကို image ထဲမှာ bake လုပ်ပါ။
- ၂၆။ bundled CLI ကို အသုံးပြုပြီး Playwright browsers ကို install လုပ်ပါ —
  `node /app/node_modules/playwright-core/cli.js install chromium`
- ၂၇။ `PLAYWRIGHT_BROWSERS_PATH` ကို set လုပ်ပြီး အဲ့ဒီ path ကို persist ဖြစ်အောင် သေချာလုပ်ပါ။

၂၈။ Docs: [Docker](/install/docker), [Browser](/tools/browser)။

၂၉။ **DMs ကို private အဖြစ်ထားပြီး groups ကို public sandboxed တစ်ယောက်တည်းသော agent နဲ့ run လုပ်လို့ရမလား**

၃၀။ ဟုတ်ပါတယ် — သင့်ရဲ့ private traffic က **DMs** ဖြစ်ပြီး public traffic က **groups** ဖြစ်ရင် ရပါတယ်။

၃၁။ `agents.defaults.sandbox.mode: "non-main"` ကို အသုံးပြုပြီး group/channel sessions (non-main keys) တွေကို Docker ထဲမှာ run လုပ်စေပြီး main DM session ကိုတော့ host ပေါ်မှာပဲ ထားပါ။ ၃၂။ ပြီးရင် sandboxed sessions ထဲမှာ အသုံးပြုနိုင်တဲ့ tools တွေကို `tools.sandbox.tools` နဲ့ ကန့်သတ်ပါ။

၃၃။ Setup walkthrough + example config: [Groups: personal DMs + public groups](/channels/groups#pattern-personal-dms-public-groups-single-agent)

၃၄။ Key config reference: [Gateway configuration](/gateway/configuration#agentsdefaultssandbox)

### ၃၅။ host folder တစ်ခုကို sandbox ထဲကို ဘယ်လို bind လုပ်မလဲ

၃၆။ `agents.defaults.sandbox.docker.binds` ကို `["host:path:mode"]` (ဥပမာ `"/home/user/src:/src:ro"`) အဖြစ် သတ်မှတ်ပါ။ ၃၇။ Global + per-agent binds တွေကို merge လုပ်ပါတယ်; `scope: "shared"` ဖြစ်တဲ့အခါ per-agent binds ကို လျစ်လျူရှုပါတယ်။ ၃၈။ အရေးကြီးတဲ့ အရာများအတွက် `:ro` ကို အသုံးပြုပြီး binds တွေက sandbox filesystem walls ကို ကျော်လွှားနိုင်တယ်ဆိုတာကို မှတ်သားထားပါ။ ၃၉။ ဥပမာများနဲ့ လုံခြုံရေးသတိပြုရန်များအတွက် [Sandboxing](/gateway/sandboxing#custom-bind-mounts) နဲ့ [Sandbox vs Tool Policy vs Elevated](/gateway/sandbox-vs-tool-policy-vs-elevated#bind-mounts-security-quick-check) ကို ကြည့်ပါ။

### ၄၀။ memory က ဘယ်လို အလုပ်လုပ်သလဲ

၄၁။ OpenClaw memory က agent workspace ထဲမှာရှိတဲ့ Markdown files တွေပဲ ဖြစ်ပါတယ် —

- ၄၂။ နေ့စဉ် notes များကို `memory/YYYY-MM-DD.md` ထဲမှာ
- ၄၃။ ရေရှည်အသုံးပြုရန် စုစည်းထားတဲ့ notes များကို `MEMORY.md` ထဲမှာ (main/private sessions အတွက်သာ)

၄၄။ OpenClaw က auto-compaction မလုပ်ခင် durable notes တွေကို ရေးသားဖို့ မော်ဒယ်ကို သတိပေးတဲ့ **silent pre-compaction memory flush** ကိုလည်း run လုပ်ပါတယ်။ ၄၅။ workspace က writable ဖြစ်တဲ့အခါမှာပဲ ဒီအရာ run လုပ်ပါတယ် (read-only sandboxes တွေမှာတော့ skip လုပ်ပါတယ်)။ [Memory](/concepts/memory) ကို ကြည့်ပါ။

### ၄၆။ Memory က အမြဲမေ့နေတယ်။ ဘယ်လိုလုပ်ရင် မှတ်ထားနိုင်မလဲ

၄၇။ bot ကို **memory ထဲကို ဒီအချက်ကို ရေးပါ** လို့ တိုက်ရိုက်ပြောပါ။ ၄၈။ ရေရှည်မှတ်စုတွေကို `MEMORY.md` ထဲမှာထားပြီး short-term context ကို `memory/YYYY-MM-DD.md` ထဲကို ထားပါ။

၄၉။ ဒီအပိုင်းက ကျွန်ုပ်တို့ ဆက်လက် တိုးတက်အောင် လုပ်နေဆဲ ဖြစ်ပါတယ်။ ၅၀။ မော်ဒယ်ကို memory သိမ်းဖို့ သတိပေးရင် အထောက်အကူဖြစ်ပါတယ်; ဘာလုပ်ရမလဲဆိုတာ သူက သိပါတယ်။ မေ့နေဆဲ ဖြစ်နေပါက Gateway သည် run လုပ်တိုင်း workspace တစ်ခုတည်းကို အသုံးပြုနေကြောင်း စစ်ဆေးပါ။

Docs: [Memory](/concepts/memory), [Agent workspace](/concepts/agent-workspace).

### ၃. semantic memory search အတွက် OpenAI API key လိုအပ်ပါသလား

၄. **OpenAI embeddings** ကို သုံးတဲ့အခါမှသာ လိုအပ်ပါတယ်။ Codex OAuth သည် chat/completions ကိုသာ ဖုံးလွှမ်းပြီး embeddings access ကို **မပေးပါ**။ ထို့ကြောင့် **Codex (OAuth သို့မဟုတ် Codex CLI login) ဖြင့် sign in လုပ်ခြင်း** သည် semantic memory search အတွက် မကူညီပါ။ ၆. OpenAI embeddings အတွက်တော့ အမှန်တကယ် API key (`OPENAI_API_KEY` သို့မဟုတ် `models.providers.openai.apiKey`) လိုအပ်နေဆဲပါ။

၇. provider ကို အထူးသတ်မှတ်မထားရင် OpenClaw က API key ကို resolve လုပ်နိုင်တဲ့အခါ (auth profiles, `models.providers.*.apiKey`, သို့မဟုတ် env vars) provider ကို auto-select လုပ်ပါမယ်။
၈. OpenAI key ကို resolve လုပ်နိုင်ရင် OpenAI ကို ဦးစားပေးပြီး မရရင် Gemini key ရှိပါက Gemini ကို သုံးပါမယ်။ ၉. key နှစ်ခုစလုံး မရှိရင် configure မလုပ်မချင်း memory search ကို disable အနေအထားနဲ့ ထားရှိပါမယ်။ ၁၀. local model path ကို configure လုပ်ထားပြီး ရှိနေပါက OpenClaw က `local` ကို ဦးစားပေးပါမယ်။

၁၁. local အနေနဲ့ပဲ သုံးချင်ရင် `memorySearch.provider = "local"` (လိုအပ်ရင် `memorySearch.fallback = "none"`) ကို သတ်မှတ်ပါ။ ၁၂. Gemini embeddings ကို သုံးချင်ရင် `memorySearch.provider = "gemini"` ကို သတ်မှတ်ပြီး `GEMINI_API_KEY` (သို့မဟုတ် `memorySearch.remote.apiKey`) ကို ပေးပါ။ ၁၃. **OpenAI, Gemini, သို့မဟုတ် local** embedding models တွေကို support လုပ်ပါတယ် — setup အသေးစိတ်အတွက် [Memory](/concepts/memory) ကို ကြည့်ပါ။

### ၁၄. memory က အမြဲတမ်းတည်ရှိနေပါသလား ကန့်သတ်ချက်တွေက ဘာတွေလဲ

၁၅. Memory files တွေက disk ပေါ်မှာ ရှိပြီး သင်ဖျက်မချင်း ဆက်လက်တည်ရှိနေပါမယ်။ ၁၆. ကန့်သတ်ချက်က model မဟုတ်ဘဲ သင့် storage ပမာဏပါ။ ၁၇. **session context** ကတော့ model ရဲ့ context window အတိုင်းအတာနဲ့ ကန့်သတ်ထားတဲ့အတွက် စကားပြောတာရှည်လာရင် compact သို့မဟုတ် truncate လုပ်နိုင်ပါတယ်။ ဒါကြောင့် memory search ရှိနေပါသည် — ၎င်းသည် သက်ဆိုင်ရာ အစိတ်အပိုင်းများကိုသာ context ထဲသို့ ပြန်လည် ဆွဲထည့်ပေးပါသည်။

၁၉. Docs: [Memory](/concepts/memory), [Context](/concepts/context).

## ၂၀. disk ပေါ်မှာ ဘယ်လိုနေရာတွေမှာ သိမ်းထားသလဲ

### ၂၁. OpenClaw နဲ့ သုံးတဲ့ data အားလုံးကို local မှာပဲ သိမ်းထားပါသလား

၂၂. မဟုတ်ပါ — **OpenClaw ရဲ့ state က local** ဖြစ်ပေမယ့် **external services တွေက သင်ပို့တဲ့အချက်အလက်တွေကို မြင်ရပါတယ်**။

- ၂၃. **Local by default:** sessions, memory files, config, နဲ့ workspace တွေက Gateway host (`~/.openclaw` + သင့် workspace directory) ပေါ်မှာ ရှိပါတယ်။
- ၂၄. **Remote by necessity:** model providers (Anthropic/OpenAI/etc.) ကို သင်ပို့တဲ့ messages တွေက ၂၅. သူတို့ရဲ့ APIs ဆီကို သွားပြီး chat platforms (WhatsApp/Telegram/Slack/etc.) တွေက ၂၆. message data ကို သူတို့ရဲ့ servers ပေါ်မှာ သိမ်းဆည်းထားပါတယ်။
- ၂၇. **Footprint ကို သင်ထိန်းချုပ်နိုင်ပါတယ်:** local models ကို သုံးရင် prompts တွေက သင့်စက်ပေါ်မှာပဲ ရှိနေပြီး channel traffic ကတော့ channel ရဲ့ servers ကို ဖြတ်သန်းနေဆဲပါ။

၂၈. ဆက်စပ်: [Agent workspace](/concepts/agent-workspace), [Memory](/concepts/memory).

### ၂၉. OpenClaw က သူ့ data ကို ဘယ်မှာ သိမ်းထားသလဲ

၃၀. အရာအားလုံးက `$OPENCLAW_STATE_DIR` (default: `~/.openclaw`) အောက်မှာ ရှိပါတယ်။

| ၃၁. Path                                                            | Purpose                                                                                  |
| ------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| ၃၂. `$OPENCLAW_STATE_DIR/openclaw.json`                             | ၃၃. Main config (JSON5)                                                                  |
| ၃၄. `$OPENCLAW_STATE_DIR/credentials/oauth.json`                    | ၃၅. Legacy OAuth import (ပထမဆုံး အသုံးပြုချိန်မှာ auth profiles ထဲကို copy လုပ်ထားပါတယ်) |
| ၃၆. `$OPENCLAW_STATE_DIR/agents/<agentId>/agent/auth-profiles.json` | ၃၇. Auth profiles (OAuth + API keys)                                                     |
| ၃၈. `$OPENCLAW_STATE_DIR/agents/<agentId>/agent/auth.json`          | ၃၉. Runtime auth cache (အလိုအလျောက် စီမံခန့်ခွဲထားပါတယ်)                                 |
| `$OPENCLAW_STATE_DIR/credentials/`                                  | ၄၀. Provider state (ဥပမာ `whatsapp/<accountId>/creds.json`)                              |
| `$OPENCLAW_STATE_DIR/agents/`                                       | ၄၁. Per-agent state (agentDir + sessions)                                                |
| ၄၂. `$OPENCLAW_STATE_DIR/agents/<agentId>/sessions/`                | ၄၃. Conversation history & state (agent တစ်ခုချင်းစီအလိုက်)                              |
| ၄၄. `$OPENCLAW_STATE_DIR/agents/<agentId>/sessions/sessions.json`   | ၄၅. Session metadata (agent တစ်ခုချင်းစီအလိုက်)                                          |

Legacy single-agent path: `~/.openclaw/agent/*` (`openclaw doctor` ဖြင့် migrate လုပ်ပေးသည်)။

၄၇. သင့် **workspace** (AGENTS.md, memory files, skills, စသည်တို့) `agents.defaults.workspace` ဖြင့် သီးခြား သတ်မှတ်ထားပြီး (default: `~/.openclaw/workspace`) ဖြစ်ပါသည်။

### ၄၉. AGENTSmd SOULmd USERmd MEMORYmd တွေကို ဘယ်မှာထားသင့်လဲ

ဤဖိုင်များသည် **agent workspace** ထဲတွင် တည်ရှိပြီး `~/.openclaw` ထဲတွင် မဟုတ်ပါ။

- 1. **Workspace (agent တစ်ခုချင်းစီအလိုက်)**: `AGENTS.md`, `SOUL.md`, `IDENTITY.md`, `USER.md`,
     `MEMORY.md` (သို့) `memory.md`, `memory/YYYY-MM-DD.md`, ရွေးချယ်နိုင်သော `HEARTBEAT.md`။
- 2. **State dir (`~/.openclaw`)**: config, credentials, auth profiles, sessions, logs,
     နှင့် shared skills (`~/.openclaw/skills`)။

3. Default workspace သည် `~/.openclaw/workspace` ဖြစ်ပြီး၊ အောက်ပါအတိုင်း ပြင်ဆင်နိုင်သည် —

```json5
{
  agents: { defaults: { workspace: "~/.openclaw/workspace" } },
}
```

4. restart ပြုလုပ်ပြီးနောက် bot က "မေ့" သွားပါက၊ Gateway သည် launch တိုင်းတွင် workspace တူညီစွာ အသုံးပြုနေကြောင်း အတည်ပြုပါ (မှတ်သားရန် — remote mode တွင် **gateway host** ၏ workspace ကို အသုံးပြုသည်၊ သင့် local laptop မဟုတ်ပါ)။

5. Tip: အချိန်ကြာရှည် ထိန်းထားလိုသော behavior သို့မဟုတ် preference ရှိပါက chat history ကို မယုံကြည်ဘဲ **AGENTS.md သို့မဟုတ် MEMORY.md ထဲသို့ ရေးထည့်ရန်** bot ကို တောင်းဆိုပါ။

6. [Agent workspace](/concepts/agent-workspace) နှင့် [Memory](/concepts/memory) ကို ကြည့်ပါ။

### 7. အကြံပြုထားသော backup strategy ကဘာလဲ

8. သင့် **agent workspace** ကို **private** git repo ထဲတွင် ထားပြီး private နေရာတစ်ခုသို့ backup လုပ်ပါ (ဥပမာ GitHub private)။ 9. ဒါဟာ memory + AGENTS/SOUL/USER ဖိုင်များကို သိမ်းဆည်းပေးပြီး၊ နောက်ပိုင်း assistant ရဲ့ "စိတ်" ကို ပြန်လည် restore လုပ်နိုင်စေသည်။

9. `~/.openclaw` အောက်ရှိ မည်သည့်အရာကိုမျှ commit **မလုပ်ပါနှင့်** (credentials, sessions, tokens)။
10. full restore လိုအပ်ပါက workspace နှင့် state directory ကို သီးခြားစီ backup လုပ်ပါ (အထက်ပါ migration မေးခွန်းကို ကြည့်ပါ)။

11. Docs: [Agent workspace](/concepts/agent-workspace)။

### 13. OpenClaw ကို အပြည့်အဝ uninstall ဘယ်လိုလုပ်မလဲ

14. သီးသန့် လမ်းညွှန်ကို ကြည့်ပါ — [Uninstall](/install/uninstall)။

### 15. agents များဟာ workspace အပြင်ဘက်မှာ အလုပ်လုပ်နိုင်ပါသလား

Yes. 16. Workspace သည် **default cwd** နှင့် memory anchor ဖြစ်ပြီး hard sandbox မဟုတ်ပါ။ 17. Relative paths များသည် workspace အတွင်းတွင် resolve ဖြစ်သော်လည်း sandboxing မဖွင့်ထားပါက absolute paths များဖြင့် host ရဲ့ အခြားနေရာများကို ဝင်ရောက်နိုင်ပါသည်။ 18. isolation လိုအပ်ပါက [`agents.defaults.sandbox`](/gateway/sandboxing) သို့မဟုတ် agent တစ်ခုချင်းစီအတွက် sandbox settings ကို အသုံးပြုပါ။ 19. repo တစ်ခုကို default working directory အဖြစ် အသုံးပြုလိုပါက၊ ထို agent ၏ `workspace` ကို repo root သို့ ညွှန်ပြပါ။ 20. OpenClaw repo သည် source code သာဖြစ်သည် — agent ကို အတွင်းမှာ အလုပ်လုပ်စေချင်တာ မဟုတ်ပါက workspace ကို သီးခြားထားပါ။

21. Example (repo ကို default cwd အဖြစ်):

```json5
{
```

### agents: {

```
defaults: {       workspace: "~/Projects/my-repo",     },
```

## },

### }

23. remote mode မှာရှိတဲ့အခါ session store က ဘယ်မှာလဲ

```
24. Session state ကို **gateway host** က ပိုင်ဆိုင်ပါသည်။
```

25. remote mode မှာရှိပါက သင်စိတ်ဝင်စားရမည့် session store သည် သင့် local laptop မဟုတ်ဘဲ remote machine ပေါ်မှာ ရှိပါတယ်။

### 26. [Session management](/concepts/session) ကို ကြည့်ပါ။

27. Config အခြေခံများ 28. config format ကဘာလဲ၊ ဘယ်မှာရှိလဲ

```json5
29. OpenClaw သည် `$OPENCLAW_CONFIG_PATH` မှ optional **JSON5** config ကို ဖတ်ပါသည် (default: `~/.openclaw/openclaw.json`) —
```

မှတ်ချက်များ-

- $OPENCLAW_CONFIG_PATH
- 31. ဖိုင်မရှိပါက (default workspace `~/.openclaw/workspace` အပါအဝင်) safe-ish defaults ကို အသုံးပြုပါသည်။ 32. gateway bind ကို lan သို့မဟုတ် tailnet သတ်မှတ်ပြီးနောက် ဘာမှမနားထောင်တော့ပါ၊ UI မှာ unauthorized လို့ပြနေပါတယ်

### 33. Non-loopback bind များတွင် **auth လိုအပ်ပါသည်**။

34. `gateway.auth.mode` + `gateway.auth.token` ကို ပြင်ဆင်ပါ (သို့) `OPENCLAW_GATEWAY_TOKEN` ကို အသုံးပြုပါ။ { gateway: {

```
bind: "lan",     auth: {
```

### ```

mode: "token",

```

```

token: "replace-me",

````

- ```
  },
````

- },

### }

36. `gateway.remote.token` သည် **remote CLI calls** အတွက်သာဖြစ်ပြီး local gateway auth ကို မဖွင့်ပေးပါ။ `web_search` ကို အသုံးပြုရန် Brave Search API key တစ်ခု လိုအပ်သည်။ **အကြံပြုချက်:** `openclaw configure --section web` ကို chạy ပြီး `tools.web.search.apiKey` ထဲတွင် သိမ်းဆည်းပါ။ Environment အခြားနည်းလမ်း: Gateway process အတွက် `BRAVE_API_KEY` ကို set လုပ်ပါ။

```json5
{
  tools: {
    web: {
      search: {
        enabled: true,
        apiKey: "BRAVE_API_KEY_HERE",
        maxResults: 5,
      },
      fetch: {
        enabled: true,
      },
    },
  },
}
```

မှတ်ချက်များ —

- သင် allowlists ကို အသုံးပြုပါက `web_search`/`web_fetch` သို့မဟုတ် `group:web` ကို ထည့်ပါ။
- `web_fetch` ကို ပုံမှန်အားဖြင့် ဖွင့်ထားပါသည် (အထူးသဖြင့် ပိတ်မထားလျှင်)။
- Daemons များသည် env vars ကို `~/.openclaw/.env` (သို့မဟုတ် service environment) မှ ဖတ်သည်။

Docs: [Web tools](/tools/web).

### ကိရိယာများအမျိုးမျိုးတွင် specialized workers များဖြင့် အလယ်ဗဟို Gateway ကို ဘယ်လို chạy ရမလဲ

အများဆုံး အသုံးပြုသော ပုံစံမှာ **Gateway တစ်ခု** (ဥပမာ Raspberry Pi) နှင့် **nodes** နှင့် **agents** ဖြစ်သည်:

- **Gateway (အလယ်ဗဟို):** channels (Signal/WhatsApp)၊ routing နှင့် sessions များကို ပိုင်ဆိုင်သည်။
- **Nodes (devices):** Macs/iOS/Android များသည် peripherals အဖြစ် ချိတ်ဆက်ပြီး local tools (`system.run`, `canvas`, `camera`) ကို ဖော်ပြပေးသည်။
- **Agents (workers):** အထူးအခန်းကဏ္ဍများအတွက် သီးခြား brains/workspaces (ဥပမာ "Hetzner ops", "Personal data") ဖြစ်သည်။
- **Sub-agents:** parallelism လိုအပ်သောအခါ main agent မှ background အလုပ်များကို spawn လုပ်သည်။
- **TUI:** Gateway သို့ ချိတ်ဆက်ပြီး agents/sessions များကို ပြောင်းလဲနိုင်သည်။

Docs: [Nodes](/nodes), [Remote access](/gateway/remote), [Multi-Agent Routing](/concepts/multi-agent), [Sub-agents](/tools/subagents), [TUI](/web/tui).

### OpenClaw browser ကို headless အဖြစ် chạy လို့ရပါသလား

Yes. ၎င်းသည် config option တစ်ခုဖြစ်သည်:

```json5
{
  browser: { headless: true },
  agents: {
    defaults: {
      sandbox: { browser: { headless: true } },
    },
  },
}
```

Default သည် `false` (headful) ဖြစ်သည်။ Headless mode သည် site အချို့တွင် anti-bot စစ်ဆေးမှုများကို ပိုမို trigger ဖြစ်နိုင်သည်။ [Browser](/tools/browser) ကို ကြည့်ပါ။

Headless သည် **တူညီသော Chromium engine** ကို အသုံးပြုထားပြီး automation အများစု (forms, clicks, scraping, logins) အတွက် အလုပ်လုပ်သည်။ အဓိက ကွာခြားချက်များ:

- မြင်ရသော browser window မရှိပါ (visual လိုအပ်ပါက screenshots ကို အသုံးပြုပါ)။
- Site အချို့သည် headless mode တွင် automation အပေါ် ပိုမိုတင်းကြပ်သည် (CAPTCHAs, anti-bot)။
  ဥပမာအားဖြင့် X/Twitter သည် headless sessions များကို မကြာခဏ ပိတ်ပင်တတ်သည်။

### Browser control အတွက် Brave ကို ဘယ်လို အသုံးပြုရမလဲ

`browser.executablePath` ကို သင့် Brave binary (သို့မဟုတ် Chromium-based browser မည်သည့်အရာမဆို) သို့ သတ်မှတ်ပြီး Gateway ကို restart လုပ်ပါ။
Config အပြည့်အစုံ ဥပမာများကို [Browser](/tools/browser#use-brave-or-another-chromium-based-browser) တွင် ကြည့်ပါ။

## Remote gateways နှင့် nodes

### Telegram၊ gateway နှင့် nodes ကြားတွင် commands များ ဘယ်လို ဆက်သွယ်ပို့ဆောင်သလဲ

Telegram messages များကို **gateway** မှ ကိုင်တွယ်သည်။ Gateway သည် agent ကို chạy ပြီးနောက်သာ node tool လိုအပ်သောအခါ **Gateway WebSocket** မှတဆင့် nodes များကို ခေါ်သည်:

Telegram → Gateway → Agent → `node.*` → Node → Gateway → Telegram

Nodes များသည် inbound provider traffic ကို မမြင်ရပါ; ၎င်းတို့သည် node RPC calls များကိုသာ လက်ခံသည်။

### Gateway ကို remote မှ host လုပ်ထားလျှင် agent သည် ကျွန်ုပ်၏ computer ကို ဘယ်လို ဝင်ရောက်နိုင်မလဲ

အတိုချုံးအဖြေ: **သင့် computer ကို node အဖြစ် pair လုပ်ပါ**။ Gateway သည် အခြားနေရာတွင် chạy နေသော်လည်း Gateway WebSocket မှတဆင့် သင့် local machine ပေါ်ရှိ `node.*` tools (screen, camera, system) များကို ခေါ်နိုင်သည်။

ပုံမှန် setup:

1. Gateway ကို အမြဲဖွင့်ထားသော host (VPS/home server) ပေါ်တွင် chạy ပါ။
2. Gateway host နှင့် သင့် computer ကို တူညီသော tailnet ပေါ်တွင် ထားပါ။
3. Gateway WS ကို ချိတ်ဆက်နိုင်ကြောင်း သေချာပါ (tailnet bind သို့မဟုတ် SSH tunnel)။
4. macOS app ကို local မှ ဖွင့်ပြီး **Remote over SSH** mode (သို့မဟုတ် direct tailnet) ဖြင့် ချိတ်ဆက်ကာ node အဖြစ် register လုပ်နိုင်အောင် ပြုလုပ်ပါ။
5. Gateway ပေါ်တွင် node ကို အတည်ပြုပါ:

   ```bash
   openclaw nodes pending
   openclaw nodes approve <requestId>
   ```

သီးခြား TCP bridge မလိုအပ်ပါ; nodes များသည် Gateway WebSocket မှတဆင့် ချိတ်ဆက်သည်။

လုံခြုံရေး သတိပေးချက်: macOS node ကို pair လုပ်ခြင်းဖြင့် ထိုစက်ပေါ်တွင် `system.run` ကို ခွင့်ပြုပါသည်။ ယုံကြည်ရသော ကိရိယာများကိုသာ pair လုပ်ပြီး [Security](/gateway/security) ကို ပြန်လည်သုံးသပ်ပါ။

Docs: [Nodes](/nodes), [Gateway protocol](/gateway/protocol), [macOS remote mode](/platforms/mac/remote), [Security](/gateway/security).

### Tailscale ချိတ်ဆက်ထားပေမယ့် အကြောင်းပြန်မရပါ ဘာလုပ်ရမလဲ

အခြေခံများကို စစ်ဆေးပါ:

- Gateway is running: `openclaw gateway status`
- Gateway health: `openclaw status`
- Channel health: `openclaw channels status`

Then verify auth and routing:

- If you use Tailscale Serve, make sure `gateway.auth.allowTailscale` is set correctly.
- If you connect via SSH tunnel, confirm the local tunnel is up and points at the right port.
- Confirm your allowlists (DM or group) include your account.

Docs: [Tailscale](/gateway/tailscale), [Remote access](/gateway/remote), [Channels](/channels).

### Can two OpenClaw instances talk to each other local VPS

Yes. There is no built-in "bot-to-bot" bridge, but you can wire it up in a few
reliable ways:

**Simplest:** use a normal chat channel both bots can access (Telegram/Slack/WhatsApp).
Have Bot A send a message to Bot B, then let Bot B reply as usual.

**CLI bridge (generic):** run a script that calls the other Gateway with
`openclaw agent --message ... --deliver`, targeting a chat where the other bot
listens. If one bot is on a remote VPS, point your CLI at that remote Gateway
via SSH/Tailscale (see [Remote access](/gateway/remote)).

Example pattern (run from a machine that can reach the target Gateway):

```bash
openclaw agent --message "Hello from local bot" --deliver --channel telegram --reply-to <chat-id>
```

Tip: add a guardrail so the two bots do not loop endlessly (mention-only, channel
allowlists, or a "do not reply to bot messages" rule).

Docs: [Remote access](/gateway/remote), [Agent CLI](/cli/agent), [Agent send](/tools/agent-send).

### Do I need separate VPSes for multiple agents

No. One Gateway can host multiple agents, each with its own workspace, model defaults,
and routing. That is the normal setup and it is much cheaper and simpler than running
one VPS per agent.

Use separate VPSes only when you need hard isolation (security boundaries) or very
different configs that you do not want to share. Otherwise, keep one Gateway and
use multiple agents or sub-agents.

### Is there a benefit to using a node on my personal laptop instead of SSH from a VPS

Yes - nodes are the first-class way to reach your laptop from a remote Gateway, and they
unlock more than shell access. The Gateway runs on macOS/Linux (Windows via WSL2) and is
lightweight (a small VPS or Raspberry Pi-class box is fine; 4 GB RAM is plenty), so a common
setup is an always-on host plus your laptop as a node.

- **No inbound SSH required.** Nodes connect out to the Gateway WebSocket and use device pairing.
- **Safer execution controls.** `system.run` is gated by node allowlists/approvals on that laptop.
- **More device tools.** Nodes expose `canvas`, `camera`, and `screen` in addition to `system.run`.
- **Local browser automation.** Keep the Gateway on a VPS, but run Chrome locally and relay control
  with the Chrome extension + a node host on the laptop.

SSH is fine for ad-hoc shell access, but nodes are simpler for ongoing agent workflows and
device automation.

Docs: [Nodes](/nodes), [Nodes CLI](/cli/nodes), [Chrome extension](/tools/chrome-extension).

### Should I install on a second laptop or just add a node

If you only need **local tools** (screen/camera/exec) on the second laptop, add it as a
**node**. That keeps a single Gateway and avoids duplicated config. Local node tools are
currently macOS-only, but we plan to extend them to other OSes.

Install a second Gateway only when you need **hard isolation** or two fully separate bots.

Docs: [Nodes](/nodes), [Nodes CLI](/cli/nodes), [Multiple gateways](/gateway/multiple-gateways).

### Do nodes run a gateway service

No. Only **one gateway** should run per host unless you intentionally run isolated profiles (see [Multiple gateways](/gateway/multiple-gateways)). Nodes are peripherals that connect
to the gateway (iOS/Android nodes, or macOS "node mode" in the menubar app). For headless node
hosts and CLI control, see [Node host CLI](/cli/node).

A full restart is required for `gateway`, `discovery`, and `canvasHost` changes.

### Is there an API RPC way to apply config

Yes. `config.apply` validates + writes the full config and restarts the Gateway as part of the operation.

### configapply wiped my config How do I recover and avoid this

`config.apply` replaces the **entire config**. If you send a partial object, everything
else is removed.

Recover:

- ၁။ အရန်ကူးမှ ပြန်လည်ထည့်သွင်းပါ (git သို့မဟုတ် ကူးယူထားသော `~/.openclaw/openclaw.json`)။
- ၂။ အရန်ကူး မရှိပါက `openclaw doctor` ကို ပြန်လည် chạy လုပ်ပြီး channel များ/မော်ဒယ်များကို ပြန်လည်သတ်မှတ်ပါ။
- ၃။ မမျှော်လင့်ထားသော အခြေအနေဖြစ်ပါက bug တစ်ခု တင်သွင်းပြီး သင်၏ နောက်ဆုံး သိရှိထားသော config သို့မဟုတ် မည်သည့်အရန်ကူးမဆို ထည့်သွင်းပါ။
- ၄။ ဒေသတွင်း coding agent တစ်ခုက log များ သို့မဟုတ် history မှ လုပ်ဆောင်နိုင်သော config ကို မကြာခဏ ပြန်လည်တည်ဆောက်ပေးနိုင်ပါသည်။

၅။ ရှောင်ရှားရန်:

- ၆။ ပြောင်းလဲမှုအသေးစားများအတွက် `openclaw config set` ကို အသုံးပြုပါ။
- ၇။ အပြန်အလှန် တည်းဖြတ်မှုများအတွက် `openclaw configure` ကို အသုံးပြုပါ။

၈။ စာတမ်းများ: [Config](/cli/config), [Configure](/cli/configure), [Doctor](/gateway/doctor)။

### ၉။ ပထမဆုံး တပ်ဆင်မှုအတွက် အနည်းဆုံး သင့်တော်သော config က ဘာလဲ

```json5
{
  agents: { defaults: { workspace: "~/.openclaw/workspace" } },
  channels: { whatsapp: { allowFrom: ["+15555550123"] } },
}
```

၁၀။ ၎င်းသည် သင်၏ workspace ကို သတ်မှတ်ပြီး ဘော့ကို မည်သူက လှုံ့ဆော်နိုင်သည်ကို ကန့်သတ်ပေးသည်။

### ၁၁။ VPS တစ်ခုတွင် Tailscale ကို မည်သို့ တပ်ဆင်ပြီး ကျွန်ုပ်၏ Mac မှ ချိတ်ဆက်ရမလဲ

၁၂။ အနည်းဆုံး အဆင့်များ:

1. ၁၃။ **VPS တွင် တပ်ဆင် + login**

   ```bash
   ၁၄။ curl -fsSL https://tailscale.com/install.sh | sh
   sudo tailscale up
   ```

2. ၁၅။ **သင်၏ Mac တွင် တပ်ဆင် + login**
   - ၁၆။ Tailscale app ကို အသုံးပြုပြီး တူညီသော tailnet သို့ sign in လုပ်ပါ။

3. ၁၇။ **MagicDNS ကို ဖွင့်ပါ (အကြံပြု)**
   - ၁၈။ Tailscale admin console တွင် VPS သည် တည်ငြိမ်သော အမည် ရရှိစေရန် MagicDNS ကို ဖွင့်ပါ။

4. ၁၉။ **tailnet hostname ကို အသုံးပြုပါ**
   - ၂၀။ SSH: `ssh user@your-vps.tailnet-xxxx.ts.net`
   - ၂၁။ Gateway WS: `ws://your-vps.tailnet-xxxx.ts.net:18789`

၂၂။ SSH မသုံးဘဲ Control UI ကို လိုလားပါက VPS တွင် Tailscale Serve ကို အသုံးပြုပါ:

```bash
openclaw gateway --tailscale serve
```

၂၃။ ၎င်းသည် gateway ကို loopback တွင် ချိတ်ထားပြီး Tailscale မှတဆင့် HTTPS ကို ဖော်ပြပေးသည်။ ၂၄။ [Tailscale](/gateway/tailscale) ကို ကြည့်ပါ။

### ၂၅။ Mac node တစ်ခုကို အဝေးရှိ Gateway Tailscale Serve သို့ မည်သို့ ချိတ်ဆက်ရမလဲ

၂၆။ Serve သည် **Gateway Control UI + WS** ကို ဖော်ပြပေးသည်။ ၂၇။ node များသည် တူညီသော Gateway WS endpoint မှတဆင့် ချိတ်ဆက်ကြသည်။

၂၈။ အကြံပြုထားသော setup:

1. ၂၉။ **VPS နှင့် Mac တို့သည် တူညီသော tailnet တွင် ရှိကြောင်း သေချာပါစေ**။
2. ၃၀။ **macOS app ကို Remote mode ဖြင့် အသုံးပြုပါ** (SSH target သည် tailnet hostname ဖြစ်နိုင်သည်)။
   ၃၁။ app သည် Gateway port ကို tunnel လုပ်ပြီး node အဖြစ် ချိတ်ဆက်ပါလိမ့်မည်။
3. ၃၂။ **gateway တွင် node ကို အတည်ပြုပါ**:

   ```bash
   openclaw nodes pending
   openclaw nodes approve <requestId>
   ```

၃၃။ စာတမ်းများ: [Gateway protocol](/gateway/protocol), [Discovery](/gateway/discovery), [macOS remote mode](/platforms/mac/remote)။

## ၃၄။ Env vars နှင့် .env loading

### ၃၅။ OpenClaw သည် environment variables များကို မည်သို့ load လုပ်သနည်း

၃၆။ OpenClaw သည် parent process (shell, launchd/systemd, CI စသည်) မှ env vars များကို ဖတ်ပါသည် ၃၇။ ထို့အပြင် အောက်ပါတို့ကိုလည်း load လုပ်ပါသည်:

- ၃၈။ လက်ရှိ working directory မှ `.env`
- ၃၉။ `~/.openclaw/.env` (aka `$OPENCLAW_STATE_DIR/.env`) မှ global fallback `.env`

၄၀။ `.env` ဖိုင် နှစ်ခုစလုံးသည် ရှိပြီးသား env vars များကို override မလုပ်ပါ။

၄၁။ config အတွင်း inline env vars များကိုလည်း သတ်မှတ်နိုင်ပါသည် (process env တွင် မရှိသေးပါကသာ အသုံးချပါသည်):

```json5
၄၂။ {
  env: {
    OPENROUTER_API_KEY: "sk-or-...",
    vars: { GROQ_API_KEY: "gsk-..." },
  },
}
```

၄၃။ အပြည့်အစုံသော precedence နှင့် source များအတွက် [/environment](/help/environment) ကို ကြည့်ပါ။

### ၄၄။ Gateway ကို service မှတဆင့် စတင်လိုက်ပြီးနောက် ကျွန်ုပ်၏ env vars များ ပျောက်သွားပါသည်။ အခု ဘာလုပ်ရမလဲ

၄၅။ ပုံမှန်တွေ့ရသော ဖြေရှင်းနည်း နှစ်ခု:

1. ၄၆။ service သည် သင်၏ shell env ကို inherit မလုပ်သည့်အချိန်တွင်ပါ ဖတ်နိုင်စေရန် ပျောက်နေသော key များကို `~/.openclaw/.env` ထဲ ထည့်ပါ။
2. ၄၇။ shell import ကို ဖွင့်ပါ (opt-in အဆင်ပြေမှု):

```json5
{
  env: {
    shellEnv: {
      enabled: true,
      timeoutMs: 15000,
    },
  },
}
```

၄၈။ ၎င်းသည် သင်၏ login shell ကို chạy လုပ်ပြီး မရှိသေးသော မျှော်လင့်ထားသော key များကိုသာ import လုပ်ပါသည် (ဘယ်တော့မှ override မလုပ်ပါ)။ ၄၉။ Env var equivalents:
`OPENCLAW_LOAD_SHELL_ENV=1`, `OPENCLAW_SHELL_ENV_TIMEOUT_MS=15000`။

### ၅၀။ ကျွန်ုပ်သည် COPILOTGITHUBTOKEN ကို သတ်မှတ်ထားသော်လည်း models status တွင် Shell env off ဟု ပြနေသည်မှာ ဘာကြောင့်လဲ

`openclaw models status` reports whether **shell env import** is enabled. "Shell env: off"
does **not** mean your env vars are missing - it just means OpenClaw won't load
your login shell automatically.

If the Gateway runs as a service (launchd/systemd), it won't inherit your shell
environment. Fix by doing one of these:

1. Put the token in `~/.openclaw/.env`:

   ```
   COPILOT_GITHUB_TOKEN=...
   ```

2. Or enable shell import (`env.shellEnv.enabled: true`).

3. Or add it to your config `env` block (applies only if missing).

Then restart the gateway and recheck:

```bash
openclaw models status
```

Copilot tokens are read from `COPILOT_GITHUB_TOKEN` (also `GH_TOKEN` / `GITHUB_TOKEN`).
See [/concepts/model-providers](/concepts/model-providers) and [/environment](/help/environment).

## Sessions and multiple chats

### How do I start a fresh conversation

Send `/new` or `/reset` as a standalone message. See [Session management](/concepts/session).

### Do sessions reset automatically if I never send new

Yes. Sessions expire after `session.idleMinutes` (default **60**). The **next**
message starts a fresh session id for that chat key. This does not delete
transcripts - it just starts a new session.

```json5
{
  session: {
    idleMinutes: 240,
  },
}
```

### Is there a way to make a team of OpenClaw instances one CEO and many agents

Yes, via **multi-agent routing** and **sub-agents**. You can create one coordinator
agent and several worker agents with their own workspaces and models.

That said, this is best seen as a **fun experiment**. It is token heavy and often
less efficient than using one bot with separate sessions. The typical model we
envision is one bot you talk to, with different sessions for parallel work. That
bot can also spawn sub-agents when needed.

Docs: [Multi-agent routing](/concepts/multi-agent), [Sub-agents](/tools/subagents), [Agents CLI](/cli/agents).

### Why did context get truncated midtask How do I prevent it

Session context is limited by the model window. Long chats, large tool outputs, or many
files can trigger compaction or truncation.

What helps:

- Ask the bot to summarize the current state and write it to a file.
- Use `/compact` before long tasks, and `/new` when switching topics.
- Keep important context in the workspace and ask the bot to read it back.
- Use sub-agents for long or parallel work so the main chat stays smaller.
- Pick a model with a larger context window if this happens often.

### How do I completely reset OpenClaw but keep it installed

Use the reset command:

```bash
openclaw reset
```

Non-interactive full reset:

```bash
openclaw reset --scope full --yes --non-interactive
```

Then re-run onboarding:

```bash
openclaw onboard --install-daemon
```

မှတ်ချက်များ-

- The onboarding wizard also offers **Reset** if it sees an existing config. See [Wizard](/start/wizard).
- If you used profiles (`--profile` / `OPENCLAW_PROFILE`), reset each state dir (defaults are `~/.openclaw-<profile>`).
- Dev reset: `openclaw gateway --dev --reset` (dev-only; wipes dev config + credentials + sessions + workspace).

### Im getting context too large errors how do I reset or compact

အောက်ပါထဲမှ တစ်ခုကို အသုံးပြုပါ:

- **Compact** (keeps the conversation but summarizes older turns):

  ```
  /compact
  ```

  or `/compact <instructions>` to guide the summary.

- **Reset** (fresh session ID for the same chat key):

  ```
  /new
  /reset
  ```

If it keeps happening:

- Enable or tune **session pruning** (`agents.defaults.contextPruning`) to trim old tool output.
- Use a model with a larger context window.

Docs: [Compaction](/concepts/compaction), [Session pruning](/concepts/session-pruning), [Session management](/concepts/session).

### Why am I seeing LLM request rejected messagesNcontentXtooluseinput Field required

This is a provider validation error: the model emitted a `tool_use` block without the required
`input`. It usually means the session history is stale or corrupted (often after long threads
or a tool/schema change).

Fix: start a fresh session with `/new` (standalone message).

### Why am I getting heartbeat messages every 30 minutes

Heartbeats run every **30m** by default. Tune or disable them:

```json5
{
  agents: {
    defaults: {
      heartbeat: {
        every: "2h", // or "0m" to disable
      },
    },
  },
}
```

If `HEARTBEAT.md` exists but is effectively empty (only blank lines and markdown
headers like `# Heading`), OpenClaw skips the heartbeat run to save API calls.
ဖိုင် မရှိပါက heartbeat သည် ဆက်လက် လည်ပတ်ပြီး မော်ဒယ်က ဘာလုပ်မည်ကို ဆုံးဖြတ်ပါသည်။

Per-agent overrides use `agents.list[].heartbeat`. Docs: [Heartbeat](/gateway/heartbeat).

### Do I need to add a bot account to a WhatsApp group

No. OpenClaw runs on **your own account**, so if you're in the group, OpenClaw can see it.
By default, group replies are blocked until you allow senders (`groupPolicy: "allowlist"`).

If you want only **you** to be able to trigger group replies:

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

### How do I get the JID of a WhatsApp group

Option 1 (fastest): tail logs and send a test message in the group:

```bash
openclaw logs --follow --json
```

Look for `chatId` (or `from`) ending in `@g.us`, like:
`1234567890-1234567890@g.us`.

Option 2 (if already configured/allowlisted): list groups from config:

```bash
openclaw directory groups list --channel whatsapp
```

Docs: [WhatsApp](/channels/whatsapp), [Directory](/cli/directory), [Logs](/cli/logs).

### Why doesnt OpenClaw reply in a group

Two common causes:

- Mention gating is on (default). You must @mention the bot (or match `mentionPatterns`).
- You configured `channels.whatsapp.groups` without `"*"` and the group isn't allowlisted.

See [Groups](/channels/groups) and [Group messages](/channels/group-messages).

### Do groupsthreads share context with DMs

Direct chats collapse to the main session by default. Groups/channels have their own session keys, and Telegram topics / Discord threads are separate sessions. See [Groups](/channels/groups) and [Group messages](/channels/group-messages).

### How many workspaces and agents can I create

No hard limits. Dozens (even hundreds) are fine, but watch for:

- **Disk growth:** sessions + transcripts live under `~/.openclaw/agents/<agentId>/sessions/`.
- **Token cost:** more agents means more concurrent model usage.
- **Ops overhead:** per-agent auth profiles, workspaces, and channel routing.

အကြံပြုချက်များ-

- Keep one **active** workspace per agent (`agents.defaults.workspace`).
- Prune old sessions (delete JSONL or store entries) if disk grows.
- Use `openclaw doctor` to spot stray workspaces and profile mismatches.

### Can I run multiple bots or chats at the same time Slack and how should I set that up

Yes. Use **Multi-Agent Routing** to run multiple isolated agents and route inbound messages by
channel/account/peer. Slack ကို channel တစ်ခုအဖြစ် ပံ့ပိုးထားပြီး သတ်မှတ်ထားသော agent များနှင့် ချိတ်ဆက်နိုင်ပါသည်။

Browser အသုံးပြုခွင့်သည် အားကောင်းသော်လည်း လူတစ်ယောက်လုပ်နိုင်သမျှ အရာအားလုံးကို မလုပ်နိုင်ပါ — anti-bot၊ CAPTCHA များနှင့် MFA တို့က automation ကို တားဆီးနိုင်ပါသေးသည်။ အယုံကြည်ရဆုံး browser ထိန်းချုပ်မှုအတွက် browser ကို chạy နေသော စက်ပေါ်တွင် Chrome extension relay ကို အသုံးပြုပါ (Gateway ကို မည်သည့်နေရာတွင်မဆို ထားနိုင်ပါသည်)။

အကောင်းဆုံး လုပ်ထုံးလုပ်နည်း setup:

- အမြဲတမ်းအလုပ်လုပ်နေသော Gateway host (VPS/Mac mini)။
- အခန်းကဏ္ဍတစ်ခုစီအတွက် agent တစ်ခုစီ (bindings)။
- ထို agent များနှင့် ချိတ်ဆက်ထားသော Slack channel(များ)။
- လိုအပ်သည့်အခါ extension relay (သို့မဟုတ် node) ဖြင့် local browser ကို အသုံးပြုပါ။

Docs: [Multi-Agent Routing](/concepts/multi-agent), [Slack](/channels/slack),
[Browser](/tools/browser), [Chrome extension](/tools/chrome-extension), [Nodes](/nodes)။

## Models: defaults, selection, aliases, switching

### မူလ model ဆိုတာ ဘာလဲ

OpenClaw ၏ မူလ model သည် သင်သတ်မှတ်ထားသည့် အောက်ပါအတိုင်း ဖြစ်ပါသည်:

```
agents.defaults.model.primary
```

Models များကို `provider/model` အဖြစ် ရည်ညွှန်းပါသည် (ဥပမာ: `anthropic/claude-opus-4-6`)။ provider ကို မထည့်သွင်းပါက OpenClaw သည် ယာယီ deprecation fallback အဖြစ် `anthropic` ဟု ယူဆပါသည် — သို့သော် သင်သည် `provider/model` ကို **ရှင်းလင်းစွာ** သတ်မှတ်သင့်ပါသည်။

### ဘယ် model ကို အကြံပြုပါသလဲ

**အကြံပြုထားသော မူလ:** `anthropic/claude-opus-4-6`။
**ကောင်းသော အခြားရွေးချယ်မှု:** `anthropic/claude-sonnet-4-5`။
**ယုံကြည်စိတ်ချရ (စာလုံးအရေအတွက် နည်း):** `openai/gpt-5.2` — Opus နီးပါးကောင်းမွန်သော်လည်း ကိုယ်ရည်ကိုယ်သွေး နည်းပါးပါသည်။
**ဘတ်ဂျက်:** `zai/glm-4.7`။

MiniMax M2.1 တွင် ကိုယ်ပိုင် docs ရှိပါသည်: [MiniMax](/providers/minimax) နှင့်
[Local models](/gateway/local-models)။

အတွေ့အကြုံအရ စည်းမျဉ်း: အရေးကြီးသော လုပ်ငန်းများအတွက် **သင်တတ်နိုင်သမျှ အကောင်းဆုံး model** ကို အသုံးပြုပါ၊ ပုံမှန် chat သို့မဟုတ် အကျဉ်းချုပ်များအတွက် စျေးသက်သာသော model ကို အသုံးပြုပါ။ agent တစ်ခုစီအလိုက် model များကို route လုပ်နိုင်ပြီး sub-agent များကို အသုံးပြု၍ အချိန်ကြာသော လုပ်ငန်းများကို parallelize လုပ်နိုင်ပါသည် (sub-agent တစ်ခုစီသည် token များကို အသုံးပြုပါသည်)။ ကြည့်ပါ [Models](/concepts/models) နှင့်
[Sub-agents](/tools/subagents)။

သတိပေးချက် အပြင်းအထန်: အားနည်းသော သို့မဟုတ် အလွန်အမင်း quantize လုပ်ထားသော model များသည် prompt injection နှင့် မလုံခြုံသော အပြုအမူများကို ပိုမိုခံစားရလွယ်ကူပါသည်။ ကြည့်ပါ [Security](/gateway/security)။

နောက်ထပ် အကြောင်းအရာ: [Models](/concepts/models)။

### selfhosted models llamacpp vLLM Ollama ကို အသုံးပြုနိုင်ပါသလား

Yes. သင်၏ local server သည် OpenAI-compatible API ကို ဖော်ထုတ်ထားပါက custom provider တစ်ခုအဖြစ် ချိတ်ဆက်နိုင်ပါသည်။ Ollama ကို တိုက်ရိုက် ပံ့ပိုးထားပြီး အလွယ်ကူဆုံး လမ်းကြောင်း ဖြစ်ပါသည်။

လုံခြုံရေး မှတ်ချက်: အရွယ်သေး သို့မဟုတ် အလွန်အမင်း quantize လုပ်ထားသော model များသည် prompt injection ကို ပိုမို ခံစားရလွယ်ကူပါသည်။ tool များကို အသုံးပြုနိုင်သော bot များအတွက် **model အရွယ်ကြီးများ** ကို အသုံးပြုရန် ကျွန်ုပ်တို့ ပြင်းပြင်းထန်ထန် အကြံပြုပါသည်။
model အရွယ်သေးများကို ဆက်လက် အသုံးပြုလိုပါက sandboxing နှင့် တင်းကျပ်သော tool allowlists များကို ဖွင့်ထားပါ။

Docs: [Ollama](/providers/ollama), [Local models](/gateway/local-models),
[Model providers](/concepts/model-providers), [Security](/gateway/security),
[Sandboxing](/gateway/sandboxing)။

### config ကို မဖျက်ဘဲ model များကို ဘယ်လို ပြောင်းလဲရမလဲ

**model commands** ကို အသုံးပြုပါ သို့မဟုတ် **model** fields များကိုသာ ပြင်ဆင်ပါ။ config တစ်ခုလုံးကို အစားထိုးခြင်းကို ရှောင်ပါ။

လုံခြုံသော ရွေးချယ်မှုများ:

- chat ထဲတွင် `/model` (မြန်ဆန်ပြီး session အလိုက်)
- `openclaw models set ...` (model config ကိုသာ update လုပ်သည်)
- `openclaw configure --section model` (interactive)
- `~/.openclaw/openclaw.json` ထဲရှိ `agents.defaults.model` ကို ပြင်ဆင်ပါ

config တစ်ခုလုံးကို အစားထိုးလိုခြင်း မရှိပါက partial object ဖြင့် `config.apply` ကို ရှောင်ပါ။
config ကို မတော်တဆ overwrite လုပ်ခဲ့ပါက backup မှ ပြန်လည် restore လုပ်ပါ သို့မဟုတ် ပြုပြင်ရန် `openclaw doctor` ကို ပြန်လည် chạy ပါ။

Docs: [Models](/concepts/models), [Configure](/cli/configure), [Config](/cli/config), [Doctor](/gateway/doctor)။

### OpenClaw, Flawd နှင့် Krill တို့သည် model အတွက် ဘာကို အသုံးပြုပါသလဲ

- **OpenClaw + Flawd:** Anthropic Opus (`anthropic/claude-opus-4-6`) — ကြည့်ပါ [Anthropic](/providers/anthropic)။
- **Krill:** MiniMax M2.1 (`minimax/MiniMax-M2.1`) — ကြည့်ပါ [MiniMax](/providers/minimax)။

### ပြန်လည်စတင်ရန် မလိုဘဲ model များကို ချက်ချင်း ဘယ်လို ပြောင်းလဲရမလဲ

standalone message အဖြစ် `/model` command ကို အသုံးပြုပါ:

```
/model sonnet
/model haiku
/model opus
/model gpt
/model gpt-mini
/model gemini
/model gemini-flash
```

You can list available models with `/model`, `/model list`, or `/model status`.

`/model` (and `/model list`) shows a compact, numbered picker. Select by number:

```
/model 3
```

You can also force a specific auth profile for the provider (per session):

```
/model opus@anthropic:default
/model opus@anthropic:work
```

Tip: `/model status` shows which agent is active, which `auth-profiles.json` file is being used, and which auth profile will be tried next.
It also shows the configured provider endpoint (`baseUrl`) and API mode (`api`) when available.

**How do I unpin a profile I set with profile**

Re-run `/model` **without** the `@profile` suffix:

```
/model anthropic/claude-opus-4-6
```

If you want to return to the default, pick it from `/model` (or send `/model <default provider/model>`).
Use `/model status` to confirm which auth profile is active.

### Can I use GPT 5.2 for daily tasks and Codex 5.3 for coding

Yes. Set one as default and switch as needed:

- **Quick switch (per session):** `/model gpt-5.2` for daily tasks, `/model gpt-5.3-codex` for coding.
- **Default + switch:** set `agents.defaults.model.primary` to `openai/gpt-5.2`, then switch to `openai-codex/gpt-5.3-codex` when coding (or the other way around).
- **Sub-agents:** route coding tasks to sub-agents with a different default model.

See [Models](/concepts/models) and [Slash commands](/tools/slash-commands).

### Why do I see Model is not allowed and then no reply

If `agents.defaults.models` is set, it becomes the **allowlist** for `/model` and any
session overrides. Choosing a model that isn't in that list returns:

```
Model "provider/model" is not allowed. Use /model to list available models.
```

That error is returned **instead of** a normal reply. Fix: add the model to
`agents.defaults.models`, remove the allowlist, or pick a model from `/model list`.

### Why do I see Unknown model minimaxMiniMaxM21

This means the **provider isn't configured** (no MiniMax provider config or auth
profile was found), so the model can't be resolved. A fix for this detection is
in **2026.1.12** (unreleased at the time of writing).

Fix checklist:

1. Upgrade to **2026.1.12** (or run from source `main`), then restart the gateway.
2. Make sure MiniMax is configured (wizard or JSON), or that a MiniMax API key
   exists in env/auth profiles so the provider can be injected.
3. Use the exact model id (case-sensitive): `minimax/MiniMax-M2.1` or
   `minimax/MiniMax-M2.1-lightning`.
4. Run:

   ```bash
   openclaw models list
   ```

   and pick from the list (or `/model list` in chat).

See [MiniMax](/providers/minimax) and [Models](/concepts/models).

### Can I use MiniMax as my default and OpenAI for complex tasks

Yes. Use **MiniMax as the default** and switch models **per session** when needed.
Fallbacks are for **errors**, not "hard tasks," so use `/model` or a separate agent.

**Option A: switch per session**

```json5
{
  env: { MINIMAX_API_KEY: "sk-...", OPENAI_API_KEY: "sk-..." },
  agents: {
    defaults: {
      model: { primary: "minimax/MiniMax-M2.1" },
      models: {
        "minimax/MiniMax-M2.1": { alias: "minimax" },
        "openai/gpt-5.2": { alias: "gpt" },
      },
    },
  },
}
```

ထို့နောက်:

```
/model gpt
```

**Option B: separate agents**

- Agent A default: MiniMax
- Agent B default: OpenAI
- Route by agent or use `/agent` to switch

Docs: [Models](/concepts/models), [Multi-Agent Routing](/concepts/multi-agent), [MiniMax](/providers/minimax), [OpenAI](/providers/openai).

### Are opus sonnet gpt builtin shortcuts

Yes. OpenClaw ships a few default shorthands (only applied when the model exists in `agents.defaults.models`):

- `opus` → `anthropic/claude-opus-4-6`
- `sonnet` → `anthropic/claude-sonnet-4-5`
- `gpt` → `openai/gpt-5.2`
- `gpt-mini` → `openai/gpt-5-mini`
- `gemini` → `google/gemini-3-pro-preview`
- `gemini-flash` → `google/gemini-3-flash-preview`

နာမည်တူ alias ကို သင်ကိုယ်တိုင် သတ်မှတ်ထားပါက သင့်တန်ဖိုးက ဦးစားပေး အသုံးပြုမည် ဖြစ်သည်။

### Model shortcut alias တွေကို ဘယ်လို သတ်မှတ်/override လုပ်ရမလဲ

Alias များသည် `agents.defaults.models.<modelId>` မှ လာပါသည်.alias\`. ဥပမာ:

```json5
{
  agents: {
    defaults: {
      model: { primary: "anthropic/claude-opus-4-6" },
      models: {
        "anthropic/claude-opus-4-6": { alias: "opus" },
        "anthropic/claude-sonnet-4-5": { alias: "sonnet" },
        "anthropic/claude-haiku-4-5": { alias: "haiku" },
      },
    },
  },
}
```

ထို့နောက် `/model sonnet` (သို့မဟုတ် support ရှိပါက `/<alias>`) ကို အသုံးပြုလျှင် 해당 model ID သို့ resolve ဖြစ်သွားပါသည်။

### OpenRouter သို့မဟုတ် ZAI ကဲ့သို့သော အခြား provider များမှ model များကို မည်သို့ ထည့်ရမလဲ

OpenRouter (token တစ်ခုချင်းအလိုက် ငွေပေးချေ; model များစွာ):

```json5
{
  agents: {
    defaults: {
      model: { primary: "openrouter/anthropic/claude-sonnet-4-5" },
      models: { "openrouter/anthropic/claude-sonnet-4-5": {} },
    },
  },
  env: { OPENROUTER_API_KEY: "sk-or-..." },
}
```

Z.AI (GLM model များ):

```json5
{
  agents: {
    defaults: {
      model: { primary: "zai/glm-4.7" },
      models: { "zai/glm-4.7": {} },
    },
  },
  env: { ZAI_API_KEY: "..." },
}
```

Provider/model ကို reference လုပ်ထားပေမယ့် လိုအပ်တဲ့ provider key မရှိပါက runtime auth error ကို တွေ့ရပါလိမ့်မယ် (ဥပမာ `No API key found for provider "zai"`)။

**Agent အသစ် ထည့်ပြီးနောက် API key မတွေ့ပါ**

အများအားဖြင့် **agent အသစ်** မှာ auth store က အလွတ်ဖြစ်နေခြင်းကို ဆိုလိုပါသည်။ Auth သည် agent တစ်ခုချင်းအလိုက် ဖြစ်ပြီး
အောက်ပါနေရာတွင် သိမ်းဆည်းထားပါသည်:

```
~/.openclaw/agents/<agentId>/agent/auth-profiles.json
```

ဖြေရှင်းရန် နည်းလမ်းများ —

- `openclaw agents add <id>` ကို run လုပ်ပြီး wizard အတွင်း auth ကို configure လုပ်ပါ။
- သို့မဟုတ် main agent ၏ `agentDir` ထဲမှ `auth-profiles.json` ကို agent အသစ်၏ `agentDir` ထဲသို့ copy လုပ်ပါ။

Agent များအကြား `agentDir` ကို မျှဝေအသုံးမပြုပါနှင့်; auth/session collision ဖြစ်စေပါသည်။

## Model failover နှင့် "All models failed"

### Failover က ဘယ်လို အလုပ်လုပ်သလဲ

Failover သည် အဆင့် ၂ ဆင့်ဖြင့် ဖြစ်ပေါ်ပါသည်:

1. Provider တူညီသည့်အတွင်း **Auth profile rotation**
2. `agents.defaults.model.fallbacks` ထဲရှိ နောက်ထပ် မော်ဒယ်သို့ **Model fallback** ပြုလုပ်ခြင်း။

Fail ဖြစ်နေသော profile များတွင် cooldown (exponential backoff) ကို အသုံးပြုသဖြင့် provider က rate-limit ဖြစ်နေသော်လည်း သို့မဟုတ် ယာယီ ပြဿနာရှိနေသော်လည်း OpenClaw က ဆက်လက် ပြန်လည်တုံ့ပြန်နိုင်ပါသည်။

### ဒီ error က ဘာကို ဆိုလိုတာလဲ

```
No credentials found for profile "anthropic:default"
```

System က auth profile ID `anthropic:default` ကို အသုံးပြုရန် ကြိုးစားခဲ့သော်လည်း မျှော်လင့်ထားသော auth store ထဲတွင် credential မတွေ့ရှိခဲ့ခြင်းကို ဆိုလိုပါသည်။

### anthropicdefault profile အတွက် No credentials found ကို ပြုပြင်ရန် checklist

- **Auth profile များရှိရာ နေရာကို အတည်ပြုပါ** (new vs legacy path)
  - လက်ရှိ: `~/.openclaw/agents/<agentId>/agent/auth-profiles.json`
  - Legacy: `~/.openclaw/agent/*` (`openclaw doctor` ဖြင့် migrated လုပ်ထားသည်)
- **Gateway မှ env var ကို load လုပ်ထားကြောင်း အတည်ပြုပါ**
  - Shell ထဲမှာ `ANTHROPIC_API_KEY` ကို set လုပ်ထားပေမယ့် Gateway ကို systemd/launchd ဖြင့် run လုပ်ပါက inherit မလုပ်နိုင်ပါ။ `~/.openclaw/.env` ထဲသို့ ထည့်ပါ သို့မဟုတ် `env.shellEnv` ကို enable လုပ်ပါ။
- **မှန်ကန်တဲ့ agent ကို ပြင်ဆင်နေကြောင်း သေချာပါစေ**
  - Multi-agent setup များတွင် `auth-profiles.json` ဖိုင်များ အများအပြား ရှိနိုင်ပါသည်။
- **Model/auth အခြေအနေကို စစ်ဆေးပါ**
  - Configure လုပ်ထားသော model များနှင့် provider များ authenticate ဖြစ်/မဖြစ်ကို ကြည့်ရန် `openclaw models status` ကို အသုံးပြုပါ။

**No credentials found for profile anthropic အတွက် ပြုပြင်ရန် checklist**

Run သည် Anthropic auth profile တစ်ခုသို့ pin လုပ်ထားသော်လည်း Gateway က ၎င်း၏ auth store ထဲတွင် မတွေ့နိုင်ခြင်းကို ဆိုလိုပါသည်။

- **Setup-token ကို အသုံးပြုပါ**
  - `claude setup-token` ကို run လုပ်ပြီး ထွက်လာသော token ကို `openclaw models auth setup-token --provider anthropic` ဖြင့် paste လုပ်ပါ။
  - Token ကို အခြား machine ပေါ်တွင် ဖန်တီးထားပါက `openclaw models auth paste-token --provider anthropic` ကို အသုံးပြုပါ။

- **API key ကို အသုံးပြုလိုပါက**
  - **Gateway host** ပေါ်ရှိ `~/.openclaw/.env` ထဲသို့ `ANTHROPIC_API_KEY` ကို ထည့်ပါ။
  - မရှိတော့သော profile ကို အတင်းအကျပ် သတ်မှတ်နေသော pinned order များကို ရှင်းလင်းပါ:

    ```bash
    openclaw models auth order clear --provider anthropic
    ```

- **Gateway host ပေါ်တွင်ပဲ command များကို run လုပ်နေကြောင်း အတည်ပြုပါ**
  - Remote mode တွင် auth profile များသည် သင့် laptop ပေါ်မဟုတ်ဘဲ gateway machine ပေါ်တွင်သာ ရှိပါသည်။

### ဘာကြောင့် Google Gemini ကိုပါ စမ်းပြီး fail ဖြစ်သွားတာလဲ

သင့် model config မှာ Google Gemini ကို fallback အဖြစ် ထည့်ထားတာ (သို့) Gemini shorthand ကို ပြောင်းသုံးထားရင် OpenClaw က model fallback လုပ်စဉ်မှာ အဲဒါကို စမ်းကြည့်ပါလိမ့်မယ်။ Google credentials ကို မသတ်မှတ်ထားရင် `No API key found for provider "google"` လို့ တွေ့ရပါလိမ့်မယ်။

ပြုပြင်ရန်: Google auth ကို ပေးပါ၊ သို့မဟုတ် `agents.defaults.model.fallbacks` / aliases ထဲမှ Google model များကို ဖယ်ရှားပါ သို့မဟုတ် မသုံးပါ။

**LLM request rejected message thinking signature required google antigravity**

အကြောင်းရင်း - session history ထဲမှာ **signature မပါသော thinking blocks** တွေ ပါဝင်နေပါတယ် (အများအားဖြင့် stream ကို အလယ်တန်းမှာ ရပ်သွားတာ / မပြီးဆုံးသွားတာကြောင့်)။ Google Antigravity က thinking blocks အတွက် signatures လိုအပ်ပါတယ်။

ဖြေရှင်းနည်း - OpenClaw က Google Antigravity Claude အတွက် signature မပါတဲ့ thinking blocks တွေကို အခု ဖယ်ရှားပစ်နေပါပြီ။ မသေးခင်ပဲ ထပ်ပေါ်နေသေးရင် **new session** တစ်ခု စတင်ပါ၊ သို့မဟုတ် အဲဒီ agent အတွက် `/thinking off` ကို သတ်မှတ်ပါ။

## Auth profiles: အဲဒါတွေက ဘာလဲ၊ ဘယ်လို စီမံခန့်ခွဲမလဲ

ဆက်စပ်: [/concepts/oauth](/concepts/oauth) (OAuth flows, token storage, multi-account patterns)

### auth profile ဆိုတာဘာလဲ

Auth profile ဆိုတာ provider တစ်ခုနဲ့ ချိတ်ထားတဲ့ အမည်ပေးထားသော credential record (OAuth သို့မဟုတ် API key) ဖြစ်ပါတယ်။ Profiles တွေက ဒီနေရာမှာ ရှိပါတယ်:

```
~/.openclaw/agents/<agentId>/agent/auth-profiles.json
```

### ပုံမှန် profile IDs တွေက ဘာတွေလဲ

OpenClaw က provider-prefixed IDs တွေကို အသုံးပြုပါတယ်၊ ဥပမာ:

- `anthropic:default` (email identity မရှိတဲ့အခါ ပုံမှန်တွေ့ရတတ်)
- OAuth identity အတွက် `anthropic:<email>`
- သင်ရွေးချယ်ထားတဲ့ custom IDs (ဥပမာ `anthropic:work`)

### ဘယ် auth profile ကို အရင် စမ်းမလဲဆိုတာ ကိုယ်တိုင် ထိန်းချုပ်လို့ ရပါသလား

Yes. Config မှာ profiles အတွက် optional metadata နဲ့ provider အလိုက် ordering (`auth.order.<provider>` ကို ထောက်ပံ့ထားပါတယ်\`)။ ဒါက secrets ကို သိမ်းတာ မဟုတ်ပါဘူး; IDs ကို provider/mode နဲ့ mapping လုပ်ပြီး rotation order ကို သတ်မှတ်ပေးတာပါ။

OpenClaw က profile တစ်ခုကို ခဏတာ **cooldown** (rate limits/timeouts/auth failures) ကြောင့်ဖြစ်စေ၊ ဒါမှမဟုတ် ပိုရှည်တဲ့ **disabled** state (billing/credits မလုံလောက်ခြင်း) ကြောင့်ဖြစ်စေ ယာယီ ကျော်သွားနိုင်ပါတယ်။ ဒါကို စစ်ဆေးချင်ရင် `openclaw models status --json` ကို chạy ပြီး `auth.unusableProfiles` ကို စစ်ကြည့်ပါ။ Tuning: `auth.cooldowns.billingBackoffHours*`

# Defaults to the configured default agent (omit --agent)openclaw models auth order get --provider anthropic# Lock rotation to a single profile (only try this one)openclaw models auth order set --provider anthropic anthropic:default# Or set an explicit order (fallback within provider)openclaw models auth order set --provider anthropic anthropic:work anthropic:default# Clear override (fall back to config auth.order / round-robin)openclaw models auth order clear --provider anthropic

```bash
Agent တစ်ခုကို သီးသန့် ရည်ရွယ်ချင်ရင်:
```

openclaw models auth order set --provider anthropic --agent main anthropic:default

```bash
OAuth နဲ့ API key က ဘာကွာခြားလဲ
```

### OpenClaw က နှစ်မျိုးလုံးကို ထောက်ပံ့ထားပါတယ်:

**OAuth** က (အသုံးပြုနိုင်တဲ့နေရာတွေမှာ) subscription access ကို မကြာခဏ အသုံးချပါတယ်။

- **API keys** က token တစ်ခုချင်းအလိုက် ပေးချေရတဲ့ billing ကို သုံးပါတယ်။
- Wizard က Anthropic setup-token နဲ့ OpenAI Codex OAuth ကို တိတိကျကျ ထောက်ပံ့ပြီး API keys တွေကိုလည်း သင့်အတွက် သိမ်းဆည်းပေးနိုင်ပါတယ်။

Wizard သည် Anthropic setup-token နှင့် OpenAI Codex OAuth ကို တိတိကျကျ support လုပ်ထားပြီး API key များကို သင့်အတွက် သိမ်းဆည်းပေးနိုင်ပါသည်။

## Gateway က ဘယ် port ကို အသုံးပြုလဲ

### Gateway က ဘယ် port ကို သုံးသလဲ

\--port > OPENCLAW_GATEWAY_PORT > gateway.port > default 18789

ဦးစားပေးမှု အစီအစဉ်:

```
ဘာကြောင့် `openclaw gateway status` မှာ Runtime running လို့ ပြပေမယ့် RPC probe failed လို့ ပြတာလဲ
```

### "running" ဆိုတာက **supervisor** (launchd/systemd/schtasks) ရဲ့ မြင်ကွင်းအရ ဖြစ်ပါတယ်။

RPC probe က CLI က gateway WebSocket ကို အမှန်တကယ် ချိတ်ဆက်ပြီး `status` ကို ခေါ်တာ ဖြစ်ပါတယ်။ `openclaw gateway status` ကို သုံးပြီး ဒီလိုင်းတွေကို ယုံကြည်ပါ:

`Probe target:` (probe က အမှန်တကယ် သုံးခဲ့တဲ့ URL)

- `Listening:` (port ပေါ်မှာ အမှန်တကယ် bind လုပ်ထားတာ)
- `Last gateway error:` (process အသက်ရှိပေမယ့် port မနားထောင်နေတဲ့အခါ အများဆုံး ဖြစ်တတ်တဲ့ အကြောင်းရင်း)
- ဘာကြောင့် `openclaw gateway status` မှာ Config cli နဲ့ Config service မတူဘဲ ပြတာလဲ

### သင် config file တစ်ခုကို ပြင်နေချိန်မှာ service က တခြား config တစ်ခုနဲ့ chạy နေပါတယ် (အများအားဖြင့် `--profile` / `OPENCLAW_STATE_DIR` မကိုက်ညီတာကြောင့်)။

openclaw gateway install --force

Fix:

```bash
Service က သုံးစေချင်တဲ့ `--profile` / environment တူညီတဲ့နေရာကနေ အဲဒါကို chạy ပါ။
```

Run that from the same `--profile` / environment you want the service to use.

### another gateway instance is already listening ဆိုတာ ဘာကို ဆိုလိုတာလဲ

OpenClaw enforces a runtime lock by binding the WebSocket listener immediately on startup (default `ws://127.0.0.1:18789`). bind မအောင်မြင်ဘဲ `EADDRINUSE` ဖြစ်ပါက `GatewayLockError` ကို throw လုပ်ပြီး အခြား instance တစ်ခုက နားထောင်နေပြီးသား ဖြစ်ကြောင်း ပြသပါသည်။

ပြုပြင်ရန်: အခြား instance ကို ရပ်ပါ၊ port ကို လွတ်ပေးပါ၊ သို့မဟုတ် `openclaw gateway --port <port>` ဖြင့် run လုပ်ပါ။

### How do I run OpenClaw in remote mode client connects to a Gateway elsewhere

Set `gateway.mode: "remote"` and point to a remote WebSocket URL, optionally with a token/password:

```json5
{
  gateway: {
    mode: "remote",
    remote: {
      url: "ws://gateway.tailnet:18789",
      token: "your-token",
      password: "your-password",
    },
  },
}
```

မှတ်ချက်များ-

- `openclaw gateway` only starts when `gateway.mode` is `local` (or you pass the override flag).
- The macOS app watches the config file and switches modes live when these values change.

### Control UI မှ unauthorized လို့ ပြသခြင်း သို့မဟုတ် ပြန်ပြန် reconnect ဖြစ်နေခြင်း ဖြစ်ရင် ဘာလုပ်ရမလဲ

Your gateway is running with auth enabled (`gateway.auth.*`), but the UI is not sending the matching token/password.

အချက်အလက်များ (code မှ):

- The Control UI stores the token in browser localStorage key `openclaw.control.settings.v1`.

Fix:

- အမြန်ဆုံး: `openclaw dashboard` (dashboard URL ကို print လုပ်ပြီး copy လုပ်ပေးသည်၊ ဖွင့်ရန် ကြိုးစားသည်၊ headless ဖြစ်ပါက SSH hint ကို ပြသည်)။
- If you don't have a token yet: `openclaw doctor --generate-gateway-token`.
- remote ဖြစ်ပါက အရင် tunnel လုပ်ပါ: `ssh -N -L 18789:127.0.0.1:18789 user@host` ပြီးနောက် `http://127.0.0.1:18789/` ကို ဖွင့်ပါ။
- Set `gateway.auth.token` (or `OPENCLAW_GATEWAY_TOKEN`) on the gateway host.
- In the Control UI settings, paste the same token.
- Still stuck? Run `openclaw status --all` and follow [Troubleshooting](/gateway/troubleshooting). See [Dashboard](/web/dashboard) for auth details.

### I set gatewaybind tailnet but it cant bind nothing listens

`tailnet` bind picks a Tailscale IP from your network interfaces (100.64.0.0/10). If the machine isn't on Tailscale (or the interface is down), there's nothing to bind to.

Fix:

- ထို host တွင် Tailscale ကို start လုပ်ပါ (100.x address ရရှိစေရန်)၊ သို့မဟုတ်
- `gateway.bind: "loopback"` / `"lan"` သို့ ပြောင်းပါ။

မှတ်ချက်: `tailnet` ကို တိတိကျကျ သတ်မှတ်ထားသည်။ `auto` prefers loopback; use `gateway.bind: "tailnet"` when you want a tailnet-only bind.

### Can I run multiple Gateways on the same host

Usually no - one Gateway can run multiple messaging channels and agents. Use multiple Gateways only when you need redundancy (ex: rescue bot) or hard isolation.

Yes, but you must isolate:

- `OPENCLAW_CONFIG_PATH` (per-instance config)
- `OPENCLAW_STATE_DIR` (instance တစ်ခုချင်းစီအတွက် state)
- `agents.defaults.workspace` (workspace isolation)
- `gateway.port` (unique ports)

Quick setup (recommended):

- Use `openclaw --profile <name> …` per instance (auto-creates `~/.openclaw-<name>`).
- Set a unique `gateway.port` in each profile config (or pass `--port` for manual runs).
- Install a per-profile service: `openclaw --profile <name> gateway install`.

Profiles also suffix service names (`bot.molt.<profile>`; legacy `com.openclaw.*`, `openclaw-gateway-<profile>.service`, `OpenClaw Gateway (<profile>)`).
Full guide: [Multiple gateways](/gateway/multiple-gateways).

### What does invalid handshake code 1008 mean

The Gateway is a **WebSocket server**, and it expects the very first message to
be a `connect` frame. If it receives anything else, it closes the connection
with **code 1008** (policy violation).

Common causes:

- You opened the **HTTP** URL in a browser (`http://...`) instead of a WS client.
- You used the wrong port or path.
- A proxy or tunnel stripped auth headers or sent a non-Gateway request.

၁။ အမြန်ပြင်ဆင်ချက်များ:

1. ၂။ WS URL ကို အသုံးပြုပါ: `ws://<host>:18789` (သို့မဟုတ် HTTPS ဖြစ်ပါက `wss://...`)။
2. ၃။ ပုံမှန် browser tab တစ်ခုမှာ WS port ကို မဖွင့်ပါနှင့်။
3. ၄။ auth ဖွင့်ထားပါက `connect` frame ထဲမှာ token/password ကို ထည့်ပါ။

၅။ CLI သို့မဟုတ် TUI ကို အသုံးပြုနေပါက URL သည် အောက်ပါအတိုင်း ဖြစ်သင့်ပါသည်:

```
၆။ openclaw tui --url ws://<host>:18789 --token <token>
```

၇။ Protocol အသေးစိတ်: [Gateway protocol](/gateway/protocol)။

## ၈။ Logging နှင့် debugging

### ၉။ logs တွေ ဘယ်မှာလဲ

၁၀။ File logs (structured):

```
/tmp/openclaw/openclaw-YYYY-MM-DD.log
```

၁၁။ `logging.file` ဖြင့် တည်ငြိမ်သော path ကို သတ်မှတ်နိုင်ပါသည်။ ၁၂။ File log level ကို `logging.level` ဖြင့် ထိန်းချုပ်ပါသည်။ ၁၃။ Console verbosity ကို `--verbose` နှင့် `logging.consoleLevel` ဖြင့် ထိန်းချုပ်ပါသည်။

၁၄။ အမြန်ဆုံး log tail:

```bash
openclaw logs --follow
```

၁၅။ Service/supervisor logs (gateway ကို launchd/systemd မှတဆင့် chạy သည့်အခါ):

- ၁၆။ macOS: `$OPENCLAW_STATE_DIR/logs/gateway.log` နှင့် `gateway.err.log` (default: `~/.openclaw/logs/...`; profiles သုံးပါက `~/.openclaw-<profile>/logs/...`)
- ၁၇။ Linux: `journalctl --user -u openclaw-gateway[-<profile>].service -n 200 --no-pager`
- ၁၈။ Windows: `schtasks /Query /TN "OpenClaw Gateway (<profile>)" /V /FO LIST`

၁၉။ ပိုမိုသိရှိရန် [Troubleshooting](/gateway/troubleshooting#log-locations) ကိုကြည့်ပါ။

### ၂၀။ Gateway service ကို ဘယ်လို start/stop/restart လုပ်ရမလဲ

၂၁။ gateway helpers ကို အသုံးပြုပါ:

```bash
၂၂။ openclaw gateway status
openclaw gateway restart
```

၂၃။ gateway ကို လက်ဖြင့် chạy နေပါက `openclaw gateway --force` သည် port ကို ပြန်လည်ရယူနိုင်ပါသည်။ ၂၄။ [Gateway](/gateway) ကို ကြည့်ပါ။

### ၂၅။ Windows မှာ terminal ကို ပိတ်လိုက်ပြီး OpenClaw ကို ဘယ်လို ပြန်စရမလဲ

၂၆။ **Windows install modes နှစ်မျိုး ရှိပါသည်**:

၂၇။ **၁) WSL2 (အကြံပြုထားသည်):** Gateway သည် Linux အတွင်းမှာ chạy ပါသည်။

၂၈။ PowerShell ကို ဖွင့်ပြီး WSL ထဲဝင်ကာ ပြန်စပါ:

```powershell
၂၉။ wsl
openclaw gateway status
openclaw gateway restart
```

၃၀။ service ကို မတပ်ဆင်ခဲ့ပါက foreground မှာ စတင်ပါ:

```bash
openclaw gateway run
```

၃၁။ **၂) Native Windows (မအကြံပြုပါ):** Gateway သည် Windows အပေါ်မှာ တိုက်ရိုက် chạy ပါသည်။

၃၂။ PowerShell ကို ဖွင့်ပြီး အောက်ပါအတိုင်း chạy ပါ:

```powershell
၃၃။ openclaw gateway status
openclaw gateway restart
```

၃၄။ လက်ဖြင့် chạy နေပါက (service မရှိပါက) အောက်ပါကို အသုံးပြုပါ:

```powershell
openclaw gateway run
```

၃၅။ Docs: [Windows (WSL2)](/platforms/windows), [Gateway service runbook](/gateway)။

### ၃၆။ Gateway က chạy နေပြီ ဒါပေမယ့် reply မရောက်ဘူးဆိုရင် ဘာစစ်ဆေးရမလဲ

၃၇။ အမြန် health sweep နဲ့ စပါ:

```bash
၃၈။ openclaw status
openclaw models status
openclaw channels status
openclaw logs --follow
```

၃၉။ အများဆုံး ဖြစ်တတ်သော အကြောင်းရင်းများ:

- ၄၀။ **gateway host** ပေါ်မှာ model auth မတင်ထားခြင်း (`models status` ကို စစ်ပါ)။
- ၄၁။ Channel pairing/allowlist က reply များကို ပိတ်ထားခြင်း (channel config + logs ကို စစ်ပါ)။
- ၄၂။ WebChat/Dashboard ကို token မှန်ကန်မှုမရှိဘဲ ဖွင့်ထားခြင်း။

၄၃။ အဝေးမှ အသုံးပြုနေပါက tunnel/Tailscale connection chạy နေကြောင်းနှင့် Gateway WebSocket ကို ချိတ်ဆက်နိုင်ကြောင်း အတည်ပြုပါ။

၄၄။ Docs: [Channels](/channels), [Troubleshooting](/gateway/troubleshooting), [Remote access](/gateway/remote)။

### ၄၅။ အကြောင်းမရှိဘဲ gateway ကနေ ချိတ်ဆက်ပြတ်သွားတယ်၊ အခု ဘာလုပ်ရမလဲ

၄၆။ ယေဘုယျအားဖြင့် UI က WebSocket connection ကို ပျောက်ဆုံးသွားခြင်းကို ဆိုလိုပါသည်။ ၄၇။ စစ်ဆေးရန်:

1. ၄၈။ Gateway က chạy နေပါသလား `openclaw gateway status`
2. ၄၉။ Gateway က ကျန်းမာနေပါသလား `openclaw status`
3. ၅၀။ UI မှာ token မှန်ကန်မှုရှိပါသလား `openclaw dashboard`
4. If remote, is the tunnel/Tailscale link up?

Then tail logs:

```bash
openclaw logs --follow
```

Docs: [Dashboard](/web/dashboard), [Remote access](/gateway/remote), [Troubleshooting](/gateway/troubleshooting).

### Telegram setMyCommands fails with network errors What should I check

Start with logs and channel status:

```bash
openclaw channels status
openclaw channels logs --channel telegram
```

If you are on a VPS or behind a proxy, confirm outbound HTTPS is allowed and DNS works.
If the Gateway is remote, make sure you are looking at logs on the Gateway host.

Docs: [Telegram](/channels/telegram), [Channel troubleshooting](/channels/troubleshooting).

### TUI shows no output What should I check

First confirm the Gateway is reachable and the agent can run:

```bash
openclaw status
openclaw models status
openclaw logs --follow
```

In the TUI, use `/status` to see the current state. If you expect replies in a chat
channel, make sure delivery is enabled (`/deliver on`).

Docs: [TUI](/web/tui), [Slash commands](/tools/slash-commands).

### How do I completely stop then start the Gateway

If you installed the service:

```bash
openclaw gateway stop
openclaw gateway start
```

ဤအရာသည် **supervised service** (macOS တွင် launchd၊ Linux တွင် systemd) ကို ရပ်တန့်/စတင် လုပ်ပေးသည်။
Use this when the Gateway runs in the background as a daemon.

If you're running in the foreground, stop with Ctrl-C, then:

```bash
openclaw gateway run
```

Docs: [Gateway service runbook](/gateway).

### ELI5 openclaw gateway restart vs openclaw gateway

- `openclaw gateway restart`: restarts the **background service** (launchd/systemd).
- `openclaw gateway`: runs the gateway **in the foreground** for this terminal session.

Service ကို install လုပ်ထားပါက gateway commands ကို အသုံးပြုပါ။ Use `openclaw gateway` when
you want a one-off, foreground run.

### What's the fastest way to get more details when something fails

Start the Gateway with `--verbose` to get more console detail. Then inspect the log file for channel auth, model routing, and RPC errors.

## Media and attachments

### My skill generated an imagePDF but nothing was sent

Outbound attachments from the agent must include a `MEDIA:<path-or-url>` line (on its own line). See [OpenClaw assistant setup](/start/openclaw) and [Agent send](/tools/agent-send).

CLI sending:

```bash
openclaw message send --target +15555550123 --message "Here you go" --media /path/to/file.png
```

Also check:

- The target channel supports outbound media and isn't blocked by allowlists.
- The file is within the provider's size limits (images are resized to max 2048px).

See [Images](/nodes/images).

## Security and access control

### Is it safe to expose OpenClaw to inbound DMs

Treat inbound DMs as untrusted input. Defaults are designed to reduce risk:

- Default behavior on DM-capable channels is **pairing**:
  - Unknown senders receive a pairing code; the bot does not process their message.
  - Approve with: `openclaw pairing approve <channel> <code>`
  - Pending requests are capped at **3 per channel**; check `openclaw pairing list <channel>` if a code didn't arrive.
- Opening DMs publicly requires explicit opt-in (`dmPolicy: "open"` and allowlist `"*"`).

Run `openclaw doctor` to surface risky DM policies.

### Is prompt injection only a concern for public bots

No. Prompt injection is about **untrusted content**, not just who can DM the bot.
If your assistant reads external content (web search/fetch, browser pages, emails,
docs, attachments, pasted logs), that content can include instructions that try
to hijack the model. This can happen even if **you are the only sender**.

The biggest risk is when tools are enabled: the model can be tricked into
exfiltrating context or calling tools on your behalf. Reduce the blast radius by:

- using a read-only or tool-disabled "reader" agent to summarize untrusted content
- keeping `web_search` / `web_fetch` / `browser` off for tool-enabled agents
- sandboxing and strict tool allowlists

Details: [Security](/gateway/security).

### Should my bot have its own email GitHub account or phone number

Yes, for most setups. Bot ကို သီးခြား account များနှင့် ဖုန်းနံပါတ်များဖြင့် သီးခြားထားခြင်းသည် တစ်ခုခုမှားသွားပါက ထိခိုက်မှု အကျယ်အဝန်းကို လျှော့ချနိုင်သည်။ This also makes it easier to rotate
credentials or revoke access without impacting your personal accounts.

သေးသေးလေးကနေ စတင်ပါ။ Give access only to the tools and accounts you actually need, and expand
later if required.

Docs: [Security](/gateway/security), [Pairing](/channels/pairing).

### Can I give it autonomy over my text messages and is that safe

We do **not** recommend full autonomy over your personal messages. The safest pattern is:

- DM များကို **pairing mode** သို့မဟုတ် ခွင့်ပြုစာရင်းကို တင်းကျပ်စွာ သုံးပါ။
- Use a **separate number or account** if you want it to message on your behalf.
- Let it draft, then **approve before sending**.

စမ်းသပ်ချင်ပါက dedicated account တစ်ခုတွင် လုပ်ပြီး သီးခြားထားပါ။ See
[Security](/gateway/security).

### Can I use cheaper models for personal assistant tasks

Yes, **if** the agent is chat-only and the input is trusted. Smaller tiers are
more susceptible to instruction hijacking, so avoid them for tool-enabled agents
or when reading untrusted content. If you must use a smaller model, lock down
tools and run inside a sandbox. See [Security](/gateway/security).

### I ran start in Telegram but didnt get a pairing code

Pairing codes are sent **only** when an unknown sender messages the bot and
`dmPolicy: "pairing"` is enabled. `/start` by itself doesn't generate a code.

Check pending requests:

```bash
openclaw pairing list telegram
```

If you want immediate access, allowlist your sender id or set `dmPolicy: "open"`
for that account.

### WhatsApp will it message my contacts How does pairing work

No. Default WhatsApp DM policy is **pairing**. Unknown senders only get a pairing code and their message is **not processed**. OpenClaw only replies to chats it receives or to explicit sends you trigger.

Approve pairing with:

```bash
openclaw pairing approve whatsapp <code>
```

List pending requests:

```bash
openclaw pairing list whatsapp
```

Wizard phone number prompt: it's used to set your **allowlist/owner** so your own DMs are permitted. It's not used for auto-sending. If you run on your personal WhatsApp number, use that number and enable `channels.whatsapp.selfChatMode`.

## Chat commands, aborting tasks, and "it won't stop"

### How do I stop internal system messages from showing in chat

Most internal or tool messages only appear when **verbose** or **reasoning** is enabled
for that session.

Fix in the chat where you see it:

```
/verbose off
/reasoning off
```

၁။ အကယ်၍ အသံအချက်အလက်များ (log) များနေဆဲဖြစ်ပါက Control UI ထဲရှိ session settings ကိုစစ်ဆေးပြီး verbose ကို **inherit** သို့ သတ်မှတ်ပါ။ ၂။ config ထဲတွင် `verboseDefault` ကို `on` သတ်မှတ်ထားသော bot profile ကို မသုံးထားကြောင်းလည်း အတည်ပြုပါ။

Docs: [Thinking and verbose](/tools/thinking), [Security](/gateway/security#reasoning--verbose-output-in-groups).

### ၄။ လည်ပတ်နေသော task ကို မည်သို့ ရပ်/ပယ်ဖျက် (stop/cancel) ရမလဲ

ဤအရာများထဲမှ တစ်ခုခုကို **standalone message အဖြစ်** (slash မပါဘဲ) ပို့ပါ။

```
၆။ stop
abort
esc
wait
exit
interrupt
```

ဤအရာများသည် abort trigger များဖြစ်သည် (slash command မဟုတ်ပါ)။

exec tool မှ background process များအတွက် agent ကို အောက်ပါအတိုင်း run လုပ်ခိုင်းနိုင်ပါသည်:

```
၉။ process action:kill sessionId:XXX
```

၁၀။ Slash commands အကျဉ်းချုပ်: [Slash commands](/tools/slash-commands) တွင် ကြည့်ပါ။

၁၁။ Command အများစုကို `/` ဖြင့် စတင်သော **သီးသန့်** message အဖြစ်ပို့ရပါသည်၊ သို့သော် `/status` ကဲ့သို့ shortcut အချို့သည် allowlisted senders များအတွက် inline အဖြစ်လည်း အလုပ်လုပ်ပါသည်။

### ၁၂။ Telegram မှ Discord သို့ message ပို့ရန် မည်သို့လုပ်ရမလဲ — Cross-context messaging ကို ခွင့်မပြုထားပါ

OpenClaw သည် default အနေဖြင့် **cross-provider** messaging ကို ပိတ်ထားပါသည်။ ၁၄။ Tool call တစ်ခုကို Telegram နှင့် ချိတ်ထားပါက၊ သင်က သီးသန့် ခွင့်မပြုမချင်း Discord သို့ မပို့ပါ။

Agent အတွက် cross-provider messaging ကို ဖွင့်ရန်:

```json5
၁၆။ {
  agents: {
    defaults: {
      tools: {
        message: {
          crossContext: {
            allowAcrossProviders: true,
            marker: { enabled: true, prefix: "[from {channel}] " },
          },
        },
      },
    },
  },
}
```

Config ကို ပြင်ပြီးနောက် gateway ကို restart လုပ်ပါ။ ၁၈။ Agent တစ်ခုတည်းအတွက်သာ လိုအပ်ပါက `agents.list[].tools.message` အောက်တွင် သတ်မှတ်ပါ။

### ၁၉။ Bot က မြန်မြန်ဆန်ဆန် ပို့သော message များကို လစ်လျူရှုသလို ခံစားရတာ ဘာကြောင့်လဲ

၂၀။ Queue mode သည် လက်ရှိ လည်ပတ်နေသော run နှင့် message အသစ်များ မည်သို့ အပြန်အလှန် သက်ရောက်မည်ကို ထိန်းချုပ်ပါသည်။ ၂၁။ Mode များ ပြောင်းရန် `/queue` ကို သုံးပါ:

- ၂၂။ `steer` - message အသစ်များသည် လက်ရှိ task ကို ဦးတည်ပြောင်းလဲစေသည်
- ၂၃။ `followup` - message များကို တစ်ကြိမ်လျှင် တစ်ခုစီ run လုပ်သည်
- ၂၄။ `collect` - message များကို စုစည်းပြီး တစ်ကြိမ်တည်း ပြန်လည်ဖြေကြားသည် (default)
- ၂၅။ `steer-backlog` - ယခုပဲ ဦးတည်ပြောင်းလဲပြီး နောက်ကျန် backlog ကို ဆက်လက်လုပ်ဆောင်သည်
- ၂၆။ `interrupt` - လက်ရှိ run ကို ပယ်ဖျက်ပြီး အသစ်စတင်သည်

followup mode များအတွက် `debounce:2s cap:25 drop:summarize` ကဲ့သို့ option များကို ထည့်နိုင်ပါသည်။

## စကရင်ရှော့/ချက်တ်မှတ်တမ်းထဲက တိတိကျကျ မေးထားသော မေးခွန်းကို ဖြေပါ

၂၉။ **မေးခွန်း: "Anthropic ကို API key ဖြင့် သုံးသောအခါ default model က ဘာလဲ?"**

၃၀။ **အဖြေ:** OpenClaw တွင် credentials နှင့် model ရွေးချယ်မှုကို သီးခြားထားရှိပါသည်။ `ANTHROPIC_API_KEY` ကို သတ်မှတ်ခြင်း (သို့မဟုတ် auth profiles ထဲမှာ Anthropic API key ကို သိမ်းဆည်းခြင်း) က authentication ကို ဖွင့်ပေးပေမယ့်၊ အမှန်တကယ် အသုံးပြုမယ့် default model က `agents.defaults.model.primary` မှာ သင်သတ်မှတ်ထားတဲ့ အရာပဲ ဖြစ်ပါတယ် (ဥပမာ `anthropic/claude-sonnet-4-5` သို့မဟုတ် `anthropic/claude-opus-4-6`)။ ၃၂။ `No credentials found for profile "anthropic:default"` ကို တွေ့ပါက၊ Gateway သည် လည်ပတ်နေသော agent အတွက် မျှော်လင့်ထားသည့် `auth-profiles.json` ထဲတွင် Anthropic credentials ကို မတွေ့ရှိနိုင်ခဲ့ခြင်းကို ဆိုလိုပါသည်။

---

၃၃။ မဖြေရှင်းနိုင်သေးပါသလား? ၃၄။ [Discord](https://discord.com/invite/clawd) တွင် မေးမြန်းပါ သို့မဟုတ် [GitHub discussion](https://github.com/openclaw/openclaw/discussions) ကို ဖွင့်ပါ။
