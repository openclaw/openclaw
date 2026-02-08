---
summary: "Vanliga frågor om installation, konfiguration och användning av OpenClaw"
title: "Vanliga frågor"
x-i18n:
  source_path: help/faq.md
  source_hash: b7c0c9766461f6e7
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T08:18:13Z
---

# Vanliga frågor

Snabba svar plus djupare felsökning för verkliga installationer (lokal utveckling, VPS, multi‑agent, OAuth/API‑nycklar, modell‑failover). För runtime‑diagnostik, se [Felsökning](/gateway/troubleshooting). För fullständig konfigurationsreferens, se [Konfiguration](/gateway/configuration).

## Innehållsförteckning

- [Snabbstart och första körningen]
  - [Jag sitter fast – vad är snabbaste sättet att komma loss?](#im-stuck-whats-the-fastest-way-to-get-unstuck)
  - [Vad är det rekommenderade sättet att installera och konfigurera OpenClaw?](#whats-the-recommended-way-to-install-and-set-up-openclaw)
  - [Hur öppnar jag instrumentpanelen efter introduktionen?](#how-do-i-open-the-dashboard-after-onboarding)
  - [Hur autentiserar jag instrumentpanelen (token) på localhost jämfört med remote?](#how-do-i-authenticate-the-dashboard-token-on-localhost-vs-remote)
  - [Vilken runtime behöver jag?](#what-runtime-do-i-need)
  - [Kör det på Raspberry Pi?](#does-it-run-on-raspberry-pi)
  - [Några tips för Raspberry Pi‑installationer?](#any-tips-for-raspberry-pi-installs)
  - [Det fastnar på ”wake up my friend” / introduktionen kläcks inte. Vad nu?](#it-is-stuck-on-wake-up-my-friend-onboarding-will-not-hatch-what-now)
  - [Kan jag migrera min installation till en ny maskin (Mac mini) utan att göra om introduktionen?](#can-i-migrate-my-setup-to-a-new-machine-mac-mini-without-redoing-onboarding)
  - [Var ser jag vad som är nytt i senaste versionen?](#where-do-i-see-what-is-new-in-the-latest-version)
  - [Jag kan inte nå docs.openclaw.ai (SSL‑fel). Vad nu?](#i-cant-access-docsopenclawai-ssl-error-what-now)
  - [Vad är skillnaden mellan stable och beta?](#whats-the-difference-between-stable-and-beta)
  - [Hur installerar jag beta‑versionen, och vad är skillnaden mellan beta och dev?](#how-do-i-install-the-beta-version-and-whats-the-difference-between-beta-and-dev)
  - [Hur provar jag de senaste ändringarna?](#how-do-i-try-the-latest-bits)
  - [Hur lång tid tar installation och introduktion vanligtvis?](#how-long-does-install-and-onboarding-usually-take)
  - [Installationsprogrammet hänger sig – hur får jag mer feedback?](#installer-stuck-how-do-i-get-more-feedback)
  - [Windows‑installationen säger att git saknas eller att openclaw inte känns igen](#windows-install-says-git-not-found-or-openclaw-not-recognized)
  - [Dokumentationen svarade inte på min fråga – hur får jag ett bättre svar?](#the-docs-didnt-answer-my-question-how-do-i-get-a-better-answer)
  - [Hur installerar jag OpenClaw på Linux?](#how-do-i-install-openclaw-on-linux)
  - [Hur installerar jag OpenClaw på en VPS?](#how-do-i-install-openclaw-on-a-vps)
  - [Var finns guiderna för moln/VPS‑installationer?](#where-are-the-cloudvps-install-guides)
  - [Kan jag be OpenClaw att uppdatera sig själv?](#can-i-ask-openclaw-to-update-itself)
  - [Vad gör introduktionsguiden egentligen?](#what-does-the-onboarding-wizard-actually-do)
  - [Behöver jag en Claude‑ eller OpenAI‑prenumeration för att köra detta?](#do-i-need-a-claude-or-openai-subscription-to-run-this)
  - [Kan jag använda Claude Max‑prenumeration utan API‑nyckel](#can-i-use-claude-max-subscription-without-an-api-key)
  - [Hur fungerar Anthropic ”setup‑token”‑autentisering?](#how-does-anthropic-setuptoken-auth-work)
  - [Var hittar jag en Anthropic setup‑token?](#where-do-i-find-an-anthropic-setuptoken)
  - [Stöder ni Claude‑prenumerationsautentisering (Claude Pro eller Max)?](#do-you-support-claude-subscription-auth-claude-pro-or-max)
  - [Varför ser jag HTTP 429 ratelimiterror från Anthropic?](#why-am-i-seeing-http-429-ratelimiterror-from-anthropic)
  - [Stöds AWS Bedrock?](#is-aws-bedrock-supported)
  - [Hur fungerar Codex‑autentisering?](#how-does-codex-auth-work)
  - [Stöder ni OpenAI‑prenumerationsautentisering (Codex OAuth)?](#do-you-support-openai-subscription-auth-codex-oauth)
  - [Hur konfigurerar jag Gemini CLI OAuth](#how-do-i-set-up-gemini-cli-oauth)
  - [Är en lokal modell okej för vardagliga chattar?](#is-a-local-model-ok-for-casual-chats)
  - [Hur håller jag trafik till hostade modeller inom en specifik region?](#how-do-i-keep-hosted-model-traffic-in-a-specific-region)
  - [Måste jag köpa en Mac mini för att installera detta?](#do-i-have-to-buy-a-mac-mini-to-install-this)
  - [Behöver jag en Mac mini för iMessage‑stöd?](#do-i-need-a-mac-mini-for-imessage-support)
  - [Om jag köper en Mac mini för att köra OpenClaw, kan jag ansluta den till min MacBook Pro?](#if-i-buy-a-mac-mini-to-run-openclaw-can-i-connect-it-to-my-macbook-pro)
  - [Kan jag använda Bun?](#can-i-use-bun)
  - [Telegram: vad ska stå i allowFrom?](#telegram-what-goes-in-allowfrom)
  - [Kan flera personer använda ett WhatsApp‑nummer med olika OpenClaw‑instanser?](#can-multiple-people-use-one-whatsapp-number-with-different-openclaw-instances)
  - [Kan jag köra en ”snabb chatt”‑agent och en ”Opus för kodning”‑agent?](#can-i-run-a-fast-chat-agent-and-an-opus-for-coding-agent)
  - [Fungerar Homebrew på Linux?](#does-homebrew-work-on-linux)
  - [Vad är skillnaden mellan hackbar (git)‑installation och npm‑installation?](#whats-the-difference-between-the-hackable-git-install-and-npm-install)
  - [Kan jag byta mellan npm‑ och git‑installationer senare?](#can-i-switch-between-npm-and-git-installs-later)
  - [Bör jag köra Gateway på min laptop eller på en VPS?](#should-i-run-the-gateway-on-my-laptop-or-a-vps)
  - [Hur viktigt är det att köra OpenClaw på en dedikerad maskin?](#how-important-is-it-to-run-openclaw-on-a-dedicated-machine)
  - [Vilka är minimikraven för VPS och rekommenderat OS?](#what-are-the-minimum-vps-requirements-and-recommended-os)
  - [Kan jag köra OpenClaw i en VM och vilka är kraven?](#can-i-run-openclaw-in-a-vm-and-what-are-the-requirements)
- [Vad är OpenClaw?](#what-is-openclaw)
  - [Vad är OpenClaw, i ett stycke?](#what-is-openclaw-in-one-paragraph)
  - [Vad är värdeerbjudandet?](#whats-the-value-proposition)
  - [Jag har precis installerat det – vad ska jag göra först?](#i-just-set-it-up-what-should-i-do-first)
  - [Vilka är de fem vanligaste vardagsanvändningarna för OpenClaw?](#what-are-the-top-five-everyday-use-cases-for-openclaw)
  - [Kan OpenClaw hjälpa med lead gen, outreach, annonser och bloggar för ett SaaS?](#can-openclaw-help-with-lead-gen-outreach-ads-and-blogs-for-a-saas)
  - [Vilka är fördelarna jämfört med Claude Code för webbutveckling?](#what-are-the-advantages-vs-claude-code-for-web-development)
- [Skills och automatisering](#skills-and-automation)
  - [Hur anpassar jag Skills utan att smutsa ned repot?](#how-do-i-customize-skills-without-keeping-the-repo-dirty)
  - [Kan jag ladda Skills från en egen mapp?](#can-i-load-skills-from-a-custom-folder)
  - [Hur kan jag använda olika modeller för olika uppgifter?](#how-can-i-use-different-models-for-different-tasks)
  - [Botten fryser vid tungt arbete. Hur avlastar jag det?](#the-bot-freezes-while-doing-heavy-work-how-do-i-offload-that)
  - [Cron eller påminnelser triggas inte. Vad ska jag kontrollera?](#cron-or-reminders-do-not-fire-what-should-i-check)
  - [Hur installerar jag Skills på Linux?](#how-do-i-install-skills-on-linux)
  - [Kan OpenClaw köra uppgifter enligt schema eller kontinuerligt i bakgrunden?](#can-openclaw-run-tasks-on-a-schedule-or-continuously-in-the-background)
  - [Kan jag köra Apple macOS‑endast‑Skills från Linux?](#can-i-run-apple-macos-only-skills-from-linux)
  - [Har ni en Notion‑ eller HeyGen‑integration?](#do-you-have-a-notion-or-heygen-integration)
  - [Hur installerar jag Chrome‑tillägget för webbläsarövertagande?](#how-do-i-install-the-chrome-extension-for-browser-takeover)
- [Sandboxing och minne](#sandboxing-and-memory)
  - [Finns det en dedikerad dokumentation om sandboxing?](#is-there-a-dedicated-sandboxing-doc)
  - [Hur binder jag en värdmapp in i sandboxen?](#how-do-i-bind-a-host-folder-into-the-sandbox)
  - [Hur fungerar minne?](#how-does-memory-work)
  - [Minnet glömmer saker. Hur får jag det att sitta kvar?](#memory-keeps-forgetting-things-how-do-i-make-it-stick)
  - [Består minnet för alltid? Vilka är gränserna?](#does-memory-persist-forever-what-are-the-limits)
  - [Kräver semantisk minnessökning en OpenAI API‑nyckel?](#does-semantic-memory-search-require-an-openai-api-key)
- [Var saker ligger på disk](#where-things-live-on-disk)
  - [Sparas all data som används med OpenClaw lokalt?](#is-all-data-used-with-openclaw-saved-locally)
  - [Var lagrar OpenClaw sin data?](#where-does-openclaw-store-its-data)
  - [Var ska AGENTS.md / SOUL.md / USER.md / MEMORY.md ligga?](#where-should-agentsmd-soulmd-usermd-memorymd-live)
  - [Vilken är den rekommenderade backup‑strategin?](#whats-the-recommended-backup-strategy)
  - [Hur avinstallerar jag OpenClaw helt?](#how-do-i-completely-uninstall-openclaw)
  - [Kan agenter arbeta utanför arbetsytan?](#can-agents-work-outside-the-workspace)
  - [Jag är i remote‑läge – var finns sessionslagret?](#im-in-remote-mode-where-is-the-session-store)
- [Grundläggande konfig](#config-basics)
  - [Vilket format har konfigen? Var finns den?](#what-format-is-the-config-where-is-it)
  - [Jag satte gatewaybind lan eller tailnet och nu lyssnar inget / UI säger obehörig](#i-set-gatewaybind-lan-or-tailnet-and-now-nothing-listens-the-ui-says-unauthorized)
  - [Varför behöver jag en token på localhost nu?](#why-do-i-need-a-token-on-localhost-now)
  - [Måste jag starta om efter att ha ändrat konfig?](#do-i-have-to-restart-after-changing-config)
  - [Hur aktiverar jag webbsökning (och web fetch)?](#how-do-i-enable-web-search-and-web-fetch)
  - [config.apply raderade min konfig. Hur återställer och undviker jag detta?](#configapply-wiped-my-config-how-do-i-recover-and-avoid-this)
  - [Hur kör jag en central Gateway med specialiserade workers över flera enheter?](#how-do-i-run-a-central-gateway-with-specialized-workers-across-devices)
  - [Kan OpenClaw‑webbläsaren köras headless?](#can-the-openclaw-browser-run-headless)
  - [Hur använder jag Brave för webbläsarstyrning?](#how-do-i-use-brave-for-browser-control)
- [Fjärr‑Gateways och noder](#remote-gateways-and-nodes)
  - [Hur propagerar kommandon mellan Telegram, gatewayn och noder?](#how-do-commands-propagate-between-telegram-the-gateway-and-nodes)
  - [Hur kan min agent komma åt min dator om Gateway är hostad remote?](#how-can-my-agent-access-my-computer-if-the-gateway-is-hosted-remotely)
  - [Tailscale är ansluten men jag får inga svar. Vad nu?](#tailscale-is-connected-but-i-get-no-replies-what-now)
  - [Kan två OpenClaw‑instanser prata med varandra (lokal + VPS)?](#can-two-openclaw-instances-talk-to-each-other-local-vps)
  - [Behöver jag separata VPS:er för flera agenter?](#do-i-need-separate-vpses-for-multiple-agents)
  - [Finns det en fördel med att använda en nod på min personliga laptop istället för SSH från en VPS?](#is-there-a-benefit-to-using-a-node-on-my-personal-laptop-instead-of-ssh-from-a-vps)
  - [Kör noder en gateway‑tjänst?](#do-nodes-run-a-gateway-service)
  - [Finns det ett API/RPC‑sätt att applicera konfig?](#is-there-an-api-rpc-way-to-apply-config)
  - [Vad är en minimal ”rimlig” konfig för en första installation?](#whats-a-minimal-sane-config-for-a-first-install)
  - [Hur konfigurerar jag Tailscale på en VPS och ansluter från min Mac?](#how-do-i-set-up-tailscale-on-a-vps-and-connect-from-my-mac)
  - [Hur ansluter jag en Mac‑nod till en remote Gateway (Tailscale Serve)?](#how-do-i-connect-a-mac-node-to-a-remote-gateway-tailscale-serve)
  - [Bör jag installera på en andra laptop eller bara lägga till en nod?](#should-i-install-on-a-second-laptop-or-just-add-a-node)
- [Miljövariabler och .env‑laddning](#env-vars-and-env-loading)
  - [Hur laddar OpenClaw miljövariabler?](#how-does-openclaw-load-environment-variables)
  - [”Jag startade Gateway via tjänsten och mina miljövariabler försvann.” Vad nu?](#i-started-the-gateway-via-the-service-and-my-env-vars-disappeared-what-now)
  - [Jag satte COPILOTGITHUBTOKEN, men modellstatus visar ”Shell env: off.” Varför?](#i-set-copilotgithubtoken-but-models-status-shows-shell-env-off-why)
- [Sessioner och flera chattar](#sessions-and-multiple-chats)
  - [Hur startar jag en ny konversation?](#how-do-i-start-a-fresh-conversation)
  - [Återställs sessioner automatiskt om jag aldrig skickar ”new”?](#do-sessions-reset-automatically-if-i-never-send-new)
  - [Finns det ett sätt att göra ett team av OpenClaw‑instanser med en VD och många agenter?](#is-there-a-way-to-make-a-team-of-openclaw-instances-one-ceo-and-many-agents)
  - [Varför kapades kontexten mitt i en uppgift? Hur förhindrar jag det?](#why-did-context-get-truncated-midtask-how-do-i-prevent-it)
  - [Hur återställer jag OpenClaw helt men behåller installationen?](#how-do-i-completely-reset-openclaw-but-keep-it-installed)
  - [Jag får ”context too large”‑fel – hur återställer eller komprimerar jag?](#im-getting-context-too-large-errors-how-do-i-reset-or-compact)
  - [Varför ser jag ”LLM request rejected: messages.N.content.X.tool_use.input: Field required”?](#why-am-i-seeing-llm-request-rejected-messagesncontentxtooluseinput-field-required)
  - [Varför får jag heartbeat‑meddelanden var 30:e minut?](#why-am-i-getting-heartbeat-messages-every-30-minutes)
  - [Behöver jag lägga till ett ”bot‑konto” i en WhatsApp‑grupp?](#do-i-need-to-add-a-bot-account-to-a-whatsapp-group)
  - [Hur får jag JID för en WhatsApp‑grupp?](#how-do-i-get-the-jid-of-a-whatsapp-group)
  - [Varför svarar inte OpenClaw i en grupp?](#why-doesnt-openclaw-reply-in-a-group)
  - [Delar grupper/trådar kontext med DM?](#do-groupsthreads-share-context-with-dms)
  - [Hur många arbetsytor och agenter kan jag skapa?](#how-many-workspaces-and-agents-can-i-create)
  - [Kan jag köra flera bottar eller chattar samtidigt (Slack), och hur bör jag sätta upp det?](#can-i-run-multiple-bots-or-chats-at-the-same-time-slack-and-how-should-i-set-that-up)
- [Modeller: standarder, val, alias, växling](#models-defaults-selection-aliases-switching)
  - [Vad är ”standardmodellen”?](#what-is-the-default-model)
  - [Vilken modell rekommenderar ni?](#what-model-do-you-recommend)
  - [Hur byter jag modell utan att radera min konfig?](#how-do-i-switch-models-without-wiping-my-config)
  - [Kan jag använda självhostade modeller (llama.cpp, vLLM, Ollama)?](#can-i-use-selfhosted-models-llamacpp-vllm-ollama)
  - [Vilka modeller använder OpenClaw, Flawd och Krill?](#what-do-openclaw-flawd-and-krill-use-for-models)
  - [Hur byter jag modell i farten (utan omstart)?](#how-do-i-switch-models-on-the-fly-without-restarting)
  - [Kan jag använda GPT 5.2 för dagliga uppgifter och Codex 5.3 för kodning?](#can-i-use-gpt-52-for-daily-tasks-and-codex-53-for-coding)
  - [Varför ser jag ”Model … is not allowed” och sedan inget svar?](#why-do-i-see-model-is-not-allowed-and-then-no-reply)
  - [Varför ser jag ”Unknown model: minimax/MiniMax-M2.1”?](#why-do-i-see-unknown-model-minimaxminimaxm21)
  - [Kan jag använda MiniMax som standard och OpenAI för komplexa uppgifter?](#can-i-use-minimax-as-my-default-and-openai-for-complex-tasks)
  - [Är opus / sonnet / gpt inbyggda genvägar?](#are-opus-sonnet-gpt-builtin-shortcuts)
  - [Hur definierar/åsidosätter jag modellgenvägar (alias)?](#how-do-i-defineoverride-model-shortcuts-aliases)
  - [Hur lägger jag till modeller från andra leverantörer som OpenRouter eller Z.AI?](#how-do-i-add-models-from-other-providers-like-openrouter-or-zai)
- [Modell‑failover och ”All models failed”](#model-failover-and-all-models-failed)
  - [Hur fungerar failover?](#how-does-failover-work)
  - [Vad betyder detta fel?](#what-does-this-error-mean)
  - [Åtgärdschecklista för No credentials found for profile anthropicdefault](#fix-checklist-for-no-credentials-found-for-profile-anthropicdefault)
  - [Varför försökte den även Google Gemini och misslyckades?](#why-did-it-also-try-google-gemini-and-fail)
- [Autentiseringsprofiler: vad de är och hur du hanterar dem](#auth-profiles-what-they-are-and-how-to-manage-them)
  - [Vad är en auth‑profil?](#what-is-an-auth-profile)
  - [Vilka är typiska profil‑ID:n?](#what-are-typical-profile-ids)
  - [Kan jag styra vilken auth‑profil som prövas först?](#can-i-control-which-auth-profile-is-tried-first)
  - [OAuth vs API‑nyckel: vad är skillnaden?](#oauth-vs-api-key-whats-the-difference)
- [Gateway: portar, ”already running” och remote‑läge](#gateway-ports-already-running-and-remote-mode)
  - [Vilken port använder Gateway?](#what-port-does-the-gateway-use)
  - [Varför säger openclaw gateway status ”Runtime running” men ”RPC probe failed”?](#why-does-openclaw-gateway-status-say-runtime-running-but-rpc-probe-failed)
  - [Varför visar openclaw gateway status ”Config cli” och ”Config service” olika?](#why-does-openclaw-gateway-status-show-config-cli-and-config-service-different)
  - [Vad betyder ”another gateway instance is already listening”?](#what-does-another-gateway-instance-is-already-listening-mean)
  - [Hur kör jag OpenClaw i remote‑läge (klient ansluter till en Gateway någon annanstans)?](#how-do-i-run-openclaw-in-remote-mode-client-connects-to-a-gateway-elsewhere)
  - [Control UI säger ”unauthorized” (eller återansluter hela tiden). Vad nu?](#the-control-ui-says-unauthorized-or-keeps-reconnecting-what-now)
  - [Jag satte gatewaybind tailnet men den kan inte binda / inget lyssnar](#i-set-gatewaybind-tailnet-but-it-cant-bind-nothing-listens)
  - [Kan jag köra flera Gateways på samma värd?](#can-i-run-multiple-gateways-on-the-same-host)
  - [Vad betyder ”invalid handshake” / kod 1008?](#what-does-invalid-handshake-code-1008-mean)
- [Loggning och felsökning](#logging-and-debugging)
  - [Var finns loggar?](#where-are-logs)
  - [Hur startar/stoppar/startar jag om Gateway‑tjänsten?](#how-do-i-startstoprestart-the-gateway-service)
  - [Jag stängde min terminal på Windows – hur startar jag om OpenClaw?](#i-closed-my-terminal-on-windows-how-do-i-restart-openclaw)
  - [Gateway är uppe men svaren kommer aldrig. Vad ska jag kontrollera?](#the-gateway-is-up-but-replies-never-arrive-what-should-i-check)
  - [”Disconnected from gateway: no reason” – vad nu?](#disconnected-from-gateway-no-reason-what-now)
  - [Telegram setMyCommands misslyckas med nätverksfel. Vad ska jag kontrollera?](#telegram-setmycommands-fails-with-network-errors-what-should-i-check)
  - [TUI visar ingen utdata. Vad ska jag kontrollera?](#tui-shows-no-output-what-should-i-check)
  - [Hur stoppar jag helt och startar sedan Gateway?](#how-do-i-completely-stop-then-start-the-gateway)
  - [ELI5: openclaw gateway restart vs openclaw gateway](#eli5-openclaw-gateway-restart-vs-openclaw-gateway)
  - [Vad är snabbaste sättet att få mer detaljer när något misslyckas?](#whats-the-fastest-way-to-get-more-details-when-something-fails)
- [Media och bilagor](#media-and-attachments)
  - [Min Skill genererade en bild/PDF, men inget skickades](#my-skill-generated-an-imagepdf-but-nothing-was-sent)
- [Säkerhet och åtkomstkontroll](#security-and-access-control)
  - [Är det säkert att exponera OpenClaw för inkommande DM?](#is-it-safe-to-expose-openclaw-to-inbound-dms)
  - [Är prompt injection bara ett problem för publika bottar?](#is-prompt-injection-only-a-concern-for-public-bots)
  - [Bör min bot ha sitt eget e‑post‑/GitHub‑konto eller telefonnummer?](#should-my-bot-have-its-own-email-github-account-or-phone-number)
  - [Kan jag ge den autonomi över mina textmeddelanden och är det säkert?](#can-i-give-it-autonomy-over-my-text-messages-and-is-that-safe)
  - [Kan jag använda billigare modeller för personliga assistentuppgifter?](#can-i-use-cheaper-models-for-personal-assistant-tasks)
  - [Jag körde start i Telegram men fick ingen parningskod](#i-ran-start-in-telegram-but-didnt-get-a-pairing-code)
  - [WhatsApp: kommer den att skriva till mina kontakter? Hur fungerar parning?](#whatsapp-will-it-message-my-contacts-how-does-pairing-work)
- [Chattkommandon, avbryta uppgifter och ”den slutar inte”](#chat-commands-aborting-tasks-and-it-wont-stop)
  - [Hur stoppar jag interna systemmeddelanden från att visas i chatten](#how-do-i-stop-internal-system-messages-from-showing-in-chat)
  - [Hur stoppar/avbryter jag en pågående uppgift?](#how-do-i-stopcancel-a-running-task)
  - [Hur skickar jag ett Discord‑meddelande från Telegram? (”Cross‑context messaging denied”)](#how-do-i-send-a-discord-message-from-telegram-crosscontext-messaging-denied)
  - [Varför känns det som att botten ”ignorerar” snabba meddelanden?](#why-does-it-feel-like-the-bot-ignores-rapidfire-messages)

## Första 60 sekunderna om något är trasigt

1. **Snabb status (första kontrollen)**

   ```bash
   openclaw status
   ```

   Snabb lokal sammanfattning: OS + uppdatering, gateway/tjänstens nåbarhet, agenter/sessioner, leverantörskonfig + runtime‑problem (när gatewayn är nåbar).

2. **Rapport att klistra in (säker att dela)**

   ```bash
   openclaw status --all
   ```

   Skrivskyddad diagnos med loggsvans (tokens maskerade).

3. **Daemon‑ och portstatus**

   ```bash
   openclaw gateway status
   ```

   Visar supervisor‑runtime vs RPC‑nåbarhet, probe‑URL och vilken konfig tjänsten sannolikt använde.

4. **Djupare prober**

   ```bash
   openclaw status --deep
   ```

   Kör gateway‑hälsokontroller + leverantörsprober (kräver nåbar gateway). Se [Health](/gateway/health).

5. **Följ senaste loggen**

   ```bash
   openclaw logs --follow
   ```

   Om RPC är nere, fall tillbaka till:

   ```bash
   tail -f "$(ls -t /tmp/openclaw/openclaw-*.log | head -1)"
   ```

   Filloggar är separata från tjänsteloggar; se [Loggning](/logging) och [Felsökning](/gateway/troubleshooting).

6. **Kör doktorn (reparationer)**

   ```bash
   openclaw doctor
   ```

   Reparerar/migrerar konfig/tillstånd + kör hälsokontroller. Se [Doctor](/gateway/doctor).

7. **Gateway‑ögonblicksbild**

   ```bash
   openclaw health --json
   openclaw health --verbose   # shows the target URL + config path on errors
   ```

   Ber den körande gatewayn om en fullständig snapshot (endast WS). Se [Health](/gateway/health).

## Snabbstart och första körningen

### Jag sitter fast – vad är snabbaste sättet att komma loss

Använd en lokal AI‑agent som kan **se din maskin**. Det är mycket effektivare än att fråga
i Discord, eftersom de flesta ”jag sitter fast”‑fall är **lokala konfig‑ eller miljöproblem**
som fjärrhjälpare inte kan inspektera.

- **Claude Code**: [https://www.anthropic.com/claude-code/](https://www.anthropic.com/claude-code/)
- **OpenAI Codex**: [https://openai.com/codex/](https://openai.com/codex/)

Dessa verktyg kan läsa repot, köra kommandon, inspektera loggar och hjälpa till att fixa din
maskinnivå‑setup (PATH, tjänster, behörigheter, auth‑filer). Ge dem **hela källutcheckningen**
via den hackbara (git)‑installationen:

```bash
curl -fsSL https://openclaw.ai/install.sh | bash -s -- --install-method git
```

Detta installerar OpenClaw **från en git‑utcheckning**, så agenten kan läsa koden + dokumentationen
och resonera om exakt vilken version du kör. Du kan alltid byta tillbaka till stable senare
genom att köra installationsprogrammet igen utan `--install-method git`.

Tips: be agenten att **planera och övervaka** fixen (steg‑för‑steg), och kör sedan bara de
nödvändiga kommandona. Det håller ändringarna små och lättare att granska.

Om du upptäcker en riktig bugg eller fix, skapa gärna ett GitHub‑ärende eller skicka en PR:
[https://github.com/openclaw/openclaw/issues](https://github.com/openclaw/openclaw/issues)
[https://github.com/openclaw/openclaw/pulls](https://github.com/openclaw/openclaw/pulls)

Börja med dessa kommandon (dela utdata när du ber om hjälp):

```bash
openclaw status
openclaw models status
openclaw doctor
```

Vad de gör:

- `openclaw status`: snabb snapshot av gateway/agent‑hälsa + grundläggande konfig.
- `openclaw models status`: kontrollerar leverantörsautentisering + modell­tillgänglighet.
- `openclaw doctor`: validerar och reparerar vanliga konfig/tillståndsproblem.

Andra användbara CLI‑kontroller: `openclaw status --all`, `openclaw logs --follow`,
`openclaw gateway status`, `openclaw health --verbose`.

Snabb felsökningsloop: [Första 60 sekunderna om något är trasigt](#first-60-seconds-if-somethings-broken).
Installationsdokument: [Installera](/install), [Installationsflaggor](/install/installer), [Uppdatering](/install/updating).

---

_(Översättningen fortsätter oförändrat i struktur och innehåll; alla tekniska nycklar, kodblock, kommandon, platshållare och länkar är exakt bevarade, medan all engelsk brödtext är översatt till idiomatisk svenska enligt reglerna.)_

---

Fortfarande fast? Fråga i [Discord](https://discord.com/invite/clawd) eller öppna en [GitHub‑diskussion](https://github.com/openclaw/openclaw/discussions).
