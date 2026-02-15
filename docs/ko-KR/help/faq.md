---
summary: "Frequently asked questions about OpenClaw setup, configuration, and usage"
title: "FAQ"
x-i18n:
  source_hash: 374526c433a945d1f88bf83b758dae7bc9702538f9619d813ad0ebe152c19c50
---

# FAQ

실제 설정(로컬 개발, VPS, 다중 에이전트, OAuth/API 키, 모델 장애 조치)에 대한 빠른 답변과 심층적인 문제 해결. 런타임 진단은 [문제 해결](/gateway/troubleshooting)을 참조하세요. 전체 구성 참조는 [구성](/gateway/configuration)을 참조하세요.

## 목차

- [Quick start and first-run setup]
  - [Im stuck whats the fastest way to get unstuck?](#im-stuck-whats-the-fastest-way-to-get-unstuck)
  - [What's the recommended way to install and set up OpenClaw?](#whats-the-recommended-way-to-install-and-set-up-openclaw)
  - [How do I open the dashboard after onboarding?](#how-do-i-open-the-dashboard-after-onboarding)
  - [How do I authenticate the dashboard (token) on localhost vs remote?](#how-do-i-authenticate-the-dashboard-token-on-localhost-vs-remote)
  - [What runtime do I need?](#what-runtime-do-i-need)
  - [Does it run on Raspberry Pi?](#does-it-run-on-raspberry-pi)
  - [Any tips for Raspberry Pi installs?](#any-tips-for-raspberry-pi-installs)
  - [It is stuck on "wake up my friend" / onboarding will not hatch. What now?](#it-is-stuck-on-wake-up-my-friend-onboarding-will-not-hatch-what-now)
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
  - [The Control UI says "unauthorized" (or keeps reconnecting). What now?](#the-control-ui-says-unauthorized-or-keeps-reconnecting-what-now)
  - [I set `gateway.bind: "tailnet"` but it can't bind / nothing listens](#i-set-gatewaybind-tailnet-but-it-cant-bind-nothing-listens)
  - [Can I run multiple Gateways on the same host?](#can-i-run-multiple-gateways-on-the-same-host)
  - [What does "invalid handshake" / code 1008 mean?](#what-does-invalid-handshake-code-1008-mean)
- [Logging and debugging](#logging-and-debugging)
  - [Where are logs?](#where-are-logs)
  - [How do I start/stop/restart the Gateway service?](#how-do-i-startstoprestart-the-gateway-service)
  - [I closed my terminal on Windows - how do I restart OpenClaw?](#i-closed-my-terminal-on-windows-how-do-i-restart-openclaw)
  - [The Gateway is up but replies never arrive. What should I check?](#the-gateway-is-up-but-replies-never-arrive-what-should-i-check)
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

## 뭔가 고장난 경우 처음 60초

1. **빠른 상태(첫 번째 확인)**

   ```bash
   openclaw status
   ```

   빠른 로컬 요약: OS + 업데이트, 게이트웨이/서비스 연결 가능성, 에이전트/세션, 공급자 구성 + 런타임 문제(게이트웨이에 연결 가능한 경우)

2. **붙여넣을 수 있는 보고서(공유해도 안전함)**

   ```bash
   openclaw status --all
   ```

   로그 테일을 사용한 읽기 전용 진단(토큰 수정됨)

3. **데몬 + 포트 상태**

   ```bash
   openclaw gateway status
   ```

   감독자 런타임과 RPC 연결 가능성, 프로브 대상 URL 및 사용 가능성이 있는 서비스 구성을 보여줍니다.

4. **심층 프로브**

   ```bash
   openclaw status --deep
   ```

   게이트웨이 상태 확인 + 공급자 프로브를 실행합니다(연결 가능한 게이트웨이 필요). [건강](/gateway/health)을 참조하세요.

5. **최신 로그 추적**

   ```bash
   openclaw logs --follow
   ```

   RPC가 다운된 경우 다음으로 대체합니다.

   ```bash
   tail -f "$(ls -t /tmp/openclaw/openclaw-*.log | head -1)"
   ```

   파일 로그는 서비스 로그와 별개입니다. [로깅](/logging) 및 [문제 해결](/gateway/troubleshooting)을 참조하세요.

6. **닥터 실행(수리)**

   ```bash
   openclaw doctor
   ```

   구성/상태를 복구/마이그레이션하고 상태 확인을 실행합니다. [의사](/gateway/doctor)를 참조하세요.

7. **게이트웨이 스냅샷**

   ```bash
   openclaw health --json
   openclaw health --verbose   # shows the target URL + config path on errors
   ```

   실행 중인 게이트웨이에 전체 스냅샷을 요청합니다(WS 전용). [건강](/gateway/health)을 참조하세요.

## 빠른 시작 및 첫 실행 설정

### 막혔어요 가장 빨리 풀 수 있는 방법이 무엇인가요?

**컴퓨터를 볼 수 있는** 로컬 AI 에이전트를 사용하세요. 물어보는 것보다 그게 훨씬 더 효과적이에요
Discord에서는 대부분의 "막혔습니다" 사례가 **로컬 구성 또는 환경 문제**이기 때문에
원격 도우미는 검사할 수 없습니다.

- **클로드 코드**: [https://www.anthropic.com/claude-code/](https://www.anthropic.com/claude-code/)
- **OpenAI 코덱스**: [https://openai.com/codex/](https://openai.com/codex/)

이러한 도구는 저장소를 읽고, 명령을 실행하고, 로그를 검사하고, 머신 수준 문제를 해결하는 데 도움을 줄 수 있습니다.
설정(PATH, 서비스, 권한, 인증 파일). 다음을 통해 **전체 소스 체크아웃**을 제공하세요.
해킹 가능한(git) 설치:

```bash
curl -fsSL https://openclaw.ai/install.sh | bash -s -- --install-method git
```

이렇게 하면 **git 체크아웃**에서 OpenClaw가 설치되므로 에이전트는 코드 + 문서를 읽을 수 있으며
실행중인 정확한 버전에 대한 이유. 나중에 언제든지 다시 안정 버전으로 전환할 수 있습니다.
`--install-method git` 없이 설치 프로그램을 다시 실행합니다.

팁: 상담원에게 수정 사항을 **계획하고 감독**하도록 (단계별) 요청한 후 해당 수정 사항만 실행하세요.
필요한 명령. 그러면 변경 사항이 작게 유지되고 감사하기가 더 쉬워집니다.

실제 버그나 수정 사항을 발견한 경우 GitHub 문제를 제출하거나 PR을 보내주세요.
[https://github.com/openclaw/openclaw/issues](https://github.com/openclaw/openclaw/issues)
[https://github.com/openclaw/openclaw/pulls](https://github.com/openclaw/openclaw/pulls)

다음 명령으로 시작하십시오(도움을 요청할 때 출력을 공유하십시오).

```bash
openclaw status
openclaw models status
openclaw doctor
```

그들이 하는 일:

- `openclaw status`: 게이트웨이/에이전트 상태 + 기본 구성의 빠른 스냅샷.
- `openclaw models status`: 공급자 인증 + 모델 가용성을 확인합니다.
- `openclaw doctor`: 일반적인 구성/상태 문제를 확인하고 복구합니다.

기타 유용한 CLI 검사: `openclaw status --all`, `openclaw logs --follow`,
`openclaw gateway status`, `openclaw health --verbose`.

빠른 디버그 루프: [뭔가 손상된 경우 처음 60초](#first-60-seconds-if-somethings-broken).
설치 문서: [설치](/install), [설치 프로그램 플래그](/install/installer), [업데이트](/install/updating).

### OpenClaw를 설치하고 설정하는 데 권장되는 방법은 무엇입니까?

저장소에서는 소스에서 실행하고 온보딩 마법사를 사용할 것을 권장합니다.

```bash
curl -fsSL https://openclaw.ai/install.sh | bash
openclaw onboard --install-daemon
```

마법사는 UI 자산을 자동으로 구축할 수도 있습니다. 온보딩 후에는 일반적으로 포트 **18789**에서 게이트웨이를 실행합니다.

출처(기여자/개발자):

```bash
git clone https://github.com/openclaw/openclaw.git
cd openclaw
pnpm install
pnpm build
pnpm ui:build # auto-installs UI deps on first run
openclaw onboard
```

아직 전역 설치가 없다면 `pnpm openclaw onboard`를 통해 실행하세요.

### 온보딩 후 대시보드를 열려면 어떻게 해야 하나요?

마법사는 온보딩 직후 깨끗한(토큰화되지 않은) 대시보드 URL로 브라우저를 열고 요약에 링크를 인쇄합니다. 해당 탭을 열어두세요. 실행되지 않은 경우 인쇄된 URL을 동일한 컴퓨터에 복사하여 붙여넣으세요.

### 로컬 호스트와 원격 호스트에서 대시보드 토큰을 어떻게 인증하나요?

**로컬호스트(동일 머신):**

- `http://127.0.0.1:18789/`를 엽니다.
- 인증을 요청하는 경우 `gateway.auth.token`(또는 `OPENCLAW_GATEWAY_TOKEN`)의 토큰을 Control UI 설정에 붙여넣습니다.
- 게이트웨이 호스트에서 검색: `openclaw config get gateway.auth.token` (또는 생성: `openclaw doctor --generate-gateway-token`).

**로컬호스트에는 없음:**

- **Tailscale Serve** (권장): 바인드 루프백 유지, `openclaw gateway --tailscale serve` 실행, `https://<magicdns>/` 열기. `gateway.auth.allowTailscale`가 `true`인 경우 ID 헤더는 인증(토큰 없음)을 충족합니다.
- **Tailnet 바인딩**: `openclaw gateway --bind tailnet --token "<token>"` 실행, `http://<tailscale-ip>:18789/` 열기, 대시보드 설정에 토큰 붙여넣기.
- **SSH 터널**: `ssh -N -L 18789:127.0.0.1:18789 user@host` 그런 다음 `http://127.0.0.1:18789/`를 열고 컨트롤 UI 설정에 토큰을 붙여넣습니다.

바인딩 모드 및 인증 세부정보는 [대시보드](/web/dashboard) 및 [웹 표면](/web)을 참조하세요.

### 나에게 필요한 런타임은 무엇입니까?

노드 **>= 22**가 필요합니다. `pnpm`을 권장합니다. Bun은 게이트웨이에 **권장되지 않습니다**.

### 라즈베리 파이에서 실행되나요?

그렇습니다. 게이트웨이는 가볍습니다. 문서 목록 **512MB-1GB RAM**, **1 코어** 및 약 **500MB**
디스크는 개인 용도로 충분하며 **Raspberry Pi 4에서 실행할 수 있습니다**.

추가 여유 공간(로그, 미디어, 기타 서비스)을 원하는 경우 **2GB가 권장되지만**
엄격한 최소값은 아닙니다.

팁: 소형 Pi/VPS는 게이트웨이를 호스팅할 수 있으며 노트북/휴대폰에서 **노드**를 페어링하여
로컬 화면/카메라/캔버스 또는 명령 실행. [노드](/nodes)를 참조하세요.

### Raspberry Pi 설치에 대한 팁

짧은 버전: 작동하지만 가장자리가 거칠어질 수 있습니다.

- **64비트** OS를 사용하고 Node >= 22를 유지합니다.
- 로그를 확인하고 빠르게 업데이트할 수 있도록 **hackable(git) 설치**를 선호하세요.
- 채널/스킬 없이 시작한 후 하나씩 추가하세요.
- 이상한 바이너리 문제가 발생하면 일반적으로 **ARM 호환성** 문제입니다.

문서: [Linux](/platforms/linux), [설치](/install).

### 잠에서 멈췄습니다. 친구 온보딩이 부화되지 않습니다. 이제 무엇을 해야 할까요?

해당 화면은 연결 가능하고 인증되는 게이트웨이에 따라 다릅니다. TUI도 다음을 보냅니다.
"일어나 친구야!" 첫 번째 해치에서 자동으로. **응답 없음**이라는 문구가 표시되는 경우
토큰은 0으로 유지되며 에이전트는 실행되지 않습니다.

1. 게이트웨이를 다시 시작합니다.

```bash
openclaw gateway restart
```

2. 상태 + 인증 확인:

```bash
openclaw status
openclaw models status
openclaw logs --follow
```

3. 여전히 멈춘다면 다음을 실행하세요:

```bash
openclaw doctor
```

게이트웨이가 원격인 경우 터널/Tailscale 연결이 작동 중이고 UI가 작동하는지 확인하세요.
올바른 게이트웨이를 가리킵니다. [원격 접속](/gateway/remote)을 참조하세요.

### 온보딩을 다시 실행하지 않고 내 설정을 새 컴퓨터 Mac mini로 마이그레이션할 수 있나요?

예. **상태 디렉터리**와 **작업 공간**을 복사한 후 Doctor를 한 번 실행하세요. 이
봇을 "정확히 동일"하게 유지합니다(메모리, 세션 기록, 인증 및 채널).
주) **두 위치** 모두 복사하는 한:

1. 새 컴퓨터에 OpenClaw를 설치합니다.
2. 이전 머신에서 `$OPENCLAW_STATE_DIR`(기본값: `~/.openclaw`)를 복사합니다.
3. 작업공간을 복사합니다(기본값: `~/.openclaw/workspace`).
4. `openclaw doctor`를 실행하고 게이트웨이 서비스를 다시 시작합니다.

이는 구성, 인증 프로필, WhatsApp 자격 증명, 세션 및 메모리를 보존합니다. 당신이 안에 있다면
원격 모드에서는 게이트웨이 호스트가 세션 저장소와 작업 영역을 소유한다는 점을 기억하세요.

**중요:** 작업공간을 GitHub에 커밋/푸시만 하면 지원하게 됩니다.
**메모리 + 부트스트랩 파일**을 실행하지만 세션 기록이나 인증은 **아님**. 그 라이브
`~/.openclaw/` 아래(예: `~/.openclaw/agents/<agentId>/sessions/`).

관련: [마이그레이션](/install/migrating), [디스크에 있는 항목](/help/faq#where-does-openclaw-store-its-data),
[에이전트 작업공간](/concepts/agent-workspace), [의사](/gateway/doctor),
[원격 모드](/gateway/remote).

### 최신 버전의 새로운 기능은 어디서 확인할 수 있나요?

GitHub 변경 로그를 확인하세요.
[https://github.com/openclaw/openclaw/blob/main/CHANGELOG.md](https://github.com/openclaw/openclaw/blob/main/CHANGELOG.md)

최신 항목이 맨 위에 표시됩니다. 상단 섹션이 **Unreleased**로 표시되어 있으면 다음 날짜의
섹션은 최신 출시 버전입니다. 항목은 **하이라이트**, **변경사항** 및
**수정**(필요한 경우 문서/기타 섹션 추가).

### docs.openclaw.ai에 액세스할 수 없습니다. SSL 오류가 발생했습니다.

일부 Comcast/Xfinity 연결은 Xfinity를 통해 `docs.openclaw.ai`를 잘못 차단합니다.
고급 보안. 비활성화하거나 허용 목록 `docs.openclaw.ai`을 선택한 후 다시 시도하세요. 더보기
세부정보: [문제 해결](/help/troubleshooting#docsopenclawai-shows-an-ssl-error-comcastxfinity).
여기에 신고하여 차단을 해제할 수 있도록 도와주세요: [https://spa.xfinity.com/check_url_status](https://spa.xfinity.com/check_url_status).

여전히 사이트에 접속할 수 없는 경우 문서는 GitHub에 미러링됩니다.
[https://github.com/openclaw/openclaw/tree/main/docs](https://github.com/openclaw/openclaw/tree/main/docs)

### 안정 버전과 베타 버전의 차이점은 무엇인가요?

**안정적** 및 **베타**는 별도의 코드 줄이 아닌 **npm dist-tags**입니다.

- `latest` = 안정적
- `beta` = 테스트를 위한 초기 빌드

빌드를 **베타**로 출시하고 테스트한 후 빌드가 견고해지면 **승격합니다.
`latest`**와 동일한 버전입니다. 이것이 베타와 안정이 다음을 가리킬 수 있는 이유입니다.
**같은 버전**.

변경된 내용을 확인하세요.
[https://github.com/openclaw/openclaw/blob/main/CHANGELOG.md](https://github.com/openclaw/openclaw/blob/main/CHANGELOG.md)

### 베타 버전을 설치하는 방법과 베타 버전과 개발자 버전의 차이점은 무엇인가요?

**베타**는 npm dist-tag `beta`입니다(`latest`와 일치할 수 있음).
**Dev**는 `main`(git)의 움직이는 헤드입니다. 게시되면 npm dist-tag `dev`를 사용합니다.

한 줄짜리(macOS/Linux):

```bash
curl -fsSL --proto '=https' --tlsv1.2 https://openclaw.ai/install.sh | bash -s -- --beta
```

```bash
curl -fsSL --proto '=https' --tlsv1.2 https://openclaw.ai/install.sh | bash -s -- --install-method git
```

Windows 설치 프로그램(PowerShell):
[https://openclaw.ai/install.ps1](https://openclaw.ai/install.ps1)

자세한 내용: [개발 채널](/install/development-channels) 및 [설치 프로그램 플래그](/install/installer).

### 일반적으로 설치 및 온보딩에 소요되는 시간

대략적인 가이드:

- **설치:** 2~5분
- **온보딩:** 구성한 채널/모델 수에 따라 5~15분 소요

멈춘 경우에는 [설치 프로그램이 멈췄습니다](/help/faq#installer-stuck-how-do-i-get-more-feedback)를 사용하세요.
그리고 [Im Stuck](/help/faq#im-stuck--whats-the-fastest-way-to-get-unstuck)의 빠른 디버그 루프.

### 최신 기능을 사용해 보려면 어떻게 해야 하나요?

두 가지 옵션:

1. **개발자 채널(git 체크아웃):**

```bash
openclaw update --channel dev
```

`main` 분기로 전환하고 소스에서 업데이트합니다.

2. **해킹 가능한 설치(설치 프로그램 사이트에서):**

```bash
curl -fsSL https://openclaw.ai/install.sh | bash -s -- --install-method git
```

그러면 편집한 다음 git을 통해 업데이트할 수 있는 로컬 저장소가 제공됩니다.

수동으로 클린 클론을 선호하는 경우 다음을 사용하세요.

```bash
git clone https://github.com/openclaw/openclaw.git
cd openclaw
pnpm install
pnpm build
```

문서: [업데이트](/cli/update), [개발 채널](/install/development-channels),
[설치](/install).

### 설치 프로그램이 멈췄습니다. 피드백을 더 받으려면 어떻게 해야 하나요?

**자세한 출력**을 사용하여 설치 프로그램을 다시 실행하세요.

```bash
curl -fsSL https://openclaw.ai/install.sh | bash -s -- --verbose
```

자세한 내용을 포함한 베타 설치:

```bash
curl -fsSL https://openclaw.ai/install.sh | bash -s -- --beta --verbose
```

해킹 가능한(git) 설치의 경우:

```bash
curl -fsSL https://openclaw.ai/install.sh | bash -s -- --install-method git --verbose
```

Windows(PowerShell)에 해당:

```powershell
# install.ps1 has no dedicated -Verbose flag yet.
Set-PSDebug -Trace 1
& ([scriptblock]::Create((iwr -useb https://openclaw.ai/install.ps1))) -NoOnboard
Set-PSDebug -Trace 0
```

추가 옵션: [설치 프로그램 플래그](/install/installer).

### Windows 설치 시 git을 찾을 수 없거나 openclaw를 인식할 수 없다고 표시됩니다.

두 가지 일반적인 Windows 문제:

**1) npm 오류가 git 생성/git을 찾을 수 없음**

- **Windows용 Git**을 설치하고 `git`가 PATH에 있는지 확인하세요.
- PowerShell을 닫았다가 다시 연 후 설치 프로그램을 다시 실행하세요.

**2) 설치 후 openclaw가 인식되지 않습니다**

- npm 전역 bin 폴더가 PATH에 없습니다.
- 경로를 확인하세요.

  ```powershell
  npm config get prefix
  ```

- `<prefix>\\bin`가 PATH에 있는지 확인하세요(대부분의 시스템에서는 `%AppData%\\npm`임).
- PATH를 업데이트한 후 PowerShell을 닫았다가 다시 엽니다.

가장 원활한 Windows 설정을 원한다면 기본 Windows 대신 **WSL2**를 사용하세요.
문서: [Windows](/platforms/windows).

### 문서에서 내 질문에 대한 답변을 찾을 수 없습니다. 어떻게 하면 더 나은 답변을 얻을 수 있나요?

**hackable(git) 설치**를 사용하여 전체 소스와 문서를 로컬에 확보한 다음 요청하세요.
귀하의 봇(또는 Claude/Codex)이 해당 폴더에서 저장소를 읽고 정확하게 답변할 수 있도록 합니다.

```bash
curl -fsSL https://openclaw.ai/install.sh | bash -s -- --install-method git
```

자세한 내용: [설치](/install) 및 [설치 프로그램 플래그](/install/installer).

### Linux에 OpenClaw를 어떻게 설치하나요?

짧은 대답: Linux 가이드를 따른 다음 온보딩 마법사를 실행하세요.

- Linux 빠른 경로 + 서비스 설치: [Linux](/platforms/linux).
- 전체 연습: [시작하기](/start/getting-started).
- 설치 프로그램 + 업데이트: [설치 및 업데이트](/install/updating).

### VPS에 OpenClaw를 어떻게 설치하나요?

모든 Linux VPS가 작동합니다. 서버에 설치한 다음 SSH/Tailscale을 사용하여 게이트웨이에 연결합니다.

가이드: [exe.dev](/install/exe-dev), [Hetzner](/install/hetzner), [Fly.io](/install/fly).
원격 접속: [게이트웨이 원격](/gateway/remote).

### cloudVPS 설치 가이드는 어디에 있나요?

우리는 일반 공급자와 **호스팅 허브**를 유지합니다. 하나를 선택하고 가이드를 따르십시오.

- [VPS 호스팅](/vps) (모든 제공업체가 한곳에 있음)
- [Fly.io](/install/fly)
- [헤츠너](/install/hetzner)
- [exe.dev](/install/exe-dev)

클라우드에서의 작동 방식: **게이트웨이는 서버에서 실행**되며 사용자는 이에 액세스합니다.
Control UI(또는 Tailscale/SSH)를 통해 노트북/휴대폰에서. 귀하의 상태 + 작업 공간
서버에 있으므로 호스트를 진실의 소스로 간주하고 백업하세요.

**노드**(Mac/iOS/Android/헤드리스)를 해당 클라우드 게이트웨이에 페어링하여 액세스할 수 있습니다.
로컬 화면/카메라/캔버스를 유지하거나 노트북에서 명령을 실행하세요.
클라우드의 게이트웨이.

허브: [플랫폼](/platforms). 원격 접속: [게이트웨이 원격](/gateway/remote).
노드: [노드](/nodes), [노드 CLI](/cli/nodes).

### OpenClaw에 자동 업데이트를 요청할 수 있나요?

짧은 대답: **가능하지만 권장되지 않음**. 업데이트 흐름은
게이트웨이(활성 세션을 삭제함)에는 깨끗한 Git 체크아웃이 필요할 수 있습니다.
확인 메시지를 표시할 수 있습니다. 더 안전함: 운영자로서 셸에서 업데이트를 실행합니다.

CLI를 사용하십시오.

```bash
openclaw update
openclaw update status
openclaw update --channel stable|beta|dev
openclaw update --tag <dist-tag|version>
openclaw update --no-restart
```

에이전트에서 자동화해야 하는 경우:

```bash
openclaw update --yes --no-restart
openclaw gateway restart
```

문서: [업데이트](/cli/update), [업데이트](/install/updating).

### 온보딩 마법사가 실제로 수행하는 작업

`openclaw onboard`는 권장 설정 경로입니다. **로컬 모드**에서는 다음을 안내합니다.

- **모델/인증 설정**(Claude 구독에 Anthropic **설정 토큰** 권장, OpenAI Codex OAuth 지원, API 키 선택, LM Studio 로컬 모델 지원)
- **작업공간** 위치 + 부트스트랩 파일
- **게이트웨이 설정**(바인드/포트/인증/tailscale)
- **공급자**(WhatsApp, Telegram, Discord, Mattermost(플러그인), Signal, iMessage)
- **데몬 설치**(macOS에서는 LaunchAgent, Linux/WSL2에서는 systemd 사용자 유닛)
- **건강체크** 및 **스킬** 선택

또한 구성된 모델이 알 수 없거나 인증이 누락된 경우에도 경고합니다.

### 이것을 실행하려면 Claude 또는 OpenAI 구독이 필요합니까?

아니요. **API 키**(Anthropic/OpenAI/기타) 또는 다음을 사용하여 OpenClaw를 실행할 수 있습니다.
**로컬 전용 모델**이므로 데이터가 기기에 그대로 유지됩니다. 구독(클로드
Pro/Max 또는 OpenAI Codex)는 해당 공급자를 인증하는 선택적 방법입니다.

문서: [인류](/providers/anthropic), [OpenAI](/providers/openai),
[로컬 모델](/gateway/local-models), [모델](/concepts/models).

### API 키 없이 Claude Max 구독을 사용할 수 있나요?

그렇습니다. **설정 토큰**으로 인증할 수 있습니다.
API 키 대신. 구독 경로입니다.

Claude Pro/Max 구독에는 **API 키가 포함되어 있지 않습니다**.
구독 계정에 대한 올바른 접근 방식. 중요: 다음을 통해 확인해야 합니다.
이러한 사용은 구독 정책 및 약관에 따라 허용됩니다.
가장 명확하고 지원되는 경로를 원한다면 Anthropic API 키를 사용하세요.

### Anthropic setuptoken 인증은 어떻게 작동하나요?

`claude setup-token`는 Claude Code CLI를 통해 **토큰 문자열**을 생성합니다(웹 콘솔에서는 사용할 수 없음). **모든 머신**에서 실행할 수 있습니다. 마법사에서 **Anthropic token (paste setup-token)**을 선택하거나 `openclaw models auth paste-token --provider anthropic`를 붙여넣습니다. 토큰은 **anthropic** 공급자에 대한 인증 프로필로 저장되며 API 키처럼 사용됩니다(자동 새로 고침 없음). 자세한 내용: [OAuth](/concepts/oauth).

### Anthropic 설정 토큰은 어디서 찾을 수 있나요?

Anthropic Console에는 **아닙니다**. 설정 토큰은 **모든 머신**에서 **Claude Code CLI**에 의해 생성됩니다.

```bash
claude setup-token
```

인쇄된 토큰을 복사한 다음 마법사에서 **Anthropic token(설정 토큰 붙여넣기)**을 선택하세요. 게이트웨이 호스트에서 실행하려면 `openclaw models auth setup-token --provider anthropic`를 사용하세요. `claude setup-token`를 다른 곳에서 실행한 경우 `openclaw models auth paste-token --provider anthropic`를 사용하여 게이트웨이 호스트에 붙여넣습니다. [인류](/providers/anthropic)를 참조하세요.

### Claude 구독 인증을 지원합니까(Claude Pro 또는 Max)

예 - **설정 토큰**을 통해 가능합니다. OpenClaw는 더 이상 Claude Code CLI OAuth 토큰을 재사용하지 않습니다. 설정 토큰 또는 Anthropic API 키를 사용하세요. 어디서나 토큰을 생성하고 게이트웨이 호스트에 붙여넣습니다. [인류](/providers/anthropic) 및 [OAuth](/concepts/oauth)를 참조하세요.

참고: Claude 구독 액세스에는 Anthropic의 약관이 적용됩니다. 프로덕션 또는 다중 사용자 워크로드의 경우 일반적으로 API 키가 더 안전한 선택입니다.

### Anthropic에서 HTTP 429 ratelimiterror가 표시되는 이유는 무엇입니까?

이는 현재 창에 대한 **인류 할당량/비율 제한**이 소진되었음을 의미합니다. 당신이
**Claude 구독**(설정 토큰 또는 Claude Code OAuth)을 사용하고 창이
계획을 재설정하거나 업그레이드하세요. **Anthropic API 키**를 사용하는 경우 Anthropic 콘솔을 확인하세요.
사용량/청구를 위해 필요에 따라 한도를 높입니다.

팁: 제공자가 속도가 제한되어 있는 동안 OpenClaw가 계속 응답할 수 있도록 **대체 모델**을 설정하세요.
[모델](/cli/models) 및 [OAuth](/concepts/oauth)를 참조하세요.

### AWS Bedrock이 지원됩니까?

예 - pi-ai의 **Amazon Bedrock(Converse)** 공급자를 통해 **수동 구성**을 사용합니다. 게이트웨이 호스트에 AWS 자격 증명/지역을 제공하고 모델 구성에 Bedrock 공급자 항목을 추가해야 합니다. [Amazon 기반암](/providers/bedrock) 및 [모델 공급자](/providers/models)를 참조하세요. 관리형 키 흐름을 선호하는 경우 Bedrock 앞의 OpenAI 호환 프록시는 여전히 유효한 옵션입니다.

### Codex 인증은 어떻게 작동하나요?

OpenClaw는 OAuth(ChatGPT 로그인)를 통해 **OpenAI 코드(Codex)**를 지원합니다. 마법사는 OAuth 흐름을 실행할 수 있으며 적절한 경우 기본 모델을 `openai-codex/gpt-5.3-codex`로 설정합니다. [모델 제공자](/concepts/model-providers) 및 [마법사](/start/wizard)를 참조하세요.

### OpenAI 구독 인증을 지원합니까 Codex OAuth

그렇습니다. OpenClaw는 **OpenAI 코드(Codex) 구독 OAuth**를 완벽하게 지원합니다. 온보딩 마법사
OAuth 흐름을 실행할 수 있습니다.

[OAuth](/concepts/oauth), [모델 제공자](/concepts/model-providers) 및 [마법사](/start/wizard)를 참조하세요.

### Gemini CLI OAuth를 어떻게 설정하나요?

Gemini CLI는 `openclaw.json`의 클라이언트 ID나 비밀이 아닌 **플러그인 인증 흐름**을 사용합니다.

단계:

1. 플러그인 활성화: `openclaw plugins enable google-gemini-cli-auth`
2. 로그인: `openclaw models auth login --provider google-gemini-cli --set-default`

이는 게이트웨이 호스트의 인증 프로필에 OAuth 토큰을 저장합니다. 세부정보: [모델 제공자](/concepts/model-providers).

### 캐주얼한 채팅에는 로컬 모델이 괜찮나요?

보통은 그렇지 않습니다. OpenClaw에는 대규모 컨텍스트와 강력한 안전성이 필요합니다. 작은 카드가 잘리고 누출됩니다. 꼭 필요한 경우 로컬(LM Studio)에서 가능한 **가장 큰** MiniMax M2.1 빌드를 실행하고 [/gateway/local-models](/gateway/local-models)를 확인하세요. 더 작은/양자화된 모델은 프롬프트 주입 위험을 증가시킵니다. [보안](/gateway/security)을 참조하세요.

### 특정 지역에서 호스팅 모델 트래픽을 유지하려면 어떻게 해야 하나요?

지역 고정 엔드포인트를 선택하세요. OpenRouter는 MiniMax, Kimi 및 GLM에 대한 미국 호스팅 옵션을 공개합니다. 데이터를 지역 내로 유지하려면 미국에서 호스팅되는 변형을 선택하세요. `models.mode: "merge"`을 사용하여 Anthropic/OpenAI를 이들과 함께 나열할 수 있으므로 선택한 지역 공급자를 존중하면서 폴백을 계속 사용할 수 있습니다.

### 이것을 설치하려면 Mac Mini를 구입해야 합니까?

아니요. OpenClaw는 macOS 또는 Linux(WSL2를 통한 Windows)에서 실행됩니다. Mac mini는 선택 사항입니다 - 일부 사람들
Always-On 호스트로 하나 구입하면 작은 VPS, 홈 서버 또는 Raspberry Pi급 상자도 작동합니다.

**macOS 전용 도구**에는 Mac만 있으면 됩니다. iMessage의 경우 [BlueBubbles](/channels/bluebubbles)를 사용합니다(권장). BlueBubbles 서버는 모든 Mac에서 실행되며 게이트웨이는 Linux 또는 다른 곳에서 실행될 수 있습니다. 다른 macOS 전용 도구를 원하는 경우 Mac에서 게이트웨이를 실행하거나 macOS 노드를 페어링하세요.

문서: [BlueBubbles](/channels/bluebubbles), [노드](/nodes), [Mac 원격 모드](/platforms/mac/remote).

### iMessage를 지원하려면 Mac mini가 필요합니까?

메시지에 로그인된 **일부 macOS 장치**가 필요합니다. Mac mini일 필요는 **아닙니다** -
모든 Mac이 작동합니다. **iMessage용 [BlueBubbles](/channels/bluebubbles)**(권장) 사용 - BlueBubbles 서버는 macOS에서 실행되는 반면 게이트웨이는 Linux 또는 다른 곳에서 실행될 수 있습니다.

일반적인 설정:

- Linux/VPS에서 게이트웨이를 실행하고 메시지에 로그인된 모든 Mac에서 BlueBubbles 서버를 실행합니다.
- 가장 간단한 단일 시스템 설정을 원한다면 Mac에서 모든 것을 실행하세요.

문서: [BlueBubbles](/channels/bluebubbles), [노드](/nodes),
[맥 원격 모드](/platforms/mac/remote).

### OpenClaw를 실행하기 위해 Mac mini를 구입하는 경우 이를 MacBook Pro에 연결할 수 있나요?

그렇습니다. **Mac mini는 게이트웨이**를 실행할 수 있으며 MacBook Pro는 게이트웨이로 연결할 수 있습니다.
**노드**(동반 장치). 노드는 게이트웨이를 실행하지 않으며 추가 기능을 제공합니다.
해당 장치의 화면/카메라/캔버스 및 `system.run`와 같은 기능.

일반적인 패턴:

- Mac mini의 게이트웨이(항상 켜져 있음).
- MacBook Pro는 macOS 앱 또는 노드 호스트를 실행하고 게이트웨이와 쌍을 이룹니다.
- `openclaw nodes status` / `openclaw nodes list`를 사용하여 확인하세요.

문서: [노드](/nodes), [노드 CLI](/cli/nodes).

### 번을 사용할 수 있나요?

번은 **권장되지 않습니다**. 특히 WhatsApp과 Telegram에서 런타임 버그가 발견됩니다.
안정적인 게이트웨이에는 **노드**를 사용하세요.

Bun을 계속 실험하고 싶다면 비프로덕션 게이트웨이에서 수행하세요.
WhatsApp/텔레그램 없이.

### 텔레그램에 무엇이 들어가는지 AllowFrom

`channels.telegram.allowFrom`는 **발신자의 텔레그램 사용자 ID**(숫자, 권장) 또는 `@username`입니다. 봇 사용자 이름이 아닙니다.

더 안전함(타사 봇 없음):

- 봇에게 DM을 보낸 후 `openclaw logs --follow`를 실행하고 `from.id`를 읽으세요.

공식 봇 API:

- 봇에게 DM을 보낸 후 `https://api.telegram.org/bot<bot_token>/getUpdates`를 호출하고 `message.from.id`를 읽어보세요.

제3자(비공개):

- `@userinfobot` 또는 `@getidsbot`에게 DM주세요.

[/channels/telegram](/channels/telegram#access-control-dms--groups)을 참조하세요.

### 여러 사람이 서로 다른 OpenClaw 인스턴스에서 하나의 WhatsApp 번호를 사용할 수 있나요?

예, **다중 에이전트 라우팅**을 통해 가능합니다. 각 발신자의 WhatsApp **DM**(피어 `kind: "direct"`, `+15551234567`과 같은 발신자 E.164)를 다른 `agentId`에 바인딩하여 각 사람이 자신의 작업 공간과 세션 저장소를 얻습니다. 답장은 여전히 ​​**동일한 WhatsApp 계정**에서 오고 DM 액세스 제어(`channels.whatsapp.dmPolicy` / `channels.whatsapp.allowFrom`)는 WhatsApp 계정별로 전역적으로 적용됩니다. [다중 에이전트 라우팅](/concepts/multi-agent) 및 [WhatsApp](/channels/whatsapp)를 참조하세요.

### 빠른 채팅 에이전트와 코딩 에이전트용 Opus를 실행할 수 있나요?

그렇습니다. 다중 에이전트 라우팅 사용: 각 에이전트에 고유한 기본 모델을 제공한 다음 인바운드 경로(공급자 계정 또는 특정 피어)를 각 에이전트에 바인딩합니다. 예제 구성은 [다중 에이전트 라우팅](/concepts/multi-agent)에 있습니다. [모델](/concepts/models) 및 [구성](/gateway/configuration)도 참조하세요.

### Homebrew가 Linux에서 작동하나요?

그렇습니다. 홈브루는 리눅스(Linuxbrew)를 지원합니다. 빠른 설정:

```bash
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
echo 'eval "$(/home/linuxbrew/.linuxbrew/bin/brew shellenv)"' >> ~/.profile
eval "$(/home/linuxbrew/.linuxbrew/bin/brew shellenv)"
brew install <formula>
```

systemd를 통해 OpenClaw를 실행하는 경우 서비스 PATH에 `/home/linuxbrew/.linuxbrew/bin`(또는 Brew 접두사)가 포함되어 있는지 확인하여 `brew` 설치된 도구가 비로그인 쉘에서 확인되도록 하세요.
최근 빌드에서는 Linux 시스템 서비스(예: `~/.local/bin`, `~/.npm-global/bin`, `~/.local/share/pnpm`, `~/.bun/bin`)에서 일반 사용자 bin 디렉터리를 앞에 추가하고 `PNPM_HOME`, `NPM_CONFIG_PREFIX`, `BUN_INSTALL`, `VOLTA_HOME`, `ASDF_DATA_DIR`, `NVM_DIR`, `FNM_DIR` 설정 시.

### 해킹 가능한 git 설치와 npm 설치의 차이점은 무엇인가요?

- **해킹 가능(git) 설치:** 전체 소스 체크아웃, 편집 가능, 기여자에게 가장 적합합니다.
  로컬에서 빌드를 실행하고 코드/문서를 패치할 수 있습니다.
- **npm 설치:** 전역 CLI 설치, 저장소 없음, "그냥 실행"에 가장 적합합니다.
  업데이트는 npm dist-tags에서 제공됩니다.

문서: [시작하기](/start/getting-started), [업데이트](/install/updating).

### 나중에 npm과 git 설치 간에 전환할 수 있나요?

그렇습니다. 다른 버전을 설치한 다음 게이트웨이 서비스가 새 진입점을 가리키도록 Doctor를 실행하세요.
**데이터는 삭제되지 않습니다**. OpenClaw 코드 설치만 변경됩니다. 귀하의 주
(`~/.openclaw`) 및 작업 공간 (`~/.openclaw/workspace`)은 그대로 유지됩니다.

npm → git에서:

```bash
git clone https://github.com/openclaw/openclaw.git
cd openclaw
pnpm install
pnpm build
openclaw doctor
openclaw gateway restart
```

git → npm에서:

```bash
npm install -g openclaw@latest
openclaw doctor
openclaw gateway restart
```

Doctor는 게이트웨이 서비스 진입점 불일치를 감지하고 현재 설치와 일치하도록 서비스 구성을 다시 작성하도록 제안합니다(자동화에서 `--repair` 사용).

백업 팁: [백업 전략](/help/faq#whats-the-recommended-backup-strategy)을 참조하세요.

### 게이트웨이를 노트북에서 실행해야 할까요, 아니면 VPS에서 실행해야 할까요?

짧은 답변: **연중무휴 24시간 안정성을 원한다면 VPS를 사용하세요**. 당신이 원하는 경우
마찰이 가장 적고 잠자기/다시 시작해도 괜찮습니다. 로컬에서 실행하세요.

**노트북(로컬 게이트웨이)**

- **장점:** 서버 비용 없음, 로컬 파일에 직접 액세스, 라이브 브라우저 창.
- **단점:** 절전/네트워크 중단 = 연결 끊김, OS 업데이트/재부팅 중단, 깨어 있어야 합니다.

**VPS/클라우드**

- **장점:** 항상 켜져 있고 네트워크가 안정적이며 노트북 절전 문제가 없으며 계속 실행하기가 더 쉽습니다.
- **단점:** 종종 헤드리스(스크린샷 사용)로 실행되고, 원격 파일 액세스만 가능하며, 업데이트하려면 SSH가 필요합니다.

**OpenClaw 관련 참고 사항:** WhatsApp/Telegram/Slack/Mattermost(플러그인)/Discord는 모두 VPS에서 잘 작동합니다. 유일한 실제 절충점은 **헤드리스 브라우저**와 보이는 창입니다. [브라우저](/tools/browser)를 참조하세요.

**권장 기본값:** 이전에 게이트웨이 연결이 끊어진 경우 VPS입니다. Local은 Mac을 적극적으로 사용하고 눈에 보이는 브라우저를 통해 로컬 파일 액세스 또는 UI 자동화를 원할 때 유용합니다.

### 전용 머신에서 OpenClaw를 실행하는 것이 얼마나 중요한가요?

필수는 아니지만 **신뢰성과 격리를 위해 권장됩니다**.

- **전용 호스트(VPS/Mac mini/Pi):** 항상 켜져 있고 절전/재부팅 중단이 적고 권한이 더 명확하며 계속 실행하기가 더 쉽습니다.
- **공유 노트북/데스크톱:** 테스트 및 실제 사용에는 전혀 문제가 없지만 컴퓨터가 절전 모드이거나 업데이트되면 일시 중지될 수 있습니다.

두 세계의 장점을 모두 누리고 싶다면 게이트웨이를 전용 호스트에 유지하고 노트북을 로컬 화면/카메라/실행 도구용 **노드**로 페어링하세요. [노드](/nodes)를 참조하세요.
보안 지침은 [보안](/gateway/security)을 읽어보세요.

### 최소 VPS 요구사항과 권장 OS는 무엇인가요?

OpenClaw는 가볍습니다. 기본 게이트웨이 + 채팅 채널 1개의 경우:

- **절대 최소값:** vCPU 1개, RAM 1GB, 디스크 ~500MB.
- **권장:** 여유 공간(로그, 미디어, 다중 채널)을 위한 vCPU 1~2개, 2GB RAM 이상. 노드 도구와 브라우저 자동화는 리소스를 많이 소모할 수 있습니다.

OS: **Ubuntu LTS**(또는 최신 Debian/Ubuntu)를 사용합니다. Linux 설치 경로는 여기에서 가장 잘 테스트됩니다.

문서: [Linux](/platforms/linux), [VPS 호스팅](/vps).

### VM에서 OpenClaw를 실행할 수 있으며 요구 사항은 무엇입니까?

그렇습니다. VM을 VPS와 동일하게 취급합니다. VM은 항상 켜져 있고, 연결 가능해야 하며, 충분한 리소스를 보유해야 합니다.
게이트웨이 및 활성화한 모든 채널을 위한 RAM입니다.

기본 지침:

- **절대 최소값:** vCPU 1개, 1GB RAM.
- **권장:** 다중 채널, 브라우저 자동화 또는 미디어 도구를 실행하는 경우 2GB RAM 이상.
- **OS:** Ubuntu LTS 또는 다른 최신 Debian/Ubuntu.

Windows를 사용하는 경우 **WSL2는 가장 쉬운 VM 스타일 설정**이며 최고의 도구를 갖추고 있습니다.
호환성. [Windows](/platforms/windows), [VPS 호스팅](/vps)을 참조하세요.
VM에서 macOS를 실행하는 경우 [macOS VM](/install/macos-vm)를 참조하세요.

## 오픈클로란 무엇인가요?

### 한 문단으로 OpenClaw란 무엇인가

OpenClaw는 자신의 장치에서 실행되는 개인 AI 비서입니다. 이미 사용하고 있는 메시징 표면(WhatsApp, Telegram, Slack, Mattermost(플러그인), Discord, Google Chat, Signal, iMessage, WebChat)에 응답하고 지원되는 플랫폼에서 음성 + 라이브 Canvas를 수행할 수도 있습니다. **게이트웨이**는 항상 켜져 있는 제어 영역입니다. 어시스턴트는 제품이다.

### 가치 제안은 무엇입니까

OpenClaw는 "단순한 Claude 래퍼"가 아닙니다. 이는 **로컬 우선 제어 플레인**입니다.
이미 사용하고 있는 채팅 앱에서 연결할 수 있는 **자체 하드웨어**의 유능한 도우미
상태 저장 세션, 메모리 및 도구 - 워크플로 제어권을 호스트에 넘겨주지 않고
SaaS.

하이라이트:

- **귀하의 장치, 데이터:** 원하는 곳 어디에서나(Mac, Linux, VPS) 게이트웨이를 실행하고
  작업 공간 + 세션 기록 로컬.
- **웹 샌드박스가 아닌 실제 채널:** WhatsApp/Telegram/Slack/Discord/Signal/iMessage/etc,
  지원되는 플랫폼의 모바일 음성 및 Canvas도 제공됩니다.
- **모델에 구애받지 않음:** 에이전트별 라우팅과 함께 Anthropic, OpenAI, MiniMax, OpenRouter 등을 사용합니다.
  그리고 장애 조치.
- **로컬 전용 옵션:** 로컬 모델을 실행하여 원하는 경우 **모든 데이터를 장치에 보관**할 수 있습니다.
- **다중 에이전트 라우팅:** 채널, 계정 또는 작업별로 별도의 에이전트가 있으며 각각 고유합니다.
  작업 공간 및 기본값.
- **오픈 소스 및 해킹 가능:** 공급업체에 종속되지 않고 검사, 확장 및 자체 호스팅이 가능합니다.

문서: [게이트웨이](/gateway), [채널](/channels), [다중 에이전트](/concepts/multi-agent),
[메모리](/concepts/memory).

### 방금 설정했는데 무엇을 먼저 해야 할까요?

좋은 첫 번째 프로젝트:

- 웹사이트를 구축하세요(WordPress, Shopify 또는 간단한 정적 사이트).
- 모바일 앱(개요, 화면, API 계획)을 프로토타입합니다.
- 파일과 폴더를 정리합니다(정리, 이름 지정, 태그 지정).
- Gmail을 연결하고 요약이나 후속 조치를 자동화하세요.

대규모 작업을 처리할 수 있지만 여러 단계로 나누고
병렬 작업에는 하위 에이전트를 사용합니다.

### OpenClaw의 일상적인 사용 사례 상위 5개는 무엇인가요?

일일 승리는 일반적으로 다음과 같습니다.

- **개인 브리핑:** 받은편지함, 캘린더, 관심 있는 뉴스에 대한 요약입니다.
- **조사 및 초안 작성:** 이메일이나 문서에 대한 빠른 조사, 요약 및 첫 번째 초안을 작성합니다.
- **알림 및 후속 조치:** cron 또는 하트비트 기반 넛지 및 체크리스트.
- **브라우저 자동화:** 양식 작성, 데이터 수집 및 웹 작업 반복.
- **교차 장치 조정:** 휴대전화에서 작업을 보내고 게이트웨이가 서버에서 이를 실행하도록 한 다음 채팅으로 결과를 다시 받습니다.

### OpenClaw가 SaaS에 대한 리드 생성 홍보 광고 및 블로그에 도움을 줄 수 있습니까?

**연구, 자격 및 제도**에 대해서는 예입니다. 사이트를 스캔하고 최종 후보 목록을 작성하며
잠재 고객을 요약하고 홍보 또는 광고 카피 초안을 작성합니다.

**홍보 활동 또는 광고 실행**의 경우 사람에게 계속 연락하세요. 스팸을 피하고 현지 법률을 준수하며
플랫폼 정책을 확인하고 전송하기 전에 모든 내용을 검토하세요. 가장 안전한 패턴은 다음과 같습니다.
OpenClaw 초안을 작성하면 승인됩니다.

문서: [보안](/gateway/security).

### 웹 개발에서 Claude Code와 비교했을 때의 장점은 무엇인가요?

OpenClaw는 IDE 대체품이 아닌 **개인 비서** 및 조정 레이어입니다. 사용
저장소 내에서 가장 빠른 직접 코딩 루프를 위한 Claude Code 또는 Codex. 다음과 같은 경우 OpenClaw를 사용하세요.
내구성 있는 메모리, 장치 간 액세스 및 도구 조정을 원합니다.

장점:

- 세션 전반에 걸쳐 **영구 메모리 + 작업 공간**
- **다중 플랫폼 액세스**(WhatsApp, Telegram, TUI, WebChat)
- **도구 조정**(브라우저, 파일, 일정, 후크)
- **Always-On Gateway**(VPS에서 실행, 어디서나 상호 작용)
- 로컬 브라우저/화면/카메라/exec용 **노드**

쇼케이스: [https://openclaw.ai/showcase](https://openclaw.ai/showcase)

## 기술 및 자동화

### 저장소를 더럽히지 않고 스킬을 사용자 정의하는 방법

저장소 복사본을 편집하는 대신 관리형 재정의를 사용하세요. 변경 사항을 `~/.openclaw/skills/<name>/SKILL.md`에 넣으세요(또는 `~/.openclaw/openclaw.json`에서 `skills.load.extraDirs`를 통해 폴더를 추가하세요). 우선 순위는 `<workspace>/skills` > `~/.openclaw/skills` > 번들이므로 git을 건드리지 않고도 관리 재정의가 승리합니다. 업스트림에 적합한 편집 내용만 저장소에 존재하고 PR로 나가야 합니다.

### 사용자 정의 폴더에서 스킬을 로드할 수 있나요?

그렇습니다. `~/.openclaw/openclaw.json`의 `skills.load.extraDirs`를 통해 추가 디렉터리를 추가합니다(최하위 우선 순위). 기본 우선순위는 그대로 유지됩니다: `<workspace>/skills` → `~/.openclaw/skills` → 번들 → `skills.load.extraDirs`. `clawhub`는 기본적으로 `./skills`에 설치되며 OpenClaw는 이를 `<workspace>/skills`로 처리합니다.

### 다양한 작업에 다양한 모델을 사용하려면 어떻게 해야 하나요?

현재 지원되는 패턴은 다음과 같습니다.

- **크론 작업**: 격리된 작업은 작업별로 `model` 재정의를 설정할 수 있습니다.
- **하위 에이전트**: 기본 모델이 다른 별도의 에이전트에 작업을 라우팅합니다.
- **주문형 전환**: `/model`를 사용하여 언제든지 현재 세션 모델을 전환할 수 있습니다.

[Cron 작업](/automation/cron-jobs), [다중 에이전트 라우팅](/concepts/multi-agent) 및 [슬래시 명령](/tools/slash-commands)을 참조하세요.

### 과중한 작업을 수행하는 동안 봇이 멈춥니다. 어떻게 하면 이를 오프로드할 수 있나요?

장기 또는 병렬 작업에는 **하위 에이전트**를 사용하세요. 하위 에이전트는 자체 세션에서 실행됩니다.
요약을 반환하고 기본 채팅의 응답성을 유지하세요.

봇에게 "이 작업을 위한 하위 에이전트 생성"을 요청하거나 `/subagents`를 사용하세요.
채팅에서 `/status`를 사용하여 게이트웨이가 지금 무엇을 하고 있는지(그리고 사용 중인지) 확인하세요.

토큰 팁: 긴 작업과 하위 에이전트는 모두 토큰을 소비합니다. 비용이 걱정된다면 다음을 설정하세요.
`agents.defaults.subagents.model`를 통해 하위 에이전트에 대한 저렴한 모델을 제공합니다.

문서: [하위 에이전트](/tools/subagents).

### 크론 또는 미리 알림이 실행되지 않습니다. 무엇을 확인해야 하나요?

Cron은 게이트웨이 프로세스 내에서 실행됩니다. 게이트웨이가 지속적으로 실행되지 않는 경우
예약된 작업이 실행되지 않습니다.

체크리스트:

- 크론이 활성화되어 있고(`cron.enabled`) `OPENCLAW_SKIP_CRON`가 설정되지 않았는지 확인하세요.
- 게이트웨이가 연중무휴로 실행되고 있는지 확인하세요(잠자기/재시작 없음).
- 작업의 시간대 설정(`--tz` 및 호스트 시간대)을 확인합니다.

디버그:

```bash
openclaw cron run <jobId> --force
openclaw cron runs --id <jobId> --limit 50
```

문서: [Cron 작업](/automation/cron-jobs), [Cron 대 하트비트](/automation/cron-vs-heartbeat).

### Linux에 스킬을 설치하려면 어떻게 해야 하나요?

**ClawHub**(CLI)를 사용하거나 작업 공간에 기술을 추가하세요. Linux에서는 macOS 기술 UI를 사용할 수 없습니다.
[https://clawhub.com](https://clawhub.com)에서 스킬을 찾아보세요.

ClawHub CLI를 설치합니다(패키지 관리자 하나 선택).

```bash
npm i -g clawhub
```

```bash
pnpm add -g clawhub
```

### OpenClaw는 일정에 따라 또는 백그라운드에서 지속적으로 작업을 실행할 수 있나요?

그렇습니다. 게이트웨이 스케줄러를 사용하십시오.

- 예약되거나 반복되는 작업에 대한 **Cron 작업**(다시 시작해도 지속됨).
- "메인 세션" 정기 점검을 위한 **하트비트**.
- 요약을 게시하거나 채팅에 전달하는 자율 에이전트를 위한 **격리된 작업**입니다.

문서: [Cron 작업](/automation/cron-jobs), [Cron 대 하트비트](/automation/cron-vs-heartbeat),
[심장박동](/gateway/heartbeat).

### Linux에서 Apple macOS 전용 기술을 실행할 수 있나요?

직접적으로는 아닙니다. macOS 기술은 `metadata.openclaw.os` 및 필수 바이너리로 제어되며 기술은 **게이트웨이 호스트**에서 자격을 갖춘 경우에만 시스템 프롬프트에 나타납니다. Linux에서는 게이팅을 재정의하지 않으면 `darwin` 전용 스킬(예: `apple-notes`, `apple-reminders`, `things-mac`)이 로드되지 않습니다.

지원되는 패턴은 세 가지입니다.

**옵션 A - Mac에서 게이트웨이를 실행합니다(가장 간단함).**
macOS 바이너리가 있는 게이트웨이를 실행한 다음 Linux에서 [원격 모드](#how-do-i-run-openclaw-in-remote-mode-client-connects-to-a-gateway-elsewhere) 또는 Tailscale을 통해 연결합니다. 게이트웨이 호스트가 macOS이기 때문에 기술이 정상적으로 로드됩니다.

**옵션 B - macOS 노드를 사용합니다(SSH 없음).**
Linux에서 게이트웨이를 실행하고, macOS 노드(메뉴 표시줄 앱)를 페어링하고, Mac에서 **노드 실행 명령**을 "항상 묻기" 또는 "항상 허용"으로 설정하세요. OpenClaw는 노드에 필요한 바이너리가 있는 경우 macOS 전용 기술을 적합한 것으로 처리할 수 있습니다. 에이전트는 `nodes` 도구를 통해 해당 기술을 실행합니다. "항상 묻기"를 선택한 경우 프롬프트에서 "항상 허용"을 승인하면 해당 명령이 허용 목록에 추가됩니다.

**옵션 C - SSH를 통한 macOS 바이너리 프록시(고급).**
게이트웨이를 Linux에 유지하되 필요한 CLI 바이너리가 Mac에서 실행되는 SSH 래퍼로 확인되도록 하세요. 그런 다음 Linux를 허용하도록 기술을 재정의하여 자격을 유지합니다.

1. 바이너리용 SSH 래퍼를 생성합니다(예: Apple Notes의 경우 `memo`).

   ```bash
   #!/usr/bin/env bash
   set -euo pipefail
   exec ssh -T user@mac-host /opt/homebrew/bin/memo "$@"
   ```

2. Linux 호스트의 `PATH`에 래퍼를 배치합니다(예: `~/bin/memo`).
3. Linux를 허용하도록 스킬 메타데이터(작업 공간 또는 `~/.openclaw/skills`)를 재정의합니다.

   ```markdown
   ---
   name: apple-notes
   description: Manage Apple Notes via the memo CLI on macOS.
   metadata: { "openclaw": { "os": ["darwin", "linux"], "requires": { "bins": ["memo"] } } }
   ---
   ```

4. 스킬 스냅샷이 새로 고쳐지도록 새 세션을 시작합니다.

### Notion 또는 HeyGen 통합이 있습니까?

오늘은 내장되어 있지 않습니다.

옵션:

- **맞춤형 기술/플러그인:** 안정적인 API 액세스에 가장 적합합니다(Notion/HeyGen 모두 API가 있음).
- **브라우저 자동화:** 코드 없이 작동하지만 속도가 느리고 취약합니다.

클라이언트별 컨텍스트(에이전시 워크플로)를 유지하려는 경우 간단한 패턴은 다음과 같습니다.

- 클라이언트당 하나의 Notion 페이지(컨텍스트 + 기본 설정 + 활성 작업).
- 세션 시작 시 상담원에게 해당 페이지를 가져오도록 요청하세요.

기본 통합을 원하는 경우 기능 요청을 개설하거나 기술을 구축하세요.
해당 API를 타겟팅합니다.

설치 기술:

```bash
clawhub install <skill-slug>
clawhub update --all
```

ClawHub는 현재 디렉터리 아래의 `./skills`에 설치됩니다(또는 구성된 OpenClaw 작업 공간으로 대체). OpenClaw는 다음 세션에서 이를 `<workspace>/skills`로 처리합니다. 에이전트 간 공유 스킬의 경우 `~/.openclaw/skills/<name>/SKILL.md`에 배치하세요. 일부 기술에서는 Homebrew를 통해 바이너리가 설치될 것으로 예상합니다. Linux에서는 Linuxbrew를 의미합니다(위의 Homebrew Linux FAQ 항목 참조). [스킬](/tools/skills) 및 [ClawHub](/tools/clawhub)를 참조하세요.

### 브라우저 장악을 위한 Chrome 확장 프로그램을 설치하려면 어떻게 해야 하나요?

내장된 설치 프로그램을 사용한 다음 Chrome에서 압축을 푼 확장 프로그램을 로드합니다.

```bash
openclaw browser extension install
openclaw browser extension path
```

그런 다음 Chrome → `chrome://extensions` → "개발자 모드" 활성화 → "압축 해제된 항목 로드" → 해당 폴더를 선택합니다.

전체 가이드(원격 게이트웨이 + 보안 참고사항 포함): [Chrome 확장 프로그램](/tools/chrome-extension)

게이트웨이가 Chrome과 동일한 시스템(기본 설정)에서 실행되는 경우 일반적으로 추가 항목이 **필요하지 않습니다**.
게이트웨이가 다른 곳에서 실행되는 경우 게이트웨이가 브라우저 작업을 프록시할 수 있도록 브라우저 시스템에서 노드 호스트를 실행합니다.
제어하려는 탭에서 확장 버튼을 클릭해야 합니다(자동 연결되지 않음).

## 샌드박스 및 메모리

### 전용 샌드박싱 문서가 있나요?

그렇습니다. [샌드박싱](/gateway/sandboxing)을 참조하세요. Docker 관련 설정(Docker 또는 샌드박스 이미지의 전체 게이트웨이)은 [Docker](/install/docker)를 참조하세요.

### Docker는 제한적이라고 느낍니다. 전체 기능을 활성화하려면 어떻게 해야 합니까?

기본 이미지는 보안 우선이며 `node` 사용자로 실행되므로
시스템 패키지, Homebrew 또는 번들 브라우저가 포함됩니다. 더 완전한 설정을 위해서는:

- `/home/node`를 `OPENCLAW_HOME_VOLUME`와 함께 유지하여 캐시가 살아남도록 하세요.
- `OPENCLAW_DOCKER_APT_PACKAGES`를 사용하여 시스템을 이미지에 굽습니다.
- 번들 CLI를 통해 Playwright 브라우저를 설치합니다.
  `node /app/node_modules/playwright-core/cli.js install chromium`
- `PLAYWRIGHT_BROWSERS_PATH`을 설정하고 경로가 지속되는지 확인하세요.

문서: [Docker](/install/docker), [브라우저](/tools/browser).

**DM을 개인용으로 유지하면서 하나의 에이전트로 그룹을 공개 샌드박스로 만들 수 있나요**

예. 개인 트래픽이 **DM**이고 공용 트래픽이 **그룹**인 경우입니다.

`agents.defaults.sandbox.mode: "non-main"`을 사용하면 그룹/채널 세션(기본 키가 아닌)이 Docker에서 실행되고 기본 DM 세션은 호스트에 유지됩니다. 그런 다음 `tools.sandbox.tools`를 통해 샌드박스 세션에서 사용할 수 있는 도구를 제한합니다.

설정 연습 + 구성 예: [그룹: 개인 DM + 공개 그룹](/channels/groups#pattern-personal-dms-public-groups-single-agent)

주요 구성 참조: [게이트웨이 구성](/gateway/configuration#agentsdefaultssandbox)

### 호스트 폴더를 샌드박스에 바인딩하는 방법

`agents.defaults.sandbox.docker.binds`를 `["host:path:mode"]`로 설정합니다(예: `"/home/user/src:/src:ro"`). 전역 + 에이전트별 바인딩 병합; `scope: "shared"`인 경우 에이전트별 바인드는 무시됩니다. 민감한 내용에는 `:ro`를 사용하고 바인드는 샌드박스 파일 시스템 벽을 우회한다는 점을 기억하세요. 예시와 안전 참고사항은 [샌드박싱](/gateway/sandboxing#custom-bind-mounts) 및 [샌드박스 vs 도구 정책 vs 상승](/gateway/sandbox-vs-tool-policy-vs-elevated#bind-mounts-security-quick-check)을 참조하세요.

### 기억은 어떻게 작동하는가

OpenClaw 메모리는 에이전트 작업 공간의 마크다운 파일일 뿐입니다.

- `memory/YYYY-MM-DD.md`의 일일 메모
- `MEMORY.md`에서 선별된 장기 노트(메인/비공개 세션만 해당)

OpenClaw는 또한 모델에게 상기시키기 위해 **자동 사전 압축 메모리 플러시**를 실행합니다.
자동 압축 전에 내구성 있는 메모를 작성합니다. 이는 작업공간이 있을 때만 실행됩니다.
쓰기 가능합니다(읽기 전용 샌드박스에서는 건너뜁니다). [메모리](/concepts/memory)를 참조하세요.

### 기억이 자꾸 잊어버리게 만드는 방법

봇에게 **사실을 메모리에 기록**하도록 요청하세요. 장기노트는 `MEMORY.md`에 속하며,
단기 컨텍스트는 `memory/YYYY-MM-DD.md`에 들어갑니다.

이 부분은 우리가 아직 개선하고 있는 부분입니다. 모델이 기억을 저장하도록 상기시키는 데 도움이 됩니다.
무엇을 해야할지 알게 됩니다. 계속 잊어버리면 게이트웨이가 동일한 것을 사용하고 있는지 확인하십시오.
실행할 때마다 작업 공간.

문서: [메모리](/concepts/memory), [에이전트 작업 영역](/concepts/agent-workspace).

### 의미 메모리 검색에는 OpenAI API 키가 필요합니까?

**OpenAI 임베딩**을 사용하는 경우에만 해당됩니다. Codex OAuth는 채팅/완료 및
임베딩 액세스 권한을 부여하지 **않기** 때문에 **Codex(OAuth 또는
Codex CLI 로그인)**은 의미기억 검색에 도움이 되지 않습니다. OpenAI 임베딩
여전히 실제 API 키(`OPENAI_API_KEY` 또는 `models.providers.openai.apiKey`)가 필요합니다.

공급자를 명시적으로 설정하지 않으면 OpenClaw는 공급자를 자동으로 선택합니다.
API 키(인증 프로필, `models.providers.*.apiKey` 또는 환경 변수)를 확인할 수 있습니다.
OpenAI 키가 확인되면 OpenAI를 선호하고, 그렇지 않으면 Gemini 키가 확인되면 Gemini를 선호합니다.
해결합니다. 두 키를 모두 사용할 수 없으면 메모리 검색은 다음을 수행할 때까지 비활성화된 상태로 유지됩니다.
그것을 구성하십시오. 로컬 모델 경로가 구성되어 있고 존재하는 경우 OpenClaw
`local`를 선호합니다.

로컬에 머무르고 싶다면 `memorySearch.provider = "local"`를 설정하세요(그리고 선택적으로
`memorySearch.fallback = "none"`). Gemini 임베딩을 원하면 다음을 설정하세요.
`memorySearch.provider = "gemini"` 및 `GEMINI_API_KEY` 제공(또는
`memorySearch.remote.apiKey`). **OpenAI, Gemini 또는 로컬** 임베딩을 지원합니다.
모델 - 설정 세부 사항은 [메모리](/concepts/memory)를 참조하세요.

### 메모리는 영원히 지속되나요? 한계는 무엇인가요?

메모리 파일은 디스크에 존재하며 삭제할 때까지 유지됩니다. 한계는 당신의 것입니다
모델이 아닌 저장 공간입니다. **세션 컨텍스트**는 여전히 모델에 의해 제한됩니다.
컨텍스트 창을 사용하므로 긴 대화가 압축되거나 잘릴 수 있습니다. 그렇기 때문에
메모리 검색이 존재합니다. 관련 부분만 다시 컨텍스트로 가져옵니다.

문서: [메모리](/concepts/memory), [컨텍스트](/concepts/context).

## 디스크에 사물이 존재하는 곳

### OpenClaw에서 사용하는 모든 데이터는 로컬에 저장되나요?

아니요 - **OpenClaw의 상태는 로컬**이지만 **외부 서비스는 사용자가 보낸 내용을 계속 볼 수 있습니다**.

- **기본적으로 로컬:** 세션, 메모리 파일, 구성 및 작업 공간이 게이트웨이 호스트에 존재합니다.
  (`~/.openclaw` + 작업공간 디렉토리).
- **필요에 따른 원격:** 모델 제공자(Anthropic/OpenAI 등)에게 보내는 메시지는 다음으로 이동합니다.
  API 및 채팅 플랫폼(WhatsApp/Telegram/Slack/등)은 메시지 데이터를 자신의 컴퓨터에 저장합니다.
  서버.
- **설치 공간을 제어합니다.** 로컬 모델을 사용하면 시스템에 프롬프트가 유지되지만 채널은
  트래픽은 여전히 채널 서버를 통과합니다.

관련 항목: [에이전트 작업 영역](/concepts/agent-workspace), [메모리](/concepts/memory).

### OpenClaw는 데이터를 어디에 저장하나요?

모든 것은 `$OPENCLAW_STATE_DIR` 아래에 있습니다(기본값: `~/.openclaw`):

| 경로                                                            | 목적                                                     |
| --------------------------------------------------------------- | -------------------------------------------------------- |
| `$OPENCLAW_STATE_DIR/openclaw.json`                             | 기본 구성(JSON5)                                         |
| `$OPENCLAW_STATE_DIR/credentials/oauth.json`                    | 레거시 OAuth 가져오기(처음 사용 시 인증 프로필에 복사됨) |
| `$OPENCLAW_STATE_DIR/agents/<agentId>/agent/auth-profiles.json` | 인증 프로필(OAuth + API 키)                              |
| `$OPENCLAW_STATE_DIR/agents/<agentId>/agent/auth.json`          | 런타임 인증 캐시(자동으로 관리됨)                        |
| `$OPENCLAW_STATE_DIR/credentials/`                              | 공급자 상태(예: `whatsapp/<accountId>/creds.json`)       |
| `$OPENCLAW_STATE_DIR/agents/`                                   | 에이전트별 상태(agentDir + 세션)                         |
| `$OPENCLAW_STATE_DIR/agents/<agentId>/sessions/`                | 대화 내역 및 상태(상담사별)                              |
| `$OPENCLAW_STATE_DIR/agents/<agentId>/sessions/sessions.json`   | 세션 메타데이터(에이전트당)                              |

레거시 단일 에이전트 경로: `~/.openclaw/agent/*` (`openclaw doctor`에 의해 마이그레이션됨).

**작업 공간**(AGENTS.md, 메모리 파일, 스킬 등)은 `agents.defaults.workspace`(기본값: `~/.openclaw/workspace`)를 통해 별도로 구성됩니다.

### AGENTSmd SOULmd USERmd MEMORYmd는 어디에 있어야 합니까?

이러한 파일은 `~/.openclaw`가 아닌 **에이전트 작업 공간**에 있습니다.

- **작업 공간(에이전트별)**: `AGENTS.md`, `SOUL.md`, `IDENTITY.md`, `USER.md`,
  `MEMORY.md` (또는 `memory.md`), `memory/YYYY-MM-DD.md`, 선택 사항 `HEARTBEAT.md`.
- **상태 디렉토리(`~/.openclaw`)**: 구성, 자격 증명, 인증 프로필, 세션, 로그,
  및 공유 스킬(`~/.openclaw/skills`).

기본 작업 공간은 `~/.openclaw/workspace`이며 다음을 통해 구성할 수 있습니다.

```json5
{
  agents: { defaults: { workspace: "~/.openclaw/workspace" } },
}
```

다시 시작한 후 봇이 "잊는" 경우 게이트웨이가 동일한 것을 사용하고 있는지 확인하세요.
시작할 때마다 작업 공간(그리고 기억하세요: 원격 모드는 **게이트웨이 호스트**를 사용합니다)
로컬 노트북이 아닌 작업 공간).

팁: 지속 가능한 동작이나 기본 설정을 원하는 경우 봇에게 **기록하도록 요청하세요.
채팅 기록에 의존하지 않고 AGENTS.md 또는 MEMORY.md**를 사용합니다.

[에이전트 작업 영역](/concepts/agent-workspace) 및 [메모리](/concepts/memory)를 참조하세요.

### 권장되는 백업 전략은 무엇입니까

**에이전트 작업 영역**을 **비공개** git 저장소에 넣고 어딘가에 백업하세요.
비공개(예: GitHub 비공개) 이는 메모리 + AGENTS/SOUL/USER를 캡처합니다.
파일을 저장하고 나중에 조수의 "마음"을 복원할 수 있습니다.

`~/.openclaw`(자격 증명, 세션, 토큰) 아래에는 아무것도 커밋하지 **마세요**.
전체 복원이 필요한 경우 작업 공간과 상태 디렉터리를 모두 백업하세요.
별도로(위의 마이그레이션 질문 참조)

문서: [에이전트 작업 영역](/concepts/agent-workspace).

### OpenClaw를 완전히 제거하려면 어떻게 해야 하나요?

전용 가이드: [제거](/install/uninstall)를 참조하세요.

### 상담원이 작업공간 외부에서 작업할 수 있나요?

예. 작업공간은 하드 샌드박스가 아닌 **기본 cwd** 및 메모리 앵커입니다.
상대 경로는 작업 공간 내에서 확인되지만 절대 경로는 다른 경로에 액세스할 수 있습니다.
샌드박싱이 활성화되지 않은 경우 호스트 위치. 격리가 필요한 경우 다음을 사용하세요.
[`agents.defaults.sandbox`](/gateway/sandboxing) 또는 에이전트별 샌드박스 설정. 당신이
저장소를 기본 작업 디렉터리로 설정하려면 해당 에이전트의 디렉터리를 지정하세요.
`workspace` repo 루트에. OpenClaw 저장소는 단지 소스 코드일 뿐입니다. 유지하다
의도적으로 에이전트가 내부에서 작업하도록 원하지 않는 한 작업 영역을 별도로 분리합니다.

예(기본 cwd로 저장소):

```json5
{
  agents: {
    defaults: {
      workspace: "~/Projects/my-repo",
    },
  },
}
```

### 세션 저장소가 있는 원격 모드에 있습니다.

세션 상태는 **게이트웨이 호스트**가 소유합니다. 원격 모드에 있는 경우 관심 있는 세션 저장소는 로컬 랩톱이 아닌 원격 시스템에 있습니다. [세션 관리](/concepts/session)를 참조하세요.

## 구성 기본 사항

### 구성은 어떤 형식인가요? 어디에 있나요?

OpenClaw는 `$OPENCLAW_CONFIG_PATH`에서 선택적 **JSON5** 구성을 읽습니다(기본값: `~/.openclaw/openclaw.json`):

```
$OPENCLAW_CONFIG_PATH
```

파일이 누락된 경우 안전한 기본값(`~/.openclaw/workspace`의 기본 작업 공간 포함)을 사용합니다.

### Gatewaybind LAN 또는 tailnet을 설정했는데 이제 UI에서 승인되지 않았다는 메시지가 들리지 않습니다.

루프백이 아닌 바인딩에는 **인증이 필요합니다**. `gateway.auth.mode` + `gateway.auth.token`를 구성합니다(또는 `OPENCLAW_GATEWAY_TOKEN` 사용).

```json5
{
  gateway: {
    bind: "lan",
    auth: {
      mode: "token",
      token: "replace-me",
    },
  },
}
```

참고:

- `gateway.remote.token`는 **원격 CLI 호출** 전용입니다. 로컬 게이트웨이 인증은 활성화되지 않습니다.
- Control UI는 `connect.params.auth.token`(앱/UI 설정에 저장됨)를 통해 인증합니다. URL에 토큰을 넣지 마십시오.

### 왜 지금 로컬호스트에 토큰이 필요한가요?

마법사는 기본적으로(루프백에서도) 게이트웨이 토큰을 생성하므로 **로컬 WS 클라이언트는 인증해야 합니다**. 이는 다른 로컬 프로세스가 게이트웨이를 호출하는 것을 차단합니다. 토큰을 Control UI 설정(또는 클라이언트 구성)에 붙여넣어 연결하세요.

**정말로** 개방형 루프백을 원한다면 구성에서 `gateway.auth`를 제거하세요. 의사는 언제든지 토큰을 생성할 수 있습니다: `openclaw doctor --generate-gateway-token`.

### 구성을 변경한 후 다시 시작해야 하나요?

게이트웨이는 구성을 감시하고 핫 리로드를 지원합니다.

- `gateway.reload.mode: "hybrid"` (기본값): 안전한 변경 사항을 즉시 적용하고, 중요한 변경 사항은 다시 시작합니다.
- `hot`, `restart`, `off`도 지원됩니다.

### 웹 검색 및 웹 가져오기를 활성화하려면 어떻게 해야 하나요?

`web_fetch`는 API 키 없이 작동합니다. `web_search`에는 Brave Search API가 필요합니다.
열쇠. **권장:** `openclaw configure --section web`를 실행하여 저장합니다.
`tools.web.search.apiKey`. 환경 대안: `BRAVE_API_KEY`을 설정합니다.
게이트웨이 프로세스.

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

참고:

- 허용 목록을 사용하는 경우 `web_search`/`web_fetch` 또는 `group:web`를 추가하세요.
- `web_fetch`는 기본적으로 활성화됩니다(명시적으로 비활성화하지 않는 한).
- 데몬은 `~/.openclaw/.env`(또는 서비스 환경)에서 환경 변수를 읽습니다.

문서: [웹 도구](/tools/web).

### 여러 기기에 걸쳐 전문 작업자가 있는 중앙 게이트웨이를 어떻게 운영하나요?

일반적인 패턴은 **하나의 게이트웨이**(예: Raspberry Pi)와 **노드** 및 **에이전트**입니다.

- **게이트웨이(중앙):** 채널(Signal/WhatsApp), 라우팅, 세션을 소유합니다.
- **노드(장치):** Mac/iOS/Android는 주변 장치로 연결하고 로컬 도구(`system.run`, `canvas`, `camera`)를 노출합니다.
- **에이전트(근로자):** 특별한 역할을 위한 별도의 두뇌/작업 공간(예: "Hetzner ops", "개인 데이터").
- **하위 에이전트:** 병렬 처리를 원할 때 기본 에이전트에서 백그라운드 작업을 생성합니다.
- **TUI:** 게이트웨이에 연결하고 에이전트/세션을 전환합니다.

문서: [노드](/nodes), [원격 액세스](/gateway/remote), [다중 에이전트 라우팅](/concepts/multi-agent), [하위 에이전트](/tools/subagents), [TUI](/web/tui).

### OpenClaw 브라우저가 헤드리스로 실행될 수 있나요?

그렇습니다. 구성 옵션입니다.

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

기본값은 `false`(헤드풀)입니다. Headless는 일부 사이트에서 안티봇 검사를 실행할 가능성이 더 높습니다. [브라우저](/tools/browser)를 참조하세요.

Headless는 **동일한 Chromium 엔진**을 사용하며 대부분의 자동화(양식, 클릭, 스크래핑, 로그인)에 작동합니다. 주요 차이점:

- 브라우저 창이 표시되지 않습니다(시각적 요소가 필요한 경우 스크린샷을 사용하세요).
- 일부 사이트는 헤드리스 모드(CAPTCHA, 안티봇)의 자동화에 대해 더 엄격합니다.
  예를 들어 X/Twitter는 종종 헤드리스 세션을 차단합니다.

### 브라우저 제어를 위해 Brave를 어떻게 사용하나요?

`browser.executablePath`을 Brave 바이너리(또는 Chromium 기반 브라우저)로 설정하고 게이트웨이를 다시 시작하세요.
[브라우저](/tools/browser#use-brave-or-another-chromium-based-browser)에서 전체 구성 예시를 확인하세요.

## 원격 게이트웨이 및 노드

### 텔레그램 게이트웨이와 노드 간에 명령이 어떻게 전파됩니까?

전보 메시지는 **게이트웨이**에 의해 처리됩니다. 게이트웨이는 에이전트를 실행하고
그런 다음 노드 도구가 필요할 때만 **Gateway WebSocket**을 통해 노드를 호출합니다.

텔레그램 → 게이트웨이 → 에이전트 → `node.*` → 노드 → 게이트웨이 → 텔레그램

노드에는 인바운드 공급자 트래픽이 표시되지 않습니다. 노드 RPC 호출만 수신합니다.

### 게이트웨이가 원격으로 호스팅되는 경우 내 에이전트가 내 컴퓨터에 어떻게 액세스할 수 있나요?

짧은 답변: **컴퓨터를 노드로 페어링**하세요. 게이트웨이는 다른 곳에서 실행되지만
Gateway WebSocket을 통해 로컬 컴퓨터의 `node.*` 도구(화면, 카메라, 시스템)를 호출합니다.

일반적인 설정:

1. Always-On 호스트(VPS/홈 서버)에서 게이트웨이를 실행합니다.
2. 게이트웨이 호스트와 컴퓨터를 동일한 테일넷에 배치합니다.
3. 게이트웨이 WS에 연결할 수 있는지 확인합니다(tailnet 바인딩 또는 SSH 터널).
4. 로컬에서 macOS 앱을 열고 **SSH를 통한 원격** 모드(또는 직접 tailnet)로 연결합니다.
   노드로 등록할 수 있습니다.
5. 게이트웨이에서 노드를 승인합니다.

   ```bash
   openclaw nodes pending
   openclaw nodes approve <requestId>
   ```

별도의 TCP 브리지가 필요하지 않습니다. 노드는 Gateway WebSocket을 통해 연결됩니다.

보안 알림: macOS 노드를 페어링하면 해당 컴퓨터에서 `system.run`가 허용됩니다. 만
신뢰하는 장치를 페어링하고 [보안](/gateway/security)을 검토하세요.

문서: [노드](/nodes), [게이트웨이 프로토콜](/gateway/protocol), [macOS 원격 모드](/platforms/mac/remote), [보안](/gateway/security).

### 테일스케일 연결은 되었는데 답이 없네요 뭐야

기본사항을 확인하세요.

- 게이트웨이가 실행 중입니다: `openclaw gateway status`
- 게이트웨이 상태: `openclaw status`
- 채널 상태: `openclaw channels status`

그런 다음 인증 및 라우팅을 확인합니다.

- Tailscale Serve를 사용하는 경우 `gateway.auth.allowTailscale`가 올바르게 설정되어 있는지 확인하세요.
- SSH 터널을 통해 연결하는 경우 로컬 터널이 작동 중이고 올바른 포트를 가리키는지 확인하세요.
- 허용 목록(DM 또는 그룹)에 귀하의 계정이 포함되어 있는지 확인하세요.

문서: [Tailscale](/gateway/tailscale), [원격 액세스](/gateway/remote), [채널](/channels).

### 두 개의 OpenClaw 인스턴스가 서로 로컬 VPS와 통신할 수 있나요?

그렇습니다. 내장된 "봇-봇" 브리지는 없지만 몇 번만 연결하면 됩니다.
신뢰할 수 있는 방법:

**가장 간단함:** 두 봇 모두 액세스할 수 있는 일반 채팅 채널(Telegram/Slack/WhatsApp)을 사용하세요.
Bot A가 Bot B에게 메시지를 보낸 다음 Bot B가 평소대로 응답하도록 합니다.

**CLI 브리지(일반):** 다음을 사용하여 다른 게이트웨이를 호출하는 스크립트를 실행합니다.
`openclaw agent --message ... --deliver`, 다른 봇이 있는 채팅을 타겟팅합니다.
듣는다. 하나의 봇이 원격 VPS에 있는 경우 해당 원격 게이트웨이에서 CLI를 가리킵니다.
SSH/Tailscale을 통해([원격 액세스](/gateway/remote) 참조).

예제 패턴(대상 게이트웨이에 연결할 수 있는 머신에서 실행):

```bash
openclaw agent --message "Hello from local bot" --deliver --channel telegram --reply-to <chat-id>
```

팁: 두 봇이 끝없이 반복되지 않도록 가드레일을 추가하세요(언급만 하자면 채널
허용 목록 또는 "봇 메시지에 회신하지 않음" 규칙).

문서: [원격 액세스](/gateway/remote), [에이전트 CLI](/cli/agent), [에이전트 보내기](/tools/agent-send).

### 여러 에이전트에 별도의 VPS가 필요한가요?

아니요. 하나의 게이트웨이는 각각 고유한 작업 공간, 모델 기본값을 갖는 여러 에이전트를 호스팅할 수 있습니다.
그리고 라우팅. 이것이 일반적인 설정이며 실행하는 것보다 훨씬 저렴하고 간단합니다.
에이전트당 하나의 VPS.

엄격한 격리(보안 경계)가 필요하거나 매우 필요한 경우에만 별도의 VPS를 사용하십시오.
공유하고 싶지 않은 다른 구성. 그렇지 않으면 하나의 게이트웨이를 유지하고
여러 에이전트 또는 하위 에이전트를 사용합니다.

### VPS에서 SSH를 사용하는 대신 개인 노트북의 노드를 사용하면 이점이 있나요?

예. 노드는 원격 게이트웨이에서 노트북에 연결하는 최고의 방법입니다.
쉘 액세스 이상의 잠금을 해제합니다. 게이트웨이는 macOS/Linux(WSL2를 통한 Windows)에서 실행되며
가볍습니다(작은 VPS 또는 Raspberry Pi급 상자도 괜찮습니다. 4GB RAM이면 충분합니다).
설정은 Always-On 호스트와 노트북을 노드로 사용합니다.

- **인바운드 SSH가 필요하지 않습니다.** 노드는 게이트웨이 WebSocket에 연결하고 장치 페어링을 사용합니다.
- **더 안전한 실행 제어.** `system.run`는 해당 노트북의 노드 허용 목록/승인에 의해 관리됩니다.
- **추가 장치 도구.** 노드는 `system.run` 외에 `canvas`, `camera` 및 `screen`를 노출합니다.
- **로컬 브라우저 자동화.** 게이트웨이를 VPS에 유지하되 Chrome을 로컬에서 실행하고 제어를 릴레이하세요.
  Chrome 확장 프로그램 + 노트북의 노드 호스트를 사용합니다.

임시 셸 액세스에는 SSH가 적합하지만 진행 중인 에이전트 워크플로 및 작업에는 노드가 더 간단합니다.
장치 자동화.

문서: [노드](/nodes), [노드 CLI](/cli/nodes), [Chrome 확장 프로그램](/tools/chrome-extension).

### 두 번째 노트북에 설치해야 할까요, 아니면 노드만 추가해야 할까요?

두 번째 노트북에 **로컬 도구**(화면/카메라/실행)만 필요한 경우 이를
**노드**. 이는 단일 게이트웨이를 유지하고 중복 구성을 방지합니다. 로컬 노드 도구는 다음과 같습니다.
현재는 macOS 전용이지만 다른 OS로도 확장할 계획입니다.

**강력한 격리**가 필요한 경우에만 두 번째 게이트웨이를 설치하거나 완전히 분리된 두 개의 봇을 설치하세요.

문서: [노드](/nodes), [노드 CLI](/cli/nodes), [다중 게이트웨이](/gateway/multiple-gateways).

### 노드가 게이트웨이 서비스를 실행합니까?

아니요. 의도적으로 격리된 프로필을 실행하지 않는 한 호스트당 **하나의 게이트웨이**만 실행해야 합니다([다중 게이트웨이](/gateway/multiple-gateways) 참조). 노드는 연결하는 주변 장치입니다.
게이트웨이(iOS/Android 노드 또는 메뉴 표시줄 앱의 macOS "노드 모드")에 연결합니다. 헤드리스 노드의 경우
호스트 및 CLI 제어는 [노드 호스트 CLI](/cli/node)를 참조하세요.

`gateway`, `discovery` 및 `canvasHost` 변경 사항은 전체 재시작이 필요합니다.

### 구성을 적용하는 API RPC 방법이 있나요?

그렇습니다. `config.apply`는 전체 구성을 검증하고 작성하고 작업의 일부로 게이트웨이를 다시 시작합니다.

### configapply로 인해 내 구성이 지워졌습니다. 어떻게 복구하고 방지할 수 있나요?

`config.apply`는 **전체 구성**을 대체합니다. 부분 객체를 보내면 모든 것이
else는 제거됩니다.

복구:

- 백업(git 또는 복사된 `~/.openclaw/openclaw.json`)에서 복원합니다.
- 백업이 없는 경우 `openclaw doctor`를 다시 실행하고 채널/모델을 재구성하세요.
- 예상치 못한 일인 경우 버그를 신고하고 마지막으로 알려진 구성이나 백업을 포함하세요.
- 로컬 코딩 에이전트는 종종 로그 또는 기록에서 작업 구성을 재구성할 수 있습니다.

피하세요:

- 작은 변경에는 `openclaw config set`를 사용하세요.
- 대화형 편집을 위해서는 `openclaw configure`를 사용하세요.

문서: [구성](/cli/config), [구성](/cli/configure), [의사](/gateway/doctor).

### 첫 설치를 위한 최소한의 정상적인 구성은 무엇입니까?

```json5
{
  agents: { defaults: { workspace: "~/.openclaw/workspace" } },
  channels: { whatsapp: { allowFrom: ["+15555550123"] } },
}
```

이렇게 하면 작업 영역이 설정되고 봇을 트리거할 수 있는 사람이 제한됩니다.

### VPS에서 Tailscale을 설정하고 Mac에서 연결하려면 어떻게 해야 하나요?

최소 단계:

1. **VPS 설치 + 로그인**

   ```bash
   curl -fsSL https://tailscale.com/install.sh | sh
   sudo tailscale up
   ```

2. **Mac에 설치 + 로그인**
   - Tailscale 앱을 사용하여 동일한 tailnet에 로그인하세요.
3. **MagicDNS 활성화(권장)**
   - Tailscale 관리 콘솔에서 MagicDNS를 활성화하여 VPS가 안정적인 이름을 갖도록 합니다.
4. **tailnet 호스트 이름 사용**
   - SSH: `ssh user@your-vps.tailnet-xxxx.ts.net`
   - 게이트웨이 WS: `ws://your-vps.tailnet-xxxx.ts.net:18789`

SSH 없이 Control UI를 원할 경우 VPS에서 Tailscale Serve를 사용하십시오.

```bash
openclaw gateway --tailscale serve
```

이렇게 하면 게이트웨이가 루프백에 바인딩된 상태로 유지되고 Tailscale을 통해 HTTPS가 노출됩니다. [꼬리척](/gateway/tailscale)을 참조하세요.

### Mac 노드를 원격 Gateway Tailscale Serve에 연결하는 방법

Serve는 **Gateway Control UI + WS**를 노출합니다. 노드는 동일한 Gateway WS 끝점을 통해 연결됩니다.

권장 설정:

1. **VPS + Mac이 동일한 테일넷에 있는지 확인하세요**.
2. **원격 모드에서 macOS 앱을 사용합니다**(SSH 대상은 tailnet 호스트 이름일 수 있음).
   앱은 게이트웨이 포트를 터널링하고 노드로 연결합니다.
3. 게이트웨이에서 **노드 승인**:

   ```bash
   openclaw nodes pending
   openclaw nodes approve <requestId>
   ```

문서: [게이트웨이 프로토콜](/gateway/protocol), [검색](/gateway/discovery), [macOS 원격 모드](/platforms/mac/remote).

## Env 변수 및 .env 로딩

### OpenClaw는 환경 변수를 어떻게 로드합니까?

OpenClaw는 상위 프로세스(shell, launchd/systemd, CI 등)에서 환경 변수를 읽고 다음을 추가로 로드합니다.

- `.env` 현재 작업 디렉터리에서
- `~/.openclaw/.env`의 전역 대체 `.env`(일명 `$OPENCLAW_STATE_DIR/.env`)

`.env` 파일은 기존 환경 변수를 재정의하지 않습니다.

구성에서 인라인 env 변수를 정의할 수도 있습니다(프로세스 env에서 누락된 경우에만 적용됨).

```json5
{
  env: {
    OPENROUTER_API_KEY: "sk-or-...",
    vars: { GROQ_API_KEY: "gsk-..." },
  },
}
```

전체 우선순위와 소스는 [/environment](/help/environment)를 참조하세요.

### 서비스를 통해 게이트웨이를 시작했는데 환경 변수가 사라졌습니다.

두 가지 일반적인 수정 사항:

1. `~/.openclaw/.env`에 누락된 키를 넣어 서비스가 쉘 환경을 상속하지 않는 경우에도 해당 키를 선택할 수 있습니다.
2. 쉘 가져오기 활성화(선택적 편의):

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

그러면 로그인 셸이 실행되고 누락된 예상 키만 가져옵니다(재정의되지 않음). Env var에 해당:
`OPENCLAW_LOAD_SHELL_ENV=1`, `OPENCLAW_SHELL_ENV_TIMEOUT_MS=15000`.

### COPILOTGITHUBTOKEN을 설정했는데 모델 상태가 Shell env off로 표시되는 이유

`openclaw models status`는 **쉘 환경 가져오기**가 활성화되었는지 여부를 보고합니다. "쉘 환경: 꺼짐"
환경 변수가 누락되었다는 의미는 **아닙니다**. 단지 OpenClaw가 로드되지 않는다는 의미일 뿐입니다.
로그인 쉘이 자동으로.

게이트웨이가 서비스(launchd/systemd)로 실행되는 경우 셸을 상속하지 않습니다.
환경. 다음 중 하나를 수행하여 문제를 해결하세요.

1. 토큰을 `~/.openclaw/.env`에 넣으세요:

   ```
   COPILOT_GITHUB_TOKEN=...
   ```

2. 또는 쉘 가져오기(`env.shellEnv.enabled: true`)를 활성화합니다.
3. 또는 구성 `env` 블록에 추가하세요(누락된 경우에만 적용).

그런 다음 게이트웨이를 다시 시작하고 다시 확인하십시오.

```bash
openclaw models status
```

Copilot 토큰은 `COPILOT_GITHUB_TOKEN` (또한 `GH_TOKEN` / `GITHUB_TOKEN`)에서 읽습니다.
[/concepts/model-providers](/concepts/model-providers) 및 [/environment](/help/environment)를 참조하세요.

## 세션 및 다중 채팅

### 새로운 대화를 시작하려면 어떻게 해야 하나요?

`/new` 또는 `/reset`를 독립형 메시지로 보냅니다. [세션 관리](/concepts/session)를 참조하세요.

### 새 메시지를 보내지 않으면 세션이 자동으로 재설정됩니까?

그렇습니다. 세션은 `session.idleMinutes` 이후 만료됩니다(기본값 **60**). **다음**
메시지는 해당 채팅 키에 대한 새로운 세션 ID를 시작합니다. 이는 삭제되지 않습니다.
성적표 - 새 세션이 시작됩니다.

```json5
{
  session: {
    idleMinutes: 240,
  },
}
```

### OpenClaw 인스턴스 팀을 CEO 한 명과 에이전트 여러 명으로 만들 수 있는 방법이 있나요?

예, **다중 에이전트 라우팅** 및 **하위 에이전트**를 통해 가능합니다. 하나의 코디네이터를 만들 수 있습니다
자체 작업 영역과 모델을 갖춘 에이전트와 여러 작업자 에이전트.

즉, 이것은 **재미있는 실험**으로 가장 잘 보입니다. 토큰이 무겁고 종종
별도의 세션이 있는 하나의 봇을 사용하는 것보다 효율성이 떨어집니다. 대표적인 모델은 우리
envision은 병렬 작업을 위한 다양한 세션이 있는 하나의 봇과 대화합니다. 그
봇은 필요할 때 하위 에이전트를 생성할 수도 있습니다.

문서: [다중 에이전트 라우팅](/concepts/multi-agent), [하위 에이전트](/tools/subagents), [에이전트 CLI](/cli/agents).

### 작업 도중에 컨텍스트가 잘린 이유는 무엇입니까? 어떻게 방지할 수 있나요?

세션 컨텍스트는 모델 창에 의해 제한됩니다. 긴 채팅, 대규모 도구 출력 또는 다수
파일은 압축이나 잘림을 유발할 수 있습니다.

도움이 되는 것:

- 봇에게 현재 상태를 요약하여 파일에 쓰도록 요청하세요.
- 긴 작업 전에는 `/compact`를 사용하고, 주제를 전환할 때는 `/new`를 사용하세요.
- 작업 공간에 중요한 컨텍스트를 유지하고 봇에게 다시 읽어달라고 요청하세요.
- 장기 또는 병렬 작업에는 하위 에이전트를 사용하여 기본 채팅을 더 작게 유지하세요.
- 이런 일이 자주 발생하는 경우 더 큰 컨텍스트 창이 있는 모델을 선택하세요.

### OpenClaw를 완전히 재설정하고 설치된 상태를 유지하는 방법

재설정 명령을 사용하십시오.

```bash
openclaw reset
```

비대화형 전체 재설정:

```bash
openclaw reset --scope full --yes --non-interactive
```

그런 다음 온보딩을 다시 실행하세요.

```bash
openclaw onboard --install-daemon
```

참고:

- 온보딩 마법사는 기존 구성이 확인되면 **재설정**도 제공합니다. [마법사](/start/wizard)를 참조하세요.
- 프로필(`--profile` / `OPENCLAW_PROFILE`)을 사용한 경우 각 상태 디렉토리를 재설정합니다(기본값은 `~/.openclaw-<profile>`).
- 개발 재설정: `openclaw gateway --dev --reset` (개발자 전용, 개발 구성 + 자격 증명 + 세션 + 작업 공간 삭제).

### 컨텍스트가 너무 크다는 오류가 발생합니다. 어떻게 재설정하거나 압축하나요?

다음 중 하나를 사용하십시오.

- **간결함**(대화를 유지하지만 이전 차례를 요약함):

  ```
  /compact
  ```

  또는 `/compact <instructions>`를 사용하여 요약을 안내하세요.

- **재설정**(동일한 채팅 키에 대한 새로운 세션 ID):

  ```
  /new
  /reset
  ```

문제가 계속 발생하는 경우:

- **세션 정리**(`agents.defaults.contextPruning`)를 활성화하거나 조정하여 이전 도구 출력을 정리합니다.
- 더 큰 컨텍스트 창이 있는 모델을 사용하십시오.

문서: [압축](/concepts/compaction), [세션 정리](/concepts/session-pruning), [세션 관리](/concepts/session).

### LLM 요청 거부 메시지가 표시되는 이유는 무엇입니까?NcontentXtooluseinput 필드 필요

이는 공급자 유효성 검사 오류입니다. 모델이 필수 항목 없이 `tool_use` 블록을 내보냈습니다.
`input`. 이는 일반적으로 세션 기록이 오래되었거나 손상되었음을 의미합니다(종종 긴 스레드 이후).
또는 도구/스키마 변경).

수정: `/new`(독립 실행형 메시지)로 새 세션을 시작하세요.

### 하트비트 메시지가 30분마다 수신되는 이유는 무엇인가요?

하트비트는 기본적으로 **30m**마다 실행됩니다. 조정하거나 비활성화합니다.

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

`HEARTBEAT.md`가 존재하지만 사실상 비어 있는 경우(빈 줄과 마크다운만 해당)
`# Heading`와 같은 헤더), OpenClaw는 API 호출을 저장하기 위해 하트비트 실행을 건너뜁니다.
파일이 누락된 경우에도 하트비트는 계속 실행되며 모델이 수행할 작업을 결정합니다.

에이전트별 재정의는 `agents.list[].heartbeat`를 사용합니다. 문서: [하트비트](/gateway/heartbeat).

### WhatsApp 그룹에 봇 계정을 추가해야 하나요?

아니요. OpenClaw는 **귀하의 계정**에서 실행되므로 귀하가 그룹에 속해 있으면 OpenClaw에서 이를 볼 수 있습니다.
기본적으로 그룹 답글은 보낸 사람을 허용할 때까지 차단됩니다(`groupPolicy: "allowlist"`).

**당신**만 그룹 답글을 실행할 수 있도록 하려면 다음 단계를 따르세요.

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

### WhatsApp 그룹의 JID는 어떻게 얻나요?

옵션 1(가장 빠름): 그룹에 로그를 기록하고 테스트 메시지를 보냅니다.

```bash
openclaw logs --follow --json
```

다음과 같이 `@g.us`로 끝나는 `chatId`(또는 `from`)를 찾습니다.
`1234567890-1234567890@g.us`.

옵션 2(이미 구성/허용 목록에 있는 경우): 구성에서 그룹을 나열합니다.

```bash
openclaw directory groups list --channel whatsapp
```

문서: [WhatsApp](/channels/whatsapp), [디렉터리](/cli/directory), [로그](/cli/logs).

### OpenClaw가 그룹에서 응답하지 않는 이유

두 가지 일반적인 원인:

- 멘션 게이팅이 켜져 있습니다(기본값). 봇을 @멘션해야 합니다(또는 `mentionPatterns`와 일치).
- `"*"` 없이 `channels.whatsapp.groups`를 구성했으며 그룹이 허용 목록에 없습니다.

[그룹](/channels/groups) 및 [그룹 메시지](/channels/group-messages)를 참조하세요.

### 그룹 스레드는 DM과 컨텍스트를 공유합니까?

직접 채팅은 기본적으로 기본 세션으로 축소됩니다. 그룹/채널에는 자체 세션 키가 있으며 텔레그램 주제/Discord 스레드는 별도의 세션입니다. [그룹](/channels/groups) 및 [그룹 메시지](/channels/group-messages)를 참조하세요.

### 얼마나 많은 작업공간과 에이전트를 만들 수 있나요?

엄격한 제한은 없습니다. 수십(심지어 수백)도 괜찮지만 다음 사항을 주의하세요.

- **디스크 증가:** 세션 + 기록은 `~/.openclaw/agents/<agentId>/sessions/` 아래에 있습니다.
- **토큰 비용:** 에이전트가 많을수록 동시 모델 사용량이 늘어납니다.
- **운영 오버헤드:** 에이전트별 인증 프로필, 작업 공간 및 채널 라우팅.

팁:

- 에이전트당 하나의 **활성** 작업 공간을 유지합니다(`agents.defaults.workspace`).
- 디스크가 커지면 이전 세션을 정리합니다(JSONL 삭제 또는 항목 저장).
- `openclaw doctor`를 사용하여 잘못된 작업 공간과 프로필 불일치를 찾아보세요.

### 동시에 여러 봇이나 채팅을 실행할 수 있나요? Slack을 어떻게 설정해야 하나요?

그렇습니다. **다중 에이전트 라우팅**을 사용하여 격리된 여러 에이전트를 실행하고 인바운드 메시지를 다음과 같이 라우팅합니다.
채널/계정/피어. Slack은 채널로 지원되며 특정 에이전트에 바인딩될 수 있습니다.

브라우저 액세스는 강력하지만 "인간이 할 수 있는 모든 작업"을 수행할 수는 없습니다. 안티봇, CAPTCHA 및 MFA는 할 수 있습니다.
여전히 자동화를 차단합니다. 가장 안정적인 브라우저 제어를 위해 Chrome 확장 릴레이를 사용하세요.
브라우저를 실행하는 머신에서(그리고 게이트웨이를 어디에든 유지합니다)

모범 사례 설정:

- Always-on 게이트웨이 호스트(VPS/Mac mini).
- 역할(바인딩)당 하나의 에이전트.
- 해당 에이전트에 바인딩된 Slack 채널입니다.
- 필요할 때 확장 릴레이(또는 노드)를 통해 로컬 브라우저.

문서: [다중 에이전트 라우팅](/concepts/multi-agent), [Slack](/channels/slack),
[브라우저](/tools/browser), [Chrome 확장 프로그램](/tools/chrome-extension), [노드](/nodes).

## 모델: 기본값, 선택, 별칭, 전환

### 기본 모델은 무엇인가요?

OpenClaw의 기본 모델은 다음과 같이 설정합니다.

```
agents.defaults.model.primary
```

모델은 `provider/model`(예: `anthropic/claude-opus-4-6`)로 참조됩니다. 공급자를 생략하는 경우 OpenClaw는 현재 `anthropic`를 임시 지원 중단 폴백으로 가정하지만 여전히 **명시적으로** `provider/model`를 설정해야 합니다.

### 어떤 모델을 추천하시나요?

**권장 기본값:** `anthropic/claude-opus-4-6`.
**좋은 대안:** `anthropic/claude-sonnet-4-5`.
**신뢰할 수 있음(캐릭터 적음):** `openai/gpt-5.2` - 거의 Opus만큼 좋지만 개성은 떨어집니다.
**예산:** `zai/glm-4.7`.

MiniMax M2.1에는 자체 문서가 있습니다: [MiniMax](/providers/minimax) 및
[로컬 모델](/gateway/local-models).

경험 법칙: 고위험 작업에는 ** 감당할 수 있는 최고의 모델**을 사용하고 더 저렴한 모델을 사용하십시오.
일상적인 채팅이나 요약을 위한 모델입니다. 에이전트별로 모델을 라우팅하고 하위 에이전트를 사용하여 다음을 수행할 수 있습니다.
긴 작업을 병렬화합니다(각 하위 에이전트는 토큰을 소비합니다). [모델](/concepts/models) 및
[하위 에이전트](/tools/subagents).

강력한 경고: 약하거나 과도하게 양자화된 모델은 프롬프트에 더 취약합니다.
주사와 불안전한 행동. [보안](/gateway/security)을 참조하세요.

추가 컨텍스트: [모델](/concepts/models).

### 자체 호스팅 모델을 사용할 수 있나요 llamacpp vLLM Ollama

그렇습니다. 로컬 서버가 OpenAI 호환 API를 노출하는 경우 다음을 가리킬 수 있습니다.
그것에 맞춤형 공급자. Ollama는 직접 지원되며 가장 쉬운 경로입니다.

보안 참고사항: 더 작거나 양자화된 모델이 프롬프트에 더 취약합니다.
주사. 도구를 사용할 수 있는 모든 봇에는 **대형 모델**을 강력히 권장합니다.
여전히 작은 모델을 원한다면 샌드박싱과 엄격한 도구 허용 목록을 활성화하세요.

문서: [Ollama](/providers/ollama), [로컬 모델](/gateway/local-models),
[모델 제공자](/concepts/model-providers), [보안](/gateway/security),
[샌드박싱](/gateway/sandboxing).

### 구성을 삭제하지 않고 모델을 전환하는 방법

**모델 명령**을 사용하거나 **모델** 필드만 편집하세요. 전체 구성 교체를 피하세요.

안전한 옵션:

- `/model` 채팅 중(빠른, 세션별)
- `openclaw models set ...` (모델 구성만 업데이트)
- `openclaw configure --section model` (대화형)
- `~/.openclaw/openclaw.json`에서 `agents.defaults.model`를 편집합니다.

전체 구성을 교체하려는 의도가 아니라면 부분 개체를 사용하여 `config.apply`를 사용하지 마세요.
구성을 덮어쓴 경우 백업에서 복원하거나 `openclaw doctor`를 다시 실행하여 복구하세요.

문서: [모델](/concepts/models), [구성](/cli/configure), [구성](/cli/config), [의사](/gateway/doctor).

### OpenClaw, Flawd 및 Krill은 모델에 무엇을 사용합니까?

- **OpenClaw + 결함:** 인류학적 작품(`anthropic/claude-opus-4-6`) - [인류학적](/providers/anthropic)을 참조하세요.
- **크릴:** MiniMax M2.1 (`minimax/MiniMax-M2.1`) - [MiniMax](/providers/minimax)를 참조하세요.

### 다시 시작하지 않고 즉시 모델을 전환하는 방법

`/model` 명령을 독립형 메시지로 사용하십시오.

```
/model sonnet
/model haiku
/model opus
/model gpt
/model gpt-mini
/model gemini
/model gemini-flash
```

`/model`, `/model list` 또는 `/model status`를 사용하여 사용 가능한 모델을 나열할 수 있습니다.

`/model` (및 `/model list`)는 번호가 매겨진 컴팩트한 선택기를 보여줍니다. 번호로 선택:

```
/model 3
```

또한 공급자에 대한 특정 인증 프로필을 강제로 적용할 수도 있습니다(세션별로).

```
/model opus@anthropic:default
/model opus@anthropic:work
```

팁: `/model status`는 어떤 에이전트가 활성 상태인지, 어떤 `auth-profiles.json` 파일이 사용되고 있는지, 다음에 어떤 인증 프로필이 시도될지 보여줍니다.
또한 사용 가능한 경우 구성된 공급자 엔드포인트(`baseUrl`) 및 API 모드(`api`)를 표시합니다.

**프로필로 설정한 프로필을 어떻게 고정 해제하나요**

`@profile` 접미사 **없이** `/model`를 다시 실행합니다.

```
/model anthropic/claude-opus-4-6
```

기본값으로 돌아가려면 `/model`에서 선택하세요(또는 `/model <default provider/model>`를 보내세요).
`/model status`를 사용하여 어떤 인증 프로필이 활성화되어 있는지 확인하세요.

### 일상 업무에는 GPT 5.2를, 코딩에는 Codex 5.3을 사용할 수 있나요?

그렇습니다. 하나를 기본값으로 설정하고 필요에 따라 전환합니다.

- **빠른 전환(세션별):** 일일 작업의 경우 `/model gpt-5.2`, 코딩의 경우 `/model gpt-5.3-codex`.
- **기본값 + 스위치:** `agents.defaults.model.primary`를 `openai/gpt-5.2`로 설정한 다음 코딩할 때 `openai-codex/gpt-5.3-codex`로 전환합니다(또는 그 반대).
- **하위 에이전트:** 코딩 작업을 다른 기본 모델을 사용하는 하위 에이전트로 라우팅합니다.

[모델](/concepts/models) 및 [슬래시 명령](/tools/slash-commands)을 참조하세요.

### 모델이 허용되지 않는다는 메시지가 표시되고 응답이 없는 이유는 무엇입니까?

`agents.defaults.models`가 설정되면 `/model`에 대한 **허용 목록**이 되며 모든
세션 재정의. 해당 목록에 없는 모델을 선택하면 다음이 반환됩니다.

```
Model "provider/model" is not allowed. Use /model to list available models.
```

해당 오류는 정상적인 응답 **대신** 반환됩니다. 수정: 모델을 다음에 추가하세요.
`agents.defaults.models`, 허용 목록을 제거하거나 `/model list`에서 모델을 선택하세요.

### 알 수 없는 모델 minimaxMiniMaxM21이 보이는 이유는 무엇인가요?

이는 **공급자가 구성되지 않았습니다**(MiniMax 공급자 구성 또는 인증이 없음)를 의미합니다.
프로필을 찾았으므로 모델을 확인할 수 없습니다. 이 감지에 대한 수정 사항은 다음과 같습니다.
**2026.1.12**(작성 당시에는 출시되지 않음).

수정 체크리스트:

1. **2026.1.12**로 업그레이드(또는 소스 `main`에서 실행)한 후 게이트웨이를 다시 시작합니다.
2. MiniMax가 구성되어 있는지(마법사 또는 JSON) 또는 MiniMax API 키가 있는지 확인하세요.
   공급자를 삽입할 수 있도록 env/auth 프로필에 존재합니다.
3. 정확한 모델 ID를 사용하십시오(대소문자 구분): `minimax/MiniMax-M2.1` 또는
   `minimax/MiniMax-M2.1-lightning`.
4. 실행:

   ```bash
   openclaw models list
   ```

   목록에서 선택하세요(또는 채팅에서 `/model list`).

[MiniMax](/providers/minimax) 및 [모델](/concepts/models)를 참조하세요.

### MiniMax를 기본값으로 사용하고 OpenAI를 복잡한 작업에 사용할 수 있나요?

그렇습니다. **MiniMax를 기본값**으로 사용하고 필요한 경우 **세션당** 모델을 전환하세요.
폴백은 "어려운 작업"이 아닌 **오류**에 대한 것이므로 `/model` 또는 별도의 에이전트를 사용하세요.

**옵션 A: 세션당 전환**

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

그런 다음:

```
/model gpt
```

**옵션 B: 별도의 대리인**

- Agent A 기본값 : MiniMax
- 에이전트 B 기본값: OpenAI
- 에이전트로 라우팅하거나 `/agent`를 사용하여 전환합니다.

문서: [모델](/concepts/models), [다중 에이전트 라우팅](/concepts/multi-agent), [MiniMax](/providers/minimax), [OpenAI](/providers/openai).

### Opus Sonnet gpt에는 단축키가 내장되어 있습니다.

그렇습니다. OpenClaw는 몇 가지 기본 약칭을 제공합니다(모델이 `agents.defaults.models`에 있는 경우에만 적용됨).

- `opus` → `anthropic/claude-opus-4-6`
- `sonnet` → `anthropic/claude-sonnet-4-5`
- `gpt` → `openai/gpt-5.2`
- `gpt-mini` → `openai/gpt-5-mini`
- `gemini` → `google/gemini-3-pro-preview`
- `gemini-flash` → `google/gemini-3-flash-preview`

동일한 이름으로 별칭을 설정하면 값이 우선합니다.

### 재정의 모델 바로가기 별칭을 어떻게 정의합니까?

별칭은 `agents.defaults.models.<modelId>.alias`에서 나옵니다. 예:

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

그런 다음 `/model sonnet`(또는 지원되는 경우 `/<alias>`)는 해당 모델 ID로 확인됩니다.

### OpenRouter 또는 ZAI와 같은 다른 제공업체의 모델을 어떻게 추가하나요?

OpenRouter(토큰당 지불, 다양한 모델):

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

Z.AI(GLM 모델):

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

공급자/모델을 참조했지만 필수 공급자 키가 누락된 경우 런타임 인증 오류가 발생합니다(예: `No API key found for provider "zai"`).

**새 에이전트를 추가한 후 공급자에 대한 API 키를 찾을 수 없습니다**

이는 일반적으로 **새 에이전트**에 빈 인증 저장소가 있음을 의미합니다. 인증은 에이전트별로 이루어지며
저장 위치:

```
~/.openclaw/agents/<agentId>/agent/auth-profiles.json
```

수정 옵션:

- `openclaw agents add <id>`를 실행하고 마법사 중에 인증을 구성합니다.
- 또는 주 에이전트의 `agentDir`에서 `auth-profiles.json`를 신규 에이전트의 `agentDir`에 복사합니다.

에이전트 전체에서 `agentDir`를 재사용하지 **마세요**. 인증/세션 충돌이 발생합니다.

## 모델 장애 조치 및 "모든 모델 실패"

### 장애 조치 작동 방식

장애 조치는 두 단계로 수행됩니다.

1. 동일한 공급자 내에서 **인증 프로필 순환**.
2. `agents.defaults.model.fallbacks`의 다음 모델로 **모델 폴백**.

실패한 프로필(지수 백오프)에는 휴지 시간이 적용되므로 OpenClaw는 공급자가 속도가 제한되거나 일시적으로 실패하는 경우에도 계속 응답할 수 있습니다.

### 이 오류는 무엇을 의미하나요?

```
No credentials found for profile "anthropic:default"
```

이는 시스템이 인증 프로필 ID `anthropic:default`를 사용하려고 시도했지만 예상 인증 저장소에서 이에 대한 자격 증명을 찾을 수 없음을 의미합니다.

### 프로필 anthropicdefault에 대한 자격 증명을 찾을 수 없음에 대한 체크리스트 수정

- **인증 프로필이 어디에 있는지 확인**(신규 경로와 기존 경로)
  - 현재: `~/.openclaw/agents/<agentId>/agent/auth-profiles.json`
  - 레거시: `~/.openclaw/agent/*` (`openclaw doctor`에 의해 마이그레이션됨)
- **환경 변수가 게이트웨이에 의해 로드되었는지 확인**
  - 쉘에 `ANTHROPIC_API_KEY`를 설정했지만 systemd/launchd를 통해 게이트웨이를 실행하는 경우 이를 상속받지 못할 수 있습니다. `~/.openclaw/.env`에 넣거나 `env.shellEnv`를 활성화하세요.
- **올바른 상담원을 편집하고 있는지 확인하세요**
  - 다중 에이전트 설정은 여러 개의 `auth-profiles.json` 파일이 있을 수 있음을 의미합니다.
- **온전성 검사 모델/인증 상태**
  - `openclaw models status`을 사용하여 구성된 모델과 공급자 인증 여부를 확인하세요.

**인류 프로필에 대한 자격 증명을 찾을 수 없음에 대한 체크리스트 수정**

이는 실행이 Anthropic 인증 프로필에 고정되어 있지만 게이트웨이는
해당 인증 스토어에서 찾을 수 없습니다.

- **설정 토큰 사용**
  - `claude setup-token`를 실행한 후 `openclaw models auth setup-token --provider anthropic`로 붙여넣으세요.
  - 토큰이 다른 머신에서 생성된 경우 `openclaw models auth paste-token --provider anthropic`를 사용하세요.
- **API 키를 대신 사용하고 싶은 경우**
  - **게이트웨이 호스트**의 `~/.openclaw/.env`에 `ANTHROPIC_API_KEY`를 입력합니다.
  - 프로필 누락을 유발하는 고정된 주문을 모두 삭제합니다.

    ```bash
    openclaw models auth order clear --provider anthropic
    ```

- **게이트웨이 호스트에서 명령을 실행하고 있는지 확인**
  - 원격 모드에서는 인증 프로필이 노트북이 아닌 게이트웨이 시스템에 있습니다.

### 구글 제미니도 시도했는데 왜 실패했을까?

모델 구성에 대체 항목으로 Google Gemini가 포함되어 있거나 Gemini 약칭으로 전환한 경우 OpenClaw는 모델 대체 중에 이를 시도합니다. Google 자격 증명을 구성하지 않은 경우 `No API key found for provider "google"`가 표시됩니다.

수정: Google 인증을 제공하거나 `agents.defaults.model.fallbacks` / 별칭에서 Google 모델을 제거/피하여 대체가 그곳으로 라우팅되지 않도록 합니다.

**LLM 요청 거부 메시지 생각 서명에 Google 반중력이 필요함**

원인: 세션 기록에는 **서명 없는 사고 블록**이 포함되어 있습니다(종종
중단된/부분 스트림) Google Antigravity에는 사고 블록에 대한 서명이 필요합니다.

수정: OpenClaw는 이제 Google Antigravity Claude의 서명되지 않은 사고 블록을 제거합니다. 계속 나타나면 **새 세션**을 시작하거나 해당 에이전트에 대해 `/thinking off`를 설정하세요.

## 인증 프로필: 정의 및 관리 방법

관련 항목: [/concepts/oauth](/concepts/oauth) (OAuth 흐름, 토큰 저장, 다중 계정 패턴)

### 인증 프로필이란 무엇입니까?

인증 프로필은 공급자에 연결된 명명된 자격 증명 레코드(OAuth 또는 API 키)입니다. 프로필 거주 지역:

```
~/.openclaw/agents/<agentId>/agent/auth-profiles.json
```

### 일반적인 프로필 ID는 무엇인가요?

OpenClaw는 다음과 같이 공급자 접두사가 붙은 ID를 사용합니다.

- `anthropic:default` (이메일 ID가 없는 경우 일반적)
- OAuth ID의 경우 `anthropic:<email>`
- 귀하가 선택하는 사용자 정의 ID(예: `anthropic:work`)

### 어떤 인증 프로필을 먼저 시도할지 제어할 수 있나요?

그렇습니다. Config는 프로필에 대한 선택적 메타데이터와 공급자별 순서를 지원합니다(`auth.order.<provider>`). 이것은 비밀을 저장하지 **않습니다**. ID를 공급자/모드에 매핑하고 회전 순서를 설정합니다.

OpenClaw는 짧은 **대기시간**(비율 제한/시간 초과/인증 실패) 또는 더 긴 **비활성화** 상태(청구/크레딧 부족)에 있는 경우 프로필을 일시적으로 건너뛸 수 있습니다. 이를 검사하려면 `openclaw models status --json`를 실행하고 `auth.unusableProfiles`를 확인하세요. 조정: `auth.cooldowns.billingBackoffHours*`.

CLI를 통해 **에이전트별** 순서 재정의(해당 에이전트의 `auth-profiles.json`에 저장됨)를 설정할 수도 있습니다.

```bash
# Defaults to the configured default agent (omit --agent)
openclaw models auth order get --provider anthropic

# Lock rotation to a single profile (only try this one)
openclaw models auth order set --provider anthropic anthropic:default

# Or set an explicit order (fallback within provider)
openclaw models auth order set --provider anthropic anthropic:work anthropic:default

# Clear override (fall back to config auth.order / round-robin)
openclaw models auth order clear --provider anthropic
```

특정 상담원을 타겟팅하려면 다음 안내를 따르세요.

```bash
openclaw models auth order set --provider anthropic --agent main anthropic:default
```

### OAuth와 API 키의 차이점은 무엇인가요?

OpenClaw는 다음을 모두 지원합니다.

- **OAuth**는 구독 액세스(해당하는 경우)를 활용하는 경우가 많습니다.
- **API 키**는 토큰당 지불 방식을 사용합니다.

마법사는 Anthropic 설정 토큰 및 OpenAI Codex OAuth를 명시적으로 지원하며 API 키를 저장할 수 있습니다.

## 게이트웨이: 포트, "이미 실행 중" 및 원격 모드

### 게이트웨이는 어떤 포트를 사용합니까?

`gateway.port`는 WebSocket + HTTP(제어 UI, 후크 등)에 대한 단일 다중화 포트를 제어합니다.

우선순위:

```
--port > OPENCLAW_GATEWAY_PORT > gateway.port > default 18789
```

### Openclaw 게이트웨이 상태에 런타임이 실행 중이라고 표시되지만 RPC 프로브가 실패했다고 표시되는 이유는 무엇입니까?

"실행 중"은 **감독자** 보기(launchd/systemd/schtasks)이기 때문입니다. RPC 프로브는 실제로 게이트웨이 WebSocket에 연결하고 `status`를 호출하는 CLI입니다.

`openclaw gateway status`를 사용하고 다음 줄을 신뢰하십시오.

- `Probe target:` (프로브가 실제로 사용한 URL)
- `Listening:` (실제로 포트에 바인딩된 것)
- `Last gateway error:` (프로세스가 살아있지만 포트가 수신하지 않는 경우의 일반적인 근본 원인)

### openclaw 게이트웨이 상태가 Config cli와 Config 서비스를 다르게 표시하는 이유는 무엇입니까?

서비스가 다른 구성 파일을 실행하는 동안 하나의 구성 파일을 편집하고 있습니다(종종 `--profile` / `OPENCLAW_STATE_DIR` 불일치).

수정:

```bash
openclaw gateway install --force
```

서비스에서 사용하려는 동일한 `--profile` / 환경에서 실행하세요.

### 다른 게이트웨이 인스턴스가 이미 수신 중이라는 것은 무엇을 의미합니까?

OpenClaw는 시작 시 즉시 WebSocket 수신기를 바인딩하여 런타임 잠금을 시행합니다(기본값 `ws://127.0.0.1:18789`). `EADDRINUSE`로 바인딩이 실패하면 다른 인스턴스가 이미 수신 중임을 나타내는 `GatewayLockError`가 발생합니다.

수정: 다른 인스턴스를 중지하거나, 포트를 해제하거나, `openclaw gateway --port <port>`로 실행하세요.

### 원격 모드에서 OpenClaw를 실행하려면 어떻게 해야 하나요? 클라이언트가 다른 곳의 게이트웨이에 연결됩니다.

`gateway.mode: "remote"`를 설정하고 선택적으로 토큰/비밀번호를 사용하여 원격 WebSocket URL을 가리킵니다.

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

참고:

- `openclaw gateway`는 `gateway.mode`가 `local`일 때만 시작됩니다(또는 재정의 플래그를 전달한 경우).
- macOS 앱은 구성 파일을 감시하고 이러한 값이 변경되면 실시간으로 모드를 전환합니다.

### 제어 UI에 승인되지 않은 메시지가 표시되거나 계속 다시 연결됩니다.

게이트웨이가 인증이 활성화된 상태로 실행 중이지만(`gateway.auth.*`) UI가 일치하는 토큰/비밀번호를 보내지 않습니다.

사실(코드에서):

- Control UI는 브라우저 localStorage 키 `openclaw.control.settings.v1`에 토큰을 저장합니다.

고치다:

- 가장 빠른 속도: `openclaw dashboard` (대시보드 URL을 인쇄 + 복사하고 열기를 시도합니다. 헤드리스인 경우 SSH 힌트를 표시합니다.)
- 아직 토큰이 없다면: `openclaw doctor --generate-gateway-token`.
- 원격인 경우 먼저 터널링: `ssh -N -L 18789:127.0.0.1:18789 user@host` 그런 다음 `http://127.0.0.1:18789/`를 엽니다.
- 게이트웨이 호스트에 `gateway.auth.token`(또는 `OPENCLAW_GATEWAY_TOKEN`)를 설정합니다.
- Control UI 설정에서 동일한 토큰을 붙여넣습니다.
- 아직도 막혔나요? `openclaw status --all`를 실행하고 [문제 해결](/gateway/troubleshooting)을 따르세요. 인증에 대한 자세한 내용은 [대시보드](/web/dashboard)를 참조하세요.

### Gatewaybind tailnet을 설정했지만 아무것도 바인딩할 수 없습니다.

`tailnet` 바인드는 네트워크 인터페이스(100.64.0.0/10)에서 Tailscale IP를 선택합니다. 머신이 Tailscale에 있지 않거나 인터페이스가 다운된 경우 바인딩할 것이 없습니다.

수정:

- 해당 호스트에서 Tailscale을 시작합니다(따라서 주소는 100.x입니다). 또는
- `gateway.bind: "loopback"` / `"lan"`로 전환합니다.

참고: `tailnet`는 명시적입니다. `auto`는 루프백을 선호합니다. tailnet 전용 바인딩을 원할 경우 `gateway.bind: "tailnet"`를 사용하십시오.

### 동일한 호스트에서 여러 게이트웨이를 실행할 수 있나요?

일반적으로 없음 - 하나의 게이트웨이가 여러 메시징 채널과 에이전트를 실행할 수 있습니다. 중복성(예: 구조 봇) 또는 엄격한 격리가 필요한 경우에만 여러 게이트웨이를 사용하십시오.

예, 하지만 다음을 격리해야 합니다.

- `OPENCLAW_CONFIG_PATH` (인스턴스별 구성)
- `OPENCLAW_STATE_DIR` (인스턴스별 상태)
- `agents.defaults.workspace` (작업 공간 격리)
- `gateway.port` (고유 포트)

빠른 설정(권장):

- 인스턴스당 `openclaw --profile <name> …`를 사용합니다(`~/.openclaw-<name>`가 자동 생성됩니다).
- 각 프로필 구성에서 고유한 `gateway.port`를 설정합니다(또는 수동 실행의 경우 `--port`를 전달합니다).
- 프로필별 서비스를 설치합니다: `openclaw --profile <name> gateway install`.

프로필에는 서비스 이름(`bot.molt.<profile>`; 레거시 `com.openclaw.*`, `openclaw-gateway-<profile>.service`, `OpenClaw Gateway (<profile>)`) 접미사도 붙습니다.
전체 가이드: [다중 게이트웨이](/gateway/multiple-gateways).

### 잘못된 핸드셰이크 코드 1008은 무엇을 의미하나요?

게이트웨이는 **WebSocket 서버**이며 첫 번째 메시지가
`connect` 프레임이어야 합니다. 다른 것을 받으면 연결을 닫습니다.
**코드 1008**(정책 위반).

일반적인 원인:

- WS 클라이언트 대신 브라우저(`http://...`)에서 **HTTP** URL을 열었습니다.
- 잘못된 포트나 경로를 사용했습니다.
- 프록시 또는 터널이 인증 헤더를 제거했거나 게이트웨이가 아닌 요청을 보냈습니다.

빠른 수정:

1. WS URL: `ws://<host>:18789`(또는 HTTPS의 경우 `wss://...`)을 사용합니다.
2. 일반 브라우저 탭에서 WS 포트를 열지 마십시오.
3. 인증이 켜져 있으면 `connect` 프레임에 토큰/비밀번호를 포함시킵니다.

CLI 또는 TUI를 사용하는 경우 URL은 다음과 같습니다.

```
openclaw tui --url ws://<host>:18789 --token <token>
```

프로토콜 세부정보: [게이트웨이 프로토콜](/gateway/protocol).

## 로깅 및 디버깅

### 로그는 어디에 있나요?

파일 로그(구조적):

```
/tmp/openclaw/openclaw-YYYY-MM-DD.log
```

`logging.file`를 통해 안정적인 경로를 설정할 수 있습니다. 파일 로그 수준은 `logging.level`에 의해 제어됩니다. 콘솔의 자세한 정보는 `--verbose` 및 `logging.consoleLevel`에 의해 제어됩니다.

가장 빠른 로그 테일:

```bash
openclaw logs --follow
```

서비스/감독자 로그(게이트웨이가 launchd/systemd를 통해 실행되는 경우):

- macOS: `$OPENCLAW_STATE_DIR/logs/gateway.log` 및 `gateway.err.log` (기본값: `~/.openclaw/logs/...`, 프로필은 `~/.openclaw-<profile>/logs/...` 사용)
- 리눅스: `journalctl --user -u openclaw-gateway[-<profile>].service -n 200 --no-pager`
- 윈도우: `schtasks /Query /TN "OpenClaw Gateway (<profile>)" /V /FO LIST`

자세한 내용은 [문제 해결](/gateway/troubleshooting#log-locations)을 참조하세요.

### 게이트웨이 서비스를 시작하고 다시 시작하려면 어떻게 해야 하나요?

게이트웨이 도우미를 사용합니다.

```bash
openclaw gateway status
openclaw gateway restart
```

게이트웨이를 수동으로 실행하면 `openclaw gateway --force`에서 포트를 회수할 수 있습니다. [게이트웨이](/gateway)를 참조하세요.

### Windows에서 터미널을 닫았습니다. OpenClaw를 다시 시작하려면 어떻게 해야 하나요?

**두 가지 Windows 설치 모드**가 있습니다.

**1) WSL2(권장):** 게이트웨이는 Linux 내부에서 실행됩니다.

PowerShell을 열고 WSL을 입력한 후 다시 시작합니다.

```powershell
wsl
openclaw gateway status
openclaw gateway restart
```

서비스를 설치한 적이 없다면 포그라운드에서 시작하세요.

```bash
openclaw gateway run
```

**2) 기본 Windows(권장하지 않음):** 게이트웨이는 Windows에서 직접 실행됩니다.

PowerShell을 열고 다음을 실행합니다.

```powershell
openclaw gateway status
openclaw gateway restart
```

수동으로 실행하는 경우(서비스 없음) 다음을 사용합니다.

```powershell
openclaw gateway run
```

문서: [Windows(WSL2)](/platforms/windows), [게이트웨이 서비스 런북](/gateway).

### 게이트웨이가 작동 중이지만 응답이 도착하지 않습니다. 무엇을 확인해야 합니까?

빠른 건강 관리로 시작하세요.

```bash
openclaw status
openclaw models status
openclaw channels status
openclaw logs --follow
```

일반적인 원인:

- **게이트웨이 호스트**에 모델 인증이 로드되지 않았습니다(`models status` 확인).
- 채널 페어링/허용 목록 차단 응답(채널 구성 + 로그 확인)
- WebChat/Dashboard가 올바른 토큰 없이 열려 있습니다.

원격인 경우 터널/Tailscale 연결이 작동 중이고
게이트웨이 WebSocket에 연결할 수 있습니다.

문서: [채널](/channels), [문제 해결](/gateway/troubleshooting), [원격 액세스](/gateway/remote).

### 게이트웨이 연결이 끊어졌습니다. 이유가 없습니다.

이는 일반적으로 UI에서 WebSocket 연결이 끊어졌음을 의미합니다. 확인:

1. 게이트웨이가 실행 중입니까? `openclaw gateway status`
2. 게이트웨이가 정상인가요? `openclaw status`
3. UI에 올바른 토큰이 있습니까? `openclaw dashboard`
4. 원격인 경우 터널/Tailscale 링크가 연결되어 있습니까?

그런 다음 테일 로그를 기록합니다.

```bash
openclaw logs --follow
```

문서: [대시보드](/web/dashboard), [원격 액세스](/gateway/remote), [문제 해결](/gateway/troubleshooting).

### Telegram setMyCommands가 네트워크 오류로 인해 실패합니다. 무엇을 확인해야 합니까?

로그 및 채널 상태로 시작합니다.

```bash
openclaw channels status
openclaw channels logs --channel telegram
```

VPS 또는 프록시 뒤에 있는 경우 아웃바운드 HTTPS가 허용되고 DNS가 작동하는지 확인하세요.
게이트웨이가 원격인 경우 게이트웨이 호스트의 로그를 보고 있는지 확인하십시오.

문서: [텔레그램](/channels/telegram), [채널 문제 해결](/channels/troubleshooting).

### TUI에 출력이 표시되지 않습니다. 무엇을 확인해야 하나요?

먼저 게이트웨이에 연결할 수 있고 에이전트가 실행될 수 있는지 확인하세요.

```bash
openclaw status
openclaw models status
openclaw logs --follow
```

TUI에서 `/status`를 사용하여 현재 상태를 확인하세요. 채팅에서 답변을 기대하는 경우
채널에서 전송이 활성화되어 있는지 확인하세요(`/deliver on`).

문서: [TUI](/web/tui), [슬래시 명령](/tools/slash-commands).

### 게이트웨이를 완전히 중지한 후 시작하는 방법

서비스를 설치한 경우:

```bash
openclaw gateway stop
openclaw gateway start
```

그러면 **감시 서비스**(macOS에서 실행, Linux에서 systemd)가 중지/시작됩니다.
게이트웨이가 백그라운드에서 데몬으로 실행될 때 이를 사용합니다.

포그라운드에서 실행 중인 경우 Ctrl-C를 눌러 중지한 후 다음을 수행하세요.

```bash
openclaw gateway run
```

문서: [게이트웨이 서비스 런북](/gateway).

### ELI5 openclaw 게이트웨이 다시 시작 및 openclaw 게이트웨이 비교

- `openclaw gateway restart`: **백그라운드 서비스**(launchd/systemd)를 다시 시작합니다.
- `openclaw gateway`: 이 터미널 세션에 대해 **포그라운드**에서 게이트웨이를 실행합니다.

서비스를 설치한 경우 게이트웨이 명령을 사용하십시오. 다음과 같은 경우에는 `openclaw gateway`를 사용하세요.
일회성 포그라운드 실행을 원합니다.

### 문제가 발생했을 때 자세한 내용을 가장 빠르게 확인할 수 있는 방법은 무엇인가요?

자세한 콘솔 정보를 얻으려면 `--verbose`로 게이트웨이를 시작하십시오. 그런 다음 로그 파일에서 채널 인증, 모델 라우팅 및 RPC 오류를 검사합니다.

## 미디어 및 첨부 파일

### 내 스킬이 imagePDF를 생성했지만 아무것도 전송되지 않았습니다.

에이전트의 아웃바운드 첨부 파일에는 `MEDIA:<path-or-url>` 줄(자체 줄)이 포함되어야 합니다. [OpenClaw 도우미 설정](/start/openclaw) 및 [에이전트 보내기](/tools/agent-send)를 참조하세요.

CLI 전송:

```bash
openclaw message send --target +15555550123 --message "Here you go" --media /path/to/file.png
```

또한 확인하십시오:

- 대상 채널은 아웃바운드 미디어를 지원하며 허용 목록에 의해 차단되지 않습니다.
- 파일이 제공업체의 크기 제한 내에 있습니다. (이미지 크기는 최대 2048px로 조정됩니다.)

[이미지](/nodes/images)를 참조하세요.

## 보안 및 액세스 제어

### OpenClaw를 인바운드 DM에 노출해도 안전한가요?

인바운드 DM을 신뢰할 수 없는 입력으로 처리합니다. 기본값은 위험을 줄이기 위해 설계되었습니다.

- DM 가능 채널의 기본 동작은 **페어링**입니다.
  - 알 수 없는 발신자가 페어링 코드를 수신합니다. 봇은 메시지를 처리하지 않습니다.
  - 승인: `openclaw pairing approve <channel> <code>`
  - 보류 중인 요청은 **채널당 3개**로 제한됩니다. 코드가 도착하지 않은 경우 `openclaw pairing list <channel>`를 확인하세요.
- DM을 공개적으로 열려면 명시적인 선택(`dmPolicy: "open"` 및 허용 목록 `"*"`)이 필요합니다.

위험한 DM 정책을 표시하려면 `openclaw doctor`를 실행하세요.

### 프롬프트 주입은 공개 봇에서만 문제가 됩니까?

아니요. 프롬프트 삽입은 봇에게 DM을 보낼 수 있는 사람뿐만 아니라 **신뢰할 수 없는 콘텐츠**에 관한 것입니다.
어시스턴트가 외부 콘텐츠(웹 검색/가져오기, 브라우저 페이지, 이메일,
문서, 첨부 파일, 붙여넣은 로그), 해당 콘텐츠에는 다음을 시도하는 지침이 포함될 수 있습니다.
모델을 납치하려고요. **당신이 유일한 발신자**인 경우에도 이런 일이 발생할 수 있습니다.

가장 큰 위험은 도구를 사용할 때입니다. 모델이 속아서 다른 사람에게 속일 수 있습니다.
귀하를 대신하여 컨텍스트를 추출하거나 도구를 호출합니다. 다음을 통해 폭발 반경을 줄입니다.

- 신뢰할 수 없는 콘텐츠를 요약하기 위해 읽기 전용 또는 도구가 비활성화된 "리더" 에이전트를 사용합니다.
- 도구 지원 에이전트에 대해 `web_search` / `web_fetch` / `browser`를 꺼진 상태로 유지
- 샌드박스 및 엄격한 도구 허용 목록

세부정보: [보안](/gateway/security).

### 내 봇에 자체 이메일 GitHub 계정이나 전화번호가 있어야 합니까?

예, 대부분의 설정에 적용됩니다. 별도의 계정과 전화번호로 봇 격리
문제가 발생하면 폭발 반경이 줄어듭니다. 이렇게 하면 회전도 더 쉬워집니다
개인 계정에 영향을 주지 않고 자격 증명을 삭제하거나 액세스를 취소할 수 있습니다.

작게 시작하십시오. 실제로 필요한 도구와 계정에만 액세스 권한을 부여하고 확장하세요.
나중에 필요한 경우.

문서: [보안](/gateway/security), [페어링](/channels/pairing).

### 문자 메시지에 자율성을 부여할 수 있나요? 그러면 안전할까요?

우리는 귀하의 개인 메시지에 대한 완전한 자율성을 권장하지 **않습니다**. 가장 안전한 패턴은 다음과 같습니다.

- DM을 **페어링 모드** 또는 엄격한 허용 목록으로 유지하세요.
- 대신 메시지를 보내려면 **별도의 번호나 계정**을 사용하세요.
- 초안을 작성하고 **보내기 전에 승인**하세요.

실험하고 싶다면 전용 계정에서 수행하고 격리된 상태로 유지하세요. 참조
[보안](/gateway/security).

### 개인 비서 작업에 더 저렴한 모델을 사용할 수 있나요?

예, **상담원이 채팅 전용이고 입력 내용을 신뢰할 수 있는 경우**입니다. 더 작은 계층은
명령어 하이재킹에 더 취약하므로 도구 지원 에이전트에서는 이를 피하세요.
또는 신뢰할 수 없는 콘텐츠를 읽을 때. 더 작은 모델을 사용해야 한다면 잠그세요.
도구를 사용하고 샌드박스 내에서 실행합니다. [보안](/gateway/security)을 참조하세요.

### 텔레그램에서 start를 실행했는데 페어링 코드를 받지 못했습니다.

페어링 코드는 알 수 없는 발신자가 봇에게 메시지를 보낼 때만 **전송됩니다**.
`dmPolicy: "pairing"`이 활성화되었습니다. `/start` 자체로는 코드를 생성하지 않습니다.

보류 중인 요청을 확인하세요.

```bash
openclaw pairing list telegram
```

즉시 액세스하려면 발신자 ID를 허용 목록에 추가하거나 `dmPolicy: "open"`를 설정하세요.
그 계정을 위해.

### WhatsApp으로 내 연락처에 메시지를 보낼 수 있나요? 페어링 작동 방식

아니요. 기본 WhatsApp DM 정책은 **페어링**입니다. 알 수 없는 발신자는 페어링 코드만 받게 되며 해당 메시지는 **처리되지 않습니다**. OpenClaw는 수신한 채팅이나 사용자가 트리거한 명시적인 전송에만 응답합니다.

다음과의 페어링을 승인합니다.

```bash
openclaw pairing approve whatsapp <code>
```

보류 중인 요청을 나열합니다.

```bash
openclaw pairing list whatsapp
```

마법사 전화번호 프롬프트: 귀하의 **허용 목록/소유자**를 설정하여 귀하의 DM이 허용되도록 하는 데 사용됩니다. 자동전송에는 사용되지 않습니다. 개인 WhatsApp 번호로 실행하는 경우 해당 번호를 사용하고 `channels.whatsapp.selfChatMode`를 활성화하세요.

## 채팅 명령, 작업 중단 및 "멈추지 않습니다"

### 내부 시스템 메시지가 채팅에 표시되지 않게 하려면 어떻게 해야 하나요?

대부분의 내부 또는 도구 메시지는 **상세** 또는 **추론**이 활성화된 경우에만 나타납니다.
해당 세션에 대해.

채팅에서 표시되는 부분을 수정하세요.

```
/verbose off
/reasoning off
```

여전히 시끄러운 경우 Control UI에서 세션 설정을 확인하고 자세한 정보를 설정하세요.
**상속**합니다. 또한 `verboseDefault`가 설정된 봇 프로필을 사용하고 있지 않은지 확인하세요.
구성에서 `on`로 설정하세요.

문서: [사고 및 장황함](/tools/thinking), [보안](/gateway/security#reasoning--verbose-output-in-groups).

### 실행 중인 작업 취소를 중지하려면 어떻게 해야 하나요?

다음 중 하나를 **독립형 메시지**로 보내세요(슬래시 없음).

```
stop
abort
esc
wait
exit
interrupt
```

이는 중단 트리거입니다(슬래시 명령 아님).

백그라운드 프로세스의 경우(exec 도구에서) 에이전트에 다음을 실행하도록 요청할 수 있습니다.

```
process action:kill sessionId:XXX
```

슬래시 명령 개요: [슬래시 명령](/tools/slash-commands)을 참조하세요.

대부분의 명령은 `/`로 시작하는 **독립형** 메시지로 전송되어야 하지만 몇 가지 단축키(예: `/status`)도 허용 목록에 있는 발신자에 대해 인라인으로 작동합니다.

### 텔레그램에서 Discord 메시지를 보내는 방법 Crosscontext 메시지 거부됨

OpenClaw는 기본적으로 **공급자 간** 메시징을 차단합니다. 도구 호출이 바인딩된 경우
Telegram으로 전송하는 경우 명시적으로 허용하지 않는 한 Discord로 전송되지 않습니다.

에이전트에 대해 공급자 간 메시징을 활성화합니다.

```json5
{
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

구성을 편집한 후 게이트웨이를 다시 시작하세요. 이거 하나만 원하신다면
대신 `agents.list[].tools.message` 아래에 설정하세요.

### 봇이 속사포 메시지를 무시하는 것처럼 느껴지는 이유는 무엇입니까?

대기열 모드는 새 메시지가 진행 중인 실행과 상호 작용하는 방식을 제어합니다. 모드를 변경하려면 `/queue`를 사용하세요.

- `steer` - 새 메시지가 현재 작업을 리디렉션합니다.
- `followup` - 한 번에 하나씩 메시지를 실행합니다.
- `collect` - 일괄 메시지 및 회신을 한 번(기본값)
- `steer-backlog` - 지금 조종하고 백로그를 처리하세요.
- `interrupt` - 현재 실행을 중단하고 새로 시작합니다.

후속 모드에 `debounce:2s cap:25 drop:summarize`와 같은 옵션을 추가할 수 있습니다.

## 스크린샷/채팅 로그의 정확한 질문에 답변하세요.

**Q: "API 키가 있는 Anthropic의 기본 모델은 무엇입니까?"**

**A:** OpenClaw에서는 자격 증명과 모델 선택이 별개입니다. `ANTHROPIC_API_KEY` 설정(또는 인증 프로필에 Anthropic API 키 저장)을 설정하면 인증이 가능하지만 실제 기본 모델은 `agents.defaults.model.primary`에서 구성한 대로입니다(예: `anthropic/claude-sonnet-4-5` 또는 `anthropic/claude-opus-4-6`). `No credentials found for profile "anthropic:default"`가 표시되면 게이트웨이가 실행 중인 에이전트에 대해 예상되는 `auth-profiles.json`에서 Anthropic 자격 증명을 찾을 수 없다는 의미입니다.

---

아직도 붙어있나요? [Discord](https://discord.com/invite/clawd)에 질문하거나 [GitHub 토론](https://github.com/openclaw/openclaw/discussions)을 열어보세요.
