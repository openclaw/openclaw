---
summary: "Mga madalas itanong tungkol sa setup, configuration, at paggamit ng OpenClaw"
title: "FAQ"
---

# FAQ

Mga mabilisang sagot kasama ang mas malalim na troubleshooting para sa mga real-world na setup (local dev, VPS, multi-agent, OAuth/API keys, model failover). Para sa runtime diagnostics, tingnan ang [Troubleshooting](/gateway/troubleshooting). Para sa kumpletong sanggunian ng config, tingnan ang [Configuration](/gateway/configuration).

## Table of contents

- [Mabilis na pagsisimula at unang setup]
  - [Nastuck ako—ano ang pinakamabilis na paraan para maka-alis?](#im-stuck-whats-the-fastest-way-to-get-unstuck)
  - [Ano ang inirerekomendang paraan para i-install at i-set up ang OpenClaw?](#whats-the-recommended-way-to-install-and-set-up-openclaw)
  - [Paano ko bubuksan ang dashboard pagkatapos ng onboarding?](#how-do-i-open-the-dashboard-after-onboarding)
  - [Paano ko ia-authenticate ang dashboard (token) sa localhost vs remote?](#how-do-i-authenticate-the-dashboard-token-on-localhost-vs-remote)
  - [Anong runtime ang kailangan ko?](#what-runtime-do-i-need)
  - [Tumatakbo ba ito sa Raspberry Pi?](#does-it-run-on-raspberry-pi)
  - [May mga tip ba para sa Raspberry Pi installs?](#any-tips-for-raspberry-pi-installs)
  - Naka-stuck ito sa "wake up my friend" / hindi magha-hatch ang onboarding.
    Ano ngayon? Hindi ko ma-access ang docs.openclaw.ai (SSL error).
    Ano ngayon?
  - [Maaari ko bang ilipat ang setup ko sa bagong machine (Mac mini) nang hindi inuulit ang onboarding?](#can-i-migrate-my-setup-to-a-new-machine-mac-mini-without-redoing-onboarding)
  - [Saan ko makikita kung ano ang bago sa pinakabagong bersyon?](#where-do-i-see-what-is-new-in-the-latest-version)
  - [Hindi ko ma-access ang docs.openclaw.ai (SSL error). Nagyeyelo ang bot habang gumagawa ng mabibigat na gawain.
    Paano ko ito ia-offload?
  - [Ano ang pagkakaiba ng stable at beta?](#whats-the-difference-between-stable-and-beta)
  - [Paano ko i-install ang beta version, at ano ang pagkakaiba ng beta at dev?](#how-do-i-install-the-beta-version-and-whats-the-difference-between-beta-and-dev)
  - [Paano ko susubukan ang pinakabagong bits?](#how-do-i-try-the-latest-bits)
  - [Gaano katagal karaniwang tumatagal ang install at onboarding?](#how-long-does-install-and-onboarding-usually-take)
  - Hindi tumatakbo ang cron o mga paalala.
    Paano ko ito mapapatagal? Palaging nakakalimot ang memory.
    Paano ko ito mapapanatili?
  - [Sinasabi ng Windows install na git not found o hindi nakikilala ang openclaw](#windows-install-says-git-not-found-or-openclaw-not-recognized)
  - [Hindi sinagot ng docs ang tanong ko—paano ako makakakuha ng mas magandang sagot?](#the-docs-didnt-answer-my-question-how-do-i-get-a-better-answer)
  - [Paano ko i-install ang OpenClaw sa Linux?](#how-do-i-install-openclaw-on-linux)
  - [Paano ko i-install ang OpenClaw sa isang VPS?](#how-do-i-install-openclaw-on-a-vps)
  - [Saan ang mga cloud/VPS install guides?](#where-are-the-cloudvps-install-guides)
  - [Maaari ko bang utusan ang OpenClaw na i-update ang sarili nito?](#can-i-ask-openclaw-to-update-itself)
  - [Ano ba talaga ang ginagawa ng onboarding wizard?](#what-does-the-onboarding-wizard-actually-do)
  - [Kailangan ko ba ng Claude o OpenAI subscription para patakbuhin ito?](#do-i-need-a-claude-or-openai-subscription-to-run-this)
  - [Maaari ko bang gamitin ang Claude Max subscription nang walang API key](#can-i-use-claude-max-subscription-without-an-api-key)
  - [Paano gumagana ang Anthropic "setup-token" auth?](#how-does-anthropic-setuptoken-auth-work)
  - [Saan ko mahahanap ang Anthropic setup-token?](#where-do-i-find-an-anthropic-setuptoken)
  - [Sinusuportahan ba ninyo ang Claude subscription auth (Claude Pro o Max)?](#do-you-support-claude-subscription-auth-claude-pro-or-max)
  - [Bakit nakikita ko ang `HTTP 429: rate_limit_error` mula sa Anthropic?](#why-am-i-seeing-http-429-ratelimiterror-from-anthropic)
  - [Sinusuportahan ba ang AWS Bedrock?](#is-aws-bedrock-supported)
  - [Paano gumagana ang Codex auth?](#how-does-codex-auth-work)
  - [Sinusuportahan ba ninyo ang OpenAI subscription auth (Codex OAuth)?](#do-you-support-openai-subscription-auth-codex-oauth)
  - [Paano ko ise-set up ang Gemini CLI OAuth](#how-do-i-set-up-gemini-cli-oauth)
  - [OK ba ang local model para sa kaswal na chats?](#is-a-local-model-ok-for-casual-chats)
  - [Paano ko mapapanatili ang hosted model traffic sa isang partikular na rehiyon?](#how-do-i-keep-hosted-model-traffic-in-a-specific-region)
  - [Kailangan ko bang bumili ng Mac Mini para i-install ito?](#do-i-have-to-buy-a-mac-mini-to-install-this)
  - [Kailangan ko ba ng Mac mini para sa iMessage support?](#do-i-need-a-mac-mini-for-imessage-support)
  - [Kung bibili ako ng Mac mini para patakbuhin ang OpenClaw, maaari ko ba itong ikonekta sa MacBook Pro ko?](#if-i-buy-a-mac-mini-to-run-openclaw-can-i-connect-it-to-my-macbook-pro)
  - [Maaari ba akong gumamit ng Bun?](#can-i-use-bun)
  - [Telegram: ano ang ilalagay sa `allowFrom`?](#telegram-what-goes-in-allowfrom)
  - [Maaari bang gumamit ang maraming tao ng iisang WhatsApp number na may iba’t ibang OpenClaw instances?](#can-multiple-people-use-one-whatsapp-number-with-different-openclaw-instances)
  - [Maaari ba akong magpatakbo ng "fast chat" agent at "Opus for coding" agent?](#can-i-run-a-fast-chat-agent-and-an-opus-for-coding-agent)
  - [Gumagana ba ang Homebrew sa Linux?](#does-homebrew-work-on-linux)
  - [Ano ang pagkakaiba ng hackable (git) install at npm install?](#whats-the-difference-between-the-hackable-git-install-and-npm-install)
  - [Maaari ba akong lumipat sa pagitan ng npm at git installs sa bandang huli?](#can-i-switch-between-npm-and-git-installs-later)
  - [Dapat ko bang patakbuhin ang Gateway sa laptop ko o sa isang VPS?](#should-i-run-the-gateway-on-my-laptop-or-a-vps)
  - [Gaano kahalaga ang pagpapatakbo ng OpenClaw sa isang dedicated machine?](#how-important-is-it-to-run-openclaw-on-a-dedicated-machine)
  - [Ano ang minimum na VPS requirements at inirerekomendang OS?](#what-are-the-minimum-vps-requirements-and-recommended-os)
  - [Maaari ba akong magpatakbo ng OpenClaw sa isang VM at ano ang mga requirements](#can-i-run-openclaw-in-a-vm-and-what-are-the-requirements)
- [Ano ang OpenClaw?](#what-is-openclaw)
  - [Ano ang OpenClaw, sa isang talata?](#what-is-openclaw-in-one-paragraph)
  - [Ano ang value proposition?](#whats-the-value-proposition)
  - [Kaka-set up ko lang—ano ang dapat kong gawin muna](#i-just-set-it-up-what-should-i-do-first)
  - [Ano ang top five na pang-araw-araw na use cases para sa OpenClaw](#what-are-the-top-five-everyday-use-cases-for-openclaw)
  - [Makakatulong ba ang OpenClaw sa lead gen outreach ads at blogs para sa isang SaaS](#can-openclaw-help-with-lead-gen-outreach-ads-and-blogs-for-a-saas)
  - [Ano ang mga bentahe kumpara sa Claude Code para sa web development?](#what-are-the-advantages-vs-claude-code-for-web-development)
- [Skills at automation](#skills-and-automation)
  - [Paano ko iko-customize ang skills nang hindi ginagawang marumi ang repo?](#how-do-i-customize-skills-without-keeping-the-repo-dirty)
  - [Maaari ba akong mag-load ng skills mula sa custom folder?](#can-i-load-skills-from-a-custom-folder)
  - [Paano ako gagamit ng iba’t ibang models para sa iba’t ibang gawain?](#how-can-i-use-different-models-for-different-tasks)
  - [Nagha-hang ang bot habang gumagawa ng mabibigat na gawain. Nasaan ito?](#what-format-is-the-config-where-is-it)
  - Binura ng config.apply ang aking config.
    Paano ako makakabawi at maiiwasan ito? What should I check?](#cron-or-reminders-do-not-fire-what-should-i-check)
  - [Paano ko i-install ang skills sa Linux?](#how-do-i-install-skills-on-linux)
  - [Maaari bang magpatakbo ang OpenClaw ng mga task sa iskedyul o tuloy-tuloy sa background?](#can-openclaw-run-tasks-on-a-schedule-or-continuously-in-the-background)
  - [Maaari ba akong magpatakbo ng Apple macOS-only skills mula sa Linux?](#can-i-run-apple-macos-only-skills-from-linux)
  - [May Notion o HeyGen integration ba kayo?](#do-you-have-a-notion-or-heygen-integration)
  - [Paano ko i-install ang Chrome extension para sa browser takeover?](#how-do-i-install-the-chrome-extension-for-browser-takeover)
- [Sandboxing at memory](#sandboxing-and-memory)
  - [May hiwalay bang sandboxing doc?](#is-there-a-dedicated-sandboxing-doc)
  - [Paano ko ibi-bind ang host folder papunta sa sandbox?](#how-do-i-bind-a-host-folder-into-the-sandbox)
  - [Paano gumagana ang memory?](#how-does-memory-work)
  - [Memory keeps forgetting things. Ano ngayon?](#i-started-the-gateway-via-the-service-and-my-env-vars-disappeared-what-now)
  - Itinakda ko ang  **Naipa-paste na ulat (ligtas ibahagi)**
  - [Kailangan ba ng OpenAI API key ang semantic memory search?](#does-semantic-memory-search-require-an-openai-api-key)
- [Saan nakatira ang mga bagay sa disk](#where-things-live-on-disk)
  - [Lahat ba ng data na ginagamit ng OpenClaw ay naka-save locally?](#is-all-data-used-with-openclaw-saved-locally)
  - [Saan iniimbak ng OpenClaw ang data nito?](#where-does-openclaw-store-its-data)
  - [Saan dapat ilagay ang AGENTS.md / SOUL.md / USER.md / MEMORY.md?](#where-should-agentsmd-soulmd-usermd-memorymd-live)
  - [Ano ang inirerekomendang backup strategy?](#whats-the-recommended-backup-strategy)
  - [Paano ko ganap na ia-uninstall ang OpenClaw?](#how-do-i-completely-uninstall-openclaw)
  - [Maaari bang magtrabaho ang agents sa labas ng workspace?](#can-agents-work-outside-the-workspace)
  - [Nasa remote mode ako—nasaan ang session store?](#im-in-remote-mode-where-is-the-session-store)
- [Mga basic ng config](#config-basics)
  - [What format is the config? Nasaan ito?](#what-format-is-the-config-where-is-it)
  - [Itinakda ko ang `gateway.bind: "lan"` (o `"tailnet"`) at ngayon ay walang nakikinig / sinasabi ng UI na unauthorized](#i-set-gatewaybind-lan-or-tailnet-and-now-nothing-listens-the-ui-says-unauthorized)
  - [Bakit kailangan ko na ng token sa localhost ngayon?](#why-do-i-need-a-token-on-localhost-now)
  - [Kailangan ko bang mag-restart pagkatapos magbago ng config?](#do-i-have-to-restart-after-changing-config)
  - [Paano ko i-enable ang web search (at web fetch)?](#how-do-i-enable-web-search-and-web-fetch)
  - [Binura ng config.apply ang aking config. Paano ako makakabawi at maiiwasan ito?](#configapply-wiped-my-config-how-do-i-recover-and-avoid-this)
  - [Paano ako magpapatakbo ng central Gateway na may specialized workers sa iba’t ibang device?](#how-do-i-run-a-central-gateway-with-specialized-workers-across-devices)
  - [Maaari bang tumakbo ang OpenClaw browser nang headless?](#can-the-openclaw-browser-run-headless)
  - [Paano ko gagamitin ang Brave para sa browser control?](#how-do-i-use-brave-for-browser-control)
- [Remote gateways at nodes](#remote-gateways-and-nodes)
  - [Paano nagpo-propagate ang mga command sa pagitan ng Telegram, gateway, at nodes?](#how-do-commands-propagate-between-telegram-the-gateway-and-nodes)
  - [Paano maa-access ng agent ko ang computer ko kung naka-host nang remote ang Gateway?](#how-can-my-agent-access-my-computer-if-the-gateway-is-hosted-remotely)
  - [Tailscale is connected but I get no replies. What now?](#tailscale-is-connected-but-i-get-no-replies-what-now)
  - [Maaari bang mag-usap ang dalawang OpenClaw instances (local + VPS)?](#can-two-openclaw-instances-talk-to-each-other-local-vps)
  - [Kailangan ko ba ng hiwalay na VPS para sa maraming agents](#do-i-need-separate-vpses-for-multiple-agents)
  - [May benepisyo ba ang paggamit ng node sa personal laptop ko imbes na SSH mula sa VPS?](#is-there-a-benefit-to-using-a-node-on-my-personal-laptop-instead-of-ssh-from-a-vps)
  - [Nagpapatakbo ba ng gateway service ang mga node?](#do-nodes-run-a-gateway-service)
  - [May API / RPC ba para i-apply ang config?](#is-there-an-api-rpc-way-to-apply-config)
  - [Ano ang minimal na “sane” config para sa unang install?](#whats-a-minimal-sane-config-for-a-first-install)
  - [Paano ko ise-set up ang Tailscale sa VPS at kumonek mula sa Mac ko?](#how-do-i-set-up-tailscale-on-a-vps-and-connect-from-my-mac)
  - [Paano ko ikokonek ang Mac node sa remote Gateway (Tailscale Serve)?](#how-do-i-connect-a-mac-node-to-a-remote-gateway-tailscale-serve)
  - [Dapat ba akong mag-install sa ikalawang laptop o magdagdag na lang ng node?](#should-i-install-on-a-second-laptop-or-just-add-a-node)
- [Env vars at .env loading](#env-vars-and-env-loading)
  - [Paano naglo-load ng environment variables ang OpenClaw?](#how-does-openclaw-load-environment-variables)
  - ["I started the Gateway via the service and my env vars disappeared." Ano na ngayon?](#i-started-the-gateway-via-the-service-and-my-env-vars-disappeared-what-now)
  - [I set `COPILOT_GITHUB_TOKEN`, but models status shows "Shell env: off." Why?](#i-set-copilotgithubtoken-but-models-status-shows-shell-env-off-why)
- [Sessions at maraming chats](#sessions-and-multiple-chats)
  - [Paano ako magsisimula ng bagong usapan?](#how-do-i-start-a-fresh-conversation)
  - [Awtomatikong nagre-reset ba ang sessions kung hindi ako kailanman magpadala ng `/new`?](#do-sessions-reset-automatically-if-i-never-send-new)
  - [May paraan ba para gawing isang CEO at maraming agents ang team ng OpenClaw instances](#is-there-a-way-to-make-a-team-of-openclaw-instances-one-ceo-and-many-agents)
  - [Why did context get truncated mid-task? How do I prevent it?](#why-did-context-get-truncated-midtask-how-do-i-prevent-it)
  - [Paano ko ganap na ire-reset ang OpenClaw pero panatilihing naka-install?](#how-do-i-completely-reset-openclaw-but-keep-it-installed)
  - [Nakakakuha ako ng "context too large" errors—paano ako magre-reset o magko-compact?](#im-getting-context-too-large-errors-how-do-i-reset-or-compact)
  - [Bakit ko nakikita ang "LLM request rejected: messages.N.content.X.tool_use.input: Field required"?](#why-am-i-seeing-llm-request-rejected-messagesncontentxtooluseinput-field-required)
  - [Bakit ako nakakakuha ng heartbeat messages bawat 30 minuto?](#why-am-i-getting-heartbeat-messages-every-30-minutes)
  - [Kailangan ko bang magdagdag ng "bot account" sa isang WhatsApp group?](#do-i-need-to-add-a-bot-account-to-a-whatsapp-group)
  - [Paano ko makukuha ang JID ng isang WhatsApp group?](#how-do-i-get-the-jid-of-a-whatsapp-group)
  - [Bakit hindi nagre-reply ang OpenClaw sa isang group?](#why-doesnt-openclaw-reply-in-a-group)
  - [Nagbabahagi ba ng context ang groups/threads sa DMs?](#do-groupsthreads-share-context-with-dms)
  - [Ilang workspaces at agents ang maaari kong likhain?](#how-many-workspaces-and-agents-can-i-create)
  - [Maaari ba akong magpatakbo ng maraming bots o chats nang sabay-sabay (Slack), at paano ko ito ise-set up?](#can-i-run-multiple-bots-or-chats-at-the-same-time-slack-and-how-should-i-set-that-up)
- [Models: mga default, pagpili, aliases, pagpapalit](#models-defaults-selection-aliases-switching)
  - [Ano ang "default model"?](#what-is-the-default-model)
  - [Anong model ang inirerekomenda ninyo?](#what-model-do-you-recommend)
  - [Paano ako magpapalit ng models nang hindi binubura ang config ko?](#how-do-i-switch-models-without-wiping-my-config)
  - [Maaari ba akong gumamit ng self-hosted models (llama.cpp, vLLM, Ollama)?](#can-i-use-selfhosted-models-llamacpp-vllm-ollama)
  - [Anong models ang ginagamit ng OpenClaw, Flawd, at Krill?](#what-do-openclaw-flawd-and-krill-use-for-models)
  - [Paano ako magpapalit ng models on the fly (nang hindi nagre-restart)?](#how-do-i-switch-models-on-the-fly-without-restarting)
  - [Maaari ba akong gumamit ng GPT 5.2 para sa daily tasks at Codex 5.3 para sa coding](#can-i-use-gpt-52-for-daily-tasks-and-codex-53-for-coding)
  - [Why do I see "Model … is not allowed" and then no reply?](#why-do-i-see-model-is-not-allowed-and-then-no-reply)
  - [Bakit ko nakikita ang "Unknown model: minimax/MiniMax-M2.1"?](#why-do-i-see-unknown-model-minimaxminimaxm21)
  - [Maaari ba akong gumamit ng MiniMax bilang default at OpenAI para sa mas kumplikadong gawain?](#can-i-use-minimax-as-my-default-and-openai-for-complex-tasks)
  - [Built-in shortcuts ba ang opus / sonnet / gpt?](#are-opus-sonnet-gpt-builtin-shortcuts)
  - [Paano ko ide-define/override ang model shortcuts (aliases)?](#how-do-i-defineoverride-model-shortcuts-aliases)
  - [Paano ako magdadagdag ng models mula sa ibang providers tulad ng OpenRouter o Z.AI?](#how-do-i-add-models-from-other-providers-like-openrouter-or-zai)
- [Model failover at "All models failed"](#model-failover-and-all-models-failed)
  - [Paano gumagana ang failover?](#how-does-failover-work)
  - [Ano ang ibig sabihin ng error na ito?](#what-does-this-error-mean)
  - [Checklist ng pag-aayos para sa `No credentials found for profile "anthropic:default"`](#fix-checklist-for-no-credentials-found-for-profile-anthropicdefault)
  - [Bakit sinubukan din nito ang Google Gemini at nabigo?](#why-did-it-also-try-google-gemini-and-fail)
- [Auth profiles: ano ang mga ito at paano pamahalaan](#auth-profiles-what-they-are-and-how-to-manage-them)
  - [Ano ang auth profile?](#what-is-an-auth-profile)
  - [Ano ang mga karaniwang profile IDs?](#what-are-typical-profile-ids)
  - [Maaari ko bang kontrolin kung aling auth profile ang unang susubukan?](#can-i-control-which-auth-profile-is-tried-first)
  - [OAuth vs API key: ano ang pagkakaiba?](#oauth-vs-api-key-whats-the-difference)
- [Gateway: ports, "already running", at remote mode](#gateway-ports-already-running-and-remote-mode)
  - [Anong port ang ginagamit ng Gateway?](#what-port-does-the-gateway-use)
  - [Bakit sinasabi ng `openclaw gateway status` na `Runtime: running` pero `RPC probe: failed`?](#why-does-openclaw-gateway-status-say-runtime-running-but-rpc-probe-failed)
  - [Bakit ipinapakita ng `openclaw gateway status` ang `Config (cli)` at `Config (service)` na magkaiba?](#why-does-openclaw-gateway-status-show-config-cli-and-config-service-different)
  - [Ano ang ibig sabihin ng "another gateway instance is already listening"?](#what-does-another-gateway-instance-is-already-listening-mean)
  - [Paano ko patatakbuhin ang OpenClaw sa remote mode (client kumokonek sa Gateway sa ibang lugar)?](#how-do-i-run-openclaw-in-remote-mode-client-connects-to-a-gateway-elsewhere)
  - [The Control UI says "unauthorized" (or keeps reconnecting). What now?](#the-control-ui-says-unauthorized-or-keeps-reconnecting-what-now)
  - [Itinakda ko ang `gateway.bind: "tailnet"` pero hindi ito makapag-bind / walang nakikinig](#i-set-gatewaybind-tailnet-but-it-cant-bind-nothing-listens)
  - [Maaari ba akong magpatakbo ng maraming Gateways sa iisang host?](#can-i-run-multiple-gateways-on-the-same-host)
  - [Ano ang ibig sabihin ng "invalid handshake" / code 1008?](#what-does-invalid-handshake-code-1008-mean)
- [Logging at debugging](#logging-and-debugging)
  - [Saan ang mga logs?](#where-are-logs)
  - [Paano ko sisimulan/ihihinto/i-restart ang Gateway service?](#how-do-i-startstoprestart-the-gateway-service)
  - [Isinara ko ang terminal ko sa Windows—paano ko ire-restart ang OpenClaw?](#i-closed-my-terminal-on-windows-how-do-i-restart-openclaw)
  - [The Gateway is up but replies never arrive. What should I check?](#the-gateway-is-up-but-replies-never-arrive-what-should-i-check)
  - ["Disconnected from gateway: no reason" — ano ngayon?](#disconnected-from-gateway-no-reason-what-now)
  - [Telegram setMyCommands fails with network errors. What should I check?](#telegram-setmycommands-fails-with-network-errors-what-should-i-check)
  - [TUI shows no output. What should I check?](#tui-shows-no-output-what-should-i-check)
  - [Paano ko ganap na ihinto at pagkatapos ay simulan ang Gateway?](#how-do-i-completely-stop-then-start-the-gateway)
  - [ELI5: `openclaw gateway restart` vs `openclaw gateway`](#eli5-openclaw-gateway-restart-vs-openclaw-gateway)
  - [Ano ang pinakamabilis na paraan para makakuha ng mas maraming detalye kapag may pumalya?](#whats-the-fastest-way-to-get-more-details-when-something-fails)
- [Media at attachments](#media-and-attachments)
  - [Gumawa ang skill ko ng image/PDF, pero walang ipinadala](#my-skill-generated-an-imagepdf-but-nothing-was-sent)
- [Seguridad at kontrol sa access](#security-and-access-control)
  - [Ligtas bang ilantad ang OpenClaw sa inbound DMs?](#is-it-safe-to-expose-openclaw-to-inbound-dms)
  - [Concern lang ba ang prompt injection para sa public bots?](#is-prompt-injection-only-a-concern-for-public-bots)
  - [Dapat bang may sarili itong email, GitHub account, o phone number](#should-my-bot-have-its-own-email-github-account-or-phone-number)
  - [Maaari ko ba itong bigyan ng awtonomiya sa aking mga text message at ligtas ba iyon](#can-i-give-it-autonomy-over-my-text-messages-and-is-that-safe)
  - [Maaari ba akong gumamit ng mas murang models para sa personal assistant tasks?](#can-i-use-cheaper-models-for-personal-assistant-tasks)
  - [Pinatakbo ko ang `/start` sa Telegram pero hindi ako nakakuha ng pairing code](#i-ran-start-in-telegram-but-didnt-get-a-pairing-code)
  - [WhatsApp: will it message my contacts? How does pairing work?](#whatsapp-will-it-message-my-contacts-how-does-pairing-work)
- [Chat commands, pag-abort ng tasks, at "hindi ito humihinto"](#chat-commands-aborting-tasks-and-it-wont-stop)
  - [Paano ko ihihinto ang pagpapakita ng internal system messages sa chat](#how-do-i-stop-internal-system-messages-from-showing-in-chat)
  - [Paano ko ihihinto/kakanselahin ang tumatakbong task?](#how-do-i-stopcancel-a-running-task)
  - [How do I send a Discord message from Telegram? ("Cross-context messaging denied")](#how-do-i-send-a-discord-message-from-telegram-crosscontext-messaging-denied)
  - [Bakit parang "ini-ignore" ng bot ang sunod-sunod na mabilis na messages?](#why-does-it-feel-like-the-bot-ignores-rapidfire-messages)

## First 60 seconds if something's broken

1. **Quick status (first check)**

   ```bash
   openclaw status
   ```

   Fast local summary: OS + update, gateway/service reachability, agents/sessions, provider config + runtime issues (when gateway is reachable).

2. **Pasteable report (safe to share)**

   ```bash
   openclaw status --all
   ```

   Read-only diagnosis with log tail (tokens redacted).

3. **Daemon + port state**

   ```bash
   openclaw gateway status
   ```

   Shows supervisor runtime vs RPC reachability, the probe target URL, and which config the service likely used.

4. **Deep probes**

   ```bash
   openclaw status --deep
   ```

   Runs gateway health checks + provider probes (requires a reachable gateway). See [Health](/gateway/health).

5. **Tail the latest log**

   ```bash
   openclaw logs --follow
   ```

   If RPC is down, fall back to:

   ```bash
   tail -f "$(ls -t /tmp/openclaw/openclaw-*.log | head -1)"
   ```

   File logs are separate from service logs; see [Logging](/logging) and [Troubleshooting](/gateway/troubleshooting).

6. **Run the doctor (repairs)**

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

## Mabilis na pagsisimula at unang setup

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

Tip: ask the agent to **plan and supervise** the fix (step-by-step), then execute only the
necessary commands. That keeps changes small and easier to audit.

If you discover a real bug or fix, please file a GitHub issue or send a PR:
[https://github.com/openclaw/openclaw/issues](https://github.com/openclaw/openclaw/issues)
[https://github.com/openclaw/openclaw/pulls](https://github.com/openclaw/openclaw/pulls)

Start with these commands (share outputs when asking for help):

```bash
openclaw status
openclaw models status
openclaw doctor
```

What they do:

- `openclaw status`: quick snapshot of gateway/agent health + basic config.
- `openclaw models status`: checks provider auth + model availability.
- `openclaw doctor`: validates and repairs common config/state issues.

Other useful CLI checks: `openclaw status --all`, `openclaw logs --follow`,
`openclaw gateway status`, `openclaw health --verbose`.

Quick debug loop: [First 60 seconds if something's broken](#first-60-seconds-if-somethings-broken).
Install docs: [Install](/install), [Installer flags](/install/installer), [Updating](/install/updating).

### What's the recommended way to install and set up OpenClaw

The repo recommends running from source and using the onboarding wizard:

```bash
curl -fsSL https://openclaw.ai/install.sh | bash
openclaw onboard --install-daemon
```

The wizard can also build UI assets automatically. After onboarding, you typically run the Gateway on port **18789**.

From source (contributors/dev):

```bash
git clone https://github.com/openclaw/openclaw.git
cd openclaw
pnpm install
pnpm build
pnpm ui:build # auto-installs UI deps on first run
openclaw onboard
```

If you don't have a global install yet, run it via `pnpm openclaw onboard`.

### How do I open the dashboard after onboarding

The wizard opens your browser with a clean (non-tokenized) dashboard URL right after onboarding and also prints the link in the summary. Keep that tab open; if it didn't launch, copy/paste the printed URL on the same machine.

### How do I authenticate the dashboard token on localhost vs remote

**Localhost (same machine):**

- Open `http://127.0.0.1:18789/`.
- If it asks for auth, paste the token from `gateway.auth.token` (or `OPENCLAW_GATEWAY_TOKEN`) into Control UI settings.
- Retrieve it from the gateway host: `openclaw config get gateway.auth.token` (or generate one: `openclaw doctor --generate-gateway-token`).

**Not on localhost:**

- **Tailscale Serve** (recommended): keep bind loopback, run `openclaw gateway --tailscale serve`, open `https://<magicdns>/`. If `gateway.auth.allowTailscale` is `true`, identity headers satisfy auth (no token).
- **Tailnet bind**: run `openclaw gateway --bind tailnet --token "<token>"`, open `http://<tailscale-ip>:18789/`, paste token in dashboard settings.
- **SSH tunnel**: `ssh -N -L 18789:127.0.0.1:18789 user@host` then open `http://127.0.0.1:18789/` and paste the token in Control UI settings.

See [Dashboard](/web/dashboard) and [Web surfaces](/web) for bind modes and auth details.

### What runtime do I need

Node **>= 22** is required. `pnpm` is recommended. Bun is **not recommended** for the Gateway.

### Does it run on Raspberry Pi

Oo. The Gateway is lightweight - docs list **512MB-1GB RAM**, **1 core**, and about **500MB**
disk as enough for personal use, and note that a **Raspberry Pi 4 can run it**.

If you want extra headroom (logs, media, other services), **2GB is recommended**, but it's
not a hard minimum.

Tip: a small Pi/VPS can host the Gateway, and you can pair **nodes** on your laptop/phone for
local screen/camera/canvas or command execution. See [Nodes](/nodes).

### Any tips for Raspberry Pi installs

Short version: it works, but expect rough edges.

- Use a **64-bit** OS and keep Node >= 22.
- Prefer the **hackable (git) install** so you can see logs and update fast.
- 3. Magsimula nang walang channels/skills, saka idagdag ang mga ito isa-isa.
- 4. Kung makaranas ka ng kakaibang binary issues, kadalasan ito ay problema sa **ARM compatibility**.

Docs: [Linux](/platforms/linux), [Install](/install).

### It is stuck on wake up my friend onboarding will not hatch What now

7. Ang screen na iyon ay nakadepende kung naaabot at authenticated ang Gateway. The TUI also sends
   "Wake up, my friend!" automatically on first hatch. 9. Kung makita mo ang linyang iyon na **walang reply**
   at nananatili sa 0 ang tokens, hindi kailanman tumakbo ang agent.

1. I-restart ang Gateway:

```bash
openclaw gateway restart
```

2. Check status + auth:

```bash
openclaw status
openclaw models status
openclaw logs --follow
```

3. If it still hangs, run:

```bash
openclaw doctor
```

13. Kung remote ang Gateway, tiyaking naka-up ang tunnel/Tailscale connection at ang UI
    ay nakaturo sa tamang Gateway. Tingnan ang [Remote access](/gateway/remote).

### Can I migrate my setup to a new machine Mac mini without redoing onboarding

Oo. Copy the **state directory** and **workspace**, then run Doctor once. This
keeps your bot "exactly the same" (memory, session history, auth, and channel
state) as long as you copy **both** locations:

1. Install OpenClaw on the new machine.
2. 18. Kopyahin ang `$OPENCLAW_STATE_DIR` (default: `~/.openclaw`) mula sa lumang machine.
3. 19. Kopyahin ang iyong workspace (default: `~/.openclaw/workspace`).
4. Run `openclaw doctor` and restart the Gateway service.

21) Pinapanatili nito ang config, auth profiles, WhatsApp creds, sessions, at memory. If you're in
    remote mode, remember the gateway host owns the session store and workspace.

23. **Mahalaga:** kung kino-commit/push mo lang ang iyong workspace sa GitHub, bina-backup mo ang **memory + bootstrap files**, pero **hindi** ang session history o auth. 24. Ang mga iyon ay nasa
    `~/.openclaw/` (halimbawa `~/.openclaw/agents/<agentId>/sessions/`).

Related: [Migrating](/install/migrating), [Where things live on disk](/help/faq#where-does-openclaw-store-its-data),
[Agent workspace](/concepts/agent-workspace), [Doctor](/gateway/doctor),
[Remote mode](/gateway/remote).

### Where do I see what is new in the latest version

Tingnan ang GitHub changelog:
[https://github.com/openclaw/openclaw/blob/main/CHANGELOG.md](https://github.com/openclaw/openclaw/blob/main/CHANGELOG.md)

28. Ang mga pinakabagong entry ay nasa itaas. 29. Kung ang seksyon sa itaas ay may markang **Unreleased**, ang susunod na may petsang
    seksyon ang pinakahuling naipadalang bersyon. 30. Ang mga entry ay naka-grupo bilang **Highlights**, **Changes**, at
    **Fixes** (kasama ang docs/ibang seksyon kung kinakailangan).

### 31. Hindi ko ma-access ang docs.openclaw.ai may SSL error Ano na ngayon

Some Comcast/Xfinity connections incorrectly block `docs.openclaw.ai` via Xfinity
Advanced Security. 33. I-disable ito o i-allowlist ang `docs.openclaw.ai`, pagkatapos ay subukang muli. More
detail: [Troubleshooting](/help/troubleshooting#docsopenclawai-shows-an-ssl-error-comcastxfinity).
Please help us unblock it by reporting here: [https://spa.xfinity.com/check_url_status](https://spa.xfinity.com/check_url_status).

36. Kung hindi mo pa rin maabot ang site, naka-mirror ang docs sa GitHub:
    [https://github.com/openclaw/openclaw/tree/main/docs](https://github.com/openclaw/openclaw/tree/main/docs)

### 37. Ano ang pagkakaiba ng stable at beta

**Stable** and **beta** are **npm dist-tags**, not separate code lines:

- `latest` = stable
- `beta` = maagang build para sa pagsubok

Nagpapadala kami ng mga build sa **beta**, sinusubukan ang mga ito, at kapag matibay na ang isang build ay **inaangat namin ang parehong bersyong iyon sa `latest`**. 42. Iyon ang dahilan kung bakit maaaring tumuro ang beta at stable sa **parehong bersyon**.

43. Tingnan kung ano ang nagbago:
    [https://github.com/openclaw/openclaw/blob/main/CHANGELOG.md](https://github.com/openclaw/openclaw/blob/main/CHANGELOG.md)

### 44. Paano ko i-install ang beta version at ano ang pagkakaiba ng beta at dev

45. Ang **Beta** ay ang npm dist-tag na `beta` (maaaring tumugma sa `latest`).
46. Ang **Dev** ay ang gumagalaw na head ng `main` (git); kapag nailathala, ginagamit nito ang npm dist-tag na `dev`.

47. One-liners (macOS/Linux):

```bash
48. curl -fsSL --proto '=https' --tlsv1.2 https://openclaw.ai/install.sh | bash -s -- --beta
```

```bash
49. curl -fsSL --proto '=https' --tlsv1.2 https://openclaw.ai/install.sh | bash -s -- --install-method git
```

50. Windows installer (PowerShell):
    [https://openclaw.ai/install.ps1](https://openclaw.ai/install.ps1)

Higit pang detalye: [Development channels](/install/development-channels) at [Installer flags](/install/installer).

### Gaano katagal karaniwang tumatagal ang pag-install at onboarding

Magaspang na gabay:

- **Install:** 2-5 minutes
- **Onboarding:** 5–15 minuto depende sa dami ng channels/models na iko-configure mo

Kung mag-hang, gamitin ang [Installer stuck](/help/faq#installer-stuck-how-do-i-get-more-feedback)
at ang mabilis na debug loop sa [Im stuck](/help/faq#im-stuck--whats-the-fastest-way-to-get-unstuck).

### Paano ko susubukan ang pinakabagong bits

Dalawang opsyon:

1. **Dev channel (git checkout):**

```bash
openclaw update --channel dev
```

Ililipat nito sa `main` branch at mag-a-update mula sa source.

2. **Hackable install (mula sa installer site):**

```bash
curl -fsSL https://openclaw.ai/install.sh | bash -s -- --install-method git
```

Magbibigay ito sa iyo ng lokal na repo na maaari mong i-edit, pagkatapos ay mag-update gamit ang git.

Kung mas gusto mo ang malinis na clone nang manu-mano, gamitin:

```bash
git clone https://github.com/openclaw/openclaw.git
cd openclaw
pnpm install
pnpm build
```

Docs: [Update](/cli/update), [Development channels](/install/development-channels),
[Install](/install).

### Installer stuck: Paano ako makakakuha ng mas maraming feedback

Patakbuhin muli ang installer na may **verbose output**:

```bash
curl -fsSL https://openclaw.ai/install.sh | bash -s -- --verbose
```

Beta install na may verbose:

```bash
curl -fsSL https://openclaw.ai/install.sh | bash -s -- --beta --verbose
```

Para sa hackable (git) install:

```bash
curl -fsSL https://openclaw.ai/install.sh | bash -s -- --install-method git --verbose
```

Higit pang opsyon: [Installer flags](/install/installer).

### Sinasabi ng Windows install na hindi makita ang git o hindi nakikilala ang openclaw

Dalawang karaniwang isyu sa Windows:

**1) npm error spawn git / git not found**

- I-install ang **Git for Windows** at tiyaking nasa PATH ang `git`.
- Isara at buksan muli ang PowerShell, pagkatapos ay patakbuhin muli ang installer.

**2) hindi nakikilala ang openclaw pagkatapos ng install**

- Ang npm global bin folder mo ay wala sa PATH.

- Suriin ang path:

  ```powershell
  npm config get prefix
  ```

- Tiyaking nasa PATH ang `<prefix>\\bin` (sa karamihan ng sistema ito ay `%AppData%\\npm`).

- Isara at buksan muli ang PowerShell matapos i-update ang PATH.

If you want the smoothest Windows setup, use **WSL2** instead of native Windows.
Docs: [Windows](/platforms/windows).

### The docs didnt answer my question how do I get a better answer

Gamitin ang **hackable (git) install** para magkaroon ka ng buong source at docs nang lokal, pagkatapos ay magtanong
sa iyong bot (o Claude/Codex) _mula sa folder na iyon_ para mabasa nito ang repo at makasagot nang eksakto.

```bash
curl -fsSL https://openclaw.ai/install.sh | bash -s -- --install-method git
```

Mas detalyado: [Install](/install) at [Installer flags](/install/installer).

### Paano ko i-install ang OpenClaw sa Linux

Maikling sagot: sundin ang Linux guide, pagkatapos ay patakbuhin ang onboarding wizard.

- Linux quick path + service install: [Linux](/platforms/linux).
- Full walkthrough: [Getting Started](/start/getting-started).
- Installer + updates: [Install & updates](/install/updating).

### Paano ko i-install ang OpenClaw sa isang VPS

Any Linux VPS works. Mag-install sa server, pagkatapos ay gumamit ng SSH/Tailscale para maabot ang Gateway.

1. Mga gabay: [exe.dev](/install/exe-dev), [Hetzner](/install/hetzner), [Fly.io](/install/fly).
2. Malayuang access: [Gateway remote](/gateway/remote).

### 3. Nasaan ang mga cloudVPS install guide

4. Pinananatili namin ang isang **hosting hub** na may mga karaniwang provider. Pumili ng isa at sundin ang gabay:

- [VPS hosting](/vps) (all providers in one place)
- [Fly.io](/install/fly)
- 8. [Hetzner](/install/hetzner)
- [exe.dev](/install/exe-dev)

How it works in the cloud: the **Gateway runs on the server**, and you access it
from your laptop/phone via the Control UI (or Tailscale/SSH). Ang iyong state + workspace ay
nakatira sa server, kaya ituring ang host bilang pinagmumulan ng katotohanan at i-back up ito.

You can pair **nodes** (Mac/iOS/Android/headless) to that cloud Gateway to access
local screen/camera/canvas or run commands on your laptop while keeping the
Gateway in the cloud.

Hub: [Platforms](/platforms). Remote access: [Gateway remote](/gateway/remote).
Nodes: [Nodes](/nodes), [Nodes CLI](/cli/nodes).

### Can I ask OpenClaw to update itself

Short answer: **possible, not recommended**. The update flow can restart the
Gateway (which drops the active session), may need a clean git checkout, and
can prompt for confirmation. 18. Mas ligtas: patakbuhin ang mga update mula sa isang shell bilang operator.

19. Gamitin ang CLI:

```bash
openclaw update
openclaw update status
openclaw update --channel stable|beta|dev
openclaw update --tag <dist-tag|version>
openclaw update --no-restart
```

21. Kung kailangan mong i-automate mula sa isang agent:

```bash
openclaw update --yes --no-restart
openclaw gateway restart
```

Docs: [Update](/cli/update), [Updating](/install/updating).

### 24. Ano ba talaga ang ginagawa ng onboarding wizard

25. Ang `openclaw onboard` ang inirerekomendang setup path. In **local mode** it walks you through:

- **Model/auth setup** (Anthropic **setup-token** recommended for Claude subscriptions, OpenAI Codex OAuth supported, API keys optional, LM Studio local models supported)
- **Workspace** location + bootstrap files
- 29. **Gateway settings** (bind/port/auth/tailscale)
- **Providers** (WhatsApp, Telegram, Discord, Mattermost (plugin), Signal, iMessage)
- **Daemon install** (LaunchAgent on macOS; systemd user unit on Linux/WSL2)
- **Health checks** and **skills** selection

It also warns if your configured model is unknown or missing auth.

### 34. Kailangan ko ba ng Claude o OpenAI subscription para patakbuhin ito

Hindi. You can run OpenClaw with **API keys** (Anthropic/OpenAI/others) or with
**local-only models** so your data stays on your device. Subscriptions (Claude
Pro/Max or OpenAI Codex) are optional ways to authenticate those providers.

Docs: [Anthropic](/providers/anthropic), [OpenAI](/providers/openai),
[Local models](/gateway/local-models), [Models](/concepts/models).

### 38. Maaari ko bang gamitin ang Claude Max subscription nang walang API key

Oo. Maaari kang mag-authenticate gamit ang **setup-token**
sa halip na API key. 40. Ito ang subscription path.

Ang mga subscription na Claude Pro/Max ay **hindi kasama ang API key**, kaya ito ang
tamang paraan para sa mga subscription account. Mahalaga: kailangan mong kumpirmahin sa
Anthropic na pinapayagan ang paggamit na ito sa ilalim ng kanilang patakaran at mga tuntunin ng subscription.
43. Kung gusto mo ang pinaka-tiyak at suportadong path, gumamit ng Anthropic API key.

### 44. Paano gumagana ang Anthropic setuptoken auth

45. Ang `claude setup-token` ay bumubuo ng **token string** sa pamamagitan ng Claude Code CLI (hindi ito available sa web console). 46. Maaari mo itong patakbuhin sa **anumang machine**. Piliin ang **Anthropic token (paste setup-token)** sa wizard o i-paste ito gamit ang `openclaw models auth paste-token --provider anthropic`. 48. Ang token ay iniimbak bilang isang auth profile para sa **anthropic** provider at ginagamit na parang API key (walang auto-refresh). Mas maraming detalye: [OAuth](/concepts/oauth).

### Saan ko mahahanap ang Anthropic setuptoken

Ito ay **wala** sa Anthropic Console. Ang setup-token ay ginagawa ng **Claude Code CLI** sa **anumang makina**:

```bash
claude setup-token
```

Kopyahin ang token na ipinapakita nito, pagkatapos ay piliin ang **Anthropic token (paste setup-token)** sa wizard. Kung gusto mo itong patakbuhin sa gateway host, gamitin ang `openclaw models auth setup-token --provider anthropic`. Kung pinatakbo mo ang `claude setup-token` sa ibang lugar, i-paste ito sa gateway host gamit ang `openclaw models auth paste-token --provider anthropic`. Tingnan ang [Anthropic](/providers/anthropic).

### Sinusuportahan ba ninyo ang Claude subscription auth (Claude Pro o Max)

Oo — sa pamamagitan ng **setup-token**. Hindi na muling ginagamit ng OpenClaw ang Claude Code CLI OAuth tokens; gumamit ng setup-token o Anthropic API key. Gawin ang token kahit saan at i-paste ito sa gateway host. Tingnan ang [Anthropic](/providers/anthropic) at [OAuth](/concepts/oauth).

Paalala: ang access sa Claude subscription ay pinamamahalaan ng mga tuntunin ng Anthropic. Para sa production o multi-user na mga workload, karaniwang mas ligtas ang API keys.

### Bakit ako nakakakita ng HTTP 429 ratelimiterror mula sa Anthropic

Ibig sabihin ay ubos na ang iyong **Anthropic quota/rate limit** para sa kasalukuyang window. Kung gumagamit ka ng **Claude subscription** (setup-token o Claude Code OAuth), maghintay na mag-reset ang window o mag-upgrade ng plano. Kung gumagamit ka ng **Anthropic API key**, tingnan ang Anthropic Console
para sa paggamit/pagsingil at itaas ang mga limit kung kinakailangan.

Tip: magtakda ng **fallback model** para makapagpatuloy sa pagsagot ang OpenClaw habang naka-rate limit ang isang provider.
Tingnan ang [Models](/cli/models) at [OAuth](/concepts/oauth).

### Sinusuportahan ba ang AWS Bedrock

Oo – sa pamamagitan ng **Amazon Bedrock (Converse)** provider ng pi-ai na may **manual config**. Kailangan mong magbigay ng AWS credentials/region sa gateway host at magdagdag ng Bedrock provider entry sa iyong models config. Tingnan ang [Amazon Bedrock](/providers/bedrock) at [Model providers](/providers/models). Kung mas gusto mo ang isang managed key flow, ang isang OpenAI-compatible proxy sa harap ng Bedrock ay isa pa ring wastong opsyon.

### Paano gumagana ang Codex auth

Sinusuportahan ng OpenClaw ang **OpenAI Code (Codex)** sa pamamagitan ng OAuth (ChatGPT sign-in). Maaaring patakbuhin ng wizard ang OAuth flow at itatakda ang default model sa `openai-codex/gpt-5.3-codex` kapag naaangkop. Tingnan ang [Model providers](/concepts/model-providers) at [Wizard](/start/wizard).

### Sinusuportahan ba ninyo ang OpenAI subscription auth Codex OAuth

Oo. Ganap na sinusuportahan ng OpenClaw ang **OpenAI Code (Codex) subscription OAuth**. Maaaring patakbuhin ng onboarding wizard
ang OAuth flow para sa iyo.

Tingnan ang [OAuth](/concepts/oauth), [Model providers](/concepts/model-providers), at [Wizard](/start/wizard).

### Paano ko ise-set up ang Gemini CLI OAuth

Gumagamit ang Gemini CLI ng **plugin auth flow**, hindi ng client id o secret sa `openclaw.json`.

Mga hakbang:

1. I-enable ang plugin: `openclaw plugins enable google-gemini-cli-auth`
2. Mag-login: `openclaw models auth login --provider google-gemini-cli --set-default`

Iniimbak nito ang mga OAuth token sa mga auth profile sa gateway host. Mga detalye: [Model providers](/concepts/model-providers).

### OK ba ang local model para sa kaswal na mga chat

Karaniwan ay hindi. Kailangan ng OpenClaw ng malaking context + matibay na safety; ang maliliit na card ay nagta-truncate at nagle-leak. Kung kinakailangan, patakbuhin ang **pinakamalaking** MiniMax M2.1 build na kaya mo nang lokal (LM Studio) at tingnan ang [/gateway/local-models](/gateway/local-models). Ang mas maliliit/quantized na modelo ay nagpapataas ng panganib ng prompt-injection – tingnan ang [Security](/gateway/security).

### Paano ko mapapanatili ang hosted model traffic sa isang partikular na rehiyon

Pumili ng mga endpoint na naka-pin sa rehiyon. Nagbibigay ang OpenRouter ng mga US-hosted na opsyon para sa MiniMax, Kimi, at GLM; piliin ang US-hosted na variant para manatili ang data sa loob ng rehiyon. Maaari mo pa ring ilista ang Anthropic/OpenAI kasama ng mga ito sa pamamagitan ng paggamit ng `models.mode: "merge"` upang manatiling available ang mga fallback habang iginagalang ang piniling regioned provider.

### Kailangan ko bang bumili ng Mac Mini para ma-install ito

Hindi. Tumatakbo ang OpenClaw sa macOS o Linux (Windows sa pamamagitan ng WSL2). Opsyonal ang Mac mini — may ilang tao na
bumibili nito bilang always-on host, ngunit puwede rin ang isang maliit na VPS, home server, o Raspberry Pi-class na device.

You only need a Mac **for macOS-only tools**. For iMessage, use [BlueBubbles](/channels/bluebubbles) (recommended) - the BlueBubbles server runs on any Mac, and the Gateway can run on Linux or elsewhere. If you want other macOS-only tools, run the Gateway on a Mac or pair a macOS node.

Docs: [BlueBubbles](/channels/bluebubbles), [Nodes](/nodes), [Mac remote mode](/platforms/mac/remote).

### Do I need a Mac mini for iMessage support

You need **some macOS device** signed into Messages. It does **not** have to be a Mac mini -
any Mac works. **Use [BlueBubbles](/channels/bluebubbles)** (recommended) for iMessage - the BlueBubbles server runs on macOS, while the Gateway can run on Linux or elsewhere.

Common setups:

- Run the Gateway on Linux/VPS, and run the BlueBubbles server on any Mac signed into Messages.
- Run everything on the Mac if you want the simplest single‑machine setup.

Docs: [BlueBubbles](/channels/bluebubbles), [Nodes](/nodes),
[Mac remote mode](/platforms/mac/remote).

### If I buy a Mac mini to run OpenClaw can I connect it to my MacBook Pro

Oo. The **Mac mini can run the Gateway**, and your MacBook Pro can connect as a
**node** (companion device). Nodes don't run the Gateway - they provide extra
capabilities like screen/camera/canvas and `system.run` on that device.

Common pattern:

- Gateway on the Mac mini (always-on).
- MacBook Pro runs the macOS app or a node host and pairs to the Gateway.
- Use `openclaw nodes status` / `openclaw nodes list` to see it.

Docs: [Nodes](/nodes), [Nodes CLI](/cli/nodes).

### Can I use Bun

Bun is **not recommended**. We see runtime bugs, especially with WhatsApp and Telegram.
Use **Node** for stable gateways.

If you still want to experiment with Bun, do it on a non-production gateway
without WhatsApp/Telegram.

### Telegram what goes in allowFrom

`channels.telegram.allowFrom` is **the human sender's Telegram user ID** (numeric, recommended) or `@username`. It is not the bot username.

Mas ligtas (walang third-party bot):

- DM your bot, then run `openclaw logs --follow` and read `from.id`.

Official Bot API:

- DM your bot, then call `https://api.telegram.org/bot<bot_token>/getUpdates` and read `message.from.id`.

Third-party (mas hindi pribado):

- DM `@userinfobot` or `@getidsbot`.

See [/channels/telegram](/channels/telegram#access-control-dms--groups).

### Can multiple people use one WhatsApp number with different OpenClaw instances

Yes, via **multi-agent routing**. Bind each sender's WhatsApp **DM** (peer `kind: "dm"`, sender E.164 like `+15551234567`) to a different `agentId`, so each person gets their own workspace and session store. Replies still come from the **same WhatsApp account**, and DM access control (`channels.whatsapp.dmPolicy` / `channels.whatsapp.allowFrom`) is global per WhatsApp account. See [Multi-Agent Routing](/concepts/multi-agent) and [WhatsApp](/channels/whatsapp).

### Can I run a fast chat agent and an Opus for coding agent

Oo. Use multi-agent routing: give each agent its own default model, then bind inbound routes (provider account or specific peers) to each agent. Example config lives in [Multi-Agent Routing](/concepts/multi-agent). See also [Models](/concepts/models) and [Configuration](/gateway/configuration).

### Does Homebrew work on Linux

Oo. Homebrew supports Linux (Linuxbrew). Mabilis na setup:

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

Oo. Install the other flavor, then run Doctor so the gateway service points at the new entrypoint.
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

Oo. Treat a VM the same as a VPS: it needs to be always on, reachable, and have enough
RAM for the Gateway and any channels you enable.

Baseline guidance:

- **Absolute minimum:** 1 vCPU, 1GB RAM.
- **Recommended:** 2GB RAM or more if you run multiple channels, browser automation, or media tools.
- **OS:** Ubuntu LTS or another modern Debian/Ubuntu.

If you are on Windows, **WSL2 is the easiest VM style setup** and has the best tooling
compatibility. See [Windows](/platforms/windows), [VPS hosting](/vps).1) Kung pinapatakbo mo ang macOS sa isang VM, tingnan ang [macOS VM](/install/macos-vm).

## Ano ang OpenClaw?

### 2. Ano ang OpenClaw sa isang talata

3. Ang OpenClaw ay isang personal na AI assistant na pinapatakbo mo sa sarili mong mga device. Sumasagot ito sa mga messaging surface na ginagamit mo na (WhatsApp, Telegram, Slack, Mattermost (plugin), Discord, Google Chat, Signal, iMessage, WebChat) at maaari ring gumawa ng boses + live Canvas sa mga sinusuportahang platform. Ang **Gateway** ang palaging-on na control plane; ang assistant ang produkto.

### Ano ang value proposition

7. Ang OpenClaw ay hindi "isang Claude wrapper lang." Isa itong **local-first control plane** na nagbibigay-daan sa iyo na magpatakbo ng isang
   makapangyarihang assistant sa **sarili mong hardware**, naaabot mula sa mga chat app na ginagamit mo na, na may
   stateful sessions, memory, at mga tool – nang hindi isinusuko ang kontrol ng iyong mga workflow sa isang hosted
   SaaS.

Mga highlight:

- 9. **Iyong mga device, iyong data:** patakbuhin ang Gateway saan mo man gusto (Mac, Linux, VPS) at panatilihing lokal ang
     workspace + kasaysayan ng session.
- **Mga tunay na channel, hindi web sandbox:** WhatsApp/Telegram/Slack/Discord/Signal/iMessage/etc,
  kasama ang mobile voice at Canvas sa mga sinusuportahang platform.
- 11. **Model-agnostic:** gumamit ng Anthropic, OpenAI, MiniMax, OpenRouter, atbp., na may per-agent routing
      at failover.
- **Local-only na opsyon:** magpatakbo ng mga lokal na modelo upang **manatili ang lahat ng data sa iyong device** kung nais mo.
- **Multi-agent routing:** separate agents per channel, account, or task, each with its own
  workspace and defaults.
- **Open source and hackable:** inspect, extend, and self-host without vendor lock-in.

Docs: [Gateway](/gateway), [Channels](/channels), [Multi-agent](/concepts/multi-agent),
[Memory](/concepts/memory).

### I just set it up what should I do first

Good first projects:

- 18. Gumawa ng website (WordPress, Shopify, o isang simpleng static site).
- Prototype a mobile app (outline, screens, API plan).
- Organize files and folders (cleanup, naming, tagging).
- Connect Gmail and automate summaries or follow ups.

It can handle large tasks, but it works best when you split them into phases and
use sub agents for parallel work.

### What are the top five everyday use cases for OpenClaw

24. Karaniwang ganito ang mga pang-araw-araw na panalo:

- **Personal briefings:** summaries of inbox, calendar, and news you care about.
- **Research and drafting:** quick research, summaries, and first drafts for emails or docs.
- 27. **Mga paalala at follow ups:** mga nudge at checklist na pinapatakbo ng cron o heartbeat.
- **Browser automation:** filling forms, collecting data, and repeating web tasks.
- 29. **Koordinasyon sa iba’t ibang device:** magpadala ng gawain mula sa iyong telepono, hayaan ang Gateway na patakbuhin ito sa isang server, at makuha ang resulta pabalik sa chat.

### 30. Makakatulong ba ang OpenClaw sa lead gen, outreach, ads, at blogs para sa isang SaaS

Yes for **research, qualification, and drafting**. 32. Kaya nitong mag-scan ng mga site, bumuo ng mga shortlist,
buodin ang mga prospect, at magsulat ng mga draft ng outreach o ad copy.

For **outreach or ad runs**, keep a human in the loop. 34. Iwasan ang spam, sundin ang mga lokal na batas at
mga patakaran ng platform, at suriin ang anumang bagay bago ito ipadala. 35. Ang pinakaligtas na pattern ay hayaang
mag-draft ang OpenClaw at ikaw ang mag-apruba.

36. Docs: [Security](/gateway/security).

### What are the advantages vs Claude Code for web development

OpenClaw is a **personal assistant** and coordination layer, not an IDE replacement. 39. Gamitin ang
Claude Code o Codex para sa pinakamabilis na direktang coding loop sa loob ng isang repo. Use OpenClaw when you
want durable memory, cross-device access, and tool orchestration.

Advantages:

- 42. **Persistent na memory + workspace** sa iba’t ibang session
- **Multi-platform access** (WhatsApp, Telegram, TUI, WebChat)
- **Tool orchestration** (browser, files, scheduling, hooks)
- 45. **Palaging naka-on na Gateway** (patakbuhin sa isang VPS, makipag-ugnayan mula kahit saan)
- **Nodes** for local browser/screen/camera/exec

47. Showcase: [https://openclaw.ai/showcase](https://openclaw.ai/showcase)

## 48. Mga kasanayan at automation

### 49. Paano ko iko-customize ang mga kasanayan nang hindi nadudumihan ang repo

50. Gumamit ng mga managed override sa halip na i-edit ang kopya ng repo. Put your changes in `~/.openclaw/skills/<name>/SKILL.md` (or add a folder via `skills.load.extraDirs` in `~/.openclaw/openclaw.json`). Precedence is `<workspace>/skills` > `~/.openclaw/skills` > bundled, so managed overrides win without touching git. Only upstream-worthy edits should live in the repo and go out as PRs.

### Can I load skills from a custom folder

Oo. Add extra directories via `skills.load.extraDirs` in `~/.openclaw/openclaw.json` (lowest precedence). Default precedence remains: `<workspace>/skills` → `~/.openclaw/skills` → bundled → `skills.load.extraDirs`. `clawhub` installs into `./skills` by default, which OpenClaw treats as `<workspace>/skills`.

### How can I use different models for different tasks

Today the supported patterns are:

- **Cron jobs**: isolated jobs can set a `model` override per job.
- **Sub-agents**: route tasks to separate agents with different default models.
- **On-demand switch**: use `/model` to switch the current session model at any time.

See [Cron jobs](/automation/cron-jobs), [Multi-Agent Routing](/concepts/multi-agent), and [Slash commands](/tools/slash-commands).

### The bot freezes while doing heavy work How do I offload that

Use **sub-agents** for long or parallel tasks. Sub-agents run in their own session,
return a summary, and keep your main chat responsive.

Ask your bot to "spawn a sub-agent for this task" or use `/subagents`.
Use `/status` in chat to see what the Gateway is doing right now (and whether it is busy).

Token tip: long tasks and sub-agents both consume tokens. If cost is a concern, set a
cheaper model for sub-agents via `agents.defaults.subagents.model`.

Docs: [Sub-agents](/tools/subagents).

### Cron or reminders do not fire What should I check

Cron runs inside the Gateway process. If the Gateway is not running continuously,
scheduled jobs will not run.

Checklist:

- Confirm cron is enabled (`cron.enabled`) and `OPENCLAW_SKIP_CRON` is not set.
- Check the Gateway is running 24/7 (no sleep/restarts).
- Verify timezone settings for the job (`--tz` vs host timezone).

Debug:

```bash
openclaw cron run <jobId> --force
openclaw cron runs --id <jobId> --limit 50
```

Docs: [Cron jobs](/automation/cron-jobs), [Cron vs Heartbeat](/automation/cron-vs-heartbeat).

### How do I install skills on Linux

Use **ClawHub** (CLI) or drop skills into your workspace. The macOS Skills UI isn't available on Linux.
Browse skills at [https://clawhub.com](https://clawhub.com).

Install the ClawHub CLI (pick one package manager):

```bash
npm i -g clawhub
```

```bash
pnpm add -g clawhub
```

### Can OpenClaw run tasks on a schedule or continuously in the background

Oo. Use the Gateway scheduler:

- **Cron jobs** for scheduled or recurring tasks (persist across restarts).
- **Heartbeat** for "main session" periodic checks.
- **Isolated jobs** for autonomous agents that post summaries or deliver to chats.

Docs: [Cron jobs](/automation/cron-jobs), [Cron vs Heartbeat](/automation/cron-vs-heartbeat),
[Heartbeat](/gateway/heartbeat).

### Can I run Apple macOS-only skills from Linux?

Not directly. macOS skills are gated by `metadata.openclaw.os` plus required binaries, and skills only appear in the system prompt when they are eligible on the **Gateway host**. On Linux, `darwin`-only skills (like `apple-notes`, `apple-reminders`, `things-mac`) will not load unless you override the gating.

You have three supported patterns:

**Option A - run the Gateway on a Mac (simplest).**
Run the Gateway where the macOS binaries exist, then connect from Linux in [remote mode](#how-do-i-run-openclaw-in-remote-mode-client-connects-to-a-gateway-elsewhere) or over Tailscale. The skills load normally because the Gateway host is macOS.

**Option B - use a macOS node (no SSH).**
Run the Gateway on Linux, pair a macOS node (menubar app), and set **Node Run Commands** to "Always Ask" or "Always Allow" on the Mac. OpenClaw can treat macOS-only skills as eligible when the required binaries exist on the node. 1. Pinapatakbo ng agent ang mga kasanayang iyon sa pamamagitan ng tool na `nodes`. 2. Kung pipiliin mo ang "Always Ask", ang pag-apruba sa "Always Allow" sa prompt ay nagdaragdag ng command na iyon sa allowlist.

3. **Option C - i-proxy ang macOS binaries sa SSH (advanced).**
   Panatilihin ang Gateway sa Linux, ngunit gawin na ang mga kinakailangang CLI binary ay mag-resolve sa mga SSH wrapper na tumatakbo sa isang Mac. 4. Pagkatapos, i-override ang skill upang payagan ang Linux para manatili itong eligible.

1. 5. Gumawa ng SSH wrapper para sa binary (halimbawa: `memo` para sa Apple Notes):

   ```bash
   6. #!/usr/bin/env bash
   set -euo pipefail
   exec ssh -T user@mac-host /opt/homebrew/bin/memo "$@"
   ```

2. 7. Ilagay ang wrapper sa `PATH` sa Linux host (halimbawa `~/bin/memo`).

3. 8. I-override ang metadata ng skill (workspace o `~/.openclaw/skills`) upang payagan ang Linux:

   ```markdown
   9. ---
   name: apple-notes
   description: Manage Apple Notes via the memo CLI on macOS.
   metadata: { "openclaw": { "os": ["darwin", "linux"], "requires": { "bins": ["memo"] } } }
   ---
   ```

4. 10. Magsimula ng bagong session upang ma-refresh ang snapshot ng mga skill.

### 11) Mayroon ka bang Notion o HeyGen integration

12. Wala pang built-in sa ngayon.

Options:

- 13. **Custom skill / plugin:** pinakamainam para sa maaasahang access sa API (may APIs ang Notion/HeyGen).
- 14. **Browser automation:** gumagana kahit walang code ngunit mas mabagal at mas marupok.

15. Kung gusto mong panatilihin ang context kada kliyente (agency workflows), isang simpleng pattern ay:

- 16. Isang Notion page bawat kliyente (context + preferences + aktibong trabaho).
- 17. Ipagawa sa agent na kunin ang page na iyon sa simula ng isang session.

18. Kung gusto mo ng native integration, magbukas ng feature request o bumuo ng skill na naka-target sa mga API na iyon.

19. Mag-install ng mga skill:

```bash
20. clawhub install <skill-slug>
clawhub update --all
```

21. Nag-i-install ang ClawHub sa `./skills` sa ilalim ng iyong kasalukuyang directory (o babalik sa iyong naka-configure na OpenClaw workspace); itinuturing ito ng OpenClaw bilang `<workspace>/skills` sa susunod na session. 22. Para sa mga shared skill sa iba’t ibang agent, ilagay ang mga ito sa `~/.openclaw/skills/<name>/SKILL.md`. 23. May ilang skill na inaasahang may mga binary na naka-install via Homebrew; sa Linux, ibig sabihin nito ay Linuxbrew (tingnan ang Homebrew Linux FAQ entry sa itaas). 24. Tingnan ang [Skills](/tools/skills) at [ClawHub](/tools/clawhub).

### How do I install the Chrome extension for browser takeover

26. Gamitin ang built-in installer, pagkatapos ay i-load ang unpacked extension sa Chrome:

```bash
openclaw browser extension install
openclaw browser extension path
```

Then Chrome → `chrome://extensions` → enable "Developer mode" → "Load unpacked" → pick that folder.

Full guide (including remote Gateway + security notes): [Chrome extension](/tools/chrome-extension)

If the Gateway runs on the same machine as Chrome (default setup), you usually **do not** need anything extra.
Kung tumatakbo ang Gateway sa ibang lugar, magpatakbo ng node host sa machine ng browser para ma-proxy ng Gateway ang mga aksyon ng browser.
You still need to click the extension button on the tab you want to control (it doesn't auto-attach).

## Sandboxing and memory

### 32. Mayroon bang nakalaang dokumento para sa sandboxing

Oo. 33. Tingnan ang [Sandboxing](/gateway/sandboxing). 34. Para sa Docker-specific na setup (buong gateway sa Docker o mga sandbox image), tingnan ang [Docker](/install/docker).

### Docker feels limited How do I enable full features

The default image is security-first and runs as the `node` user, so it does not
include system packages, Homebrew, or bundled browsers. For a fuller setup:

- Persist `/home/node` with `OPENCLAW_HOME_VOLUME` so caches survive.
- 39. I-bake ang mga system dependency sa image gamit ang `OPENCLAW_DOCKER_APT_PACKAGES`.
- I-install ang mga Playwright browser gamit ang kasamang CLI:
  `node /app/node_modules/playwright-core/cli.js install chromium`
- Set `PLAYWRIGHT_BROWSERS_PATH` and ensure the path is persisted.

42. Docs: [Docker](/install/docker), [Browser](/tools/browser).

43. **Maaari ko bang panatilihing personal ang DMs ngunit gawing public sandboxed ang mga grupo gamit ang isang agent**

Yes - if your private traffic is **DMs** and your public traffic is **groups**.

Use `agents.defaults.sandbox.mode: "non-main"` so group/channel sessions (non-main keys) run in Docker, while the main DM session stays on-host. 46. Pagkatapos, higpitan kung anong mga tool ang available sa mga sandboxed session sa pamamagitan ng `tools.sandbox.tools`.

Setup walkthrough + example config: [Groups: personal DMs + public groups](/channels/groups#pattern-personal-dms-public-groups-single-agent)

Key config reference: [Gateway configuration](/gateway/configuration#agentsdefaultssandbox)

### How do I bind a host folder into the sandbox

50. Itakda ang `agents.defaults.sandbox.docker.binds` sa `["host:path:mode"]` (hal., `"/home/user/src:/src:ro"`). Pinagsasama ang global at per-agent binds; hindi pinapansin ang per-agent binds kapag `scope: "shared"`. Gamitin ang `:ro` para sa anumang sensitibo at tandaan na nilalampasan ng binds ang mga pader ng sandbox filesystem. See [Sandboxing](/gateway/sandboxing#custom-bind-mounts) and [Sandbox vs Tool Policy vs Elevated](/gateway/sandbox-vs-tool-policy-vs-elevated#bind-mounts-security-quick-check) for examples and safety notes.

### Paano gumagana ang memory

Ang memory ng OpenClaw ay mga Markdown file lang sa agent workspace:

- Mga daily note sa `memory/YYYY-MM-DD.md`
- Mga piniling pangmatagalang note sa `MEMORY.md` (mga main/private session lang)

Nagpapatakbo rin ang OpenClaw ng **silent pre-compaction memory flush** para paalalahanan ang modelo na magsulat ng matitibay na note bago ang auto-compaction. Tingnan ang [Memory](/concepts/memory).

### Patuloy na nakakalimot ang memorya ng mga bagay. Paano ko ito mapananatili

Ask the bot to **write the fact to memory**. Paulit-ulit na nakakalimot ang memory. Paano ko ito mapapadikit

Sabihin sa bot na **isulat ang katotohanan sa memory**. Ang mga pangmatagalang note ay dapat nasa `MEMORY.md`, ang panandaliang konteksto ay napupunta sa `memory/YYYY-MM-DD.md`.

Ito ay bahagi pa ring pinapabuti namin.

### Nakakatulong na paalalahanan ang modelo na mag-imbak ng mga memory;

malalaman nito kung ano ang gagawin. Kung patuloy itong nakakalimot, tiyaking ginagamit ng Gateway ang parehong workspace sa bawat run.

If you don't set a provider explicitly, OpenClaw auto-selects a provider when it
can resolve an API key (auth profiles, `models.providers.*.apiKey`, or env vars).
It prefers OpenAI if an OpenAI key resolves, otherwise Gemini if a Gemini key
resolves. Kung gagamit ka lang ng **OpenAI embeddings**. If you have a local model path configured and present, OpenClaw
prefers `local`.

If you'd rather stay local, set `memorySearch.provider = "local"` (and optionally
`memorySearch.fallback = "none"`). If you want Gemini embeddings, set
`memorySearch.provider = "gemini"` and provide `GEMINI_API_KEY` (or
`memorySearch.remote.apiKey`). Ang OpenAI embeddings

### Nagpapatuloy ba ang memorya magpakailanman? Ano ang mga limitasyon

Kung hindi ka magtatakda ng provider nang tahasan, awtomatikong pumipili ang OpenClaw ng provider kapag kaya nitong The limit is your
storage, not the model. The **session context** is still limited by the model
context window, so long conversations can compact or truncate. Kung walang available na key, mananatiling naka-disable ang memory search hanggang sa

ma-configure mo ito.

## Where things live on disk

### ang `local`.

No - **OpenClaw's state is local**, but **external services still see what you send them**.

- `memorySearch.fallback = "none"`).
- **Remote by necessity:** messages you send to model providers (Anthropic/OpenAI/etc.) go to
  their APIs, and chat platforms (WhatsApp/Telegram/Slack/etc.) `memorySearch.remote.apiKey`).
- **You control the footprint:** using local models keeps prompts on your machine, but channel
  traffic still goes through the channel's servers.

model - tingnan ang [Memory](/concepts/memory) para sa mga detalye ng setup.

### Nananatili ba ang memory magpakailanman? Ano ang mga limitasyon

Ang mga memory file ay nasa disk at nananatili hanggang sa burahin mo ang mga ito.

| Ang limitasyon ay ang iyong                                                                       | Layunin                                                                                       |
| ------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `$OPENCLAW_STATE_DIR/openclaw.json`                                                               | Ang **session context** ay limitado pa rin ng model                                           |
| context window, kaya ang mahahabang pag-uusap ay maaaring i-compact o i-truncate. | Iyan ang dahilan kung bakit umiiral ang                                                       |
| `$OPENCLAW_STATE_DIR/agents/<agentId>/agent/auth-profiles.json`                                   | Mga auth profile (OAuth + API keys)                                        |
| `$OPENCLAW_STATE_DIR/agents/<agentId>/agent/auth.json`                                            | Runtime auth cache (awtomatikong pinamamahalaan)                           |
| `$OPENCLAW_STATE_DIR/credentials/`                                                                | State ng provider (hal. `whatsapp/<accountId>/creds.json`) |
| `$OPENCLAW_STATE_DIR/agents/`                                                                     | Per-agent na state (agentDir + mga session)                                |
| `$OPENCLAW_STATE_DIR/agents/<agentId>/sessions/`                                                  | Kasaysayan at state ng usapan (per agent)                                  |
| `$OPENCLAW_STATE_DIR/agents/<agentId>/sessions/sessions.json`                                     | Metadata ng session (per agent)                                            |

Legacy na single-agent path: `~/.openclaw/agent/*` (minigrate ng `openclaw doctor`).

Ang iyong **workspace** (AGENTS.md, mga memory file, skills, atbp.) ay hiwalay at kino-configure sa pamamagitan ng `agents.defaults.workspace` (default: `~/.openclaw/workspace`).

### Saan dapat nakalagay ang AGENTSmd SOULmd USERmd MEMORYmd

These files live in the **agent workspace**, not `~/.openclaw`.

- **Workspace (per agent)**: `AGENTS.md`, `SOUL.md`, `IDENTITY.md`, `USER.md`,
  `MEMORY.md` (o `memory.md`), `memory/YYYY-MM-DD.md`, opsyonal na `HEARTBEAT.md`.
- **State dir (`~/.openclaw`)**: config, credentials, mga auth profile, mga session, logs,
  at mga shared skill (`~/.openclaw/skills`).

Ang default workspace ay `~/.openclaw/workspace`, maaaring baguhin sa pamamagitan ng:

```json5
{
  agents: { defaults: { workspace: "~/.openclaw/workspace" } },
}
```

Kung ang bot ay "nakakalimot" pagkatapos mag-restart, tiyaking ginagamit ng Gateway ang parehong
workspace sa bawat paglunsad (at tandaan: ang remote mode ay gumagamit ng **workspace ng gateway host**, hindi ng iyong lokal na laptop).

Tip: kung gusto mo ng matibay na behavior o preference, hilingin sa bot na **isulat ito sa
AGENTS.md o MEMORY.md** sa halip na umasa sa chat history.

Tingnan ang [Agent workspace](/concepts/agent-workspace) at [Memory](/concepts/memory).

### What's the recommended backup strategy

Ilagay ang iyong **agent workspace** sa isang **pribadong** git repo at i-backup ito sa isang
pribadong lugar (halimbawa, GitHub private). Kinukuha nito ang memory + mga file ng AGENTS/SOUL/USER,
files, at hinahayaan kang maibalik ang "isip" ng assistant sa kalaunan.

Do **not** commit anything under `~/.openclaw` (credentials, sessions, tokens).
If you need a full restore, back up both the workspace and the state directory
separately (see the migration question above).

Docs: [Agent workspace](/concepts/agent-workspace).

### Paano ko ganap na ia-uninstall ang OpenClaw

Tingnan ang nakalaang gabay: [Uninstall](/install/uninstall).

### Maaari bang gumana ang mga agent sa labas ng workspace

Oo. The workspace is the **default cwd** and memory anchor, not a hard sandbox.
Relative paths resolve inside the workspace, but absolute paths can access other
host locations unless sandboxing is enabled. If you need isolation, use
[`agents.defaults.sandbox`](/gateway/sandboxing) or per-agent sandbox settings. If you
want a repo to be the default working directory, point that agent's
`workspace` to the repo root. Ang OpenClaw repo ay source code lamang; panatilihing hiwalay ang
workspace maliban kung sadyang gusto mong magtrabaho ang agent sa loob nito.

Halimbawa (repo bilang default cwd):

```json5
{
  agents: {
    defaults: {
      workspace: "~/Projects/my-repo",
    },
  },
}
```

### Im in remote mode where is the session store

Session state is owned by the **gateway host**. Kung nasa remote mode ka, ang session store na mahalaga ay nasa remote machine, hindi sa iyong lokal na laptop. See [Session management](/concepts/session).

## Config basics

### What format is the config Where is it

OpenClaw reads an optional **JSON5** config from `$OPENCLAW_CONFIG_PATH` (default: `~/.openclaw/openclaw.json`):

```
$OPENCLAW_CONFIG_PATH
```

Kung nawawala ang file, gagamit ito ng medyo ligtas na mga default (kabilang ang default workspace na `~/.openclaw/workspace`).

### I set gatewaybind lan or tailnet and now nothing listens the UI says unauthorized

Ang mga non-loopback bind ay **nangangailangan ng auth**. Configure `gateway.auth.mode` + `gateway.auth.token` (or use `OPENCLAW_GATEWAY_TOKEN`).

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

Mga tala:

- Ang `gateway.remote.token` ay para **sa mga remote CLI call lamang**; hindi nito pinapagana ang local gateway auth.
- The Control UI authenticates via `connect.params.auth.token` (stored in app/UI settings). Avoid putting tokens in URLs.

### Bakit kailangan ko na ngayon ng token sa localhost

The wizard generates a gateway token by default (even on loopback) so **local WS clients must authenticate**. Pinipigilan nito ang ibang lokal na proseso na tumawag sa Gateway. Paste the token into the Control UI settings (or your client config) to connect.

If you **really** want open loopback, remove `gateway.auth` from your config. Doctor can generate a token for you any time: `openclaw doctor --generate-gateway-token`.

### Do I have to restart after changing config

The Gateway watches the config and supports hot-reload:

- `gateway.reload.mode: "hybrid"` (default): hot-apply safe changes, restart for critical ones
- `hot`, `restart`, `off` are also supported

### How do I enable web search and web fetch

`web_fetch` works without an API key. `web_search` requires a Brave Search API
key. **Recommended:** run `openclaw configure --section web` to store it in
`tools.web.search.apiKey`. Environment alternative: set `BRAVE_API_KEY` for the
Gateway process.

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

Mga tala:

- If you use allowlists, add `web_search`/`web_fetch` or `group:web`.
- Ang `web_fetch` ay naka-enable bilang default (maliban kung tahasang i-disable).
- Daemons read env vars from `~/.openclaw/.env` (or the service environment).

Docs: [Web tools](/tools/web).

### How do I run a central Gateway with specialized workers across devices

Ang karaniwang pattern ay **isang Gateway** (hal. Raspberry Pi) kasama ang **mga node** at **mga agent**:

- **Gateway (sentral):** nagmamay-ari ng mga channel (Signal/WhatsApp), routing, at mga session.
- **Mga Node (mga device):** kumokonek ang Macs/iOS/Android bilang peripherals at nag-eexpose ng mga lokal na tool (`system.run`, `canvas`, `camera`).
- **Agents (workers):** separate brains/workspaces for special roles (e.g. "Hetzner ops", "Personal data").
- **Sub-agents:** spawn background work from a main agent when you want parallelism.
- **TUI:** kumokonek sa Gateway at nagpapalit ng mga agent/session.

Docs: [Nodes](/nodes), [Remote access](/gateway/remote), [Multi-Agent Routing](/concepts/multi-agent), [Sub-agents](/tools/subagents), [TUI](/web/tui).

### Maaari bang tumakbo ang OpenClaw browser nang headless

Oo. Isa itong opsyon sa config:

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

Ang default ay `false` (may UI/headful). Mas malamang na mag-trigger ang headless ng mga anti-bot check sa ilang site. Tingnan ang [Browser](/tools/browser).

Gumagamit ang headless ng **parehong Chromium engine** at gumagana para sa karamihan ng automation (mga form, click, scraping, login). The main differences:

- Walang nakikitang browser window (gumamit ng mga screenshot kung kailangan mo ng visuals).
- Mas mahigpit ang ilang site laban sa automation sa headless mode (CAPTCHA, anti-bot).
  Halimbawa, madalas hinaharangan ng X/Twitter ang mga headless session.

### Paano ko gagamitin ang Brave para sa browser control

Itakda ang `browser.executablePath` sa iyong Brave binary (o anumang Chromium-based na browser) at i-restart ang Gateway.
Tingnan ang buong mga halimbawa ng config sa [Browser](/tools/browser#use-brave-or-another-chromium-based-browser).

## Mga remote gateway at node

### Paano nagpo-propagate ang mga command sa pagitan ng Telegram, ng gateway, at ng mga node

Ang mga mensahe sa Telegram ay hinahawakan ng **gateway**. Pinapatakbo ng gateway ang agent at
saka lamang tumatawag sa mga node sa pamamagitan ng **Gateway WebSocket** kapag kailangan ang isang node tool:

Telegram → Gateway → Agent → `node.*` → Node → Gateway → Telegram

Hindi nakikita ng mga node ang inbound provider traffic; tumatanggap lamang sila ng mga node RPC call.

### Paano maa-access ng aking agent ang aking computer kung ang Gateway ay naka-host nang remote

Short answer: **pair your computer as a node**. The Gateway runs elsewhere, but it can
call `node.*` tools (screen, camera, system) on your local machine over the Gateway WebSocket.

Typical setup:

1. Run the Gateway on the always-on host (VPS/home server).
2. Put the Gateway host + your computer on the same tailnet.
3. Ensure the Gateway WS is reachable (tailnet bind or SSH tunnel).
4. Open the macOS app locally and connect in **Remote over SSH** mode (or direct tailnet)
   so it can register as a node.
5. Approve the node on the Gateway:

   ```bash
   openclaw nodes pending
   openclaw nodes approve <requestId>
   ```

No separate TCP bridge is required; nodes connect over the Gateway WebSocket.

Security reminder: pairing a macOS node allows `system.run` on that machine. Only
pair devices you trust, and review [Security](/gateway/security).

Docs: [Nodes](/nodes), [Gateway protocol](/gateway/protocol), [macOS remote mode](/platforms/mac/remote), [Security](/gateway/security).

### Tailscale is connected but I get no replies What now

Check the basics:

- Gateway is running: `openclaw gateway status`
- Gateway health: `openclaw status`
- Channel health: `openclaw channels status`

Then verify auth and routing:

- If you use Tailscale Serve, make sure `gateway.auth.allowTailscale` is set correctly.
- If you connect via SSH tunnel, confirm the local tunnel is up and points at the right port.
- Confirm your allowlists (DM or group) include your account.

Docs: [Tailscale](/gateway/tailscale), [Remote access](/gateway/remote), [Channels](/channels).

### Can two OpenClaw instances talk to each other local VPS

Oo. There is no built-in "bot-to-bot" bridge, but you can wire it up in a few
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

Hindi. One Gateway can host multiple agents, each with its own workspace, model defaults,
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
**node**. That keeps a single Gateway and avoids duplicated config. Ang mga lokal na node tool ay kasalukuyang macOS-only, ngunit plano naming palawakin ang mga ito sa iba pang OS.

Mag-install ng pangalawang Gateway **lamang kapag kailangan mo ng hard isolation** o dalawang ganap na hiwalay na bot.

Docs: [Nodes](/nodes), [Nodes CLI](/cli/nodes), [Multiple gateways](/gateway/multiple-gateways).

### Nagpapatakbo ba ang mga node ng gateway service

Hindi. **Isang gateway lamang** ang dapat tumakbo bawat host maliban kung sinasadya mong magpatakbo ng mga isolated profile (tingnan ang [Multiple gateways](/gateway/multiple-gateways)). Ang mga node ay mga peripheral na kumokonekta sa gateway (mga iOS/Android node, o macOS "node mode" sa menubar app). Para sa mga headless node host at kontrol gamit ang CLI, tingnan ang [Node host CLI](/cli/node).

Kailangan ng buong restart para sa mga pagbabago sa `gateway`, `discovery`, at `canvasHost`.

### Mayroon bang API RPC na paraan para i-apply ang config

Oo. Ang `config.apply` ay nagva-validate + nagsusulat ng buong config at nire-restart ang Gateway bilang bahagi ng operasyon.

### Binura ng configapply ang aking config. Paano ako magre-recover at maiiwasan ito

Pinapalitan ng `config.apply` ang **buong config**. Kung magpapadala ka ng partial na object, ang lahat ng iba pa ay aalisin.

I-recover:

- I-restore mula sa backup (git o isang kinopyang `~/.openclaw/openclaw.json`).
- Kung wala kang backup, patakbuhin muli ang `openclaw doctor` at i-reconfigure ang mga channel/model.
- Kung hindi ito inaasahan, mag-file ng bug at isama ang huli mong kilalang config o anumang backup.
- Madalas na kayang buuing muli ng isang lokal na coding agent ang isang gumaganang config mula sa mga log o history.

Iwasan ito:

- Gamitin ang `openclaw config set` para sa maliliit na pagbabago.
- Gamitin ang `openclaw configure` para sa interactive na pag-edit.

Docs: [Config](/cli/config), [Configure](/cli/configure), [Doctor](/gateway/doctor).

### Ano ang minimal at matinong config para sa unang install

```json5
{
  agents: { defaults: { workspace: "~/.openclaw/workspace" } },
  channels: { whatsapp: { allowFrom: ["+15555550123"] } },
}
```

Itinatakda nito ang iyong workspace at nililimitahan kung sino ang maaaring mag-trigger ng bot.

### Paano ako magse-set up ng Tailscale sa isang VPS at kumonekta mula sa aking Mac

Minimal na mga hakbang:

1. **I-install + mag-login sa VPS**

   ```bash
   curl -fsSL https://tailscale.com/install.sh | sh
   sudo tailscale up
   ```

2. **I-install + mag-login sa iyong Mac**
   - Gamitin ang Tailscale app at mag-sign in sa parehong tailnet.

3. **I-enable ang MagicDNS (inirerekomenda)**
   - Sa Tailscale admin console, i-enable ang MagicDNS para magkaroon ang VPS ng stable na pangalan.

4. **Gamitin ang tailnet hostname**
   - SSH: `ssh user@your-vps.tailnet-xxxx.ts.net`
   - Gateway WS: `ws://your-vps.tailnet-xxxx.ts.net:18789`

Kung gusto mo ang Control UI nang walang SSH, gamitin ang Tailscale Serve sa VPS:

```bash
openclaw gateway --tailscale serve
```

Pinananatili nitong naka-bind ang gateway sa loopback at inilalantad ang HTTPS sa pamamagitan ng Tailscale. Tingnan ang [Tailscale](/gateway/tailscale).

### Paano ako kumokonekta ng isang Mac node sa isang remote Gateway Tailscale Serve

Inilalantad ng Serve ang **Gateway Control UI + WS**. Kumokonekta ang mga node sa parehong Gateway WS endpoint.

Inirerekomendang setup:

1. **Siguraduhing nasa parehong tailnet ang VPS + Mac**.
2. **Gamitin ang macOS app sa Remote mode** (ang SSH target ay maaaring ang tailnet hostname).
   Ita-tunnel ng app ang Gateway port at kokonekta bilang isang node.
3. **Aprubahan ang node** sa gateway:

   ```bash
   openclaw nodes pending
   openclaw nodes approve <requestId>
   ```

Docs: [Gateway protocol](/gateway/protocol), [Discovery](/gateway/discovery), [macOS remote mode](/platforms/mac/remote).

## Mga env var at .env loading

### Paano nilo-load ng OpenClaw ang mga environment variable

Binabasa ng OpenClaw ang mga env var mula sa parent process (shell, launchd/systemd, CI, atbp.) at dagdag pa nitong nilo-load:

- `.env` mula sa kasalukuyang working directory
- isang global fallback na `.env` mula sa `~/.openclaw/.env` (aka `$OPENCLAW_STATE_DIR/.env`)

Hindi ina‑override ng alinmang `.env` file ang mga umiiral na env var.

2. Maaari ka ring magtakda ng inline env vars sa config (ilalapat lamang kung wala sa process env):

```json5
3. {
  env: {
    OPENROUTER_API_KEY: "sk-or-...",
    vars: { GROQ_API_KEY: "gsk-..." },
  },
}
```

Tingnan ang [/environment](/help/environment) para sa buong precedence at mga source.

### 4. Sinimulan ko ang Gateway sa pamamagitan ng service at nawala ang aking env vars. Ano na ngayon

5. Dalawang karaniwang ayos:

1. 6. Ilagay ang mga nawawalang key sa `~/.openclaw/.env` para makuha pa rin ang mga ito kahit hindi minamana ng service ang iyong shell env.
2. I-enable ang shell import (opt-in na convenience):

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

Pinapatakbo nito ang iyong login shell at ini-import lamang ang mga nawawalang inaasahang key (hindi kailanman nag-o-override). 9. Mga katumbas na env var:
`OPENCLAW_LOAD_SHELL_ENV=1`, `OPENCLAW_SHELL_ENV_TIMEOUT_MS=15000`.

### 10. Itinakda ko ang COPILOTGITHUBTOKEN pero ipinapakita ng models status na naka-off ang Shell env. Bakit

`openclaw models status` nag-uulat kung naka-enable ang **shell env import**. "Shell env: off"hindi **nangangahulugang** nawawala ang iyong env vars — ibig sabihin lang nito ay hindi awtomatikong ilo-load ng OpenClaw ang iyong login shell.

13. Kung ang Gateway ay tumatakbo bilang isang service (launchd/systemd), hindi nito mamanahin ang iyong shell environment. 14. Ayusin sa pamamagitan ng paggawa ng isa sa mga ito:

1. Ilagay ang token sa `~/.openclaw/.env`:

   ```
   16. COPILOT_GITHUB_TOKEN=...
   ```

2. 17. O paganahin ang shell import (`env.shellEnv.enabled: true`).

3. O idagdag ito sa iyong config na `env` block (naaangkop lamang kung wala pa).

Pagkatapos ay i-restart ang gateway at muling suriin:

```bash
openclaw models status
```

20. Binabasa ang mga Copilot token mula sa `COPILOT_GITHUB_TOKEN` (pati `GH_TOKEN` / `GITHUB_TOKEN`).
21. Tingnan ang [/concepts/model-providers](/concepts/model-providers) at [/environment](/help/environment).

## Mga session at maraming chat

### Paano ako magsisimula ng bagong pag-uusap

Magpadala ng `/new` o `/reset` bilang hiwalay na mensahe. Tingnan ang [Session management](/concepts/session).

### Awtomatikong nagre-reset ba ang mga session kung hindi ako kailanman magpapadala ng bago

Oo. 27. Nag-e-expire ang mga session pagkatapos ng `session.idleMinutes` (default **60**). Ang **susunod**
mensaheng ipapadala ay magsisimula ng bagong session id para sa chat key na iyon. Hindi nito binubura ang mga transcript — nagsisimula lang ito ng bagong session.

```json5
30. {
  session: {
    idleMinutes: 240,
  },
}
```

### May paraan ba para gawing isang CEO at maraming agent ang isang team ng mga OpenClaw instance

Oo, sa pamamagitan ng **multi-agent routing** at **sub-agents**. Maaari kang lumikha ng isang coordinator agent at ilang worker agent na may kani-kanilang workspace at mga model.

Gayunpaman, mas mainam itong ituring bilang isang **masayang eksperimento**. 35. Mabigat ito sa token at kadalasang mas hindi episyente kaysa gumamit ng isang bot na may magkakahiwalay na session. 36. Ang karaniwang modelong naiisip namin ay isang bot na kausap mo, na may iba’t ibang session para sa sabayang gawain. 37. Ang bot na iyon ay maaari ring mag-spawn ng mga sub-agent kapag kinakailangan.

Docs: [Multi-agent routing](/concepts/multi-agent), [Sub-agents](/tools/subagents), [Agents CLI](/cli/agents).

### Bakit naputol ang context sa gitna ng gawain Paano ko ito maiiwasan

40. Ang session context ay limitado ng window ng model. 41. Ang mahahabang chat, malalaking output ng tool, o maraming file ay maaaring mag-trigger ng compaction o truncation.

42. Ano ang nakakatulong:

- Hilingin sa bot na ibuod ang kasalukuyang estado at isulat ito sa isang file.
- 44. Gamitin ang `/compact` bago ang mahahabang gawain, at `/new` kapag nagpapalit ng paksa.
- 45. Panatilihin ang mahalagang context sa workspace at hilingin sa bot na basahin itong muli.
- Gumamit ng mga sub-agent para sa mahahaba o sabayang gawain upang manatiling mas maliit ang pangunahing chat.
- 47. Pumili ng model na may mas malaking context window kung madalas itong mangyari.

### Paano ko ganap na ire-reset ang OpenClaw pero panatilihing naka-install

Gamitin ang reset command:

```bash
openclaw reset
```

Non-interactive na full reset:

```bash
openclaw reset --scope full --yes --non-interactive
```

Then re-run onboarding:

```bash
openclaw onboard --install-daemon
```

Mga tala:

- The onboarding wizard also offers **Reset** if it sees an existing config. See [Wizard](/start/wizard).
- If you used profiles (`--profile` / `OPENCLAW_PROFILE`), reset each state dir (defaults are `~/.openclaw-<profile>`).
- Dev reset: `openclaw gateway --dev --reset` (dev-only; wipes dev config + credentials + sessions + workspace).

### Nakakakuha ako ng mga error na masyadong malaki ang context paano ako magre-reset o magko-compact

Gamitin ang isa sa mga ito:

- **Compact** (keeps the conversation but summarizes older turns):

  ```
  /compact
  ```

  or `/compact <instructions>` to guide the summary.

- **Reset** (bagong session ID para sa parehong chat key):

  ```
  /new
  /reset
  ```

If it keeps happening:

- I-enable o i-tune ang **session pruning** (`agents.defaults.contextPruning`) para putulin ang lumang tool output.
- Use a model with a larger context window.

Docs: [Compaction](/concepts/compaction), [Session pruning](/concepts/session-pruning), [Session management](/concepts/session).

### Why am I seeing LLM request rejected messagesNcontentXtooluseinput Field required

This is a provider validation error: the model emitted a `tool_use` block without the required
`input`. It usually means the session history is stale or corrupted (often after long threads
or a tool/schema change).

Fix: start a fresh session with `/new` (standalone message).

### Bakit ako nakakakuha ng mga heartbeat message tuwing 30 minuto

Tumatakbo ang mga heartbeat tuwing **30m** bilang default. I-tune o i-disable ang mga ito:

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
Kung nawawala ang file, tatakbo pa rin ang heartbeat at ang model ang magpapasya kung ano ang gagawin.

Per-agent overrides use `agents.list[].heartbeat`. Docs: [Heartbeat](/gateway/heartbeat).

### Do I need to add a bot account to a WhatsApp group

Hindi. Tumatakbo ang OpenClaw sa **sarili mong account**, kaya kung kasama ka sa grupo, makikita ito ng OpenClaw.
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

### Paano ko makukuha ang JID ng isang WhatsApp group

Option 1 (fastest): tail logs and send a test message in the group:

```bash
openclaw logs --follow --json
```

Hanapin ang `chatId` (o `from`) na nagtatapos sa `@g.us`, tulad ng:
`1234567890-1234567890@g.us`.

Option 2 (if already configured/allowlisted): list groups from config:

```bash
openclaw directory groups list --channel whatsapp
```

Docs: [WhatsApp](/channels/whatsapp), [Directory](/cli/directory), [Logs](/cli/logs).

### Bakit hindi sumasagot ang OpenClaw sa isang grupo

Dalawang karaniwang sanhi:

- Mention gating is on (default). Kailangan mong i-@mention ang bot (o tumugma sa `mentionPatterns`).
- Na-configure mo ang `channels.whatsapp.groups` nang walang "\*" at ang grupo ay wala sa allowlist.

See [Groups](/channels/groups) and [Group messages](/channels/group-messages).

### Nagbabahagi ba ng context ang mga group thread sa mga DM

Direct chats collapse to the main session by default. Groups/channels have their own session keys, and Telegram topics / Discord threads are separate sessions. See [Groups](/channels/groups) and [Group messages](/channels/group-messages).

### Ilang workspace at agent ang maaari kong likhain

1. Walang mahihigpit na limitasyon. 2. Ayos lang ang dose-dosenang (kahit daan-daan), pero bantayan ang:

- **Paglaki ng disk:** ang mga session + transcript ay nasa ilalim ng `~/.openclaw/agents/<agentId>/sessions/`.
- 4. **Gastos sa token:** mas maraming agent ay nangangahulugan ng mas maraming sabayang paggamit ng modelo.
- 5. **Ops overhead:** mga auth profile kada agent, workspace, at pag-route ng channel.

Mga tip:

- 6. Panatilihin ang isang **aktibong** workspace kada agent (`agents.defaults.workspace`).
- I-prune ang mga lumang session (burahin ang JSONL o store entries) kung lumalaki ang disk.
- Gamitin ang `openclaw doctor` upang makita ang mga ligaw na workspace at mga hindi tugmang profile.

### Can I run multiple bots or chats at the same time Slack and how should I set that up

Oo. 10. Gamitin ang **Multi-Agent Routing** para magpatakbo ng maraming hiwa-hiwalay na agent at i-route ang mga papasok na mensahe ayon sa channel/account/peer. 11. Sinusuportahan ang Slack bilang channel at maaaring i-bind sa mga partikular na agent.

Browser access is powerful but not "do anything a human can" - anti-bot, CAPTCHAs, and MFA can
still block automation. For the most reliable browser control, use the Chrome extension relay
on the machine that runs the browser (and keep the Gateway anywhere).

Best-practice setup:

- 15. Always-on na Gateway host (VPS/Mac mini).
- One agent per role (bindings).
- Slack channel(s) bound to those agents.
- Local browser via extension relay (or a node) when needed.

Docs: [Multi-Agent Routing](/concepts/multi-agent), [Slack](/channels/slack),
[Browser](/tools/browser), [Chrome extension](/tools/chrome-extension), [Nodes](/nodes).

## Models: defaults, selection, aliases, switching

### What is the default model

OpenClaw's default model is whatever you set as:

```
agents.defaults.model.primary
```

Models are referenced as `provider/model` (example: `anthropic/claude-opus-4-6`). If you omit the provider, OpenClaw currently assumes `anthropic` as a temporary deprecation fallback - but you should still **explicitly** set `provider/model`.

### What model do you recommend

26. **Inirerekomendang default:** `anthropic/claude-opus-4-6`.
27. **Magandang alternatibo:** `anthropic/claude-sonnet-4-5`.
    **Reliable (less character):** `openai/gpt-5.2` - nearly as good as Opus, just less personality.
    **Budget:** `zai/glm-4.7`.

MiniMax M2.1 has its own docs: [MiniMax](/providers/minimax) and
[Local models](/gateway/local-models).

31. Rule of thumb: gamitin ang **pinakamahusay na modelong kaya ng budget** para sa high-stakes na gawain, at mas murang modelo para sa karaniwang chat o mga buod. 32. Maaari kang mag-route ng mga modelo kada agent at gumamit ng mga sub-agent para
    mag-parallelize ng mahahabang gawain (bawat sub-agent ay kumokonsumo ng token). See [Models](/concepts/models) and
    [Sub-agents](/tools/subagents).

Strong warning: weaker/over-quantized models are more vulnerable to prompt
injection and unsafe behavior. 35. Tingnan ang [Security](/gateway/security).

More context: [Models](/concepts/models).

### Can I use selfhosted models llamacpp vLLM Ollama

Oo. 38. Kung ang iyong lokal na server ay naglalantad ng OpenAI-compatible API, maaari kang magturo ng custom provider dito. 39. Direktang sinusuportahan ang Ollama at ito ang pinakamadaling landas.

40. Paalala sa seguridad: ang mas maliliit o mabigat na na-quantize na mga modelo ay mas madaling tamaan ng prompt injection. 41. Mariing inirerekomenda ang **malalaking modelo** para sa anumang bot na maaaring gumamit ng mga tool.
41. Kung gusto mo pa rin ng maliliit na modelo, paganahin ang sandboxing at mahigpit na tool allowlists.

43. Docs: [Ollama](/providers/ollama), [Local models](/gateway/local-models),
    [Model providers](/concepts/model-providers), [Security](/gateway/security),
    [Sandboxing](/gateway/sandboxing).

### How do I switch models without wiping my config

Use **model commands** or edit only the **model** fields. 46. Iwasan ang buong pagpapalit ng config.

47. Mga ligtas na opsyon:

- `/model` in chat (quick, per-session)
- `openclaw models set ...` (updates just model config)
- `openclaw configure --section model` (interactive)
- edit `agents.defaults.model` in `~/.openclaw/openclaw.json`

Avoid `config.apply` with a partial object unless you intend to replace the whole config.
If you did overwrite config, restore from backup or re-run `openclaw doctor` to repair.

Docs: [Models](/concepts/models), [Configure](/cli/configure), [Config](/cli/config), [Doctor](/gateway/doctor).

### What do OpenClaw, Flawd, and Krill use for models

- **OpenClaw + Flawd:** Anthropic Opus (`anthropic/claude-opus-4-6`) - see [Anthropic](/providers/anthropic).
- **Krill:** MiniMax M2.1 (`minimax/MiniMax-M2.1`) - see [MiniMax](/providers/minimax).

### How do I switch models on the fly without restarting

Use the `/model` command as a standalone message:

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

Oo. Set one as default and switch as needed:

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

Ibig sabihin nito **hindi naka-configure ang provider** (walang nahanap na MiniMax provider config o auth profile), kaya hindi ma-resolve ang model. A fix for this detection is
in **2026.1.12** (unreleased at the time of writing).

Fix checklist:

1. Upgrade to **2026.1.12** (or run from source `main`), then restart the gateway.
2. Siguraduhing naka-configure ang MiniMax (wizard o JSON), o may umiiral na MiniMax API key sa env/auth profiles para ma-inject ang provider.
3. Use the exact model id (case-sensitive): `minimax/MiniMax-M2.1` or
   `minimax/MiniMax-M2.1-lightning`.
4. Run:

   ```bash
   openclaw models list
   ```

   and pick from the list (or `/model list` in chat).

See [MiniMax](/providers/minimax) and [Models](/concepts/models).

### Maaari ko bang gamitin ang MiniMax bilang default at ang OpenAI para sa mga kumplikadong gawain

Oo. Use **MiniMax as the default** and switch models **per session** when needed.
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

Pagkatapos:

```
/model gpt
```

**Option B: separate agents**

- Agent A default: MiniMax
- Agent B default: OpenAI
- Mag-route ayon sa agent o gamitin ang `/agent` para mag-switch

Docs: [Models](/concepts/models), [Multi-Agent Routing](/concepts/multi-agent), [MiniMax](/providers/minimax), [OpenAI](/providers/openai).

### Ang opus sonnet gpt ba ay mga builtin shortcut

Oo. OpenClaw ships a few default shorthands (only applied when the model exists in `agents.defaults.models`):

- `opus` → `anthropic/claude-opus-4-6`
- `sonnet` → `anthropic/claude-sonnet-4-5`
- `gpt` → `openai/gpt-5.2`
- `gpt-mini` → `openai/gpt-5-mini`
- `gemini` → `google/gemini-3-pro-preview`
- `gemini-flash` → `google/gemini-3-flash-preview`

Kung magse-set ka ng sarili mong alias na may kaparehong pangalan, mananaig ang value mo.

### How do I defineoverride model shortcuts aliases

Ang mga alias ay nagmumula sa `agents.defaults.models.<modelId>`.alias\`. Halimbawa:

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

Pagkatapos, ang `/model sonnet` (o `/<alias>` kapag suportado) ay mare-resolve sa model ID na iyon.

### How do I add models from other providers like OpenRouter or ZAI

OpenRouter (bayad kada token; maraming modelo):

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

Z.AI (GLM models):

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

If you reference a provider/model but the required provider key is missing, you'll get a runtime auth error (e.g. `No API key found for provider "zai"`).

**No API key found for provider after adding a new agent**

This usually means the **new agent** has an empty auth store. Auth is per-agent and
stored in:

```
~/.openclaw/agents/<agentId>/agent/auth-profiles.json
```

Mga opsyon sa pag-aayos:

- Patakbuhin ang `openclaw agents add <id>` at i-configure ang auth sa panahon ng wizard.
- Or copy `auth-profiles.json` from the main agent's `agentDir` into the new agent's `agentDir`.

Huwag **huwag** muling gamitin ang `agentDir` sa iba’t ibang agent; nagdudulot ito ng banggaan sa auth/session.

## Model failover and "All models failed"

### Paano gumagana ang failover

Nangyayari ang failover sa dalawang yugto:

1. **Auth profile rotation** sa loob ng parehong provider.
2. **Model fallback** sa susunod na model sa `agents.defaults.model.fallbacks`.

Cooldowns apply to failing profiles (exponential backoff), so OpenClaw can keep responding even when a provider is rate-limited or temporarily failing.

### Ano ang ibig sabihin ng error na ito

```
No credentials found for profile "anthropic:default"
```

Ibig sabihin, sinubukan ng system na gamitin ang auth profile ID na `anthropic:default`, ngunit hindi ito nakahanap ng mga kredensyal para rito sa inaasahang auth store.

### Checklist sa pag-aayos para sa No credentials found for profile anthropicdefault

- **Kumpirmahin kung saan nakaimbak ang mga auth profile** (bago vs legacy na mga path)
  - Kasalukuyan: `~/.openclaw/agents/<agentId>/agent/auth-profiles.json`
  - Legacy: `~/.openclaw/agent/*` (mina-migrate ng `openclaw doctor`)
- **Kumpirmahin na naka-load ang iyong env var ng Gateway**
  - If you set `ANTHROPIC_API_KEY` in your shell but run the Gateway via systemd/launchd, it may not inherit it. Ilagay ito sa `~/.openclaw/.env` o i-enable ang `env.shellEnv`.
- **Siguraduhing ini-e-edit mo ang tamang agent**
  - Sa mga multi-agent setup, maaaring may maraming `auth-profiles.json` file.
- **I-sanity-check ang status ng model/auth**
  - Use `openclaw models status` to see configured models and whether providers are authenticated.

**Checklist sa pag-aayos para sa No credentials found for profile anthropic**

Ibig sabihin nito, ang run ay naka-pin sa isang Anthropic auth profile, ngunit hindi ito mahanap ng Gateway sa auth store nito.

- **Gumamit ng setup-token**
  - Patakbuhin ang `claude setup-token`, pagkatapos ay i-paste ito gamit ang `openclaw models auth setup-token --provider anthropic`.
  - Kung ang token ay ginawa sa ibang machine, gamitin ang `openclaw models auth paste-token --provider anthropic`.

- **Kung gusto mong gumamit ng API key sa halip**
  - Ilagay ang `ANTHROPIC_API_KEY` sa `~/.openclaw/.env` sa **gateway host**.
  - I-clear ang anumang pinned order na pumipilit sa isang nawawalang profile:

    ```bash
    openclaw models auth order clear --provider anthropic
    ```

- **Kumpirmahin na pinapatakbo mo ang mga command sa gateway host**
  - Sa remote mode, ang mga auth profile ay nasa gateway machine, hindi sa iyong laptop.

### Bakit sinubukan din nito ang Google Gemini at nabigo

Kung ang iyong model config ay may kasamang Google Gemini bilang fallback (o lumipat ka sa isang Gemini shorthand), susubukan ito ng OpenClaw sa panahon ng model fallback. Kung hindi mo pa naka-configure ang Google credentials, makikita mo ang `No API key found for provider "google"`.

Ayusin: magbigay ng Google auth, o alisin/iwasan ang mga Google model sa `agents.defaults.model.fallbacks` / mga alias upang hindi doon mag-route ang fallback.

**Tinanggihang mensahe ng LLM request: thinking signature required google antigravity**

Sanhi: ang session history ay naglalaman ng **thinking blocks na walang signatures** (madalas mula sa isang na-abort o bahagyang stream). Ang Google Antigravity ay nangangailangan ng signatures para sa thinking blocks.

Ayusin: Tinatanggal na ngayon ng OpenClaw ang mga unsigned thinking blocks para sa Google Antigravity Claude. Kung lumalabas pa rin ito, magsimula ng **bagong session** o itakda ang `/thinking off` para sa agent na iyon.

## Auth profiles: ano ang mga ito at paano pamahalaan

Kaugnay: [/concepts/oauth](/concepts/oauth) (OAuth flows, token storage, mga pattern sa multi-account)

### Ano ang auth profile

Ang auth profile ay isang pinangalanang credential record (OAuth o API key) na naka-tali sa isang provider. Ang mga profile ay nakatira sa:

```
~/.openclaw/agents/<agentId>/agent/auth-profiles.json
```

### Ano ang mga karaniwang profile ID

Gumagamit ang OpenClaw ng mga ID na may provider prefix tulad ng:

- `anthropic:default` (karaniwan kapag walang email identity)
- `anthropic:<email>` para sa mga OAuth identity
- mga custom ID na pinili mo (hal. `anthropic:work`)

### Maaari ko bang kontrolin kung aling auth profile ang unang susubukan

Oo. Sinusuportahan ng config ang opsyonal na metadata para sa mga profile at isang ordering kada provider (\`auth.order.<provider>\`\`). This does **not** store secrets; it maps IDs to provider/mode and sets rotation order.

Maaaring pansamantalang laktawan ng OpenClaw ang isang profile kung ito ay nasa maikling **cooldown** (rate limits/timeouts/auth failures) o mas mahabang **disabled** na estado (billing/kulang na credits). Upang suriin ito, patakbuhin ang `openclaw models status --json` at tingnan ang `auth.unusableProfiles`. Pag-tune: `auth.cooldowns.billingBackoffHours*`.

You can also set a **per-agent** order override (stored in that agent's `auth-profiles.json`) via the CLI:

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

Upang i-target ang isang partikular na agent:

```bash
openclaw models auth order set --provider anthropic --agent main anthropic:default
```

### OAuth vs API key whats the difference

Sinusuportahan ng OpenClaw ang pareho:

- **OAuth** ay madalas na gumagamit ng access sa subscription (kung naaangkop).
- **API keys** ay gumagamit ng pay-per-token na pagsingil.

Ang wizard ay hayagang sumusuporta sa Anthropic setup-token at OpenAI Codex OAuth at maaaring mag-imbak ng mga API key para sa iyo.

## Gateway: mga port, "already running", at remote mode

### What port does the Gateway use

`gateway.port` controls the single multiplexed port for WebSocket + HTTP (Control UI, hooks, etc.).

Precedence:

```
--port > OPENCLAW_GATEWAY_PORT > gateway.port > default 18789
```

### Why does openclaw gateway status say Runtime running but RPC probe failed

1. Dahil ang "running" ay pananaw ng **supervisor** (launchd/systemd/schtasks). 2. Ang RPC probe ay ang CLI na aktwal na kumokonekta sa gateway WebSocket at tumatawag ng `status`.

Use `openclaw gateway status` and trust these lines:

- 4. `Probe target:` (ang URL na aktwal na ginamit ng probe)
- 5. `Listening:` (kung ano ang talagang naka-bind sa port)
- 6. `Last gateway error:` (karaniwang root cause kapag buhay ang proseso pero hindi nakikinig ang port)

### Bakit ipinapakita ng openclaw gateway status na magkaiba ang Config cli at Config service

8. Nag-e-edit ka ng isang config file habang ibang config ang ginagamit ng tumatakbong service (madalas na `--profile` / `OPENCLAW_STATE_DIR` mismatch).

Fix:

```bash
openclaw gateway install --force
```

10. Patakbuhin iyon mula sa parehong `--profile` / environment na gusto mong gamitin ng service.

### 11. Ano ang ibig sabihin ng another gateway instance is already listening

12. Ipinapatupad ng OpenClaw ang runtime lock sa pamamagitan ng agarang pag-bind ng WebSocket listener sa startup (default `ws://127.0.0.1:18789`). 13. Kapag nabigo ang bind na may `EADDRINUSE`, nagtatapon ito ng `GatewayLockError` na nagsasaad na may isa pang instance na nakikinig na.

14. Ayusin: ihinto ang ibang instance, palayain ang port, o patakbuhin gamit ang `openclaw gateway --port <port>`.

### 15. Paano ko patatakbuhin ang OpenClaw sa remote mode kung saan kumokonekta ang client sa Gateway sa ibang lugar

16. Itakda ang `gateway.mode: "remote"` at ituro sa isang remote WebSocket URL, opsyonal na may token/password:

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

Mga tala:

- 18. Ang `openclaw gateway` ay nagsisimula lamang kapag ang `gateway.mode` ay `local` (o kapag nag-pass ka ng override flag).
- The macOS app watches the config file and switches modes live when these values change.

### The Control UI says unauthorized or keeps reconnecting What now

Your gateway is running with auth enabled (`gateway.auth.*`), but the UI is not sending the matching token/password.

22. Mga katotohanan (mula sa code):

- 23. Iniimbak ng Control UI ang token sa browser localStorage key na `openclaw.control.settings.v1`.

Fix:

- Fastest: `openclaw dashboard` (prints + copies the dashboard URL, tries to open; shows SSH hint if headless).
- If you don't have a token yet: `openclaw doctor --generate-gateway-token`.
- If remote, tunnel first: `ssh -N -L 18789:127.0.0.1:18789 user@host` then open `http://127.0.0.1:18789/`.
- 27. Itakda ang `gateway.auth.token` (o `OPENCLAW_GATEWAY_TOKEN`) sa gateway host.
- In the Control UI settings, paste the same token.
- Still stuck? Run `openclaw status --all` and follow [Troubleshooting](/gateway/troubleshooting). See [Dashboard](/web/dashboard) for auth details.

### I set gatewaybind tailnet but it cant bind nothing listens

`tailnet` bind picks a Tailscale IP from your network interfaces (100.64.0.0/10). If the machine isn't on Tailscale (or the interface is down), there's nothing to bind to.

Fix:

- 35. Simulan ang Tailscale sa host na iyon (para magkaroon ito ng 100.x address), o
- 36. Lumipat sa `gateway.bind: "loopback"` / `"lan"`.

37. Tandaan: explicit ang `tailnet`. 38. Mas pinipili ng `auto` ang loopback; gamitin ang `gateway.bind: "tailnet"` kapag gusto mo ng tailnet-only na bind.

### 39. Maaari ba akong magpatakbo ng maraming Gateways sa iisang host

Usually no - one Gateway can run multiple messaging channels and agents. Use multiple Gateways only when you need redundancy (ex: rescue bot) or hard isolation.

Yes, but you must isolate:

- `OPENCLAW_CONFIG_PATH` (per-instance config)
- `OPENCLAW_STATE_DIR` (per-instance state)
- 45. `agents.defaults.workspace` (workspace isolation)
- 46. `gateway.port` (natatanging mga port)

47. Mabilisang setup (inirerekomenda):

- 48. Gamitin ang `openclaw --profile <name> …` bawat instance (awtomatikong lumilikha ng `~/.openclaw-<name>`).
- Set a unique `gateway.port` in each profile config (or pass `--port` for manual runs).
- 50. Mag-install ng per-profile service: `openclaw --profile <name> gateway install`.

1. Nagdadagdag din ng suffix ang mga profile sa mga pangalan ng serbisyo (\`bot.molt.<profile>
2. `; legacy `com.openclaw.\*`, `openclaw-gateway-<profile>.service`, `OpenClaw Gateway (<profile>)`).`; legacy `com.openclaw.*`, `openclaw-gateway-<profile>.service`, `OpenClaw Gateway (<profile>)`).
3. Buong gabay: [Multiple gateways](/gateway/multiple-gateways).

### 4. Ano ang ibig sabihin ng invalid handshake code 1008

The Gateway is a **WebSocket server**, and it expects the very first message to
be a `connect` frame. If it receives anything else, it closes the connection
with **code 1008** (policy violation).

7. Mga karaniwang sanhi:

- 8. Binuksan mo ang **HTTP** URL sa isang browser (`http://...`) sa halip na isang WS client.
- You used the wrong port or path.
- A proxy or tunnel stripped auth headers or sent a non-Gateway request.

Quick fixes:

1. Use the WS URL: `ws://<host>:18789` (or `wss://...` if HTTPS).
2. Don't open the WS port in a normal browser tab.
3. If auth is on, include the token/password in the `connect` frame.

If you're using the CLI or TUI, the URL should look like:

```
openclaw tui --url ws://<host>:18789 --token <token>
```

Protocol details: [Gateway protocol](/gateway/protocol).

## Logging and debugging

### Where are logs

File logs (structured):

```
/tmp/openclaw/openclaw-YYYY-MM-DD.log
```

You can set a stable path via `logging.file`. File log level is controlled by `logging.level`. Console verbosity is controlled by `--verbose` and `logging.consoleLevel`.

24. Pinakamabilis na pag-tail ng log:

```bash
openclaw logs --follow
```

25. Mga log ng service/supervisor (kapag tumatakbo ang gateway sa pamamagitan ng launchd/systemd):

- 26. macOS: `$OPENCLAW_STATE_DIR/logs/gateway.log` at `gateway.err.log` (default: `~/.openclaw/logs/...`; ang mga profile ay gumagamit ng `~/.openclaw-<profile>/logs/...`)
- Linux: `journalctl --user -u openclaw-gateway[-<profile>].service -n 200 --no-pager`
- Windows: `schtasks /Query /TN "OpenClaw Gateway (<profile>)" /V /FO LIST`

See [Troubleshooting](/gateway/troubleshooting#log-locations) for more.

### How do I startstoprestart the Gateway service

Use the gateway helpers:

```bash
openclaw gateway status
openclaw gateway restart
```

33. Kung pinapatakbo mo nang mano-mano ang gateway, maaaring bawiin ng `openclaw gateway --force` ang port. See [Gateway](/gateway).

### I closed my terminal on Windows how do I restart OpenClaw

There are **two Windows install modes**:

37. **1) WSL2 (inirerekomenda):** tumatakbo ang Gateway sa loob ng Linux.

38. Buksan ang PowerShell, pumasok sa WSL, pagkatapos ay i-restart:

```powershell
39. wsl
openclaw gateway status
openclaw gateway restart
```

40. Kung hindi mo kailanman na-install ang serbisyo, simulan ito sa foreground:

```bash
openclaw gateway run
```

**2) Native Windows (not recommended):** the Gateway runs directly in Windows.

Open PowerShell and run:

```powershell
openclaw gateway status
openclaw gateway restart
```

If you run it manually (no service), use:

```powershell
openclaw gateway run
```

45. Mga docs: [Windows (WSL2)](/platforms/windows), [Gateway service runbook](/gateway).

### The Gateway is up but replies never arrive What should I check

47. Magsimula sa isang mabilis na health sweep:

```bash
48. openclaw status
openclaw models status
openclaw channels status
openclaw logs --follow
```

Common causes:

- Model auth not loaded on the **gateway host** (check `models status`).
- Channel pairing/allowlist ay humaharang sa mga reply (suriin ang channel config + logs).
- Bukas ang WebChat/Dashboard nang walang tamang token.

If you are remote, confirm the tunnel/Tailscale connection is up and that the
Gateway WebSocket is reachable.

Docs: [Channels](/channels), [Troubleshooting](/gateway/troubleshooting), [Remote access](/gateway/remote).

### Nadiskonek mula sa gateway nang walang dahilan, ano na ang gagawin

This usually means the UI lost the WebSocket connection. Suriin:

1. Is the Gateway running? `openclaw gateway status`
2. Healthy ba ang Gateway? `openclaw status`
3. Does the UI have the right token? `openclaw dashboard`
4. If remote, is the tunnel/Tailscale link up?

Pagkatapos ay i-tail ang logs:

```bash
openclaw logs --follow
```

Docs: [Dashboard](/web/dashboard), [Remote access](/gateway/remote), [Troubleshooting](/gateway/troubleshooting).

### Nabibigo ang Telegram setMyCommands na may network errors. Ano ang dapat kong suriin

Magsimula sa logs at status ng channel:

```bash
openclaw channels status
openclaw channels logs --channel telegram
```

If you are on a VPS or behind a proxy, confirm outbound HTTPS is allowed and DNS works.
Kung remote ang Gateway, tiyaking tinitingnan mo ang logs sa Gateway host.

Docs: [Telegram](/channels/telegram), [Channel troubleshooting](/channels/troubleshooting).

### TUI shows no output What should I check

First confirm the Gateway is reachable and the agent can run:

```bash
openclaw status
openclaw models status
openclaw logs --follow
```

In the TUI, use `/status` to see the current state. Kung umaasa ka ng mga reply sa isang chat
channel, tiyaking naka-enable ang delivery (`/deliver on`).

Docs: [TUI](/web/tui), [Slash commands](/tools/slash-commands).

### Paano ko tuluyang ihihinto at pagkatapos ay sisimulan muli ang Gateway

If you installed the service:

```bash
openclaw gateway stop
openclaw gateway start
```

This stops/starts the **supervised service** (launchd on macOS, systemd on Linux).
Use this when the Gateway runs in the background as a daemon.

If you're running in the foreground, stop with Ctrl-C, then:

```bash
openclaw gateway run
```

Docs: [Gateway service runbook](/gateway).

### ELI5: openclaw gateway restart vs openclaw gateway

- `openclaw gateway restart`: nire-restart ang **background service** (launchd/systemd).
- `openclaw gateway`: pinapatakbo ang gateway **sa foreground** para sa session ng terminal na ito.

Kung na-install mo ang service, gamitin ang mga gateway command. Gamitin ang `openclaw gateway` kapag
nais mo ng isang beses lang, foreground run.

### What's the fastest way to get more details when something fails

Simulan ang Gateway gamit ang `--verbose` para makakuha ng mas maraming detalye sa console. Pagkatapos ay siyasatin ang log file para sa channel auth, model routing, at mga RPC error.

## Media and attachments

### My skill generated an imagePDF but nothing was sent

Ang mga outbound attachment mula sa agent ay dapat may kasamang linyang `MEDIA:<path-or-url>` (sa sarili nitong linya). Tingnan ang [OpenClaw assistant setup](/start/openclaw) at [Agent send](/tools/agent-send).

Pagpapadala mula sa CLI:

```bash
openclaw message send --target +15555550123 --message "Here you go" --media /path/to/file.png
```

Suriin din:

- Sinusuportahan ng target channel ang outbound media at hindi ito naka-block ng mga allowlist.
- Ang file ay pasok sa mga limitasyon ng laki ng provider (ang mga larawan ay nire-resize hanggang max 2048px).

See [Images](/nodes/images).

## 1. Seguridad at kontrol sa access

### 2. Ligtas bang ilantad ang OpenClaw sa mga papasok na DM

Treat inbound DMs as untrusted input. 4. Ang mga default ay idinisenyo upang mabawasan ang panganib:

- Default behavior on DM-capable channels is **pairing**:
  - Unknown senders receive a pairing code; the bot does not process their message.
  - Approve with: `openclaw pairing approve <channel> <code>`
  - 8. Ang mga nakabinbing kahilingan ay nililimitahan sa **3 bawat channel**; tingnan ang `openclaw pairing list <channel>` kung hindi dumating ang isang code.
- Opening DMs publicly requires explicit opt-in (`dmPolicy: "open"` and allowlist `"*"`).

Run `openclaw doctor` to surface risky DM policies.

### Is prompt injection only a concern for public bots

Hindi. 12. Ang prompt injection ay tungkol sa **hindi pinagkakatiwalaang nilalaman**, hindi lamang kung sino ang maaaring mag-DM sa bot.
If your assistant reads external content (web search/fetch, browser pages, emails,
docs, attachments, pasted logs), that content can include instructions that try
to hijack the model. This can happen even if **you are the only sender**.

The biggest risk is when tools are enabled: the model can be tricked into
exfiltrating context or calling tools on your behalf. Reduce the blast radius by:

- using a read-only or tool-disabled "reader" agent to summarize untrusted content
- keeping `web_search` / `web_fetch` / `browser` off for tool-enabled agents
- 19. pag-sandbox at mahigpit na mga allowlist ng tool

Ang paghiwalay ng bot gamit ang magkakahiwalay na account at mga numero ng telepono
ay nagpapaliit ng blast radius kung may magkamali.

### 21. Dapat bang magkaroon ang aking bot ng sarili nitong email, GitHub account, o numero ng telepono

22. Oo, para sa karamihan ng mga setup. Ginagawa rin nitong mas madali ang pag-rotate ng
    mga kredensyal o pagbawi ng access nang hindi naaapektuhan ang iyong mga personal na account. Magsimula sa maliit.

Panatilihin ang mga DM sa **pairing mode** o isang mahigpit na allowlist. 26. Bigyan lamang ng access ang mga tool at account na talagang kailangan mo, at palawakin
sa kalaunan kung kinakailangan.

27. Mga Docs: [Security](/gateway/security), [Pairing](/channels/pairing).

### 28. Maaari ko bang bigyan ito ng awtonomiya sa aking mga text message at ligtas ba iyon

29. **Hindi** namin inirerekomenda ang ganap na awtonomiya sa iyong mga personal na mensahe. 30. Ang pinakaligtas na pattern ay:

- Gumamit ng **hiwalay na numero o account** kung gusto mong magpadala ito ng mga mensahe sa iyong ngalan.
- Hayaan itong mag-draft, pagkatapos ay **aprubahan bago ipadala**.
- Maaari ba akong gumamit ng mas murang mga modelo para sa mga gawain ng personal assistant

34. Kung gusto mong mag-eksperimento, gawin ito sa isang dedikadong account at panatilihin itong hiwalay. 35. Tingnan ang
    [Security](/gateway/security).

### Tingnan ang [Security](/gateway/security).

37. Oo, **kung** ang agent ay chat-only at ang input ay pinagkakatiwalaan. 38. Ang mas maliliit na tier ay
    mas madaling maapektuhan ng instruction hijacking, kaya iwasan ang mga ito para sa mga tool-enabled na agent
    o kapag nagbabasa ng hindi pinagkakatiwalaang nilalaman. 39. Kung kailangan mong gumamit ng mas maliit na modelo, higpitan ang
    mga tool at patakbuhin sa loob ng isang sandbox. Ipinapadala ang mga pairing code **lamang** kapag may hindi kilalang sender na nag-message sa bot at
    naka-enable ang `dmPolicy: "pairing"`.

### 41. Pinatakbo ko ang start sa Telegram pero hindi ako nakakuha ng pairing code

Security: I-summarize ang panganib, repro, beripikasyon, walang sensitibong data. 43. Ang `/start` lamang ay hindi bumubuo ng code.

44. Suriin ang mga nakabinbing kahilingan:

```bash
openclaw pairing list telegram
```

45. Kung gusto mo ng agarang access, i-allowlist ang iyong sender id o itakda ang `dmPolicy: "open"`
    para sa account na iyon.

### 46. WhatsApp magme-message ba ito sa aking mga contact Paano gumagana ang pairing

Hindi. 47. Ang default na WhatsApp DM policy ay **pairing**. 48. Ang mga hindi kilalang nagpadala ay nakakakuha lamang ng pairing code at ang kanilang mensahe ay **hindi pinoproseso**. 49. Sumusagot lamang ang OpenClaw sa mga chat na natatanggap nito o sa mga tahasang pagpapadala na iyong tina-trigger.

50. Aprubahan ang pairing gamit ang:

```bash
1. openclaw pairing approve whatsapp <code>
```

2. Ilista ang mga nakabinbing kahilingan:

```bash
openclaw pairing list whatsapp
```

3. Prompt ng numero ng telepono ng wizard: ginagamit ito para itakda ang iyong **allowlist/owner** upang payagan ang sarili mong mga DM. 4. Hindi ito ginagamit para sa awtomatikong pagpapadala. 5. Kung tumatakbo ka gamit ang iyong personal na WhatsApp number, gamitin ang numerong iyon at paganahin ang `channels.whatsapp.selfChatMode`.

## 6. Mga chat command, pag-abort ng mga gawain, at "hindi ito humihinto"

### 7. Paano ko ihihinto ang pagpapakita ng mga internal system message sa chat

8. Karamihan sa mga internal o tool message ay lumalabas lamang kapag naka-enable ang **verbose** o **reasoning** para sa sesyong iyon.

9. Ayusin sa chat kung saan mo ito nakikita:

```
10. /verbose off
/reasoning off
```

11. Kung maingay pa rin, tingnan ang mga setting ng session sa Control UI at itakda ang verbose sa **inherit**. 12. Kumpirmahin din na hindi ka gumagamit ng bot profile na may `verboseDefault` na nakatakda sa `on` sa config.

13. Docs: [Thinking and verbose](/tools/thinking), [Security](/gateway/security#reasoning--verbose-output-in-groups).

### 14. Paano ko ihihinto/kakanselahin ang isang tumatakbong gawain

15. Ipadala ang alinman sa mga ito **bilang hiwalay na mensahe** (walang slash):

```
16. stop
abort
esc
wait
exit
interrupt
```

17. Ito ang mga abort trigger (hindi mga slash command).

18. Para sa mga background process (mula sa exec tool), maaari mong hilingin sa agent na patakbuhin ang:

```
19. process action:kill sessionId:XXX
```

20. Pangkalahatang-ideya ng mga slash command: tingnan ang [Slash commands](/tools/slash-commands).

21. Karamihan sa mga command ay dapat ipadala bilang **hiwalay** na mensahe na nagsisimula sa `/`, ngunit may ilang shortcut (tulad ng `/status`) na gumagana rin inline para sa mga allowlisted na sender.

### 22. Paano ako magpapadala ng Discord message mula sa Telegram: Tinanggihan ang cross-context messaging

23. Hinaharangan ng OpenClaw ang **cross-provider** messaging bilang default. 24. Kung ang isang tool call ay naka-bind sa Telegram, hindi ito magpapadala sa Discord maliban kung tahasan mo itong pahihintulutan.

25. Paganahin ang cross-provider messaging para sa agent:

```json5
26. {
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

27. I-restart ang gateway pagkatapos i-edit ang config. 28. Kung gusto mo lang ito para sa iisang agent, itakda ito sa ilalim ng `agents.list[].tools.message` sa halip.

### 29. Bakit parang binabalewala ng bot ang sunud-sunod na mabilis na mga mensahe

30. Kinokontrol ng queue mode kung paano nakikipag-ugnayan ang mga bagong mensahe sa isang kasalukuyang tumatakbong gawain. 31. Gamitin ang `/queue` para baguhin ang mga mode:

- 32. `steer` - ang mga bagong mensahe ay nire-redirect ang kasalukuyang gawain
- 33. `followup` - patakbuhin ang mga mensahe nang paisa-isa
- 34. `collect` - i-batch ang mga mensahe at sumagot nang minsanan (default)
- 35. `steer-backlog` - mag-steer ngayon, pagkatapos ay iproseso ang backlog
- 36. `interrupt` - i-abort ang kasalukuyang run at magsimula muli

37. Maaari kang magdagdag ng mga opsyon tulad ng `debounce:2s cap:25 drop:summarize` para sa mga followup mode.

## 38. Sagutin ang eksaktong tanong mula sa screenshot/chat log

39. **Q: "Ano ang default na modelo para sa Anthropic kapag may API key?"**

40. **A:** Sa OpenClaw, hiwalay ang mga kredensyal at pagpili ng modelo. 41. Ang pagtatakda ng `ANTHROPIC_API_KEY` (o pag-iimbak ng Anthropic API key sa mga auth profile) ay nagpapagana ng authentication, ngunit ang aktwal na default na modelo ay kung ano man ang iyong itinakda sa `agents.defaults.model.primary` (halimbawa, `anthropic/claude-sonnet-4-5` o `anthropic/claude-opus-4-6`). 42. Kung makita mo ang `No credentials found for profile "anthropic:default"`, ibig sabihin ay hindi mahanap ng Gateway ang mga Anthropic credential sa inaasahang `auth-profiles.json` para sa agent na tumatakbo.

---

43. Naka-stuck pa rin? 44. Magtanong sa [Discord](https://discord.com/invite/clawd) o magbukas ng [GitHub discussion](https://github.com/openclaw/openclaw/discussions).
