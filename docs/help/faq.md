---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
summary: "Frequently asked questions about OpenClaw setup, configuration, and usage"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
title: "FAQ"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# FAQ（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Quick answers plus deeper troubleshooting for real-world setups (local dev, VPS, multi-agent, OAuth/API keys, model failover). For runtime diagnostics, see [Troubleshooting](/gateway/troubleshooting). For the full config reference, see [Configuration](/gateway/configuration).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Table of contents（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- [Quick start and first-run setup]（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - [Im stuck whats the fastest way to get unstuck?](#im-stuck-whats-the-fastest-way-to-get-unstuck)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - [What's the recommended way to install and set up OpenClaw?](#whats-the-recommended-way-to-install-and-set-up-openclaw)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - [How do I open the dashboard after onboarding?](#how-do-i-open-the-dashboard-after-onboarding)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - [How do I authenticate the dashboard (token) on localhost vs remote?](#how-do-i-authenticate-the-dashboard-token-on-localhost-vs-remote)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - [What runtime do I need?](#what-runtime-do-i-need)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - [Does it run on Raspberry Pi?](#does-it-run-on-raspberry-pi)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - [Any tips for Raspberry Pi installs?](#any-tips-for-raspberry-pi-installs)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - [It is stuck on "wake up my friend" / onboarding will not hatch. What now?](#it-is-stuck-on-wake-up-my-friend-onboarding-will-not-hatch-what-now)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - [Can I migrate my setup to a new machine (Mac mini) without redoing onboarding?](#can-i-migrate-my-setup-to-a-new-machine-mac-mini-without-redoing-onboarding)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - [Where do I see what is new in the latest version?](#where-do-i-see-what-is-new-in-the-latest-version)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - [I can't access docs.openclaw.ai (SSL error). What now?](#i-cant-access-docsopenclawai-ssl-error-what-now)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - [What's the difference between stable and beta?](#whats-the-difference-between-stable-and-beta)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - [How do I install the beta version, and what's the difference between beta and dev?](#how-do-i-install-the-beta-version-and-whats-the-difference-between-beta-and-dev)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - [How do I try the latest bits?](#how-do-i-try-the-latest-bits)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - [How long does install and onboarding usually take?](#how-long-does-install-and-onboarding-usually-take)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - [Installer stuck? How do I get more feedback?](#installer-stuck-how-do-i-get-more-feedback)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - [Windows install says git not found or openclaw not recognized](#windows-install-says-git-not-found-or-openclaw-not-recognized)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - [The docs didn't answer my question - how do I get a better answer?](#the-docs-didnt-answer-my-question-how-do-i-get-a-better-answer)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - [How do I install OpenClaw on Linux?](#how-do-i-install-openclaw-on-linux)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - [How do I install OpenClaw on a VPS?](#how-do-i-install-openclaw-on-a-vps)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - [Where are the cloud/VPS install guides?](#where-are-the-cloudvps-install-guides)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - [Can I ask OpenClaw to update itself?](#can-i-ask-openclaw-to-update-itself)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - [What does the onboarding wizard actually do?](#what-does-the-onboarding-wizard-actually-do)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - [Do I need a Claude or OpenAI subscription to run this?](#do-i-need-a-claude-or-openai-subscription-to-run-this)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - [Can I use Claude Max subscription without an API key](#can-i-use-claude-max-subscription-without-an-api-key)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - [How does Anthropic "setup-token" auth work?](#how-does-anthropic-setuptoken-auth-work)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - [Where do I find an Anthropic setup-token?](#where-do-i-find-an-anthropic-setuptoken)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - [Do you support Claude subscription auth (Claude Pro or Max)?](#do-you-support-claude-subscription-auth-claude-pro-or-max)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - [Why am I seeing `HTTP 429: rate_limit_error` from Anthropic?](#why-am-i-seeing-http-429-ratelimiterror-from-anthropic)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - [Is AWS Bedrock supported?](#is-aws-bedrock-supported)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - [How does Codex auth work?](#how-does-codex-auth-work)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - [Do you support OpenAI subscription auth (Codex OAuth)?](#do-you-support-openai-subscription-auth-codex-oauth)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - [How do I set up Gemini CLI OAuth](#how-do-i-set-up-gemini-cli-oauth)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - [Is a local model OK for casual chats?](#is-a-local-model-ok-for-casual-chats)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - [How do I keep hosted model traffic in a specific region?](#how-do-i-keep-hosted-model-traffic-in-a-specific-region)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - [Do I have to buy a Mac Mini to install this?](#do-i-have-to-buy-a-mac-mini-to-install-this)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - [Do I need a Mac mini for iMessage support?](#do-i-need-a-mac-mini-for-imessage-support)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - [If I buy a Mac mini to run OpenClaw, can I connect it to my MacBook Pro?](#if-i-buy-a-mac-mini-to-run-openclaw-can-i-connect-it-to-my-macbook-pro)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - [Can I use Bun?](#can-i-use-bun)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - [Telegram: what goes in `allowFrom`?](#telegram-what-goes-in-allowfrom)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - [Can multiple people use one WhatsApp number with different OpenClaw instances?](#can-multiple-people-use-one-whatsapp-number-with-different-openclaw-instances)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - [Can I run a "fast chat" agent and an "Opus for coding" agent?](#can-i-run-a-fast-chat-agent-and-an-opus-for-coding-agent)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - [Does Homebrew work on Linux?](#does-homebrew-work-on-linux)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - [What's the difference between the hackable (git) install and npm install?](#whats-the-difference-between-the-hackable-git-install-and-npm-install)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - [Can I switch between npm and git installs later?](#can-i-switch-between-npm-and-git-installs-later)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - [Should I run the Gateway on my laptop or a VPS?](#should-i-run-the-gateway-on-my-laptop-or-a-vps)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - [How important is it to run OpenClaw on a dedicated machine?](#how-important-is-it-to-run-openclaw-on-a-dedicated-machine)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - [What are the minimum VPS requirements and recommended OS?](#what-are-the-minimum-vps-requirements-and-recommended-os)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - [Can I run OpenClaw in a VM and what are the requirements](#can-i-run-openclaw-in-a-vm-and-what-are-the-requirements)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- [What is OpenClaw?](#what-is-openclaw)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - [What is OpenClaw, in one paragraph?](#what-is-openclaw-in-one-paragraph)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - [What's the value proposition?](#whats-the-value-proposition)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - [I just set it up what should I do first](#i-just-set-it-up-what-should-i-do-first)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - [What are the top five everyday use cases for OpenClaw](#what-are-the-top-five-everyday-use-cases-for-openclaw)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - [Can OpenClaw help with lead gen outreach ads and blogs for a SaaS](#can-openclaw-help-with-lead-gen-outreach-ads-and-blogs-for-a-saas)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - [What are the advantages vs Claude Code for web development?](#what-are-the-advantages-vs-claude-code-for-web-development)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- [Skills and automation](#skills-and-automation)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - [How do I customize skills without keeping the repo dirty?](#how-do-i-customize-skills-without-keeping-the-repo-dirty)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - [Can I load skills from a custom folder?](#can-i-load-skills-from-a-custom-folder)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - [How can I use different models for different tasks?](#how-can-i-use-different-models-for-different-tasks)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - [The bot freezes while doing heavy work. How do I offload that?](#the-bot-freezes-while-doing-heavy-work-how-do-i-offload-that)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - [Cron or reminders do not fire. What should I check?](#cron-or-reminders-do-not-fire-what-should-i-check)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - [How do I install skills on Linux?](#how-do-i-install-skills-on-linux)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - [Can OpenClaw run tasks on a schedule or continuously in the background?](#can-openclaw-run-tasks-on-a-schedule-or-continuously-in-the-background)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - [Can I run Apple macOS-only skills from Linux?](#can-i-run-apple-macos-only-skills-from-linux)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - [Do you have a Notion or HeyGen integration?](#do-you-have-a-notion-or-heygen-integration)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - [How do I install the Chrome extension for browser takeover?](#how-do-i-install-the-chrome-extension-for-browser-takeover)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- [Sandboxing and memory](#sandboxing-and-memory)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - [Is there a dedicated sandboxing doc?](#is-there-a-dedicated-sandboxing-doc)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - [How do I bind a host folder into the sandbox?](#how-do-i-bind-a-host-folder-into-the-sandbox)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - [How does memory work?](#how-does-memory-work)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - [Memory keeps forgetting things. How do I make it stick?](#memory-keeps-forgetting-things-how-do-i-make-it-stick)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - [Does memory persist forever? What are the limits?](#does-memory-persist-forever-what-are-the-limits)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - [Does semantic memory search require an OpenAI API key?](#does-semantic-memory-search-require-an-openai-api-key)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- [Where things live on disk](#where-things-live-on-disk)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - [Is all data used with OpenClaw saved locally?](#is-all-data-used-with-openclaw-saved-locally)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - [Where does OpenClaw store its data?](#where-does-openclaw-store-its-data)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - [Where should AGENTS.md / SOUL.md / USER.md / MEMORY.md live?](#where-should-agentsmd-soulmd-usermd-memorymd-live)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - [What's the recommended backup strategy?](#whats-the-recommended-backup-strategy)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - [How do I completely uninstall OpenClaw?](#how-do-i-completely-uninstall-openclaw)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - [Can agents work outside the workspace?](#can-agents-work-outside-the-workspace)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - [I'm in remote mode - where is the session store?](#im-in-remote-mode-where-is-the-session-store)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- [Config basics](#config-basics)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - [What format is the config? Where is it?](#what-format-is-the-config-where-is-it)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - [I set `gateway.bind: "lan"` (or `"tailnet"`) and now nothing listens / the UI says unauthorized](#i-set-gatewaybind-lan-or-tailnet-and-now-nothing-listens-the-ui-says-unauthorized)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - [Why do I need a token on localhost now?](#why-do-i-need-a-token-on-localhost-now)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - [Do I have to restart after changing config?](#do-i-have-to-restart-after-changing-config)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - [How do I enable web search (and web fetch)?](#how-do-i-enable-web-search-and-web-fetch)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - [config.apply wiped my config. How do I recover and avoid this?](#configapply-wiped-my-config-how-do-i-recover-and-avoid-this)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - [How do I run a central Gateway with specialized workers across devices?](#how-do-i-run-a-central-gateway-with-specialized-workers-across-devices)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - [Can the OpenClaw browser run headless?](#can-the-openclaw-browser-run-headless)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - [How do I use Brave for browser control?](#how-do-i-use-brave-for-browser-control)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- [Remote gateways and nodes](#remote-gateways-and-nodes)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - [How do commands propagate between Telegram, the gateway, and nodes?](#how-do-commands-propagate-between-telegram-the-gateway-and-nodes)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - [How can my agent access my computer if the Gateway is hosted remotely?](#how-can-my-agent-access-my-computer-if-the-gateway-is-hosted-remotely)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - [Tailscale is connected but I get no replies. What now?](#tailscale-is-connected-but-i-get-no-replies-what-now)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - [Can two OpenClaw instances talk to each other (local + VPS)?](#can-two-openclaw-instances-talk-to-each-other-local-vps)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - [Do I need separate VPSes for multiple agents](#do-i-need-separate-vpses-for-multiple-agents)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - [Is there a benefit to using a node on my personal laptop instead of SSH from a VPS?](#is-there-a-benefit-to-using-a-node-on-my-personal-laptop-instead-of-ssh-from-a-vps)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - [Do nodes run a gateway service?](#do-nodes-run-a-gateway-service)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - [Is there an API / RPC way to apply config?](#is-there-an-api-rpc-way-to-apply-config)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - [What's a minimal "sane" config for a first install?](#whats-a-minimal-sane-config-for-a-first-install)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - [How do I set up Tailscale on a VPS and connect from my Mac?](#how-do-i-set-up-tailscale-on-a-vps-and-connect-from-my-mac)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - [How do I connect a Mac node to a remote Gateway (Tailscale Serve)?](#how-do-i-connect-a-mac-node-to-a-remote-gateway-tailscale-serve)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - [Should I install on a second laptop or just add a node?](#should-i-install-on-a-second-laptop-or-just-add-a-node)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- [Env vars and .env loading](#env-vars-and-env-loading)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - [How does OpenClaw load environment variables?](#how-does-openclaw-load-environment-variables)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - ["I started the Gateway via the service and my env vars disappeared." What now?](#i-started-the-gateway-via-the-service-and-my-env-vars-disappeared-what-now)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - [I set `COPILOT_GITHUB_TOKEN`, but models status shows "Shell env: off." Why?](#i-set-copilotgithubtoken-but-models-status-shows-shell-env-off-why)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- [Sessions and multiple chats](#sessions-and-multiple-chats)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - [How do I start a fresh conversation?](#how-do-i-start-a-fresh-conversation)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - [Do sessions reset automatically if I never send `/new`?](#do-sessions-reset-automatically-if-i-never-send-new)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - [Is there a way to make a team of OpenClaw instances one CEO and many agents](#is-there-a-way-to-make-a-team-of-openclaw-instances-one-ceo-and-many-agents)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - [Why did context get truncated mid-task? How do I prevent it?](#why-did-context-get-truncated-midtask-how-do-i-prevent-it)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - [How do I completely reset OpenClaw but keep it installed?](#how-do-i-completely-reset-openclaw-but-keep-it-installed)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - [I'm getting "context too large" errors - how do I reset or compact?](#im-getting-context-too-large-errors-how-do-i-reset-or-compact)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - [Why am I seeing "LLM request rejected: messages.N.content.X.tool_use.input: Field required"?](#why-am-i-seeing-llm-request-rejected-messagesncontentxtooluseinput-field-required)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - [Why am I getting heartbeat messages every 30 minutes?](#why-am-i-getting-heartbeat-messages-every-30-minutes)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - [Do I need to add a "bot account" to a WhatsApp group?](#do-i-need-to-add-a-bot-account-to-a-whatsapp-group)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - [How do I get the JID of a WhatsApp group?](#how-do-i-get-the-jid-of-a-whatsapp-group)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - [Why doesn't OpenClaw reply in a group?](#why-doesnt-openclaw-reply-in-a-group)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - [Do groups/threads share context with DMs?](#do-groupsthreads-share-context-with-dms)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - [How many workspaces and agents can I create?](#how-many-workspaces-and-agents-can-i-create)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - [Can I run multiple bots or chats at the same time (Slack), and how should I set that up?](#can-i-run-multiple-bots-or-chats-at-the-same-time-slack-and-how-should-i-set-that-up)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- [Models: defaults, selection, aliases, switching](#models-defaults-selection-aliases-switching)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - [What is the "default model"?](#what-is-the-default-model)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - [What model do you recommend?](#what-model-do-you-recommend)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - [How do I switch models without wiping my config?](#how-do-i-switch-models-without-wiping-my-config)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - [Can I use self-hosted models (llama.cpp, vLLM, Ollama)?](#can-i-use-selfhosted-models-llamacpp-vllm-ollama)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - [What do OpenClaw, Flawd, and Krill use for models?](#what-do-openclaw-flawd-and-krill-use-for-models)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - [How do I switch models on the fly (without restarting)?](#how-do-i-switch-models-on-the-fly-without-restarting)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - [Can I use GPT 5.2 for daily tasks and Codex 5.3 for coding](#can-i-use-gpt-52-for-daily-tasks-and-codex-53-for-coding)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - [Why do I see "Model … is not allowed" and then no reply?](#why-do-i-see-model-is-not-allowed-and-then-no-reply)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - [Why do I see "Unknown model: minimax/MiniMax-M2.1"?](#why-do-i-see-unknown-model-minimaxminimaxm21)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - [Can I use MiniMax as my default and OpenAI for complex tasks?](#can-i-use-minimax-as-my-default-and-openai-for-complex-tasks)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - [Are opus / sonnet / gpt built-in shortcuts?](#are-opus-sonnet-gpt-builtin-shortcuts)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - [How do I define/override model shortcuts (aliases)?](#how-do-i-defineoverride-model-shortcuts-aliases)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - [How do I add models from other providers like OpenRouter or Z.AI?](#how-do-i-add-models-from-other-providers-like-openrouter-or-zai)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- [Model failover and "All models failed"](#model-failover-and-all-models-failed)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - [How does failover work?](#how-does-failover-work)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - [What does this error mean?](#what-does-this-error-mean)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - [Fix checklist for `No credentials found for profile "anthropic:default"`](#fix-checklist-for-no-credentials-found-for-profile-anthropicdefault)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - [Why did it also try Google Gemini and fail?](#why-did-it-also-try-google-gemini-and-fail)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- [Auth profiles: what they are and how to manage them](#auth-profiles-what-they-are-and-how-to-manage-them)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - [What is an auth profile?](#what-is-an-auth-profile)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - [What are typical profile IDs?](#what-are-typical-profile-ids)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - [Can I control which auth profile is tried first?](#can-i-control-which-auth-profile-is-tried-first)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - [OAuth vs API key: what's the difference?](#oauth-vs-api-key-whats-the-difference)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- [Gateway: ports, "already running", and remote mode](#gateway-ports-already-running-and-remote-mode)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - [What port does the Gateway use?](#what-port-does-the-gateway-use)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - [Why does `openclaw gateway status` say `Runtime: running` but `RPC probe: failed`?](#why-does-openclaw-gateway-status-say-runtime-running-but-rpc-probe-failed)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - [Why does `openclaw gateway status` show `Config (cli)` and `Config (service)` different?](#why-does-openclaw-gateway-status-show-config-cli-and-config-service-different)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - [What does "another gateway instance is already listening" mean?](#what-does-another-gateway-instance-is-already-listening-mean)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - [How do I run OpenClaw in remote mode (client connects to a Gateway elsewhere)?](#how-do-i-run-openclaw-in-remote-mode-client-connects-to-a-gateway-elsewhere)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - [The Control UI says "unauthorized" (or keeps reconnecting). What now?](#the-control-ui-says-unauthorized-or-keeps-reconnecting-what-now)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - [I set `gateway.bind: "tailnet"` but it can't bind / nothing listens](#i-set-gatewaybind-tailnet-but-it-cant-bind-nothing-listens)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - [Can I run multiple Gateways on the same host?](#can-i-run-multiple-gateways-on-the-same-host)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - [What does "invalid handshake" / code 1008 mean?](#what-does-invalid-handshake-code-1008-mean)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- [Logging and debugging](#logging-and-debugging)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - [Where are logs?](#where-are-logs)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - [How do I start/stop/restart the Gateway service?](#how-do-i-startstoprestart-the-gateway-service)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - [I closed my terminal on Windows - how do I restart OpenClaw?](#i-closed-my-terminal-on-windows-how-do-i-restart-openclaw)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - [The Gateway is up but replies never arrive. What should I check?](#the-gateway-is-up-but-replies-never-arrive-what-should-i-check)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - ["Disconnected from gateway: no reason" - what now?](#disconnected-from-gateway-no-reason-what-now)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - [Telegram setMyCommands fails with network errors. What should I check?](#telegram-setmycommands-fails-with-network-errors-what-should-i-check)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - [TUI shows no output. What should I check?](#tui-shows-no-output-what-should-i-check)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - [How do I completely stop then start the Gateway?](#how-do-i-completely-stop-then-start-the-gateway)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - [ELI5: `openclaw gateway restart` vs `openclaw gateway`](#eli5-openclaw-gateway-restart-vs-openclaw-gateway)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - [What's the fastest way to get more details when something fails?](#whats-the-fastest-way-to-get-more-details-when-something-fails)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- [Media and attachments](#media-and-attachments)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - [My skill generated an image/PDF, but nothing was sent](#my-skill-generated-an-imagepdf-but-nothing-was-sent)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- [Security and access control](#security-and-access-control)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - [Is it safe to expose OpenClaw to inbound DMs?](#is-it-safe-to-expose-openclaw-to-inbound-dms)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - [Is prompt injection only a concern for public bots?](#is-prompt-injection-only-a-concern-for-public-bots)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - [Should my bot have its own email GitHub account or phone number](#should-my-bot-have-its-own-email-github-account-or-phone-number)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - [Can I give it autonomy over my text messages and is that safe](#can-i-give-it-autonomy-over-my-text-messages-and-is-that-safe)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - [Can I use cheaper models for personal assistant tasks?](#can-i-use-cheaper-models-for-personal-assistant-tasks)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - [I ran `/start` in Telegram but didn't get a pairing code](#i-ran-start-in-telegram-but-didnt-get-a-pairing-code)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - [WhatsApp: will it message my contacts? How does pairing work?](#whatsapp-will-it-message-my-contacts-how-does-pairing-work)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- [Chat commands, aborting tasks, and "it won't stop"](#chat-commands-aborting-tasks-and-it-wont-stop)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - [How do I stop internal system messages from showing in chat](#how-do-i-stop-internal-system-messages-from-showing-in-chat)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - [How do I stop/cancel a running task?](#how-do-i-stopcancel-a-running-task)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - [How do I send a Discord message from Telegram? ("Cross-context messaging denied")](#how-do-i-send-a-discord-message-from-telegram-crosscontext-messaging-denied)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - [Why does it feel like the bot "ignores" rapid-fire messages?](#why-does-it-feel-like-the-bot-ignores-rapidfire-messages)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## First 60 seconds if something's broken（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
1. **Quick status (first check)**（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
   ```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
   openclaw status（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
   ```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
   Fast local summary: OS + update, gateway/service reachability, agents/sessions, provider config + runtime issues (when gateway is reachable).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
2. **Pasteable report (safe to share)**（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
   ```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
   openclaw status --all（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
   ```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
   Read-only diagnosis with log tail (tokens redacted).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
3. **Daemon + port state**（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
   ```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
   openclaw gateway status（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
   ```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
   Shows supervisor runtime vs RPC reachability, the probe target URL, and which config the service likely used.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
4. **Deep probes**（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
   ```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
   openclaw status --deep（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
   ```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
   Runs gateway health checks + provider probes (requires a reachable gateway). See [Health](/gateway/health).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
5. **Tail the latest log**（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
   ```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
   openclaw logs --follow（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
   ```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
   If RPC is down, fall back to:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
   ```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
   tail -f "$(ls -t /tmp/openclaw/openclaw-*.log | head -1)"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
   ```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
   File logs are separate from service logs; see [Logging](/logging) and [Troubleshooting](/gateway/troubleshooting).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
6. **Run the doctor (repairs)**（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
   ```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
   openclaw doctor（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
   ```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
   Repairs/migrates config/state + runs health checks. See [Doctor](/gateway/doctor).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
7. **Gateway snapshot**（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
   ```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
   openclaw health --json（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
   openclaw health --verbose   # shows the target URL + config path on errors（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
   ```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
   Asks the running gateway for a full snapshot (WS-only). See [Health](/gateway/health).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Quick start and first-run setup（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Im stuck whats the fastest way to get unstuck（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Use a local AI agent that can **see your machine**. That is far more effective than asking（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
in Discord, because most "I'm stuck" cases are **local config or environment issues** that（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
remote helpers cannot inspect.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Claude Code**: [https://www.anthropic.com/claude-code/](https://www.anthropic.com/claude-code/)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **OpenAI Codex**: [https://openai.com/codex/](https://openai.com/codex/)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
These tools can read the repo, run commands, inspect logs, and help fix your machine-level（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
setup (PATH, services, permissions, auth files). Give them the **full source checkout** via（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
the hackable (git) install:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
curl -fsSL https://openclaw.ai/install.sh | bash -s -- --install-method git（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
This installs OpenClaw **from a git checkout**, so the agent can read the code + docs and（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
reason about the exact version you are running. You can always switch back to stable later（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
by re-running the installer without `--install-method git`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Tip: ask the agent to **plan and supervise** the fix (step-by-step), then execute only the（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
necessary commands. That keeps changes small and easier to audit.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
If you discover a real bug or fix, please file a GitHub issue or send a PR:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
[https://github.com/openclaw/openclaw/issues](https://github.com/openclaw/openclaw/issues)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
[https://github.com/openclaw/openclaw/pulls](https://github.com/openclaw/openclaw/pulls)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Start with these commands (share outputs when asking for help):（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw status（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw models status（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw doctor（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
What they do:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `openclaw status`: quick snapshot of gateway/agent health + basic config.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `openclaw models status`: checks provider auth + model availability.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `openclaw doctor`: validates and repairs common config/state issues.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Other useful CLI checks: `openclaw status --all`, `openclaw logs --follow`,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
`openclaw gateway status`, `openclaw health --verbose`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Quick debug loop: [First 60 seconds if something's broken](#first-60-seconds-if-somethings-broken).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Install docs: [Install](/install), [Installer flags](/install/installer), [Updating](/install/updating).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### What's the recommended way to install and set up OpenClaw（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
The repo recommends running from source and using the onboarding wizard:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
curl -fsSL https://openclaw.ai/install.sh | bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw onboard --install-daemon（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
The wizard can also build UI assets automatically. After onboarding, you typically run the Gateway on port **18789**.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
From source (contributors/dev):（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
git clone https://github.com/openclaw/openclaw.git（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
cd openclaw（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
pnpm install（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
pnpm build（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
pnpm ui:build # auto-installs UI deps on first run（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw onboard（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
If you don't have a global install yet, run it via `pnpm openclaw onboard`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### How do I open the dashboard after onboarding（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
The wizard opens your browser with a clean (non-tokenized) dashboard URL right after onboarding and also prints the link in the summary. Keep that tab open; if it didn't launch, copy/paste the printed URL on the same machine.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### How do I authenticate the dashboard token on localhost vs remote（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**Localhost (same machine):**（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Open `http://127.0.0.1:18789/`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- If it asks for auth, paste the token from `gateway.auth.token` (or `OPENCLAW_GATEWAY_TOKEN`) into Control UI settings.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Retrieve it from the gateway host: `openclaw config get gateway.auth.token` (or generate one: `openclaw doctor --generate-gateway-token`).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**Not on localhost:**（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Tailscale Serve** (recommended): keep bind loopback, run `openclaw gateway --tailscale serve`, open `https://<magicdns>/`. If `gateway.auth.allowTailscale` is `true`, identity headers satisfy auth (no token).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Tailnet bind**: run `openclaw gateway --bind tailnet --token "<token>"`, open `http://<tailscale-ip>:18789/`, paste token in dashboard settings.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **SSH tunnel**: `ssh -N -L 18789:127.0.0.1:18789 user@host` then open `http://127.0.0.1:18789/` and paste the token in Control UI settings.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
See [Dashboard](/web/dashboard) and [Web surfaces](/web) for bind modes and auth details.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### What runtime do I need（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Node **>= 22** is required. `pnpm` is recommended. Bun is **not recommended** for the Gateway.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Does it run on Raspberry Pi（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Yes. The Gateway is lightweight - docs list **512MB-1GB RAM**, **1 core**, and about **500MB**（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
disk as enough for personal use, and note that a **Raspberry Pi 4 can run it**.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
If you want extra headroom (logs, media, other services), **2GB is recommended**, but it's（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
not a hard minimum.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Tip: a small Pi/VPS can host the Gateway, and you can pair **nodes** on your laptop/phone for（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
local screen/camera/canvas or command execution. See [Nodes](/nodes).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Any tips for Raspberry Pi installs（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Short version: it works, but expect rough edges.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Use a **64-bit** OS and keep Node >= 22.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Prefer the **hackable (git) install** so you can see logs and update fast.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Start without channels/skills, then add them one by one.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- If you hit weird binary issues, it is usually an **ARM compatibility** problem.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Docs: [Linux](/platforms/linux), [Install](/install).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### It is stuck on wake up my friend onboarding will not hatch What now（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
That screen depends on the Gateway being reachable and authenticated. The TUI also sends（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
"Wake up, my friend!" automatically on first hatch. If you see that line with **no reply**（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
and tokens stay at 0, the agent never ran.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
1. Restart the Gateway:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw gateway restart（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
2. Check status + auth:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw status（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw models status（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw logs --follow（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
3. If it still hangs, run:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw doctor（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
If the Gateway is remote, ensure the tunnel/Tailscale connection is up and that the UI（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
is pointed at the right Gateway. See [Remote access](/gateway/remote).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Can I migrate my setup to a new machine Mac mini without redoing onboarding（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Yes. Copy the **state directory** and **workspace**, then run Doctor once. This（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
keeps your bot "exactly the same" (memory, session history, auth, and channel（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
state) as long as you copy **both** locations:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
1. Install OpenClaw on the new machine.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
2. Copy `$OPENCLAW_STATE_DIR` (default: `~/.openclaw`) from the old machine.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
3. Copy your workspace (default: `~/.openclaw/workspace`).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
4. Run `openclaw doctor` and restart the Gateway service.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
That preserves config, auth profiles, WhatsApp creds, sessions, and memory. If you're in（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
remote mode, remember the gateway host owns the session store and workspace.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**Important:** if you only commit/push your workspace to GitHub, you're backing（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
up **memory + bootstrap files**, but **not** session history or auth. Those live（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
under `~/.openclaw/` (for example `~/.openclaw/agents/<agentId>/sessions/`).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Related: [Migrating](/install/migrating), [Where things live on disk](/help/faq#where-does-openclaw-store-its-data),（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
[Agent workspace](/concepts/agent-workspace), [Doctor](/gateway/doctor),（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
[Remote mode](/gateway/remote).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Where do I see what is new in the latest version（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Check the GitHub changelog:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
[https://github.com/openclaw/openclaw/blob/main/CHANGELOG.md](https://github.com/openclaw/openclaw/blob/main/CHANGELOG.md)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Newest entries are at the top. If the top section is marked **Unreleased**, the next dated（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
section is the latest shipped version. Entries are grouped by **Highlights**, **Changes**, and（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**Fixes** (plus docs/other sections when needed).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### I cant access docs.openclaw.ai SSL error What now（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Some Comcast/Xfinity connections incorrectly block `docs.openclaw.ai` via Xfinity（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Advanced Security. Disable it or allowlist `docs.openclaw.ai`, then retry. More（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
detail: [Troubleshooting](/help/troubleshooting#docsopenclawai-shows-an-ssl-error-comcastxfinity).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Please help us unblock it by reporting here: [https://spa.xfinity.com/check_url_status](https://spa.xfinity.com/check_url_status).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
If you still can't reach the site, the docs are mirrored on GitHub:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
[https://github.com/openclaw/openclaw/tree/main/docs](https://github.com/openclaw/openclaw/tree/main/docs)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### What's the difference between stable and beta（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**Stable** and **beta** are **npm dist-tags**, not separate code lines:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `latest` = stable（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `beta` = early build for testing（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
We ship builds to **beta**, test them, and once a build is solid we **promote（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
that same version to `latest`**. That's why beta and stable can point at the（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**same version**.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
See what changed:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
[https://github.com/openclaw/openclaw/blob/main/CHANGELOG.md](https://github.com/openclaw/openclaw/blob/main/CHANGELOG.md)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### How do I install the beta version and whats the difference between beta and dev（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**Beta** is the npm dist-tag `beta` (may match `latest`).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**Dev** is the moving head of `main` (git); when published, it uses the npm dist-tag `dev`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
One-liners (macOS/Linux):（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
curl -fsSL --proto '=https' --tlsv1.2 https://openclaw.ai/install.sh | bash -s -- --beta（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
curl -fsSL --proto '=https' --tlsv1.2 https://openclaw.ai/install.sh | bash -s -- --install-method git（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Windows installer (PowerShell):（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
[https://openclaw.ai/install.ps1](https://openclaw.ai/install.ps1)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
More detail: [Development channels](/install/development-channels) and [Installer flags](/install/installer).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### How long does install and onboarding usually take（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Rough guide:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Install:** 2-5 minutes（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Onboarding:** 5-15 minutes depending on how many channels/models you configure（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
If it hangs, use [Installer stuck](/help/faq#installer-stuck-how-do-i-get-more-feedback)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
and the fast debug loop in [Im stuck](/help/faq#im-stuck--whats-the-fastest-way-to-get-unstuck).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### How do I try the latest bits（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Two options:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
1. **Dev channel (git checkout):**（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw update --channel dev（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
This switches to the `main` branch and updates from source.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
2. **Hackable install (from the installer site):**（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
curl -fsSL https://openclaw.ai/install.sh | bash -s -- --install-method git（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
That gives you a local repo you can edit, then update via git.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
If you prefer a clean clone manually, use:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
git clone https://github.com/openclaw/openclaw.git（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
cd openclaw（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
pnpm install（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
pnpm build（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Docs: [Update](/cli/update), [Development channels](/install/development-channels),（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
[Install](/install).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Installer stuck How do I get more feedback（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Re-run the installer with **verbose output**:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
curl -fsSL https://openclaw.ai/install.sh | bash -s -- --verbose（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Beta install with verbose:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
curl -fsSL https://openclaw.ai/install.sh | bash -s -- --beta --verbose（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
For a hackable (git) install:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
curl -fsSL https://openclaw.ai/install.sh | bash -s -- --install-method git --verbose（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
More options: [Installer flags](/install/installer).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Windows install says git not found or openclaw not recognized（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Two common Windows issues:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**1) npm error spawn git / git not found**（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Install **Git for Windows** and make sure `git` is on your PATH.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Close and reopen PowerShell, then re-run the installer.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**2) openclaw is not recognized after install**（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Your npm global bin folder is not on PATH.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Check the path:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  ```powershell（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  npm config get prefix（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  ```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Ensure `<prefix>\\bin` is on PATH (on most systems it is `%AppData%\\npm`).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Close and reopen PowerShell after updating PATH.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
If you want the smoothest Windows setup, use **WSL2** instead of native Windows.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Docs: [Windows](/platforms/windows).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### The docs didnt answer my question how do I get a better answer（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Use the **hackable (git) install** so you have the full source and docs locally, then ask（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
your bot (or Claude/Codex) _from that folder_ so it can read the repo and answer precisely.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
curl -fsSL https://openclaw.ai/install.sh | bash -s -- --install-method git（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
More detail: [Install](/install) and [Installer flags](/install/installer).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### How do I install OpenClaw on Linux（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Short answer: follow the Linux guide, then run the onboarding wizard.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Linux quick path + service install: [Linux](/platforms/linux).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Full walkthrough: [Getting Started](/start/getting-started).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Installer + updates: [Install & updates](/install/updating).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### How do I install OpenClaw on a VPS（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Any Linux VPS works. Install on the server, then use SSH/Tailscale to reach the Gateway.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Guides: [exe.dev](/install/exe-dev), [Hetzner](/install/hetzner), [Fly.io](/install/fly).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Remote access: [Gateway remote](/gateway/remote).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Where are the cloudVPS install guides（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
We keep a **hosting hub** with the common providers. Pick one and follow the guide:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- [VPS hosting](/vps) (all providers in one place)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- [Fly.io](/install/fly)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- [Hetzner](/install/hetzner)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- [exe.dev](/install/exe-dev)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
How it works in the cloud: the **Gateway runs on the server**, and you access it（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
from your laptop/phone via the Control UI (or Tailscale/SSH). Your state + workspace（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
live on the server, so treat the host as the source of truth and back it up.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
You can pair **nodes** (Mac/iOS/Android/headless) to that cloud Gateway to access（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
local screen/camera/canvas or run commands on your laptop while keeping the（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Gateway in the cloud.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Hub: [Platforms](/platforms). Remote access: [Gateway remote](/gateway/remote).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Nodes: [Nodes](/nodes), [Nodes CLI](/cli/nodes).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Can I ask OpenClaw to update itself（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Short answer: **possible, not recommended**. The update flow can restart the（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Gateway (which drops the active session), may need a clean git checkout, and（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
can prompt for confirmation. Safer: run updates from a shell as the operator.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Use the CLI:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw update（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw update status（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw update --channel stable|beta|dev（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw update --tag <dist-tag|version>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw update --no-restart（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
If you must automate from an agent:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw update --yes --no-restart（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw gateway restart（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Docs: [Update](/cli/update), [Updating](/install/updating).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### What does the onboarding wizard actually do（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
`openclaw onboard` is the recommended setup path. In **local mode** it walks you through:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Model/auth setup** (Anthropic **setup-token** recommended for Claude subscriptions, OpenAI Codex OAuth supported, API keys optional, LM Studio local models supported)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Workspace** location + bootstrap files（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Gateway settings** (bind/port/auth/tailscale)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Providers** (WhatsApp, Telegram, Discord, Mattermost (plugin), Signal, iMessage)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Daemon install** (LaunchAgent on macOS; systemd user unit on Linux/WSL2)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Health checks** and **skills** selection（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
It also warns if your configured model is unknown or missing auth.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Do I need a Claude or OpenAI subscription to run this（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
No. You can run OpenClaw with **API keys** (Anthropic/OpenAI/others) or with（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**local-only models** so your data stays on your device. Subscriptions (Claude（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Pro/Max or OpenAI Codex) are optional ways to authenticate those providers.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Docs: [Anthropic](/providers/anthropic), [OpenAI](/providers/openai),（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
[Local models](/gateway/local-models), [Models](/concepts/models).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Can I use Claude Max subscription without an API key（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Yes. You can authenticate with a **setup-token**（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
instead of an API key. This is the subscription path.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Claude Pro/Max subscriptions **do not include an API key**, so this is the（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
correct approach for subscription accounts. Important: you must verify with（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Anthropic that this usage is allowed under their subscription policy and terms.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
If you want the most explicit, supported path, use an Anthropic API key.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### How does Anthropic setuptoken auth work（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
`claude setup-token` generates a **token string** via the Claude Code CLI (it is not available in the web console). You can run it on **any machine**. Choose **Anthropic token (paste setup-token)** in the wizard or paste it with `openclaw models auth paste-token --provider anthropic`. The token is stored as an auth profile for the **anthropic** provider and used like an API key (no auto-refresh). More detail: [OAuth](/concepts/oauth).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Where do I find an Anthropic setuptoken（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
It is **not** in the Anthropic Console. The setup-token is generated by the **Claude Code CLI** on **any machine**:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
claude setup-token（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Copy the token it prints, then choose **Anthropic token (paste setup-token)** in the wizard. If you want to run it on the gateway host, use `openclaw models auth setup-token --provider anthropic`. If you ran `claude setup-token` elsewhere, paste it on the gateway host with `openclaw models auth paste-token --provider anthropic`. See [Anthropic](/providers/anthropic).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Do you support Claude subscription auth (Claude Pro or Max)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Yes - via **setup-token**. OpenClaw no longer reuses Claude Code CLI OAuth tokens; use a setup-token or an Anthropic API key. Generate the token anywhere and paste it on the gateway host. See [Anthropic](/providers/anthropic) and [OAuth](/concepts/oauth).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Note: Claude subscription access is governed by Anthropic's terms. For production or multi-user workloads, API keys are usually the safer choice.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Why am I seeing HTTP 429 ratelimiterror from Anthropic（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
That means your **Anthropic quota/rate limit** is exhausted for the current window. If you（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
use a **Claude subscription** (setup-token or Claude Code OAuth), wait for the window to（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
reset or upgrade your plan. If you use an **Anthropic API key**, check the Anthropic Console（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
for usage/billing and raise limits as needed.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Tip: set a **fallback model** so OpenClaw can keep replying while a provider is rate-limited.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
See [Models](/cli/models) and [OAuth](/concepts/oauth).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Is AWS Bedrock supported（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Yes - via pi-ai's **Amazon Bedrock (Converse)** provider with **manual config**. You must supply AWS credentials/region on the gateway host and add a Bedrock provider entry in your models config. See [Amazon Bedrock](/providers/bedrock) and [Model providers](/providers/models). If you prefer a managed key flow, an OpenAI-compatible proxy in front of Bedrock is still a valid option.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### How does Codex auth work（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
OpenClaw supports **OpenAI Code (Codex)** via OAuth (ChatGPT sign-in). The wizard can run the OAuth flow and will set the default model to `openai-codex/gpt-5.3-codex` when appropriate. See [Model providers](/concepts/model-providers) and [Wizard](/start/wizard).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Do you support OpenAI subscription auth Codex OAuth（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Yes. OpenClaw fully supports **OpenAI Code (Codex) subscription OAuth**. The onboarding wizard（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
can run the OAuth flow for you.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
See [OAuth](/concepts/oauth), [Model providers](/concepts/model-providers), and [Wizard](/start/wizard).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### How do I set up Gemini CLI OAuth（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Gemini CLI uses a **plugin auth flow**, not a client id or secret in `openclaw.json`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Steps:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
1. Enable the plugin: `openclaw plugins enable google-gemini-cli-auth`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
2. Login: `openclaw models auth login --provider google-gemini-cli --set-default`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
This stores OAuth tokens in auth profiles on the gateway host. Details: [Model providers](/concepts/model-providers).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Is a local model OK for casual chats（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Usually no. OpenClaw needs large context + strong safety; small cards truncate and leak. If you must, run the **largest** MiniMax M2.1 build you can locally (LM Studio) and see [/gateway/local-models](/gateway/local-models). Smaller/quantized models increase prompt-injection risk - see [Security](/gateway/security).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### How do I keep hosted model traffic in a specific region（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Pick region-pinned endpoints. OpenRouter exposes US-hosted options for MiniMax, Kimi, and GLM; choose the US-hosted variant to keep data in-region. You can still list Anthropic/OpenAI alongside these by using `models.mode: "merge"` so fallbacks stay available while respecting the regioned provider you select.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Do I have to buy a Mac Mini to install this（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
No. OpenClaw runs on macOS or Linux (Windows via WSL2). A Mac mini is optional - some people（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
buy one as an always-on host, but a small VPS, home server, or Raspberry Pi-class box works too.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
You only need a Mac **for macOS-only tools**. For iMessage, use [BlueBubbles](/channels/bluebubbles) (recommended) - the BlueBubbles server runs on any Mac, and the Gateway can run on Linux or elsewhere. If you want other macOS-only tools, run the Gateway on a Mac or pair a macOS node.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Docs: [BlueBubbles](/channels/bluebubbles), [Nodes](/nodes), [Mac remote mode](/platforms/mac/remote).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Do I need a Mac mini for iMessage support（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
You need **some macOS device** signed into Messages. It does **not** have to be a Mac mini -（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
any Mac works. **Use [BlueBubbles](/channels/bluebubbles)** (recommended) for iMessage - the BlueBubbles server runs on macOS, while the Gateway can run on Linux or elsewhere.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Common setups:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Run the Gateway on Linux/VPS, and run the BlueBubbles server on any Mac signed into Messages.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Run everything on the Mac if you want the simplest single‑machine setup.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Docs: [BlueBubbles](/channels/bluebubbles), [Nodes](/nodes),（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
[Mac remote mode](/platforms/mac/remote).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### If I buy a Mac mini to run OpenClaw can I connect it to my MacBook Pro（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Yes. The **Mac mini can run the Gateway**, and your MacBook Pro can connect as a（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**node** (companion device). Nodes don't run the Gateway - they provide extra（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
capabilities like screen/camera/canvas and `system.run` on that device.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Common pattern:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Gateway on the Mac mini (always-on).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- MacBook Pro runs the macOS app or a node host and pairs to the Gateway.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Use `openclaw nodes status` / `openclaw nodes list` to see it.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Docs: [Nodes](/nodes), [Nodes CLI](/cli/nodes).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Can I use Bun（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Bun is **not recommended**. We see runtime bugs, especially with WhatsApp and Telegram.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Use **Node** for stable gateways.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
If you still want to experiment with Bun, do it on a non-production gateway（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
without WhatsApp/Telegram.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Telegram what goes in allowFrom（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
`channels.telegram.allowFrom` is **the human sender's Telegram user ID** (numeric, recommended) or `@username`. It is not the bot username.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Safer (no third-party bot):（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- DM your bot, then run `openclaw logs --follow` and read `from.id`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Official Bot API:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- DM your bot, then call `https://api.telegram.org/bot<bot_token>/getUpdates` and read `message.from.id`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Third-party (less private):（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- DM `@userinfobot` or `@getidsbot`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
See [/channels/telegram](/channels/telegram#access-control-dms--groups).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Can multiple people use one WhatsApp number with different OpenClaw instances（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Yes, via **multi-agent routing**. Bind each sender's WhatsApp **DM** (peer `kind: "direct"`, sender E.164 like `+15551234567`) to a different `agentId`, so each person gets their own workspace and session store. Replies still come from the **same WhatsApp account**, and DM access control (`channels.whatsapp.dmPolicy` / `channels.whatsapp.allowFrom`) is global per WhatsApp account. See [Multi-Agent Routing](/concepts/multi-agent) and [WhatsApp](/channels/whatsapp).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Can I run a fast chat agent and an Opus for coding agent（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Yes. Use multi-agent routing: give each agent its own default model, then bind inbound routes (provider account or specific peers) to each agent. Example config lives in [Multi-Agent Routing](/concepts/multi-agent). See also [Models](/concepts/models) and [Configuration](/gateway/configuration).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Does Homebrew work on Linux（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Yes. Homebrew supports Linux (Linuxbrew). Quick setup:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
echo 'eval "$(/home/linuxbrew/.linuxbrew/bin/brew shellenv)"' >> ~/.profile（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
eval "$(/home/linuxbrew/.linuxbrew/bin/brew shellenv)"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
brew install <formula>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
If you run OpenClaw via systemd, ensure the service PATH includes `/home/linuxbrew/.linuxbrew/bin` (or your brew prefix) so `brew`-installed tools resolve in non-login shells.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Recent builds also prepend common user bin dirs on Linux systemd services (for example `~/.local/bin`, `~/.npm-global/bin`, `~/.local/share/pnpm`, `~/.bun/bin`) and honor `PNPM_HOME`, `NPM_CONFIG_PREFIX`, `BUN_INSTALL`, `VOLTA_HOME`, `ASDF_DATA_DIR`, `NVM_DIR`, and `FNM_DIR` when set.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### What's the difference between the hackable git install and npm install（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Hackable (git) install:** full source checkout, editable, best for contributors.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  You run builds locally and can patch code/docs.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **npm install:** global CLI install, no repo, best for "just run it."（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  Updates come from npm dist-tags.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Docs: [Getting started](/start/getting-started), [Updating](/install/updating).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Can I switch between npm and git installs later（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Yes. Install the other flavor, then run Doctor so the gateway service points at the new entrypoint.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
This **does not delete your data** - it only changes the OpenClaw code install. Your state（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
(`~/.openclaw`) and workspace (`~/.openclaw/workspace`) stay untouched.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
From npm → git:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
git clone https://github.com/openclaw/openclaw.git（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
cd openclaw（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
pnpm install（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
pnpm build（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw doctor（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw gateway restart（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
From git → npm:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
npm install -g openclaw@latest（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw doctor（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw gateway restart（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Doctor detects a gateway service entrypoint mismatch and offers to rewrite the service config to match the current install (use `--repair` in automation).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Backup tips: see [Backup strategy](/help/faq#whats-the-recommended-backup-strategy).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Should I run the Gateway on my laptop or a VPS（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Short answer: **if you want 24/7 reliability, use a VPS**. If you want the（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
lowest friction and you're okay with sleep/restarts, run it locally.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**Laptop (local Gateway)**（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Pros:** no server cost, direct access to local files, live browser window.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Cons:** sleep/network drops = disconnects, OS updates/reboots interrupt, must stay awake.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**VPS / cloud**（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Pros:** always-on, stable network, no laptop sleep issues, easier to keep running.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Cons:** often run headless (use screenshots), remote file access only, you must SSH for updates.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**OpenClaw-specific note:** WhatsApp/Telegram/Slack/Mattermost (plugin)/Discord all work fine from a VPS. The only real trade-off is **headless browser** vs a visible window. See [Browser](/tools/browser).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**Recommended default:** VPS if you had gateway disconnects before. Local is great when you're actively using the Mac and want local file access or UI automation with a visible browser.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### How important is it to run OpenClaw on a dedicated machine（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Not required, but **recommended for reliability and isolation**.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Dedicated host (VPS/Mac mini/Pi):** always-on, fewer sleep/reboot interruptions, cleaner permissions, easier to keep running.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Shared laptop/desktop:** totally fine for testing and active use, but expect pauses when the machine sleeps or updates.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
If you want the best of both worlds, keep the Gateway on a dedicated host and pair your laptop as a **node** for local screen/camera/exec tools. See [Nodes](/nodes).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
For security guidance, read [Security](/gateway/security).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### What are the minimum VPS requirements and recommended OS（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
OpenClaw is lightweight. For a basic Gateway + one chat channel:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Absolute minimum:** 1 vCPU, 1GB RAM, ~500MB disk.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Recommended:** 1-2 vCPU, 2GB RAM or more for headroom (logs, media, multiple channels). Node tools and browser automation can be resource hungry.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
OS: use **Ubuntu LTS** (or any modern Debian/Ubuntu). The Linux install path is best tested there.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Docs: [Linux](/platforms/linux), [VPS hosting](/vps).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Can I run OpenClaw in a VM and what are the requirements（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Yes. Treat a VM the same as a VPS: it needs to be always on, reachable, and have enough（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
RAM for the Gateway and any channels you enable.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Baseline guidance:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Absolute minimum:** 1 vCPU, 1GB RAM.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Recommended:** 2GB RAM or more if you run multiple channels, browser automation, or media tools.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **OS:** Ubuntu LTS or another modern Debian/Ubuntu.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
If you are on Windows, **WSL2 is the easiest VM style setup** and has the best tooling（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
compatibility. See [Windows](/platforms/windows), [VPS hosting](/vps).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
If you are running macOS in a VM, see [macOS VM](/install/macos-vm).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## What is OpenClaw?（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### What is OpenClaw in one paragraph（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
OpenClaw is a personal AI assistant you run on your own devices. It replies on the messaging surfaces you already use (WhatsApp, Telegram, Slack, Mattermost (plugin), Discord, Google Chat, Signal, iMessage, WebChat) and can also do voice + a live Canvas on supported platforms. The **Gateway** is the always-on control plane; the assistant is the product.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### What's the value proposition（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
OpenClaw is not "just a Claude wrapper." It's a **local-first control plane** that lets you run a（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
capable assistant on **your own hardware**, reachable from the chat apps you already use, with（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
stateful sessions, memory, and tools - without handing control of your workflows to a hosted（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
SaaS.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Highlights:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Your devices, your data:** run the Gateway wherever you want (Mac, Linux, VPS) and keep the（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  workspace + session history local.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Real channels, not a web sandbox:** WhatsApp/Telegram/Slack/Discord/Signal/iMessage/etc,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  plus mobile voice and Canvas on supported platforms.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Model-agnostic:** use Anthropic, OpenAI, MiniMax, OpenRouter, etc., with per-agent routing（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  and failover.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Local-only option:** run local models so **all data can stay on your device** if you want.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Multi-agent routing:** separate agents per channel, account, or task, each with its own（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  workspace and defaults.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Open source and hackable:** inspect, extend, and self-host without vendor lock-in.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Docs: [Gateway](/gateway), [Channels](/channels), [Multi-agent](/concepts/multi-agent),（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
[Memory](/concepts/memory).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### I just set it up what should I do first（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Good first projects:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Build a website (WordPress, Shopify, or a simple static site).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Prototype a mobile app (outline, screens, API plan).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Organize files and folders (cleanup, naming, tagging).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Connect Gmail and automate summaries or follow ups.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
It can handle large tasks, but it works best when you split them into phases and（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
use sub agents for parallel work.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### What are the top five everyday use cases for OpenClaw（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Everyday wins usually look like:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Personal briefings:** summaries of inbox, calendar, and news you care about.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Research and drafting:** quick research, summaries, and first drafts for emails or docs.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Reminders and follow ups:** cron or heartbeat driven nudges and checklists.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Browser automation:** filling forms, collecting data, and repeating web tasks.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Cross device coordination:** send a task from your phone, let the Gateway run it on a server, and get the result back in chat.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Can OpenClaw help with lead gen outreach ads and blogs for a SaaS（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Yes for **research, qualification, and drafting**. It can scan sites, build shortlists,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
summarize prospects, and write outreach or ad copy drafts.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
For **outreach or ad runs**, keep a human in the loop. Avoid spam, follow local laws and（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
platform policies, and review anything before it is sent. The safest pattern is to let（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
OpenClaw draft and you approve.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Docs: [Security](/gateway/security).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### What are the advantages vs Claude Code for web development（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
OpenClaw is a **personal assistant** and coordination layer, not an IDE replacement. Use（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Claude Code or Codex for the fastest direct coding loop inside a repo. Use OpenClaw when you（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
want durable memory, cross-device access, and tool orchestration.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Advantages:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Persistent memory + workspace** across sessions（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Multi-platform access** (WhatsApp, Telegram, TUI, WebChat)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Tool orchestration** (browser, files, scheduling, hooks)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Always-on Gateway** (run on a VPS, interact from anywhere)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Nodes** for local browser/screen/camera/exec（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Showcase: [https://openclaw.ai/showcase](https://openclaw.ai/showcase)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Skills and automation（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### How do I customize skills without keeping the repo dirty（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Use managed overrides instead of editing the repo copy. Put your changes in `~/.openclaw/skills/<name>/SKILL.md` (or add a folder via `skills.load.extraDirs` in `~/.openclaw/openclaw.json`). Precedence is `<workspace>/skills` > `~/.openclaw/skills` > bundled, so managed overrides win without touching git. Only upstream-worthy edits should live in the repo and go out as PRs.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Can I load skills from a custom folder（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Yes. Add extra directories via `skills.load.extraDirs` in `~/.openclaw/openclaw.json` (lowest precedence). Default precedence remains: `<workspace>/skills` → `~/.openclaw/skills` → bundled → `skills.load.extraDirs`. `clawhub` installs into `./skills` by default, which OpenClaw treats as `<workspace>/skills`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### How can I use different models for different tasks（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Today the supported patterns are:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Cron jobs**: isolated jobs can set a `model` override per job.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Sub-agents**: route tasks to separate agents with different default models.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **On-demand switch**: use `/model` to switch the current session model at any time.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
See [Cron jobs](/automation/cron-jobs), [Multi-Agent Routing](/concepts/multi-agent), and [Slash commands](/tools/slash-commands).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### The bot freezes while doing heavy work How do I offload that（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Use **sub-agents** for long or parallel tasks. Sub-agents run in their own session,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
return a summary, and keep your main chat responsive.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Ask your bot to "spawn a sub-agent for this task" or use `/subagents`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Use `/status` in chat to see what the Gateway is doing right now (and whether it is busy).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Token tip: long tasks and sub-agents both consume tokens. If cost is a concern, set a（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
cheaper model for sub-agents via `agents.defaults.subagents.model`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Docs: [Sub-agents](/tools/subagents).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Cron or reminders do not fire What should I check（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Cron runs inside the Gateway process. If the Gateway is not running continuously,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
scheduled jobs will not run.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Checklist:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Confirm cron is enabled (`cron.enabled`) and `OPENCLAW_SKIP_CRON` is not set.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Check the Gateway is running 24/7 (no sleep/restarts).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Verify timezone settings for the job (`--tz` vs host timezone).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Debug:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw cron run <jobId> --force（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw cron runs --id <jobId> --limit 50（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Docs: [Cron jobs](/automation/cron-jobs), [Cron vs Heartbeat](/automation/cron-vs-heartbeat).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### How do I install skills on Linux（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Use **ClawHub** (CLI) or drop skills into your workspace. The macOS Skills UI isn't available on Linux.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Browse skills at [https://clawhub.com](https://clawhub.com).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Install the ClawHub CLI (pick one package manager):（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
npm i -g clawhub（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
pnpm add -g clawhub（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Can OpenClaw run tasks on a schedule or continuously in the background（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Yes. Use the Gateway scheduler:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Cron jobs** for scheduled or recurring tasks (persist across restarts).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Heartbeat** for "main session" periodic checks.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Isolated jobs** for autonomous agents that post summaries or deliver to chats.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Docs: [Cron jobs](/automation/cron-jobs), [Cron vs Heartbeat](/automation/cron-vs-heartbeat),（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
[Heartbeat](/gateway/heartbeat).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Can I run Apple macOS-only skills from Linux?（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Not directly. macOS skills are gated by `metadata.openclaw.os` plus required binaries, and skills only appear in the system prompt when they are eligible on the **Gateway host**. On Linux, `darwin`-only skills (like `apple-notes`, `apple-reminders`, `things-mac`) will not load unless you override the gating.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
You have three supported patterns:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**Option A - run the Gateway on a Mac (simplest).**（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Run the Gateway where the macOS binaries exist, then connect from Linux in [remote mode](#how-do-i-run-openclaw-in-remote-mode-client-connects-to-a-gateway-elsewhere) or over Tailscale. The skills load normally because the Gateway host is macOS.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**Option B - use a macOS node (no SSH).**（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Run the Gateway on Linux, pair a macOS node (menubar app), and set **Node Run Commands** to "Always Ask" or "Always Allow" on the Mac. OpenClaw can treat macOS-only skills as eligible when the required binaries exist on the node. The agent runs those skills via the `nodes` tool. If you choose "Always Ask", approving "Always Allow" in the prompt adds that command to the allowlist.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**Option C - proxy macOS binaries over SSH (advanced).**（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Keep the Gateway on Linux, but make the required CLI binaries resolve to SSH wrappers that run on a Mac. Then override the skill to allow Linux so it stays eligible.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
1. Create an SSH wrapper for the binary (example: `memo` for Apple Notes):（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
   ```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
   #!/usr/bin/env bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
   set -euo pipefail（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
   exec ssh -T user@mac-host /opt/homebrew/bin/memo "$@"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
   ```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
2. Put the wrapper on `PATH` on the Linux host (for example `~/bin/memo`).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
3. Override the skill metadata (workspace or `~/.openclaw/skills`) to allow Linux:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
   ```markdown（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
   ---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
   name: apple-notes（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
   description: Manage Apple Notes via the memo CLI on macOS.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
   metadata: { "openclaw": { "os": ["darwin", "linux"], "requires": { "bins": ["memo"] } } }（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
   ---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
   ```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
4. Start a new session so the skills snapshot refreshes.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Do you have a Notion or HeyGen integration（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Not built-in today.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Options:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Custom skill / plugin:** best for reliable API access (Notion/HeyGen both have APIs).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Browser automation:** works without code but is slower and more fragile.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
If you want to keep context per client (agency workflows), a simple pattern is:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- One Notion page per client (context + preferences + active work).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Ask the agent to fetch that page at the start of a session.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
If you want a native integration, open a feature request or build a skill（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
targeting those APIs.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Install skills:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
clawhub install <skill-slug>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
clawhub update --all（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
ClawHub installs into `./skills` under your current directory (or falls back to your configured OpenClaw workspace); OpenClaw treats that as `<workspace>/skills` on the next session. For shared skills across agents, place them in `~/.openclaw/skills/<name>/SKILL.md`. Some skills expect binaries installed via Homebrew; on Linux that means Linuxbrew (see the Homebrew Linux FAQ entry above). See [Skills](/tools/skills) and [ClawHub](/tools/clawhub).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### How do I install the Chrome extension for browser takeover（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Use the built-in installer, then load the unpacked extension in Chrome:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw browser extension install（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw browser extension path（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Then Chrome → `chrome://extensions` → enable "Developer mode" → "Load unpacked" → pick that folder.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Full guide (including remote Gateway + security notes): [Chrome extension](/tools/chrome-extension)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
If the Gateway runs on the same machine as Chrome (default setup), you usually **do not** need anything extra.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
If the Gateway runs elsewhere, run a node host on the browser machine so the Gateway can proxy browser actions.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
You still need to click the extension button on the tab you want to control (it doesn't auto-attach).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Sandboxing and memory（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Is there a dedicated sandboxing doc（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Yes. See [Sandboxing](/gateway/sandboxing). For Docker-specific setup (full gateway in Docker or sandbox images), see [Docker](/install/docker).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Docker feels limited How do I enable full features（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
The default image is security-first and runs as the `node` user, so it does not（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
include system packages, Homebrew, or bundled browsers. For a fuller setup:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Persist `/home/node` with `OPENCLAW_HOME_VOLUME` so caches survive.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Bake system deps into the image with `OPENCLAW_DOCKER_APT_PACKAGES`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Install Playwright browsers via the bundled CLI:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  `node /app/node_modules/playwright-core/cli.js install chromium`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Set `PLAYWRIGHT_BROWSERS_PATH` and ensure the path is persisted.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Docs: [Docker](/install/docker), [Browser](/tools/browser).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**Can I keep DMs personal but make groups public sandboxed with one agent**（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Yes - if your private traffic is **DMs** and your public traffic is **groups**.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Use `agents.defaults.sandbox.mode: "non-main"` so group/channel sessions (non-main keys) run in Docker, while the main DM session stays on-host. Then restrict what tools are available in sandboxed sessions via `tools.sandbox.tools`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Setup walkthrough + example config: [Groups: personal DMs + public groups](/channels/groups#pattern-personal-dms-public-groups-single-agent)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Key config reference: [Gateway configuration](/gateway/configuration#agentsdefaultssandbox)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### How do I bind a host folder into the sandbox（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Set `agents.defaults.sandbox.docker.binds` to `["host:path:mode"]` (e.g., `"/home/user/src:/src:ro"`). Global + per-agent binds merge; per-agent binds are ignored when `scope: "shared"`. Use `:ro` for anything sensitive and remember binds bypass the sandbox filesystem walls. See [Sandboxing](/gateway/sandboxing#custom-bind-mounts) and [Sandbox vs Tool Policy vs Elevated](/gateway/sandbox-vs-tool-policy-vs-elevated#bind-mounts-security-quick-check) for examples and safety notes.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### How does memory work（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
OpenClaw memory is just Markdown files in the agent workspace:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Daily notes in `memory/YYYY-MM-DD.md`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Curated long-term notes in `MEMORY.md` (main/private sessions only)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
OpenClaw also runs a **silent pre-compaction memory flush** to remind the model（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
to write durable notes before auto-compaction. This only runs when the workspace（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
is writable (read-only sandboxes skip it). See [Memory](/concepts/memory).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Memory keeps forgetting things How do I make it stick（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Ask the bot to **write the fact to memory**. Long-term notes belong in `MEMORY.md`,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
short-term context goes into `memory/YYYY-MM-DD.md`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
This is still an area we are improving. It helps to remind the model to store memories;（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
it will know what to do. If it keeps forgetting, verify the Gateway is using the same（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
workspace on every run.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Docs: [Memory](/concepts/memory), [Agent workspace](/concepts/agent-workspace).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Does semantic memory search require an OpenAI API key（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Only if you use **OpenAI embeddings**. Codex OAuth covers chat/completions and（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
does **not** grant embeddings access, so **signing in with Codex (OAuth or the（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Codex CLI login)** does not help for semantic memory search. OpenAI embeddings（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
still need a real API key (`OPENAI_API_KEY` or `models.providers.openai.apiKey`).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
If you don't set a provider explicitly, OpenClaw auto-selects a provider when it（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
can resolve an API key (auth profiles, `models.providers.*.apiKey`, or env vars).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
It prefers OpenAI if an OpenAI key resolves, otherwise Gemini if a Gemini key（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
resolves. If neither key is available, memory search stays disabled until you（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
configure it. If you have a local model path configured and present, OpenClaw（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
prefers `local`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
If you'd rather stay local, set `memorySearch.provider = "local"` (and optionally（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
`memorySearch.fallback = "none"`). If you want Gemini embeddings, set（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
`memorySearch.provider = "gemini"` and provide `GEMINI_API_KEY` (or（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
`memorySearch.remote.apiKey`). We support **OpenAI, Gemini, or local** embedding（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
models - see [Memory](/concepts/memory) for the setup details.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Does memory persist forever What are the limits（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Memory files live on disk and persist until you delete them. The limit is your（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
storage, not the model. The **session context** is still limited by the model（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
context window, so long conversations can compact or truncate. That is why（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
memory search exists - it pulls only the relevant parts back into context.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Docs: [Memory](/concepts/memory), [Context](/concepts/context).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Where things live on disk（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Is all data used with OpenClaw saved locally（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
No - **OpenClaw's state is local**, but **external services still see what you send them**.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Local by default:** sessions, memory files, config, and workspace live on the Gateway host（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  (`~/.openclaw` + your workspace directory).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Remote by necessity:** messages you send to model providers (Anthropic/OpenAI/etc.) go to（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  their APIs, and chat platforms (WhatsApp/Telegram/Slack/etc.) store message data on their（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  servers.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **You control the footprint:** using local models keeps prompts on your machine, but channel（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  traffic still goes through the channel's servers.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Related: [Agent workspace](/concepts/agent-workspace), [Memory](/concepts/memory).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Where does OpenClaw store its data（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Everything lives under `$OPENCLAW_STATE_DIR` (default: `~/.openclaw`):（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Path                                                            | Purpose                                                      |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| --------------------------------------------------------------- | ------------------------------------------------------------ |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `$OPENCLAW_STATE_DIR/openclaw.json`                             | Main config (JSON5)                                          |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `$OPENCLAW_STATE_DIR/credentials/oauth.json`                    | Legacy OAuth import (copied into auth profiles on first use) |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `$OPENCLAW_STATE_DIR/agents/<agentId>/agent/auth-profiles.json` | Auth profiles (OAuth + API keys)                             |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `$OPENCLAW_STATE_DIR/agents/<agentId>/agent/auth.json`          | Runtime auth cache (managed automatically)                   |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `$OPENCLAW_STATE_DIR/credentials/`                              | Provider state (e.g. `whatsapp/<accountId>/creds.json`)      |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `$OPENCLAW_STATE_DIR/agents/`                                   | Per-agent state (agentDir + sessions)                        |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `$OPENCLAW_STATE_DIR/agents/<agentId>/sessions/`                | Conversation history & state (per agent)                     |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `$OPENCLAW_STATE_DIR/agents/<agentId>/sessions/sessions.json`   | Session metadata (per agent)                                 |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Legacy single-agent path: `~/.openclaw/agent/*` (migrated by `openclaw doctor`).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Your **workspace** (AGENTS.md, memory files, skills, etc.) is separate and configured via `agents.defaults.workspace` (default: `~/.openclaw/workspace`).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Where should AGENTSmd SOULmd USERmd MEMORYmd live（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
These files live in the **agent workspace**, not `~/.openclaw`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Workspace (per agent)**: `AGENTS.md`, `SOUL.md`, `IDENTITY.md`, `USER.md`,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  `MEMORY.md` (or `memory.md`), `memory/YYYY-MM-DD.md`, optional `HEARTBEAT.md`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **State dir (`~/.openclaw`)**: config, credentials, auth profiles, sessions, logs,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  and shared skills (`~/.openclaw/skills`).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Default workspace is `~/.openclaw/workspace`, configurable via:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json5（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  agents: { defaults: { workspace: "~/.openclaw/workspace" } },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
If the bot "forgets" after a restart, confirm the Gateway is using the same（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
workspace on every launch (and remember: remote mode uses the **gateway host's**（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
workspace, not your local laptop).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Tip: if you want a durable behavior or preference, ask the bot to **write it into（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
AGENTS.md or MEMORY.md** rather than relying on chat history.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
See [Agent workspace](/concepts/agent-workspace) and [Memory](/concepts/memory).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### What's the recommended backup strategy（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Put your **agent workspace** in a **private** git repo and back it up somewhere（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
private (for example GitHub private). This captures memory + AGENTS/SOUL/USER（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
files, and lets you restore the assistant's "mind" later.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Do **not** commit anything under `~/.openclaw` (credentials, sessions, tokens).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
If you need a full restore, back up both the workspace and the state directory（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
separately (see the migration question above).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Docs: [Agent workspace](/concepts/agent-workspace).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### How do I completely uninstall OpenClaw（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
See the dedicated guide: [Uninstall](/install/uninstall).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Can agents work outside the workspace（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Yes. The workspace is the **default cwd** and memory anchor, not a hard sandbox.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Relative paths resolve inside the workspace, but absolute paths can access other（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
host locations unless sandboxing is enabled. If you need isolation, use（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
[`agents.defaults.sandbox`](/gateway/sandboxing) or per-agent sandbox settings. If you（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
want a repo to be the default working directory, point that agent's（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
`workspace` to the repo root. The OpenClaw repo is just source code; keep the（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
workspace separate unless you intentionally want the agent to work inside it.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Example (repo as default cwd):（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json5（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  agents: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    defaults: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      workspace: "~/Projects/my-repo",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Im in remote mode where is the session store（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Session state is owned by the **gateway host**. If you're in remote mode, the session store you care about is on the remote machine, not your local laptop. See [Session management](/concepts/session).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Config basics（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### What format is the config Where is it（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
OpenClaw reads an optional **JSON5** config from `$OPENCLAW_CONFIG_PATH` (default: `~/.openclaw/openclaw.json`):（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
$OPENCLAW_CONFIG_PATH（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
If the file is missing, it uses safe-ish defaults (including a default workspace of `~/.openclaw/workspace`).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### I set gatewaybind lan or tailnet and now nothing listens the UI says unauthorized（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Non-loopback binds **require auth**. Configure `gateway.auth.mode` + `gateway.auth.token` (or use `OPENCLAW_GATEWAY_TOKEN`).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json5（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  gateway: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    bind: "lan",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    auth: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      mode: "token",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      token: "replace-me",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Notes:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `gateway.remote.token` is for **remote CLI calls** only; it does not enable local gateway auth.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- The Control UI authenticates via `connect.params.auth.token` (stored in app/UI settings). Avoid putting tokens in URLs.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Why do I need a token on localhost now（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
The wizard generates a gateway token by default (even on loopback) so **local WS clients must authenticate**. This blocks other local processes from calling the Gateway. Paste the token into the Control UI settings (or your client config) to connect.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
If you **really** want open loopback, remove `gateway.auth` from your config. Doctor can generate a token for you any time: `openclaw doctor --generate-gateway-token`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Do I have to restart after changing config（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
The Gateway watches the config and supports hot-reload:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `gateway.reload.mode: "hybrid"` (default): hot-apply safe changes, restart for critical ones（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `hot`, `restart`, `off` are also supported（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### How do I enable web search and web fetch（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
`web_fetch` works without an API key. `web_search` requires a Brave Search API（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
key. **Recommended:** run `openclaw configure --section web` to store it in（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
`tools.web.search.apiKey`. Environment alternative: set `BRAVE_API_KEY` for the（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Gateway process.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json5（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  tools: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    web: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      search: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        enabled: true,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        apiKey: "BRAVE_API_KEY_HERE",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        maxResults: 5,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      fetch: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        enabled: true,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Notes:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- If you use allowlists, add `web_search`/`web_fetch` or `group:web`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `web_fetch` is enabled by default (unless explicitly disabled).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Daemons read env vars from `~/.openclaw/.env` (or the service environment).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Docs: [Web tools](/tools/web).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### How do I run a central Gateway with specialized workers across devices（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
The common pattern is **one Gateway** (e.g. Raspberry Pi) plus **nodes** and **agents**:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Gateway (central):** owns channels (Signal/WhatsApp), routing, and sessions.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Nodes (devices):** Macs/iOS/Android connect as peripherals and expose local tools (`system.run`, `canvas`, `camera`).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Agents (workers):** separate brains/workspaces for special roles (e.g. "Hetzner ops", "Personal data").（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Sub-agents:** spawn background work from a main agent when you want parallelism.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **TUI:** connect to the Gateway and switch agents/sessions.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Docs: [Nodes](/nodes), [Remote access](/gateway/remote), [Multi-Agent Routing](/concepts/multi-agent), [Sub-agents](/tools/subagents), [TUI](/web/tui).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Can the OpenClaw browser run headless（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Yes. It's a config option:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json5（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  browser: { headless: true },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  agents: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    defaults: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      sandbox: { browser: { headless: true } },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Default is `false` (headful). Headless is more likely to trigger anti-bot checks on some sites. See [Browser](/tools/browser).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Headless uses the **same Chromium engine** and works for most automation (forms, clicks, scraping, logins). The main differences:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- No visible browser window (use screenshots if you need visuals).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Some sites are stricter about automation in headless mode (CAPTCHAs, anti-bot).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  For example, X/Twitter often blocks headless sessions.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### How do I use Brave for browser control（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Set `browser.executablePath` to your Brave binary (or any Chromium-based browser) and restart the Gateway.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
See the full config examples in [Browser](/tools/browser#use-brave-or-another-chromium-based-browser).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Remote gateways and nodes（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### How do commands propagate between Telegram the gateway and nodes（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Telegram messages are handled by the **gateway**. The gateway runs the agent and（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
only then calls nodes over the **Gateway WebSocket** when a node tool is needed:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Telegram → Gateway → Agent → `node.*` → Node → Gateway → Telegram（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Nodes don't see inbound provider traffic; they only receive node RPC calls.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### How can my agent access my computer if the Gateway is hosted remotely（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Short answer: **pair your computer as a node**. The Gateway runs elsewhere, but it can（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
call `node.*` tools (screen, camera, system) on your local machine over the Gateway WebSocket.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Typical setup:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
1. Run the Gateway on the always-on host (VPS/home server).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
2. Put the Gateway host + your computer on the same tailnet.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
3. Ensure the Gateway WS is reachable (tailnet bind or SSH tunnel).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
4. Open the macOS app locally and connect in **Remote over SSH** mode (or direct tailnet)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
   so it can register as a node.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
5. Approve the node on the Gateway:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
   ```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
   openclaw nodes pending（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
   openclaw nodes approve <requestId>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
   ```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
No separate TCP bridge is required; nodes connect over the Gateway WebSocket.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Security reminder: pairing a macOS node allows `system.run` on that machine. Only（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
pair devices you trust, and review [Security](/gateway/security).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Docs: [Nodes](/nodes), [Gateway protocol](/gateway/protocol), [macOS remote mode](/platforms/mac/remote), [Security](/gateway/security).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Tailscale is connected but I get no replies What now（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Check the basics:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Gateway is running: `openclaw gateway status`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Gateway health: `openclaw status`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Channel health: `openclaw channels status`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Then verify auth and routing:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- If you use Tailscale Serve, make sure `gateway.auth.allowTailscale` is set correctly.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- If you connect via SSH tunnel, confirm the local tunnel is up and points at the right port.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Confirm your allowlists (DM or group) include your account.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Docs: [Tailscale](/gateway/tailscale), [Remote access](/gateway/remote), [Channels](/channels).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Can two OpenClaw instances talk to each other local VPS（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Yes. There is no built-in "bot-to-bot" bridge, but you can wire it up in a few（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
reliable ways:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**Simplest:** use a normal chat channel both bots can access (Telegram/Slack/WhatsApp).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Have Bot A send a message to Bot B, then let Bot B reply as usual.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**CLI bridge (generic):** run a script that calls the other Gateway with（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
`openclaw agent --message ... --deliver`, targeting a chat where the other bot（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
listens. If one bot is on a remote VPS, point your CLI at that remote Gateway（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
via SSH/Tailscale (see [Remote access](/gateway/remote)).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Example pattern (run from a machine that can reach the target Gateway):（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw agent --message "Hello from local bot" --deliver --channel telegram --reply-to <chat-id>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Tip: add a guardrail so the two bots do not loop endlessly (mention-only, channel（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
allowlists, or a "do not reply to bot messages" rule).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Docs: [Remote access](/gateway/remote), [Agent CLI](/cli/agent), [Agent send](/tools/agent-send).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Do I need separate VPSes for multiple agents（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
No. One Gateway can host multiple agents, each with its own workspace, model defaults,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
and routing. That is the normal setup and it is much cheaper and simpler than running（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
one VPS per agent.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Use separate VPSes only when you need hard isolation (security boundaries) or very（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
different configs that you do not want to share. Otherwise, keep one Gateway and（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
use multiple agents or sub-agents.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Is there a benefit to using a node on my personal laptop instead of SSH from a VPS（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Yes - nodes are the first-class way to reach your laptop from a remote Gateway, and they（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
unlock more than shell access. The Gateway runs on macOS/Linux (Windows via WSL2) and is（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
lightweight (a small VPS or Raspberry Pi-class box is fine; 4 GB RAM is plenty), so a common（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
setup is an always-on host plus your laptop as a node.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **No inbound SSH required.** Nodes connect out to the Gateway WebSocket and use device pairing.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Safer execution controls.** `system.run` is gated by node allowlists/approvals on that laptop.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **More device tools.** Nodes expose `canvas`, `camera`, and `screen` in addition to `system.run`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Local browser automation.** Keep the Gateway on a VPS, but run Chrome locally and relay control（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  with the Chrome extension + a node host on the laptop.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
SSH is fine for ad-hoc shell access, but nodes are simpler for ongoing agent workflows and（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
device automation.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Docs: [Nodes](/nodes), [Nodes CLI](/cli/nodes), [Chrome extension](/tools/chrome-extension).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Should I install on a second laptop or just add a node（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
If you only need **local tools** (screen/camera/exec) on the second laptop, add it as a（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**node**. That keeps a single Gateway and avoids duplicated config. Local node tools are（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
currently macOS-only, but we plan to extend them to other OSes.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Install a second Gateway only when you need **hard isolation** or two fully separate bots.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Docs: [Nodes](/nodes), [Nodes CLI](/cli/nodes), [Multiple gateways](/gateway/multiple-gateways).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Do nodes run a gateway service（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
No. Only **one gateway** should run per host unless you intentionally run isolated profiles (see [Multiple gateways](/gateway/multiple-gateways)). Nodes are peripherals that connect（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
to the gateway (iOS/Android nodes, or macOS "node mode" in the menubar app). For headless node（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
hosts and CLI control, see [Node host CLI](/cli/node).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
A full restart is required for `gateway`, `discovery`, and `canvasHost` changes.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Is there an API RPC way to apply config（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Yes. `config.apply` validates + writes the full config and restarts the Gateway as part of the operation.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### configapply wiped my config How do I recover and avoid this（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
`config.apply` replaces the **entire config**. If you send a partial object, everything（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
else is removed.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Recover:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Restore from backup (git or a copied `~/.openclaw/openclaw.json`).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- If you have no backup, re-run `openclaw doctor` and reconfigure channels/models.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- If this was unexpected, file a bug and include your last known config or any backup.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- A local coding agent can often reconstruct a working config from logs or history.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Avoid it:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Use `openclaw config set` for small changes.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Use `openclaw configure` for interactive edits.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Docs: [Config](/cli/config), [Configure](/cli/configure), [Doctor](/gateway/doctor).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### What's a minimal sane config for a first install（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json5（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  agents: { defaults: { workspace: "~/.openclaw/workspace" } },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  channels: { whatsapp: { allowFrom: ["+15555550123"] } },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
This sets your workspace and restricts who can trigger the bot.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### How do I set up Tailscale on a VPS and connect from my Mac（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Minimal steps:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
1. **Install + login on the VPS**（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
   ```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
   curl -fsSL https://tailscale.com/install.sh | sh（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
   sudo tailscale up（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
   ```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
2. **Install + login on your Mac**（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
   - Use the Tailscale app and sign in to the same tailnet.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
3. **Enable MagicDNS (recommended)**（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
   - In the Tailscale admin console, enable MagicDNS so the VPS has a stable name.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
4. **Use the tailnet hostname**（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
   - SSH: `ssh user@your-vps.tailnet-xxxx.ts.net`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
   - Gateway WS: `ws://your-vps.tailnet-xxxx.ts.net:18789`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
If you want the Control UI without SSH, use Tailscale Serve on the VPS:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw gateway --tailscale serve（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
This keeps the gateway bound to loopback and exposes HTTPS via Tailscale. See [Tailscale](/gateway/tailscale).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### How do I connect a Mac node to a remote Gateway Tailscale Serve（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Serve exposes the **Gateway Control UI + WS**. Nodes connect over the same Gateway WS endpoint.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Recommended setup:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
1. **Make sure the VPS + Mac are on the same tailnet**.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
2. **Use the macOS app in Remote mode** (SSH target can be the tailnet hostname).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
   The app will tunnel the Gateway port and connect as a node.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
3. **Approve the node** on the gateway:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
   ```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
   openclaw nodes pending（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
   openclaw nodes approve <requestId>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
   ```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Docs: [Gateway protocol](/gateway/protocol), [Discovery](/gateway/discovery), [macOS remote mode](/platforms/mac/remote).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Env vars and .env loading（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### How does OpenClaw load environment variables（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
OpenClaw reads env vars from the parent process (shell, launchd/systemd, CI, etc.) and additionally loads:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `.env` from the current working directory（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- a global fallback `.env` from `~/.openclaw/.env` (aka `$OPENCLAW_STATE_DIR/.env`)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Neither `.env` file overrides existing env vars.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
You can also define inline env vars in config (applied only if missing from the process env):（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json5（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  env: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    OPENROUTER_API_KEY: "sk-or-...",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    vars: { GROQ_API_KEY: "gsk-..." },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
See [/environment](/help/environment) for full precedence and sources.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### I started the Gateway via the service and my env vars disappeared What now（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Two common fixes:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
1. Put the missing keys in `~/.openclaw/.env` so they're picked up even when the service doesn't inherit your shell env.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
2. Enable shell import (opt-in convenience):（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json5（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  env: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    shellEnv: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      enabled: true,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      timeoutMs: 15000,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
This runs your login shell and imports only missing expected keys (never overrides). Env var equivalents:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
`OPENCLAW_LOAD_SHELL_ENV=1`, `OPENCLAW_SHELL_ENV_TIMEOUT_MS=15000`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### I set COPILOTGITHUBTOKEN but models status shows Shell env off Why（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
`openclaw models status` reports whether **shell env import** is enabled. "Shell env: off"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
does **not** mean your env vars are missing - it just means OpenClaw won't load（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
your login shell automatically.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
If the Gateway runs as a service (launchd/systemd), it won't inherit your shell（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
environment. Fix by doing one of these:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
1. Put the token in `~/.openclaw/.env`:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
   ```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
   COPILOT_GITHUB_TOKEN=...（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
   ```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
2. Or enable shell import (`env.shellEnv.enabled: true`).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
3. Or add it to your config `env` block (applies only if missing).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Then restart the gateway and recheck:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw models status（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Copilot tokens are read from `COPILOT_GITHUB_TOKEN` (also `GH_TOKEN` / `GITHUB_TOKEN`).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
See [/concepts/model-providers](/concepts/model-providers) and [/environment](/help/environment).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Sessions and multiple chats（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### How do I start a fresh conversation（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Send `/new` or `/reset` as a standalone message. See [Session management](/concepts/session).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Do sessions reset automatically if I never send new（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Yes. Sessions expire after `session.idleMinutes` (default **60**). The **next**（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
message starts a fresh session id for that chat key. This does not delete（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
transcripts - it just starts a new session.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json5（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  session: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    idleMinutes: 240,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Is there a way to make a team of OpenClaw instances one CEO and many agents（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Yes, via **multi-agent routing** and **sub-agents**. You can create one coordinator（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
agent and several worker agents with their own workspaces and models.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
That said, this is best seen as a **fun experiment**. It is token heavy and often（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
less efficient than using one bot with separate sessions. The typical model we（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
envision is one bot you talk to, with different sessions for parallel work. That（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
bot can also spawn sub-agents when needed.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Docs: [Multi-agent routing](/concepts/multi-agent), [Sub-agents](/tools/subagents), [Agents CLI](/cli/agents).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Why did context get truncated midtask How do I prevent it（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Session context is limited by the model window. Long chats, large tool outputs, or many（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
files can trigger compaction or truncation.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
What helps:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Ask the bot to summarize the current state and write it to a file.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Use `/compact` before long tasks, and `/new` when switching topics.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Keep important context in the workspace and ask the bot to read it back.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Use sub-agents for long or parallel work so the main chat stays smaller.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Pick a model with a larger context window if this happens often.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### How do I completely reset OpenClaw but keep it installed（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Use the reset command:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw reset（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Non-interactive full reset:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw reset --scope full --yes --non-interactive（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Then re-run onboarding:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw onboard --install-daemon（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Notes:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- The onboarding wizard also offers **Reset** if it sees an existing config. See [Wizard](/start/wizard).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- If you used profiles (`--profile` / `OPENCLAW_PROFILE`), reset each state dir (defaults are `~/.openclaw-<profile>`).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Dev reset: `openclaw gateway --dev --reset` (dev-only; wipes dev config + credentials + sessions + workspace).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Im getting context too large errors how do I reset or compact（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Use one of these:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Compact** (keeps the conversation but summarizes older turns):（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  ```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  /compact（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  ```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  or `/compact <instructions>` to guide the summary.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Reset** (fresh session ID for the same chat key):（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  ```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  /new（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  /reset（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  ```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
If it keeps happening:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Enable or tune **session pruning** (`agents.defaults.contextPruning`) to trim old tool output.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Use a model with a larger context window.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Docs: [Compaction](/concepts/compaction), [Session pruning](/concepts/session-pruning), [Session management](/concepts/session).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Why am I seeing LLM request rejected messagesNcontentXtooluseinput Field required（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
This is a provider validation error: the model emitted a `tool_use` block without the required（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
`input`. It usually means the session history is stale or corrupted (often after long threads（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
or a tool/schema change).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Fix: start a fresh session with `/new` (standalone message).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Why am I getting heartbeat messages every 30 minutes（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Heartbeats run every **30m** by default. Tune or disable them:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json5（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  agents: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    defaults: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      heartbeat: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        every: "2h", // or "0m" to disable（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
If `HEARTBEAT.md` exists but is effectively empty (only blank lines and markdown（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
headers like `# Heading`), OpenClaw skips the heartbeat run to save API calls.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
If the file is missing, the heartbeat still runs and the model decides what to do.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Per-agent overrides use `agents.list[].heartbeat`. Docs: [Heartbeat](/gateway/heartbeat).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Do I need to add a bot account to a WhatsApp group（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
No. OpenClaw runs on **your own account**, so if you're in the group, OpenClaw can see it.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
By default, group replies are blocked until you allow senders (`groupPolicy: "allowlist"`).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
If you want only **you** to be able to trigger group replies:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json5（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  channels: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    whatsapp: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      groupPolicy: "allowlist",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      groupAllowFrom: ["+15551234567"],（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### How do I get the JID of a WhatsApp group（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Option 1 (fastest): tail logs and send a test message in the group:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw logs --follow --json（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Look for `chatId` (or `from`) ending in `@g.us`, like:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
`1234567890-1234567890@g.us`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Option 2 (if already configured/allowlisted): list groups from config:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw directory groups list --channel whatsapp（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Docs: [WhatsApp](/channels/whatsapp), [Directory](/cli/directory), [Logs](/cli/logs).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Why doesnt OpenClaw reply in a group（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Two common causes:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Mention gating is on (default). You must @mention the bot (or match `mentionPatterns`).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- You configured `channels.whatsapp.groups` without `"*"` and the group isn't allowlisted.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
See [Groups](/channels/groups) and [Group messages](/channels/group-messages).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Do groupsthreads share context with DMs（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Direct chats collapse to the main session by default. Groups/channels have their own session keys, and Telegram topics / Discord threads are separate sessions. See [Groups](/channels/groups) and [Group messages](/channels/group-messages).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### How many workspaces and agents can I create（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
No hard limits. Dozens (even hundreds) are fine, but watch for:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Disk growth:** sessions + transcripts live under `~/.openclaw/agents/<agentId>/sessions/`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Token cost:** more agents means more concurrent model usage.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Ops overhead:** per-agent auth profiles, workspaces, and channel routing.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Tips:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Keep one **active** workspace per agent (`agents.defaults.workspace`).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Prune old sessions (delete JSONL or store entries) if disk grows.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Use `openclaw doctor` to spot stray workspaces and profile mismatches.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Can I run multiple bots or chats at the same time Slack and how should I set that up（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Yes. Use **Multi-Agent Routing** to run multiple isolated agents and route inbound messages by（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
channel/account/peer. Slack is supported as a channel and can be bound to specific agents.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Browser access is powerful but not "do anything a human can" - anti-bot, CAPTCHAs, and MFA can（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
still block automation. For the most reliable browser control, use the Chrome extension relay（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
on the machine that runs the browser (and keep the Gateway anywhere).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Best-practice setup:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Always-on Gateway host (VPS/Mac mini).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- One agent per role (bindings).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Slack channel(s) bound to those agents.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Local browser via extension relay (or a node) when needed.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Docs: [Multi-Agent Routing](/concepts/multi-agent), [Slack](/channels/slack),（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
[Browser](/tools/browser), [Chrome extension](/tools/chrome-extension), [Nodes](/nodes).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Models: defaults, selection, aliases, switching（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### What is the default model（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
OpenClaw's default model is whatever you set as:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
agents.defaults.model.primary（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Models are referenced as `provider/model` (example: `anthropic/claude-opus-4-6`). If you omit the provider, OpenClaw currently assumes `anthropic` as a temporary deprecation fallback - but you should still **explicitly** set `provider/model`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### What model do you recommend（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**Recommended default:** `anthropic/claude-opus-4-6`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**Good alternative:** `anthropic/claude-sonnet-4-5`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**Reliable (less character):** `openai/gpt-5.2` - nearly as good as Opus, just less personality.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**Budget:** `zai/glm-4.7`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
MiniMax M2.1 has its own docs: [MiniMax](/providers/minimax) and（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
[Local models](/gateway/local-models).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Rule of thumb: use the **best model you can afford** for high-stakes work, and a cheaper（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
model for routine chat or summaries. You can route models per agent and use sub-agents to（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
parallelize long tasks (each sub-agent consumes tokens). See [Models](/concepts/models) and（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
[Sub-agents](/tools/subagents).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Strong warning: weaker/over-quantized models are more vulnerable to prompt（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
injection and unsafe behavior. See [Security](/gateway/security).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
More context: [Models](/concepts/models).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Can I use selfhosted models llamacpp vLLM Ollama（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Yes. If your local server exposes an OpenAI-compatible API, you can point a（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
custom provider at it. Ollama is supported directly and is the easiest path.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Security note: smaller or heavily quantized models are more vulnerable to prompt（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
injection. We strongly recommend **large models** for any bot that can use tools.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
If you still want small models, enable sandboxing and strict tool allowlists.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Docs: [Ollama](/providers/ollama), [Local models](/gateway/local-models),（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
[Model providers](/concepts/model-providers), [Security](/gateway/security),（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
[Sandboxing](/gateway/sandboxing).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### How do I switch models without wiping my config（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Use **model commands** or edit only the **model** fields. Avoid full config replaces.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Safe options:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `/model` in chat (quick, per-session)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `openclaw models set ...` (updates just model config)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `openclaw configure --section model` (interactive)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- edit `agents.defaults.model` in `~/.openclaw/openclaw.json`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Avoid `config.apply` with a partial object unless you intend to replace the whole config.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
If you did overwrite config, restore from backup or re-run `openclaw doctor` to repair.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Docs: [Models](/concepts/models), [Configure](/cli/configure), [Config](/cli/config), [Doctor](/gateway/doctor).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### What do OpenClaw, Flawd, and Krill use for models（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **OpenClaw + Flawd:** Anthropic Opus (`anthropic/claude-opus-4-6`) - see [Anthropic](/providers/anthropic).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Krill:** MiniMax M2.1 (`minimax/MiniMax-M2.1`) - see [MiniMax](/providers/minimax).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### How do I switch models on the fly without restarting（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Use the `/model` command as a standalone message:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
/model sonnet（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
/model haiku（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
/model opus（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
/model gpt（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
/model gpt-mini（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
/model gemini（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
/model gemini-flash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
You can list available models with `/model`, `/model list`, or `/model status`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
`/model` (and `/model list`) shows a compact, numbered picker. Select by number:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
/model 3（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
You can also force a specific auth profile for the provider (per session):（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
/model opus@anthropic:default（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
/model opus@anthropic:work（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Tip: `/model status` shows which agent is active, which `auth-profiles.json` file is being used, and which auth profile will be tried next.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
It also shows the configured provider endpoint (`baseUrl`) and API mode (`api`) when available.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**How do I unpin a profile I set with profile**（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Re-run `/model` **without** the `@profile` suffix:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
/model anthropic/claude-opus-4-6（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
If you want to return to the default, pick it from `/model` (or send `/model <default provider/model>`).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Use `/model status` to confirm which auth profile is active.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Can I use GPT 5.2 for daily tasks and Codex 5.3 for coding（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Yes. Set one as default and switch as needed:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Quick switch (per session):** `/model gpt-5.2` for daily tasks, `/model gpt-5.3-codex` for coding.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Default + switch:** set `agents.defaults.model.primary` to `openai/gpt-5.2`, then switch to `openai-codex/gpt-5.3-codex` when coding (or the other way around).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Sub-agents:** route coding tasks to sub-agents with a different default model.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
See [Models](/concepts/models) and [Slash commands](/tools/slash-commands).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Why do I see Model is not allowed and then no reply（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
If `agents.defaults.models` is set, it becomes the **allowlist** for `/model` and any（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
session overrides. Choosing a model that isn't in that list returns:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Model "provider/model" is not allowed. Use /model to list available models.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
That error is returned **instead of** a normal reply. Fix: add the model to（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
`agents.defaults.models`, remove the allowlist, or pick a model from `/model list`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Why do I see Unknown model minimaxMiniMaxM21（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
This means the **provider isn't configured** (no MiniMax provider config or auth（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
profile was found), so the model can't be resolved. A fix for this detection is（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
in **2026.1.12** (unreleased at the time of writing).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Fix checklist:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
1. Upgrade to **2026.1.12** (or run from source `main`), then restart the gateway.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
2. Make sure MiniMax is configured (wizard or JSON), or that a MiniMax API key（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
   exists in env/auth profiles so the provider can be injected.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
3. Use the exact model id (case-sensitive): `minimax/MiniMax-M2.1` or（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
   `minimax/MiniMax-M2.1-lightning`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
4. Run:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
   ```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
   openclaw models list（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
   ```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
   and pick from the list (or `/model list` in chat).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
See [MiniMax](/providers/minimax) and [Models](/concepts/models).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Can I use MiniMax as my default and OpenAI for complex tasks（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Yes. Use **MiniMax as the default** and switch models **per session** when needed.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Fallbacks are for **errors**, not "hard tasks," so use `/model` or a separate agent.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**Option A: switch per session**（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json5（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  env: { MINIMAX_API_KEY: "sk-...", OPENAI_API_KEY: "sk-..." },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  agents: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    defaults: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      model: { primary: "minimax/MiniMax-M2.1" },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      models: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        "minimax/MiniMax-M2.1": { alias: "minimax" },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        "openai/gpt-5.2": { alias: "gpt" },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Then:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
/model gpt（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**Option B: separate agents**（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Agent A default: MiniMax（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Agent B default: OpenAI（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Route by agent or use `/agent` to switch（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Docs: [Models](/concepts/models), [Multi-Agent Routing](/concepts/multi-agent), [MiniMax](/providers/minimax), [OpenAI](/providers/openai).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Are opus sonnet gpt builtin shortcuts（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Yes. OpenClaw ships a few default shorthands (only applied when the model exists in `agents.defaults.models`):（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `opus` → `anthropic/claude-opus-4-6`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `sonnet` → `anthropic/claude-sonnet-4-5`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `gpt` → `openai/gpt-5.2`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `gpt-mini` → `openai/gpt-5-mini`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `gemini` → `google/gemini-3-pro-preview`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `gemini-flash` → `google/gemini-3-flash-preview`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
If you set your own alias with the same name, your value wins.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### How do I defineoverride model shortcuts aliases（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Aliases come from `agents.defaults.models.<modelId>.alias`. Example:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json5（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  agents: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    defaults: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      model: { primary: "anthropic/claude-opus-4-6" },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      models: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        "anthropic/claude-opus-4-6": { alias: "opus" },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        "anthropic/claude-sonnet-4-5": { alias: "sonnet" },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        "anthropic/claude-haiku-4-5": { alias: "haiku" },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Then `/model sonnet` (or `/<alias>` when supported) resolves to that model ID.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### How do I add models from other providers like OpenRouter or ZAI（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
OpenRouter (pay-per-token; many models):（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json5（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  agents: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    defaults: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      model: { primary: "openrouter/anthropic/claude-sonnet-4-5" },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      models: { "openrouter/anthropic/claude-sonnet-4-5": {} },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  env: { OPENROUTER_API_KEY: "sk-or-..." },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Z.AI (GLM models):（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json5（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  agents: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    defaults: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      model: { primary: "zai/glm-4.7" },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      models: { "zai/glm-4.7": {} },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  env: { ZAI_API_KEY: "..." },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
If you reference a provider/model but the required provider key is missing, you'll get a runtime auth error (e.g. `No API key found for provider "zai"`).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**No API key found for provider after adding a new agent**（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
This usually means the **new agent** has an empty auth store. Auth is per-agent and（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
stored in:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
~/.openclaw/agents/<agentId>/agent/auth-profiles.json（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Fix options:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Run `openclaw agents add <id>` and configure auth during the wizard.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Or copy `auth-profiles.json` from the main agent's `agentDir` into the new agent's `agentDir`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Do **not** reuse `agentDir` across agents; it causes auth/session collisions.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Model failover and "All models failed"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### How does failover work（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Failover happens in two stages:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
1. **Auth profile rotation** within the same provider.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
2. **Model fallback** to the next model in `agents.defaults.model.fallbacks`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Cooldowns apply to failing profiles (exponential backoff), so OpenClaw can keep responding even when a provider is rate-limited or temporarily failing.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### What does this error mean（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
No credentials found for profile "anthropic:default"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
It means the system attempted to use the auth profile ID `anthropic:default`, but could not find credentials for it in the expected auth store.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Fix checklist for No credentials found for profile anthropicdefault（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Confirm where auth profiles live** (new vs legacy paths)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Current: `~/.openclaw/agents/<agentId>/agent/auth-profiles.json`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Legacy: `~/.openclaw/agent/*` (migrated by `openclaw doctor`)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Confirm your env var is loaded by the Gateway**（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - If you set `ANTHROPIC_API_KEY` in your shell but run the Gateway via systemd/launchd, it may not inherit it. Put it in `~/.openclaw/.env` or enable `env.shellEnv`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Make sure you're editing the correct agent**（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Multi-agent setups mean there can be multiple `auth-profiles.json` files.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Sanity-check model/auth status**（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Use `openclaw models status` to see configured models and whether providers are authenticated.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**Fix checklist for No credentials found for profile anthropic**（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
This means the run is pinned to an Anthropic auth profile, but the Gateway（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
can't find it in its auth store.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Use a setup-token**（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Run `claude setup-token`, then paste it with `openclaw models auth setup-token --provider anthropic`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - If the token was created on another machine, use `openclaw models auth paste-token --provider anthropic`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **If you want to use an API key instead**（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Put `ANTHROPIC_API_KEY` in `~/.openclaw/.env` on the **gateway host**.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Clear any pinned order that forces a missing profile:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    ```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    openclaw models auth order clear --provider anthropic（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    ```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Confirm you're running commands on the gateway host**（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - In remote mode, auth profiles live on the gateway machine, not your laptop.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Why did it also try Google Gemini and fail（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
If your model config includes Google Gemini as a fallback (or you switched to a Gemini shorthand), OpenClaw will try it during model fallback. If you haven't configured Google credentials, you'll see `No API key found for provider "google"`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Fix: either provide Google auth, or remove/avoid Google models in `agents.defaults.model.fallbacks` / aliases so fallback doesn't route there.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**LLM request rejected message thinking signature required google antigravity**（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Cause: the session history contains **thinking blocks without signatures** (often from（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
an aborted/partial stream). Google Antigravity requires signatures for thinking blocks.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Fix: OpenClaw now strips unsigned thinking blocks for Google Antigravity Claude. If it still appears, start a **new session** or set `/thinking off` for that agent.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Auth profiles: what they are and how to manage them（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Related: [/concepts/oauth](/concepts/oauth) (OAuth flows, token storage, multi-account patterns)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### What is an auth profile（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
An auth profile is a named credential record (OAuth or API key) tied to a provider. Profiles live in:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
~/.openclaw/agents/<agentId>/agent/auth-profiles.json（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### What are typical profile IDs（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
OpenClaw uses provider-prefixed IDs like:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `anthropic:default` (common when no email identity exists)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `anthropic:<email>` for OAuth identities（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- custom IDs you choose (e.g. `anthropic:work`)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Can I control which auth profile is tried first（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Yes. Config supports optional metadata for profiles and an ordering per provider (`auth.order.<provider>`). This does **not** store secrets; it maps IDs to provider/mode and sets rotation order.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
OpenClaw may temporarily skip a profile if it's in a short **cooldown** (rate limits/timeouts/auth failures) or a longer **disabled** state (billing/insufficient credits). To inspect this, run `openclaw models status --json` and check `auth.unusableProfiles`. Tuning: `auth.cooldowns.billingBackoffHours*`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
You can also set a **per-agent** order override (stored in that agent's `auth-profiles.json`) via the CLI:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Defaults to the configured default agent (omit --agent)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw models auth order get --provider anthropic（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Lock rotation to a single profile (only try this one)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw models auth order set --provider anthropic anthropic:default（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Or set an explicit order (fallback within provider)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw models auth order set --provider anthropic anthropic:work anthropic:default（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Clear override (fall back to config auth.order / round-robin)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw models auth order clear --provider anthropic（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
To target a specific agent:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw models auth order set --provider anthropic --agent main anthropic:default（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### OAuth vs API key whats the difference（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
OpenClaw supports both:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **OAuth** often leverages subscription access (where applicable).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **API keys** use pay-per-token billing.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
The wizard explicitly supports Anthropic setup-token and OpenAI Codex OAuth and can store API keys for you.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Gateway: ports, "already running", and remote mode（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### What port does the Gateway use（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
`gateway.port` controls the single multiplexed port for WebSocket + HTTP (Control UI, hooks, etc.).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Precedence:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
--port > OPENCLAW_GATEWAY_PORT > gateway.port > default 18789（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Why does openclaw gateway status say Runtime running but RPC probe failed（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Because "running" is the **supervisor's** view (launchd/systemd/schtasks). The RPC probe is the CLI actually connecting to the gateway WebSocket and calling `status`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Use `openclaw gateway status` and trust these lines:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `Probe target:` (the URL the probe actually used)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `Listening:` (what's actually bound on the port)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `Last gateway error:` (common root cause when the process is alive but the port isn't listening)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Why does openclaw gateway status show Config cli and Config service different（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
You're editing one config file while the service is running another (often a `--profile` / `OPENCLAW_STATE_DIR` mismatch).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Fix:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw gateway install --force（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Run that from the same `--profile` / environment you want the service to use.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### What does another gateway instance is already listening mean（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
OpenClaw enforces a runtime lock by binding the WebSocket listener immediately on startup (default `ws://127.0.0.1:18789`). If the bind fails with `EADDRINUSE`, it throws `GatewayLockError` indicating another instance is already listening.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Fix: stop the other instance, free the port, or run with `openclaw gateway --port <port>`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### How do I run OpenClaw in remote mode client connects to a Gateway elsewhere（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Set `gateway.mode: "remote"` and point to a remote WebSocket URL, optionally with a token/password:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json5（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  gateway: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    mode: "remote",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    remote: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      url: "ws://gateway.tailnet:18789",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      token: "your-token",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      password: "your-password",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Notes:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `openclaw gateway` only starts when `gateway.mode` is `local` (or you pass the override flag).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- The macOS app watches the config file and switches modes live when these values change.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### The Control UI says unauthorized or keeps reconnecting What now（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Your gateway is running with auth enabled (`gateway.auth.*`), but the UI is not sending the matching token/password.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Facts (from code):（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- The Control UI stores the token in browser localStorage key `openclaw.control.settings.v1`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Fix:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Fastest: `openclaw dashboard` (prints + copies the dashboard URL, tries to open; shows SSH hint if headless).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- If you don't have a token yet: `openclaw doctor --generate-gateway-token`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- If remote, tunnel first: `ssh -N -L 18789:127.0.0.1:18789 user@host` then open `http://127.0.0.1:18789/`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Set `gateway.auth.token` (or `OPENCLAW_GATEWAY_TOKEN`) on the gateway host.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- In the Control UI settings, paste the same token.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Still stuck? Run `openclaw status --all` and follow [Troubleshooting](/gateway/troubleshooting). See [Dashboard](/web/dashboard) for auth details.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### I set gatewaybind tailnet but it cant bind nothing listens（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
`tailnet` bind picks a Tailscale IP from your network interfaces (100.64.0.0/10). If the machine isn't on Tailscale (or the interface is down), there's nothing to bind to.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Fix:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Start Tailscale on that host (so it has a 100.x address), or（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Switch to `gateway.bind: "loopback"` / `"lan"`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Note: `tailnet` is explicit. `auto` prefers loopback; use `gateway.bind: "tailnet"` when you want a tailnet-only bind.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Can I run multiple Gateways on the same host（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Usually no - one Gateway can run multiple messaging channels and agents. Use multiple Gateways only when you need redundancy (ex: rescue bot) or hard isolation.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Yes, but you must isolate:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `OPENCLAW_CONFIG_PATH` (per-instance config)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `OPENCLAW_STATE_DIR` (per-instance state)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `agents.defaults.workspace` (workspace isolation)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `gateway.port` (unique ports)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Quick setup (recommended):（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Use `openclaw --profile <name> …` per instance (auto-creates `~/.openclaw-<name>`).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Set a unique `gateway.port` in each profile config (or pass `--port` for manual runs).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Install a per-profile service: `openclaw --profile <name> gateway install`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Profiles also suffix service names (`bot.molt.<profile>`; legacy `com.openclaw.*`, `openclaw-gateway-<profile>.service`, `OpenClaw Gateway (<profile>)`).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Full guide: [Multiple gateways](/gateway/multiple-gateways).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### What does invalid handshake code 1008 mean（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
The Gateway is a **WebSocket server**, and it expects the very first message to（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
be a `connect` frame. If it receives anything else, it closes the connection（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
with **code 1008** (policy violation).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Common causes:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- You opened the **HTTP** URL in a browser (`http://...`) instead of a WS client.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- You used the wrong port or path.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- A proxy or tunnel stripped auth headers or sent a non-Gateway request.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Quick fixes:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
1. Use the WS URL: `ws://<host>:18789` (or `wss://...` if HTTPS).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
2. Don't open the WS port in a normal browser tab.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
3. If auth is on, include the token/password in the `connect` frame.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
If you're using the CLI or TUI, the URL should look like:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw tui --url ws://<host>:18789 --token <token>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Protocol details: [Gateway protocol](/gateway/protocol).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Logging and debugging（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Where are logs（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
File logs (structured):（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
/tmp/openclaw/openclaw-YYYY-MM-DD.log（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
You can set a stable path via `logging.file`. File log level is controlled by `logging.level`. Console verbosity is controlled by `--verbose` and `logging.consoleLevel`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Fastest log tail:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw logs --follow（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Service/supervisor logs (when the gateway runs via launchd/systemd):（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- macOS: `$OPENCLAW_STATE_DIR/logs/gateway.log` and `gateway.err.log` (default: `~/.openclaw/logs/...`; profiles use `~/.openclaw-<profile>/logs/...`)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Linux: `journalctl --user -u openclaw-gateway[-<profile>].service -n 200 --no-pager`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Windows: `schtasks /Query /TN "OpenClaw Gateway (<profile>)" /V /FO LIST`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
See [Troubleshooting](/gateway/troubleshooting#log-locations) for more.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### How do I startstoprestart the Gateway service（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Use the gateway helpers:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw gateway status（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw gateway restart（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
If you run the gateway manually, `openclaw gateway --force` can reclaim the port. See [Gateway](/gateway).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### I closed my terminal on Windows how do I restart OpenClaw（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
There are **two Windows install modes**:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**1) WSL2 (recommended):** the Gateway runs inside Linux.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Open PowerShell, enter WSL, then restart:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```powershell（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
wsl（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw gateway status（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw gateway restart（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
If you never installed the service, start it in the foreground:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw gateway run（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**2) Native Windows (not recommended):** the Gateway runs directly in Windows.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Open PowerShell and run:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```powershell（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw gateway status（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw gateway restart（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
If you run it manually (no service), use:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```powershell（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw gateway run（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Docs: [Windows (WSL2)](/platforms/windows), [Gateway service runbook](/gateway).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### The Gateway is up but replies never arrive What should I check（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Start with a quick health sweep:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw status（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw models status（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw channels status（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw logs --follow（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Common causes:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Model auth not loaded on the **gateway host** (check `models status`).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Channel pairing/allowlist blocking replies (check channel config + logs).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- WebChat/Dashboard is open without the right token.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
If you are remote, confirm the tunnel/Tailscale connection is up and that the（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Gateway WebSocket is reachable.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Docs: [Channels](/channels), [Troubleshooting](/gateway/troubleshooting), [Remote access](/gateway/remote).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Disconnected from gateway no reason what now（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
This usually means the UI lost the WebSocket connection. Check:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
1. Is the Gateway running? `openclaw gateway status`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
2. Is the Gateway healthy? `openclaw status`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
3. Does the UI have the right token? `openclaw dashboard`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
4. If remote, is the tunnel/Tailscale link up?（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Then tail logs:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw logs --follow（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Docs: [Dashboard](/web/dashboard), [Remote access](/gateway/remote), [Troubleshooting](/gateway/troubleshooting).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Telegram setMyCommands fails with network errors What should I check（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Start with logs and channel status:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw channels status（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw channels logs --channel telegram（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
If you are on a VPS or behind a proxy, confirm outbound HTTPS is allowed and DNS works.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
If the Gateway is remote, make sure you are looking at logs on the Gateway host.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Docs: [Telegram](/channels/telegram), [Channel troubleshooting](/channels/troubleshooting).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### TUI shows no output What should I check（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
First confirm the Gateway is reachable and the agent can run:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw status（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw models status（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw logs --follow（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
In the TUI, use `/status` to see the current state. If you expect replies in a chat（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
channel, make sure delivery is enabled (`/deliver on`).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Docs: [TUI](/web/tui), [Slash commands](/tools/slash-commands).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### How do I completely stop then start the Gateway（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
If you installed the service:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw gateway stop（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw gateway start（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
This stops/starts the **supervised service** (launchd on macOS, systemd on Linux).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Use this when the Gateway runs in the background as a daemon.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
If you're running in the foreground, stop with Ctrl-C, then:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw gateway run（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Docs: [Gateway service runbook](/gateway).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### ELI5 openclaw gateway restart vs openclaw gateway（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `openclaw gateway restart`: restarts the **background service** (launchd/systemd).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `openclaw gateway`: runs the gateway **in the foreground** for this terminal session.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
If you installed the service, use the gateway commands. Use `openclaw gateway` when（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
you want a one-off, foreground run.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### What's the fastest way to get more details when something fails（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Start the Gateway with `--verbose` to get more console detail. Then inspect the log file for channel auth, model routing, and RPC errors.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Media and attachments（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### My skill generated an imagePDF but nothing was sent（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Outbound attachments from the agent must include a `MEDIA:<path-or-url>` line (on its own line). See [OpenClaw assistant setup](/start/openclaw) and [Agent send](/tools/agent-send).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
CLI sending:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw message send --target +15555550123 --message "Here you go" --media /path/to/file.png（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Also check:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- The target channel supports outbound media and isn't blocked by allowlists.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- The file is within the provider's size limits (images are resized to max 2048px).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
See [Images](/nodes/images).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Security and access control（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Is it safe to expose OpenClaw to inbound DMs（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Treat inbound DMs as untrusted input. Defaults are designed to reduce risk:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Default behavior on DM-capable channels is **pairing**:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Unknown senders receive a pairing code; the bot does not process their message.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Approve with: `openclaw pairing approve <channel> <code>`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Pending requests are capped at **3 per channel**; check `openclaw pairing list <channel>` if a code didn't arrive.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Opening DMs publicly requires explicit opt-in (`dmPolicy: "open"` and allowlist `"*"`).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Run `openclaw doctor` to surface risky DM policies.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Is prompt injection only a concern for public bots（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
No. Prompt injection is about **untrusted content**, not just who can DM the bot.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
If your assistant reads external content (web search/fetch, browser pages, emails,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
docs, attachments, pasted logs), that content can include instructions that try（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
to hijack the model. This can happen even if **you are the only sender**.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
The biggest risk is when tools are enabled: the model can be tricked into（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
exfiltrating context or calling tools on your behalf. Reduce the blast radius by:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- using a read-only or tool-disabled "reader" agent to summarize untrusted content（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- keeping `web_search` / `web_fetch` / `browser` off for tool-enabled agents（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- sandboxing and strict tool allowlists（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Details: [Security](/gateway/security).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Should my bot have its own email GitHub account or phone number（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Yes, for most setups. Isolating the bot with separate accounts and phone numbers（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
reduces the blast radius if something goes wrong. This also makes it easier to rotate（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
credentials or revoke access without impacting your personal accounts.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Start small. Give access only to the tools and accounts you actually need, and expand（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
later if required.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Docs: [Security](/gateway/security), [Pairing](/channels/pairing).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Can I give it autonomy over my text messages and is that safe（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
We do **not** recommend full autonomy over your personal messages. The safest pattern is:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Keep DMs in **pairing mode** or a tight allowlist.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Use a **separate number or account** if you want it to message on your behalf.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Let it draft, then **approve before sending**.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
If you want to experiment, do it on a dedicated account and keep it isolated. See（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
[Security](/gateway/security).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Can I use cheaper models for personal assistant tasks（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Yes, **if** the agent is chat-only and the input is trusted. Smaller tiers are（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
more susceptible to instruction hijacking, so avoid them for tool-enabled agents（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
or when reading untrusted content. If you must use a smaller model, lock down（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
tools and run inside a sandbox. See [Security](/gateway/security).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### I ran start in Telegram but didnt get a pairing code（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Pairing codes are sent **only** when an unknown sender messages the bot and（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
`dmPolicy: "pairing"` is enabled. `/start` by itself doesn't generate a code.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Check pending requests:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw pairing list telegram（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
If you want immediate access, allowlist your sender id or set `dmPolicy: "open"`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
for that account.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### WhatsApp will it message my contacts How does pairing work（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
No. Default WhatsApp DM policy is **pairing**. Unknown senders only get a pairing code and their message is **not processed**. OpenClaw only replies to chats it receives or to explicit sends you trigger.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Approve pairing with:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw pairing approve whatsapp <code>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
List pending requests:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw pairing list whatsapp（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Wizard phone number prompt: it's used to set your **allowlist/owner** so your own DMs are permitted. It's not used for auto-sending. If you run on your personal WhatsApp number, use that number and enable `channels.whatsapp.selfChatMode`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Chat commands, aborting tasks, and "it won't stop"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### How do I stop internal system messages from showing in chat（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Most internal or tool messages only appear when **verbose** or **reasoning** is enabled（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
for that session.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Fix in the chat where you see it:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
/verbose off（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
/reasoning off（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
If it is still noisy, check the session settings in the Control UI and set verbose（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
to **inherit**. Also confirm you are not using a bot profile with `verboseDefault` set（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
to `on` in config.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Docs: [Thinking and verbose](/tools/thinking), [Security](/gateway/security#reasoning--verbose-output-in-groups).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### How do I stopcancel a running task（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Send any of these **as a standalone message** (no slash):（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
stop（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
abort（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
esc（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
wait（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
exit（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
interrupt（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
These are abort triggers (not slash commands).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
For background processes (from the exec tool), you can ask the agent to run:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
process action:kill sessionId:XXX（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Slash commands overview: see [Slash commands](/tools/slash-commands).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Most commands must be sent as a **standalone** message that starts with `/`, but a few shortcuts (like `/status`) also work inline for allowlisted senders.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### How do I send a Discord message from Telegram Crosscontext messaging denied（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
OpenClaw blocks **cross-provider** messaging by default. If a tool call is bound（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
to Telegram, it won't send to Discord unless you explicitly allow it.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Enable cross-provider messaging for the agent:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json5（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  agents: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    defaults: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      tools: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        message: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          crossContext: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
            allowAcrossProviders: true,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
            marker: { enabled: true, prefix: "[from {channel}] " },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Restart the gateway after editing config. If you only want this for a single（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
agent, set it under `agents.list[].tools.message` instead.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Why does it feel like the bot ignores rapidfire messages（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Queue mode controls how new messages interact with an in-flight run. Use `/queue` to change modes:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `steer` - new messages redirect the current task（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `followup` - run messages one at a time（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `collect` - batch messages and reply once (default)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `steer-backlog` - steer now, then process backlog（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `interrupt` - abort current run and start fresh（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
You can add options like `debounce:2s cap:25 drop:summarize` for followup modes.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Answer the exact question from the screenshot/chat log（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**Q: "What's the default model for Anthropic with an API key?"**（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**A:** In OpenClaw, credentials and model selection are separate. Setting `ANTHROPIC_API_KEY` (or storing an Anthropic API key in auth profiles) enables authentication, but the actual default model is whatever you configure in `agents.defaults.model.primary` (for example, `anthropic/claude-sonnet-4-5` or `anthropic/claude-opus-4-6`). If you see `No credentials found for profile "anthropic:default"`, it means the Gateway couldn't find Anthropic credentials in the expected `auth-profiles.json` for the agent that's running.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Still stuck? Ask in [Discord](https://discord.com/invite/clawd) or open a [GitHub discussion](https://github.com/openclaw/openclaw/discussions).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
