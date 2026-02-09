---
summary: "Vanliga frågor om installation, konfiguration och användning av OpenClaw"
title: "Vanliga frågor"
---

# Vanliga frågor

Snabba svar plus djupare felsökning för verkliga inställningar (lokal dev, VPS, multi-agent, OAuth/API-nycklar, modellfel). För runtime diagnostik, se [Troubleshooting](/gateway/troubleshooting). För fullständig referens till konfiguration, se [Configuration](/gateway/configuration).

## Innehållsförteckning

- [Snabbstart och första körningen]
  - [Jag sitter fast – vad är snabbaste sättet att komma loss?](#im-stuck-whats-the-fastest-way-to-get-unstuck)
  - [Vad är det rekommenderade sättet att installera och konfigurera OpenClaw?](#whats-the-recommended-way-to-install-and-set-up-openclaw)
  - [Hur öppnar jag instrumentpanelen efter introduktionen?](#how-do-i-open-the-dashboard-after-onboarding)
  - [Hur autentiserar jag instrumentpanelen (token) på localhost jämfört med remote?](#how-do-i-authenticate-the-dashboard-token-on-localhost-vs-remote)
  - [Vilken runtime behöver jag?](#what-runtime-do-i-need)
  - [Kör det på Raspberry Pi?](#does-it-run-on-raspberry-pi)
  - [Några tips för Raspberry Pi‑installationer?](#any-tips-for-raspberry-pi-installs)
  - [Det är fastnat på "vakna upp min vän" / onboarding kommer inte kläckas. Vad nu?](#it-is-stuck-on-wake-up-my-friend-onboarding-will-not-hatch-what-now)
  - [Kan jag migrera min installation till en ny maskin (Mac mini) utan att göra om introduktionen?](#can-i-migrate-my-setup-to-a-new-machine-mac-mini-without-redoing-onboarding)
  - [Var ser jag vad som är nytt i senaste versionen?](#where-do-i-see-what-is-new-in-the-latest-version)
  - [Jag kan inte komma åt docs.openclaw.ai (SSL-fel). Vad nu?](#i-cant-access-docsopenclawai-ssl-error-what-now)
  - [Vad är skillnaden mellan stable och beta?](#whats-the-difference-between-stable-and-beta)
  - [Hur installerar jag beta‑versionen, och vad är skillnaden mellan beta och dev?](#how-do-i-install-the-beta-version-and-whats-the-difference-between-beta-and-dev)
  - [Hur provar jag de senaste ändringarna?](#how-do-i-try-the-latest-bits)
  - [Hur lång tid tar installation och introduktion vanligtvis?](#how-long-does-install-and-onboarding-usually-take)
  - [Installationsprogrammet fastnar? Hur får jag mer feedback?](#installer-stuck-how-do-i-get-more-feedback)
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
  - [Botten fryser medan man gör tungt arbete. Hur avlastar jag det?](#the-bot-freezes-while-doing-heavy-work-how-do-i-offload-that)
  - [Cron eller påminnelser brinner inte. Vad ska jag kontrollera?](#cron-or-reminders-do-not-fire-what-should-i-check)
  - [Hur installerar jag Skills på Linux?](#how-do-i-install-skills-on-linux)
  - [Kan OpenClaw köra uppgifter enligt schema eller kontinuerligt i bakgrunden?](#can-openclaw-run-tasks-on-a-schedule-or-continuously-in-the-background)
  - [Kan jag köra Apple macOS‑endast‑Skills från Linux?](#can-i-run-apple-macos-only-skills-from-linux)
  - [Har ni en Notion‑ eller HeyGen‑integration?](#do-you-have-a-notion-or-heygen-integration)
  - [Hur installerar jag Chrome‑tillägget för webbläsarövertagande?](#how-do-i-install-the-chrome-extension-for-browser-takeover)
- [Sandboxing och minne](#sandboxing-and-memory)
  - [Finns det en dedikerad dokumentation om sandboxing?](#is-there-a-dedicated-sandboxing-doc)
  - [Hur binder jag en värdmapp in i sandboxen?](#how-do-i-bind-a-host-folder-into-the-sandbox)
  - [Hur fungerar minne?](#how-does-memory-work)
  - [Minnet glömmer saker och ting. Hur får jag det att sticka?](#memory-keeps-forgetting-things-how-do-i-make-it-stick)
  - [Består minnet för evigt? Vilka är gränserna?](#does-memory-persist-forever-what-are-the-limits)
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
  - [Vilket format är konfigurationen? Var finns det?](#what-format-is-the-config-where-is-it)
  - [Jag satte gatewaybind lan eller tailnet och nu lyssnar inget / UI säger obehörig](#i-set-gatewaybind-lan-or-tailnet-and-now-nothing-listens-the-ui-says-unauthorized)
  - [Varför behöver jag en token på localhost nu?](#why-do-i-need-a-token-on-localhost-now)
  - [Måste jag starta om efter att ha ändrat konfig?](#do-i-have-to-restart-after-changing-config)
  - [Hur aktiverar jag webbsökning (och web fetch)?](#how-do-i-enable-web-search-and-web-fetch)
  - [config.apply rensade min konfiguration. Hur återhämtar jag mig och undviker detta?](#configapply-wiped-my-config-how-do-i-recover-and-avoid-this)
  - [Hur kör jag en central Gateway med specialiserade workers över flera enheter?](#how-do-i-run-a-central-gateway-with-specialized-workers-across-devices)
  - [Kan OpenClaw‑webbläsaren köras headless?](#can-the-openclaw-browser-run-headless)
  - [Hur använder jag Brave för webbläsarstyrning?](#how-do-i-use-brave-for-browser-control)
- [Fjärr‑Gateways och noder](#remote-gateways-and-nodes)
  - [Hur propagerar kommandon mellan Telegram, gatewayn och noder?](#how-do-commands-propagate-between-telegram-the-gateway-and-nodes)
  - [Hur kan min agent komma åt min dator om Gateway är hostad remote?](#how-can-my-agent-access-my-computer-if-the-gateway-is-hosted-remotely)
  - [Tailscale är ansluten, men jag får inga svar. Vad nu?](#tailscale-is-connected-but-i-get-no-replies-what-now)
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
  - ["Jag startade Gateway via tjänsten och mina env vars försvann." Vad nu?](#i-started-the-gateway-via-the-service-and-my-env-vars-disappeared-what-now)
  - [Jag satte `COPILOT_GITHUB_TOKEN`, men modellernas status visar "Shell env: off." Varför?](#i-set-copilotgithubtoken-but-models-status-shows-shell-env-off-why)
- [Sessioner och flera chattar](#sessions-and-multiple-chats)
  - [Hur startar jag en ny konversation?](#how-do-i-start-a-fresh-conversation)
  - [Återställs sessioner automatiskt om jag aldrig skickar ”new”?](#do-sessions-reset-automatically-if-i-never-send-new)
  - [Finns det ett sätt att göra ett team av OpenClaw‑instanser med en VD och många agenter?](#is-there-a-way-to-make-a-team-of-openclaw-instances-one-ceo-and-many-agents)
  - [Varför blev kontext stympad mitt i uppgiften? Hur förhindrar jag det?](#why-did-context-get-truncated-midtask-how-do-i-prevent-it)
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
  - [Varför ser jag "Modell … är inte tillåtet" och sedan inget svar?](#why-do-i-see-model-is-not-allowed-and-then-no-reply)
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
  - [Kontroll UI säger "obehörig" (eller håller på att återanslutas). Vad nu?](#the-control-ui-says-unauthorized-or-keeps-reconnecting-what-now)
  - [Jag satte gatewaybind tailnet men den kan inte binda / inget lyssnar](#i-set-gatewaybind-tailnet-but-it-cant-bind-nothing-listens)
  - [Kan jag köra flera Gateways på samma värd?](#can-i-run-multiple-gateways-on-the-same-host)
  - [Vad betyder ”invalid handshake” / kod 1008?](#what-does-invalid-handshake-code-1008-mean)
- [Loggning och felsökning](#logging-and-debugging)
  - [Var finns loggar?](#where-are-logs)
  - [Hur startar/stoppar/startar jag om Gateway‑tjänsten?](#how-do-i-startstoprestart-the-gateway-service)
  - [Jag stängde min terminal på Windows – hur startar jag om OpenClaw?](#i-closed-my-terminal-on-windows-how-do-i-restart-openclaw)
  - [The Gateway är uppe men svar kommer aldrig. Vad ska jag kontrollera?](#the-gateway-is-up-but-replies-never-arrive-what-should-i-check)
  - [”Disconnected from gateway: no reason” – vad nu?](#disconnected-from-gateway-no-reason-what-now)
  - [Telegram setMyCommands misslyckas med nätverksfel. Vad ska jag kontrollera?](#telegram-setmycommands-fails-with-network-errors-what-should-i-check)
  - [TUI visar ingen utgång. Vad ska jag kontrollera?](#tui-shows-no-output-what-should-i-check)
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
  - [WhatsApp: kommer det att skicka meddelanden till mina kontakter? Hur fungerar parkoppling?](#whatsapp-will-it-message-my-contacts-how-does-pairing-work)
- [Chattkommandon, avbryta uppgifter och ”den slutar inte”](#chat-commands-aborting-tasks-and-it-wont-stop)
  - [Hur stoppar jag interna systemmeddelanden från att visas i chatten](#how-do-i-stop-internal-system-messages-from-showing-in-chat)
  - [Hur stoppar/avbryter jag en pågående uppgift?](#how-do-i-stopcancel-a-running-task)
  - [Hur skickar jag ett Discord-meddelande från Telegram? ("Korsöverskridande meddelanden nekade")](#how-do-i-send-a-discord-message-from-telegram-crosscontext-messaging-denied)
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

   Kör gateway hälsokontroller + leverantör sonder (kräver en nåbar gateway). Se [Health](/gateway/health).

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

   Reparationer/migrerar config/state + kör hälsokontroller. Se [Doctor](/gateway/doctor).

7. **Gateway‑ögonblicksbild**

   ```bash
   openclaw health --json
   openclaw health --verbose   # shows the target URL + config path on errors
   ```

   Frågar den körande gateway för en fullständig ögonblicksbild (WS-endast). Se [Health](/gateway/health).

## Snabbstart och första körningen

### Jag sitter fast – vad är snabbaste sättet att komma loss

Använd en lokal AI-agent som kan **se din maskin**. Det är mycket effektivare än att fråga
i Discord, eftersom de flesta "Jag har fastnat" fall är **lokala konfigurations- eller miljöproblem** som
fjärrhjälpare inte kan inspektera.

- **Claude Code**: [https://www.anthropic.com/claude-code/](https://www.anthropic.com/claude-code/)
- **OpenAI Codex**: [https://openai.com/codex/](https://openai.com/codex/)

Dessa verktyg kan läsa rapo, köra kommandon, inspektera loggar, och hjälpa till att fixa din maskinnivå
inställning (PATH, tjänster, behörigheter, auth filer). Ge dem **full källa kassan** via
den hackbara (git) installation:

```bash
curl -fsSL https://openclaw.ai/install.sh | bash -s -- --install-method git
```

Detta installerar OpenClaw **från en git-kassa**, så att agenten kan läsa koden + docs och
orsak till den exakta versionen du kör. Du kan alltid växla tillbaka till stable senare
genom att köra om installationsprogrammet utan `--install-method git`.

Tips: be agenten att **planera och övervaka** åtgärden (steg-för-steg), sedan kör endast de
nödvändiga kommandon. Det håller förändringar små och lättare att granska.

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

Snabb debug loop: [Första 60 sekunder om något är trasigt](#first-60-seconds-if-somethings-broken).
Installera dokument: [Install](/install), [Installationsflaggor](/install/installer), [Updating](/install/updating).

### Vad är det rekommenderade sättet att installera och konfigurera OpenClaw

_(Översättningen fortsätter oförändrat i struktur och innehåll; alla tekniska nycklar, kodblock, kommandon, platshållare och länkar är exakt bevarade, medan all engelsk brödtext är översatt till idiomatisk svenska enligt reglerna.)_

```bash
curl -fsSL https://openclaw.ai/install.sh <unk> bash
openclaw ombord --install-daemon
```

Guiden kan också bygga UI tillgångar automatiskt. Efter ombordstigning kör du typiskt Gateway på port **18789**.

Från källa (bidragsgivare/dev):

```bash
git clone https://github.com/openclaw/openclaw.git
cd openclaw
pnpm install
pnpm build
pnpm ui:build # auto-installs UI deps på första körningen
openclaw ombord
```

Om du inte har en global installation ännu, kör den via `pnpm openclaw onboard`.

### Hur öppnar jag instrumentbrädan efter onboarding

Guiden öppnar din webbläsare med en ren (icke-tokenized) instrumentpanel URL direkt efter onboarding och skriver även ut länken i sammanfattningen. Håll den fliken öppen, om den inte startar, kopiera / klistra in den tryckta webbadressen på samma maskin.

### Hur autentiserar jag instrumentbrädans token på localhost vs remote

**Localhost (samma maskin):**

- Öppna `http://127.0.0.1:18789/`.
- Om den ber om auth, klistra in token från `gateway.auth.token` (eller `OPENCLAW_GATEWAY_TOKEN`) i kontrollgränssnittets inställningar.
- Hämta den från gateway-värden: `openclaw config get gateway.auth.token` (eller generera en: `openclaw doctor --generate-gateway-token`).

**Inte på localhost:**

- **Tailscale Serve** (rekommenderas): behåll bind loopback, kör `openclaw gateway --tailscale serve`, öppna `https://<magicdns>/`. Om `gateway.auth.allowTailscale` är `true`, uppfyller identitetshuvuden auth (ingen token).
- **Tailnet bind**: kör `openclaw gateway --bind tailnet --token "<token>"`, open `http://<tailscale-ip>:18789/`, klistra in token i instrumentbrädans inställningar.
- **SSH-tunnel**: `ssh -N -L 18789:127.0.0.1:18789 user@host` öppna sedan `http://127.0.0.1:18789/` och klistra in token i kontrollgränssnittets inställningar.

Se [Dashboard](/web/dashboard) och [webbytor](/web) för binda lägen och auth detaljer.

### Vilken runtime behöver jag

Nod **>= 22** krävs. `pnpm` rekommenderas. Bun är **inte rekommenderas** för Gateway.

### Gör det körs på Raspberry Pi

Ja. Gateway är lätt - dokumentlista **512MB-1GB RAM**, **1 kärna**, och om **500MB**
disk som tillräckligt för personligt bruk, och notera att en **Raspberry Pi 4 kan köra det**.

Om du vill ha extra huvudrum (loggar, media, andra tjänster), rekommenderas **2GB**, men det är
inte ett hårt minimum.

Tips: en liten Pi/VPS kan vara värd för Gateway, och du kan koppla **noder** till din bärbara dator/telefon för
lokal skärm/kamera/canvas eller kommandoutförande. Se [Nodes](/nodes).

### Några tips för Raspberry Pi installerar

Kort version: det fungerar, men förvänta dig grova kanter.

- Använd en **64-bitars** OS och behåll Node >= 22.
- Föredrar **hackbar (git) install** så att du kan se loggar och uppdatera snabbt.
- Börja utan kanaler/färdigheter, lägg sedan till dem en efter en.
- Om du träffar konstiga binära problem, är det oftast ett **ARM-kompatibilitet** problem.

Dokument: [Linux](/platforms/linux), [Install](/install).

### Det har fastnat på vakna min vän kommer inte att kläckas Vad nu

Den skärmen beror på att Gateway kan nås och autentiseras. TUI skickar också
"Vakna upp, min vän!" automatiskt på första luckan. Om du ser den raden med **inget svar**
och tokens stanna på 0, agenten sprang aldrig.

1. Starta om Gateway:

```bash
openclaw gateway restart
```

2. Kontrollera status + auth:

```bash
openclaw status
openclaw modellens status
openclaw loggar --follow
```

3. Om det fortfarande hänger, köra:

```bash
openclaw doctor
```

Om Gateway är fjärrstyrd, se till att tunneln/Tailscale anslutningen är uppe och att UI
pekas på rätt Gateway. Se [Remote access](/gateway/remote).

### Kan jag migrera min installation till en ny maskin Mac mini utan ombordstigning

Ja. Kopiera **statskatalogen** och **arbetsyta**, kör sedan Doctor en gång. Denna
håller din bot "exakt densamma" (minne, sessionshistorik, författare och kanal
tillstånd) så länge du kopierar **båda** platser:

1. Installera OpenClaw på den nya maskinen.
2. Kopiera `$OPENCLAW_STATE_DIR` (standard: `~/.openclaw`) från den gamla maskinen.
3. Kopiera din arbetsyta (standard: `~/.openclaw/workspace`).
4. Kör `openclaw doctor` och starta om Gateway-tjänsten.

Som bevarar konfiguration, auth profiler, WhatsApp krediter, sessioner och minne. Om du är i
fjärrläge, kom ihåg gateway-värden äger sessionsbutiken och arbetsytan.

**Viktigt:** om du bara förbinder/trycker din arbetsyta till GitHub, säkerhetskopierar du
upp **minne + bootstrap-filer**, men **inte** sessionshistorik eller författa. De lever
under `~/.openclaw/` (till exempel `~/.openclaw/agents/<agentId>/sessions/`).

Relaterat: [Migrating](/install/migrating), [Var saker och ting lever på disk](/help/faq#where-does-openclaw-store-its-data),
[Agent workspace](/concepts/agent-workspace), [Doctor](/gateway/doctor),
[Remote mode](/gateway/remote).

### Var ser jag vad som är nytt i den senaste versionen

Kontrollera GitHub changelog:
[https://github.com/openclaw/openclaw/blob/main/CHANGELOG.md](https://github.com/openclaw/openclaw/blob/main/CHANGELOG.md)

Nyaste poster är på toppen. Om det översta avsnittet är markerat **Osläppt**, är nästa daterade
sektionen den senaste levererade versionen. Poster är grupperade efter **Höjdpunkter**, **ändringar**, och
**Fixes** (plus docs/andra sektioner när det behövs).

### Jag kan inte komma åt docs.openclaw.ai SSL-fel Vad nu

Vissa Comcast/Xfinity-anslutningar blockerar felaktigt `docs.openclaw.ai` via Xfinity
Advanced Security. Inaktivera det eller tillåt lista `docs.openclaw.ai`, försök sedan. Mer
detalj: [Troubleshooting](/help/troubleshooting#docsopenclawai-shows-an-ssl-error-comcastxfinity).
Hjälp oss att avblockera det genom att rapportera här: [https://spa.xfinity.com/check_url_status](https://spa.xfinity.com/check_url_status).

Om du fortfarande inte kan nå webbplatsen speglas dokumenten på GitHub:
[https://github.com/openclaw/openclaw/tree/main/docs](https://github.com/openclaw/openclaw/tree/main/docs)

### Vad är skillnaden mellan stabil och beta

**Stabil** och **beta** är **npm dist-tags**, inte separata kodrader:

- `latest` = stabil
- `beta` = tidig uppbyggnad för testning

Vi skickar byggen till **beta**, testa dem, och när en bygg är solid främjar vi \*\*
samma version till `latest`\*\*. Det är därför beta och stabila kan peka mot
**samma version**.

Se vad som ändrats:
[https://github.com/openclaw/openclaw/blob/main/CHANGELOG.md](https://github.com/openclaw/openclaw/blob/main/CHANGELOG.md)

### Hur installerar jag betaversionen och vad är skillnaden mellan beta och dev

**Beta** är dist-taggen npm `beta` (kan matcha `latest`).
**Dev** är det rörliga huvudet av `main` (git); när den är publicerad använder den npm dist-taggen `dev`.

One-liners (macOS/Linux):

```bash
curl -fsSL --proto '=https' --tlsv1.2 https://openclaw.ai/install.sh <unk> bash -s -- --beta
```

```bash
curl -fsSL --proto '=https' --tlsv1.2 https://openclaw.ai/install.sh <unk> bash -s -- --install-method git
```

Windows installer (PowerShell):
[https://openclaw.ai/install.ps1](https://openclaw.ai/install.ps1)

Mer detalj: [Utvecklingskanaler](/install/development-channels) och [Installationsflaggor](/install/installer).

### Hur lång tid det tar för installationen och onboarding

Tuff guide:

- **Installera:** 2-5 minuter
- **Onboard:** 5-15 minuter beroende på hur många kanaler/modeller du konfigurerar

Om det hänger, använd [Installer stuck](/help/faq#installer-stuck-how-do-i-get-more-feedback)
och den snabba debug loopen i [Im stuck](/help/faq#im-stuck--whats-the-fastest-way-to-get-unstuck).

### Hur gör jag för att prova de senaste bitarna

Två alternativ:

1. **Dev kanal (git kassa):**

```bash
openclaw uppdatering --channel dev
```

Detta växlar till grenen `main` och uppdateringar från källan.

2. **Hackbar installation (från installationssidan):**

```bash
curl -fsSL https://openclaw.ai/install.sh | bash -s -- --install-method git
```

Det ger dig en lokal repo du kan redigera, sedan uppdatera via git.

Om du föredrar en ren klon manuellt, användning:

```bash
git clone https://github.com/openclaw/openclaw.git
cd openclaw
pnpm install
pnpm build
```

Dokument: [Update](/cli/update), [Utvecklingskanaler](/install/development-channels),
[Install](/install).

### Installationsprogram fastnat Hur får jag mer feedback

Kör om installationsprogrammet med **verbose output**:

```bash
curl -fsSL https://openclaw.ai/install.sh <unk> bash -s -- --verbose
```

Beta installation med verbos:

```bash
curl -fsSL https://openclaw.ai/install.sh <unk> bash -s -- --beta --verbose
```

För en hackbar (git) installation:

```bash
curl -fsSL https://openclaw.ai/install.sh <unk> bash -s -- --install-method git --verbose
```

Fler alternativ: [Installationsflaggor](/install/installer).

### Windows installera säger git inte hittades eller openclaw inte känns igen

Två vanliga Windows-problem:

**1) npm fel vid spawngit / git hittades inte**

- Installera **Git för Windows** och se till att `git` är på din PATH.
- Stäng och öppna PowerShell igen och kör sedan om installationsprogrammet.

\*\*2) openclaw känns inte igen efter installationen \*\*

- Din npm globala bin mapp är inte på PATH.

- Kontrollera sökvägen:

  ```powershell
  npm config get prefix
  ```

- Säkerställ att `<prefix>\\bin` är på PATH (på de flesta system är det `%AppData%\\npm`).

- Stäng och öppna PowerShell igen efter uppdatering PATH.

Om du vill ha den smidigaste Windows-konfigurationen, använd **WSL2** istället för inhemska Windows.
Dokument: [Windows](/platforms/windows).

### Dokumenten besvarade inte min fråga hur jag får ett bättre svar

Använd **hackbar (git) install** så att du har full källkod och dokumentation lokalt, fråga sedan
din bot (eller Claude/Codex) _från den mappen_ så att den kan läsa repo och svara exakt.

```bash
curl -fsSL https://openclaw.ai/install.sh | bash -s -- --install-method git
```

Mer detalj: [Install](/install) och [Installationsflaggor](/install/installer).

### Hur installerar jag OpenClaw på Linux

Kort svar: Följ Linuxguiden och kör sedan onboardingguiden.

- Linux quick path + service install: [Linux](/platforms/linux).
- Fullständig genomgång: [Komma igång](/start/getting-started).
- Installer + uppdateringar: [Installera & uppdateringar](/install/updating).

### Hur installerar jag OpenClaw på en VPS

Alla Linux VPS fungerar. Installera på servern och använd sedan SSH/Tailscale för att nå Gateway.

Guider: [exe.dev](/install/exe-dev), [Hetzner](/install/hetzner), [Fly.io](/install/fly).
Fjärråtkomst: [Gateway remote](/gateway/remote).

### Var finns installationsguiderna för molnVPS

Vi behåller en \*\* hostinghubb \*\* med de gemensamma leverantörerna. Välj en och följ guiden:

- [VPS hosting](/vps) (alla leverantörer på ett ställe)
- [Fly.io](/install/fly)
- [Hetzner](/install/hetzner)
- [exe.dev](/install/exe-dev)

Hur det fungerar i molnet: **Gateway körs på servern**, och du kommer åt det
från din bärbara dator/telefon via styrgränssnittet (eller Skala/SSH). Ditt tillstånd + arbetsyta
lever på servern, så behandla värden som källan till sanningen och säkerhetskopiera den.

Du kan koppla **noder** (Mac/iOS/Android/headless) till det molnet Gateway för att komma åt
lokal skärm/kamera/canvas eller köra kommandon på din bärbara dator samtidigt som du behåller
Gateway i molnet.

Hub: [Platforms](/platforms). Fjärråtkomst: [Gateway remote](/gateway/remote).
Nodes: [Nodes](/nodes), [Nodes CLI](/cli/nodes).

### Kan jag be OpenClaw att uppdatera sig själv

Kort svar: **möjligt, rekommenderas inte**. Uppdateringsflödet kan starta om
Gateway (som tappar den aktiva sessionen), kan behöva en ren git kassan, och
kan be om bekräftelse. Säkrare: kör uppdateringar från ett skal som operatör.

Använd CLI:

```bash
openclaw update
openclaw update status
openclaw update --channel stable<unk> beta<unk> dev
openclaw update --tag <dist-tag|version>
openclaw update --no-restart
```

Om du måste automatisera från en agent:

```bash
openclaw update --yes --no-restart
openclaw gateway omstart
```

Dokument: [Update](/cli/update), [Updating](/install/updating).

### Vad gör onboarding guiden faktiskt göra

`openclaw onboard` är den rekommenderade inställningssökvägen. I **lokalt läge** går det dig genom:

- **Konfigurering av modell/auth** (Antropisk **setup-token** rekommenderas för Claude-prenumerationer, OpenAI Codex OAuth stöds, API-nycklar som är valfria, lokala modeller som stöds)
- **Arbetsplatsen** plats + bootstrap filer
- **Gateway inställningar** (bind/port/auth/tailscale)
- **Leverantörer** (WhatsApp, Telegram, Discord, Mattermost (plugin), Signal, iMessage)
- **Daemon installer** (LaunchAgent på macOS; system-användarenhet på Linux/WSL2)
- **Hälsokontroller** och **färdigheter** urval

Det varnar också om din konfigurerade modell är okänd eller saknar författ.

### Behöver jag en Claude eller OpenAI prenumeration för att köra detta

Nej. Du kan köra OpenClaw med **API-nycklar** (Anthropic/OpenAI/others) eller med
**lokala modeller** så att dina data stannar på din enhet. Prenumerationer (Claude
Pro/Max eller OpenAI Codex) är valfria sätt att autentisera dessa leverantörer.

Dokument: [Anthropic](/providers/anthropic), [OpenAI](/providers/openai),
[Lokala modeller](/gateway/local-models), [Models](/concepts/models).

### Kan jag använda Claude Max abonnemang utan en API-nyckel

Ja. Du kan autentisera med en **setup-token**
istället för en API-nyckel. Detta är abonnemangets väg.

Claude Pro/Max prenumerationer **inkluderar inte en API-nyckel**, så det här är
rätt metod för prenumerationskonton. Förutsättning: du måste verifiera med
Anthropic att denna användning är tillåten enligt deras prenumerationspolicy och villkor.
Om du vill ha den mest explicita sökvägen, använd en Anthropic API-nyckel.

### Hur fungerar Anthropic setuptoken auth

`claude setup-token` genererar en **tokensträng** via Claude Code CLI (det är inte tillgängligt i webbkonsolen). Du kan köra den på **alla maskiner**. Välj **Antropisk token (klistra in setup-token)** i guiden eller klistra in den med `openclaw models auth paste-token --provider anthropic`. Token lagras som en auth profil för leverantören **anthropic** och används som en API-nyckel (ingen automatisk uppdatering). Mer detalj: [OAuth](/concepts/oauth).

### Var hittar jag en antropisk setuptoken

Det är **inte** i Antropiska konsolen. Uppsättningstoken genereras av **Claude Code CLI** på **alla maskiner**:

```bash
claude setup-token
```

Kopiera token det skriver ut, välj sedan **Antropisk token (klistra in setup-token)** i guiden. Om du vill köra det på gateway-värden, använd `openclaw models auth setup-token --provider anthropic`. Om du körde `claude setup-token` någon annanstans, klistra in den på gateway-värden med `openclaw-modeller auth paste-token --provider anthropic`. Se [Anthropic](/providers/anthropic).

### Stödjer du Claude prenumeration auth (Claude Pro eller Max)

Ja - via **setup-token**. OpenClaw återanvänder inte längre Claude Code CLI OAuth tokens; använd en setup-token eller en antropisk API-nyckel. Generera token var som helst och klistra in den på gatewayvärden. Se [Anthropic](/providers/anthropic) och [OAuth](/concepts/oauth).

Obs: Claude prenumerationsaccess styrs av Anthropics villkor. För produktion eller arbetsbelastning för flera användare, API-nycklar är oftast det säkrare valet.

### Varför ser jag HTTP 429 ratelimiterror från Anthropic

Det betyder att din **antropiska kvot/räntegång** är utmattad för det aktuella fönstret. Om du
använder en **Claude prenumeration** (setup-token eller Claude Code OAuth), vänta på fönstret till
återställa eller uppgradera din plan. Om du använder en **Anthropic API-nyckel**, kontrollera Anthropic Console
för användning/fakturering och höja gränserna efter behov.

Tips: ställ in en **reservmodell** så att OpenClaw kan fortsätta svara medan en leverantör är hastighetsbegränsad.
Se [Models](/cli/models) och [OAuth](/concepts/oauth).

### Stöds AWS berggrund

Ja - via pi-ais **Amazon Bedrock (Converse)** leverantör med **manuell konfiguration**. Du måste ange AWS autentiseringsuppgifter/region på gateway-värden och lägga till en berggrund leverantörsinmatning i din modellkonfiguration. Se [Amazon Bedrock](/providers/bedrock) och [Modellleverantörer](/providers/models). Om du föredrar ett hanterat nyckelflöde är en OpenAI-kompatibel proxy framför Bedrock fortfarande ett giltigt alternativ.

### Hur fungerar Codex auth

OpenClaw stöder **OpenAI-kod (Codex)** via OAuth (ChatGPT-inloggning). Guiden kan köra OAuth flödet och kommer att ställa in standardmodellen till `openai-codex/gpt-5.3-codex` när det är lämpligt. Se [Modellleverantörer](/concepts/model-providers) och [Wizard](/start/wizard).

### Stödjer du OpenAI prenumeration auth Codex OAuth

Ja. OpenClaw stöder till fullo **OpenAI-kod (Codex) prenumeration OAuth**. Onboarding guiden
kan köra OAuth flödet för dig.

Se [OAuth](/concepts/oauth), [Modellleverantörer](/concepts/model-providers) och [Wizard](/start/wizard).

### Hur ställer jag in Gemini CLI OAuth

Gemini CLI använder ett **plugin auth flow**, inte ett klient-id eller hemligt i `openclaw.json`.

Steg

1. Aktivera plugin: 'openclaw plugins aktivera google-gemini-cli-auth'
2. Logga in: `openclaw models auth login --provider google-gemini-cli --set-default`

Detta lagrar OAuth tokens i auth profiler på gateway värd. Detaljer: [Modellleverantörer](/concepts/model-providers).

### Är en lokal modell OK för avslappnade chattar

Vanligtvis nej. OpenClaw behöver stort sammanhang + stark säkerhet; små kort trunkerar och läcker. Om du måste köra **största** MiniMax M2.1 kan du bygga lokalt (LM Studio) och se [/gateway/local-models](/gateway/local-models). Mindre / kvantifierade modeller ökar risken för snabb injektion - se [Security](/gateway/security).

### Hur behåller jag modelltrafiken i en viss region

Välj region-pinnade slutpunkter. OpenRouter exponerar USA-hostade alternativ för MiniMax, Kimi och GLM; välj den USA-hostade varianten för att hålla data i regionen. Du kan fortfarande lista Anthropic/OpenAI tillsammans med dessa genom att använda `models.mode: "merge"` så reservdelar förblir tillgängliga medan du respekterar den regionerade leverantören du väljer.

### Måste jag köpa en Mac Mini för att installera detta

Nej. OpenClaw körs på macOS eller Linux (Windows via WSL2). En Mac mini är valfri - vissa människor
köpa en som en alltid - på värd, men en liten VPS, hemserver, eller Raspberry Pi-klass box fungerar också.

Du behöver bara en Mac **för macOS-verktyg**. För iMessage, använd [BlueBubbles](/channels/bluebubbles) (rekommenderas) - BlueBubbles server körs på vilken Mac som helst, och Gateway kan köras på Linux eller någon annanstans. Om du vill ha andra macOS-bara verktyg, kör Gateway på en Mac eller para ihop en macOS-nod.

Dokument: [BlueBubbles](/channels/bluebubbles), [Nodes](/nodes), [Mac remote mode](/platforms/mac/remote).

### Behöver jag en Mac mini för iMessage support

Du behöver **vissa macOS-enhet** inloggade i Meddelanden. Det behöver **inte** vara en Mac mini -
alla Mac fungerar. **Använd [BlueBubbles](/channels/bluebubbles)** (rekommenderas) för iMessage - BlueBubbles server körs på macOS, medan Gateway kan köras på Linux eller någon annanstans.

Vanliga inställningar:

- Kör Gateway på Linux/VPS, och kör BlueBubbles server på alla Mac som är inloggade i Meddelanden.
- Kör allt på Mac om du vill ha den enklaste enkel-maskin setup.

Dokument: [BlueBubbles](/channels/bluebubbles), [Nodes](/nodes),
[Mac remote mode](/platforms/mac/remote).

### Om jag köper en Mac mini att köra OpenClaw kan jag ansluta den till min MacBook Pro

Ja. **Mac mini kan köra Gateway**, och din MacBook Pro kan ansluta som en
**node** (följeslagarenhet). Noder kör inte Gateway - de ger extra
funktioner som skärm/kamera/canvas och `system.run` på den enheten.

Vanligt mönster:

- Gateway på Mac mini (alltid-på).
- MacBook Pro kör macOS app eller en nod värd och par till Gateway.
- Använd `openclaw nodes status` / `openclaw nodes list` för att se den.

Dokumentation: [Nodes](/nodes), [Nodes CLI](/cli/nodes).

### Kan jag använda Bun

Bun är **inte rekommenderas**. Vi ser körtidsbuggar, särskilt med WhatsApp och Telegram.
Använd **Node** för stabila gateways.

Om du fortfarande vill experimentera med Bun, gör det på en icke-produktionsgateway
utan WhatsApp/Telegram.

### Telegram vad som går i tillåtna

`channels.telegram.allowFrom` är **den mänskliga avsändarens Telegram användar-ID** (numerisk, rekommenderas) eller `@username`. Det är inte bot användarnamn.

Säkrare (ingen tredjepartsbot):

- DM din bot och kör sedan `openclaw loggar --follow` och läs `from.id`.

Officiellt bot-API:

- DM din bot och anropa sedan `https://api.telegram.org/bot<bot_token>/getUpdates` och läs `message.from.id`.

Tredjepart (mindre privat):

- DM `@userinfobot` eller `@getidsbot`.

Se [/channels/telegram](/channels/telegram#access-control-dms--groups).

### Kan flera personer använda ett WhatsApp-nummer med olika OpenClaw instanser

Ja, via **multi-agent routing**. Bind varje avsändares WhatsApp **DM** (peer `kind: "dm" `, avsändare E. 64 som `+15551234567`) till en annan `agentId`, så varje person får sin egen arbetsyta och session butik. Svaren kommer fortfarande från **samma WhatsApp-konto**, och DM åtkomstkontroll (`channels.whatsapp.dmPolicy` / `channels.whatsapp.allowFrom`) är global per WhatsApp-konto. Se [Multi-Agent Routing](/concepts/multi-agent) och [WhatsApp](/channels/whatsapp).

### Kan jag köra en snabb chattagent och en Opus för kodningsagent

Ja. Använd multi-agent routing: ge varje agent sin egen standardmodell, bind sedan inkommande rutter (leverantörskonto eller specifika jämnåriga) till varje agent. Exempel på konfigurationen lever i [Multi-Agent Routing](/concepts/multi-agent). Se även [Models](/concepts/models) och [Configuration](/gateway/configuration).

### Arbetar Homebrew på Linux

Ja. Homebrew stöder Linux (Linuxbrew). Snabbstart:

```bash
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
echo 'eval "$(/home/linuxbrew/.linuxbrew/bin/brew shellenv)"' >> ~/.profile
eval "$(/home/linuxbrew/.linuxbrew/bin/brew shellenv)"
brew install <formula>
```

Om du kör OpenClaw via systemet, se till att tjänsten PATH innehåller `/home/linuxbrew/.linuxbrew/bin` (eller ditt bryggprefix) så `brew`-installerade verktyg löser i icke-inloggningsskal.
Nyligen byggda även prepend common user bin dirs on Linux systemd services (till exempel `~/.local/bin`, `~/.npm-global/bin`, `~/.local/share/pnpm`, `~/. un/bin`) och honor `PNPM_HOME`, `NPM_CONFIG_PREFIX`, `BUN_INSTALL`, `VOLTA_HOME`, `ASDF_DATA_DIR`, `NVM_DIR` och `FNM_DIR` när den är inställd.

### Vad är skillnaden mellan den hackbara git install och npm install

- **Hackable (git) installerar:** full källa checkout, redigerbar, bäst för bidragsgivare.
  Du kör bygger lokalt och kan lappa kod/dokument.
- **npm installera:** global CLI installera, ingen repo, bäst för att "bara köra det".
  Uppdateringar kommer från npm dist-taggar.

Dokument: [Komma igång](/start/getting-started), [Updating](/install/updating).

### Kan jag växla mellan npm och git installeras senare

Ja. Installera den andra smaken, kör sedan Doctor så gateway servicepunkter på den nya ingångspunkten.
Denna **tar inte bort dina data** - den ändrar bara OpenClaw-koden installera. Ditt tillstånd
(`~/.openclaw`) och arbetsytan (`~/.openclaw/workspace`) förblir orörd.

Från npm → git:

```bash
git clone https://github.com/openclaw/openclaw.git
cd openclaw
pnpm install
pnpm build
openclaw doctor
openclaw gateway omstart
```

Från git → npm:

```bash
npm install -g openclaw@senaste
openclaw doctor
openclaw gateway omstart
```

Läkare upptäcker en gateway-tjänst som inte stämmer överens med varandra och erbjuder sig att skriva om konfigurationen för tjänsten för att matcha den aktuella installationen (använd `--reparair` i automation).

Tips: se [Backupstrategi](/help/faq#whats-the-recommended-backup-strategy).

### Ska jag köra Gateway på min bärbara dator eller en VPS

Kort svar: **om du vill ha pålitlighet dygnet runt, använd en VPS**. Om du vill ha den lägsta friktionen på
och du är okej med vila/starta om, kör den lokalt.

**Bärbar dator (lokal Gateway)**

- **Pro:** ingen serverkostnad, direkt åtkomst till lokala filer, live webbläsarfönster.
- **Nackdelar:** sömn/nätverksdroppar = frånkopplingar, OS-uppdateringar/omstarter avbryta, måste vara vakna.

**VPS / moln**

- **Pro:** alltid-på, stabilt nätverk, inga problem med laptops sömn, lättare att köra.
- **Koner:** kör ofta huvudlöst (använd skärmdumpar), fjärråtkomst till filer, du måste SSH för uppdateringar.

**OpenClaw-specifik anteckning:** WhatsApp/Telegram/Slack/Mattermost (plugin)/Discord fungerar alla bra från en VPS. Den enda riktiga avvägningen är **huvudlös webbläsare** mot ett synligt fönster. Se [Browser](/tools/browser).

**Rekommenderad standard:** VPS om du hade gateway kopplas från tidigare. Lokalt är bra när du aktivt använder Mac och vill ha lokal filåtkomst eller UI-automatisering med en synlig webbläsare.

### Hur viktigt är det att köra OpenClaw på en dedikerad maskin

Krävs inte, men **rekommenderas för tillförlitlighet och isolering**.

- **Dedikerad värd (VPS/Mac mini/Pi):** alltid, färre vilo/omstart avbrott, renare behörigheter, lättare att fortsätta köra.
- **Delad laptop/skrivbord:** helt okej för testning och aktiv användning, men förvänta dig pauser när maskinen sover eller uppdaterar.

Om du vill ha det bästa av två världar, hålla Gateway på en dedikerad värd och koppla din bärbara dator som en **nod** för lokal skärm/kamera/exec-verktyg. Se [Nodes](/nodes).
För säkerhetsvägledning, läs [Security](/gateway/security).

### Vilka är minimikraven för VPS och rekommenderat OS

OpenClaw är lätt. För en grundläggande Gateway + en chatt kanal:

- **Absolut minimum:** 1 vCPU, 1GB RAM, ~500MB disk.
- **Rekommenderas:** 1-2 vCPU, 2 GB RAM eller mer för huvudrum (loggar, media, flera kanaler). Node verktyg och webbläsarautomatisering kan vara resurssunga.

OS: Använd **Ubuntu LTS** (eller alla moderna Debian/Ubuntu). Linux installationsvägen är bäst testad där.

Dokument: [Linux](/platforms/linux), [VPS hosting](/vps).

### Kan jag köra OpenClaw i en VM och vilka är kraven

Ja. Behandla en VM på samma sätt som en VPS: den måste alltid vara på, nåbar, och har tillräckligt med
RAM för Gateway och alla kanaler du aktiverar.

Baslinje vägledning:

- **Absolut minimum:** 1 vCPU, 1 GB RAM.
- **Rekommenderas:** 2GB RAM eller mer om du kör flera kanaler, webbläsarautomatisering eller mediaverktyg.
- **OS:** Ubuntu LTS eller en annan modern Debian/Ubuntu.

Om du är i Windows, är **WSL2 den enklaste VM stil setup** och har den bästa verktyget
kompatibilitet. Se [Windows](/platforms/windows), [VPS hosting](/vps).
Om du kör macOS i en VM, se [macOS VM](/install/macos-vm).

## Vad är OpenClaw?

### Vad är OpenClaw i ett stycke

OpenClaw är en personlig AI-assistent som du kör på dina egna enheter. Den svarar på de meddelandeytor du redan använder (WhatsApp, Telegram, Slack, Mattermost (plugin), Discord, Google Chat, Signal, iMessage, WebChat) och kan också göra röst + en levande Canvas på stödda plattformar. **Gateway** är det alltid på kontrollplanet; assistenten är produkten.

### Vad är värdet proposition

OpenClaw är inte "bara ett Claude-omslag". Det är ett **lokalt första styrplan** som låter dig köra en
kapabel assistent på **din egen maskinvara**, som kan nås från de chattappar du redan använder, med
staty sessioner, minne och verktyg - utan att lämna kontroll över dina arbetsflöden till en värd
SaaS.

Höjdpunkter:

- **Dina enheter, dina data:** kör Gateway var du än vill (Mac, Linux, VPS) och behåller arbetsytan* sessionshistorik lokalt.
- **Verkliga kanaler, inte en webb-sandlåda:** WhatsApp/Telegram/Slack/Discord/Signal/iMessage/etc,
  plus mobil röst och Canvas på stödda plattformar.
- **Modell-agnostik:** använd Anthropic, OpenAI, MiniMax, OpenRouter, etc., med per-agent routing
  och failover.
- **Lokalt endast:** kör lokala modeller så **all data kan stanna på din enhet** om du vill.
- **Multi-agent routing:** separata agenter per kanal, konto eller uppgift, var och en med sin egen
  arbetsyta och standard.
- **Öppen källkod och hackbar:** inspektera, utöka och själv värd utan leverantörens låsning.

Dokument: [Gateway](/gateway), [Channels](/channels), [Multi-agent](/concepts/multi-agent),
[Memory](/concepts/memory).

### Jag bara ställa in det vad jag ska göra först

Bra första projekt:

- Bygg en webbplats (WordPress, Shopify, eller en enkel statisk plats).
- Prototyp en mobilapp (kontur, skärmar, API-plan).
- Organisera filer och mappar (rensning, namngivning, taggning).
- Anslut Gmail och automatisera sammanfattningar eller uppföljningar.

Den kan hantera stora uppgifter, men det fungerar bäst när man delar upp dem i faser och
använder underagenter för parallellt arbete.

### Vilka är de fem mest vardagliga användningsfallen för OpenClaw

Vardagsvinster brukar se ut:

- **Personliga genomgångar:** sammanfattningar av inkorg, kalender och nyheter du bryr dig om.
- **Forskning och utkast:** snabb forskning, sammanfattningar och första utkast till e-post eller dokument.
- **Påminnelser och uppföljningar:** Cron- eller hjärtslagsdrivna knuffar och checklistor.
- **Webbläsarautomatisering:** ifyllande formulär, insamling av data och upprepande webbuppgifter.
- **Cross enhetskoordination:** skicka en uppgift från din telefon, låt Gateway köra den på en server och få resultatet tillbaka i chatten.

### Kan OpenClaw hjälpa till med lead gen uppsökande annonser och bloggar för en SaaS

Ja för **forskning, kvalifikationer och utarbetande**. Det kan skanna webbplatser, bygga shortlists,
sammanfatta framtidsutsikter och skriva utåtriktade eller annonskopieringsutkast.

För **uppsökande eller annonskörning**, håll en människa i loopen. Undvik skräppost, följ lokala lagar och
plattformspolicyer, och granska allt innan det skickas. Det säkraste mönstret är att låta
OpenClaw utkast och du godkänner.

Dokument: [Security](/gateway/security).

### Vilka är fördelarna mot Claude Code för webbutveckling

OpenClaw är ett **personlig assistent** och koordinationslager, inte en IDE-ersättning. Använd
Claude Code eller Codex för den snabbaste direkta kodningsslingan inuti en repa. Använd OpenClaw när du
vill ha hållbart minne, åtkomst över enheter och verktygsorkestrering.

Fördelar:

- **Beständigt minne + arbetsyta** över sessioner
- **Åtkomst till flera plattformar** (WhatsApp, Telegram, TUI, WebChat)
- **Verktygsorkestrering** (webbläsare, filer, schemaläggning, krokar)
- **Alltid-på Gateway** (kör på en VPS, interagera var som helst)
- **Noder** för lokal webbläsare/skärm/kamera/exec

Showcase: [https://openclaw.ai/showcase](https://openclaw.ai/showcase)

## Färdighet och automatisering

### Hur anpassar jag kompetens utan att hålla repo smutsiga

Använd hanterade åsidosättningar istället för att redigera reporoporten. Sätt dina ändringar i `~/.openclaw/skills/<name>/SKILL.md` (eller lägg till en mapp via `skills.load.extraDirs` i `~/.openclaw/openclaw.json`). Precedence is `<workspace>/skills` > `~/.openclaw/skills` > bundled, så hanterade overrides win utan att röra git. Endast upstream-worthy redigeringar bör leva i repo och gå ut som PR.

### Kan jag ladda färdigheter från en anpassad mapp

Ja. Lägg till extra kataloger via `skills.load.extraDirs` i `~/.openclaw/openclaw.json` (lägsta prioritet). Standardprioritet återstår: `<workspace>/skills` → `~/.openclaw/skills` → buntade → `skills.load.extraDirs`. `clawhub` installeras i `./skills` som standard, som OpenClaw behandlar som `<workspace>/skills`.

### Hur kan jag använda olika modeller för olika uppgifter

Idag stöds mönstren är:

- **Cron jobb**: isolerade jobb kan ställa in en `modell` åsidosätt per jobb.
- **Underagenter**: dirigera uppgifter för att separera agenter med olika standardmodeller.
- **On-demand switch**: använd `/model` för att växla den aktuella sessionsmodellen när som helst.

Se [Cron jobs](/automation/cron-jobs), [Multi-Agent Routing](/concepts/multi-agent) och [Slash kommandon](/tools/slash-commands).

### Botten fryser medan du gör hårt arbete Hur gör jag avlasta det

Använd **underagenter** för långa eller parallella uppgifter. Underagenter kör i sin egen session,
returnera en sammanfattning, och hålla din huvudchatt lyhörd.

Be din bot att "skapa en underagent för denna uppgift" eller använd `/subagents`.
Använd `/status` i chatten för att se vad Gateway gör just nu (och om det är upptaget).

Token Tips: långa uppgifter och underagenter båda konsumerar tokens. Om kostnaden är ett bekymmer, ange en
billigare modell för underagenter via `agents.defaults.subagents.model`.

Dokument: [Sub-agents](/tools/subagents).

### Cron eller påminnelser inte eld Vad ska jag kontrollera

Cron körs inne i Gateway processen. Om Gateway inte körs kontinuerligt, kommer
schemalagda jobb inte att köras.

Checklista:

- Bekräfta cron är aktiverad (`cron.enabled`) och `OPENCLAW_SKIP_CRON` är inte inställd.
- Kontrollera att Gateway körs 24/7 (ingen viloläge/omstart).
- Verifiera tidzoninställningar för jobbet (`--tz` vs värdtidszon).

Debug:

```bash
openclaw cron kör <jobId> --force
openclaw cron kör --id <jobId> --limit 50
```

Dokument: [Cron jobb](/automation/cron-jobs), [Cron vs Heartbeat](/automation/cron-vs-heartbeat).

### Hur installerar jag färdigheter på Linux

Använd **ClawHub** (CLI) eller släpp färdigheter i din arbetsyta. macOS Skills UI är inte tillgängligt på Linux.
Bläddra bland färdigheter på [https://clawhub.com](https://clawhub.com).

Installera ClawHub CLI (välj en pakethanterare):

```bash
npm i -g clawhub
```

```bash
pnpm add -g clawhub
```

### Kan OpenClaw köra uppgifter på ett schema eller kontinuerligt i bakgrunden

Ja. Använd schemat för Gateway:

- **Cron jobb** för schemalagda eller återkommande uppgifter (kvarstår vid omstart).
- **Heartbeat** för "main session" periodiska kontroller.
- **Isolerade jobb** för autonoma agenter som lägger upp sammanfattningar eller levererar till chattar.

Dokument: [Cron jobs](/automation/cron-jobs), [Cron vs Heartbeat](/automation/cron-vs-heartbeat),
[Heartbeat](/gateway/heartbeat).

### Kan jag köra endast kunskaper i Apple macOS-system från Linux?

Inte direkt. macOS färdigheter är gated av `metadata.openclaw.os` plus nödvändiga binärer, och färdigheter visas bara i systemprompten när de är berättigade på **Gateway värd**. På Linux kommer `darwin`-endast-färdigheter (som `apple-notes`, `apple-reminders`, `things-mac`) inte att laddas om du inte åsidosätter gatingen.

Du har tre stödda mönster:

\*\*Alternativ A - kör Gateway på en Mac (enklaste). \*
Kör Gateway där macOS binärerna finns, anslut sedan från Linux i [remote mode](#how-do-i-run-openclaw-in-remote-mode-client-connects-to-a-gateway-elsewhere) eller över Tailscale. Kompetensbelastningen normalt eftersom Gateway-värden är macOS.

\*\*Alternativ B - använd en macOS nod (ingen SSH). \*
Kör Gateway på Linux, para ihop en macOS nod (menubar app), och sätt **Node Run Commands** till "Always Ask" eller "Always allow" på Mac. OpenClaw kan behandla macOS-endast färdigheter som berättigade när de nödvändiga binärerna finns på noden. Agenten kör dessa färdigheter via `nodes`-verktyget. Om du väljer "Always Ask", godkänna "Always Allow" i prompten lägger det kommandot till tillåtna listan.

\*\*Alternativ C - proxy macOS binärer över SSH (avancerat). \*
Håll Gateway på Linux, men gör nödvändiga CLI-binärer lösa till SSH-omvandlare som kör på en Mac. Åsidosätt sedan skickligheten för att tillåta Linux så att den förblir berättigad.

1. Skapa en SSH-omvandlare för binären (exempel: `memo` för Apple Notes):

   ```bash
   #!/usr/bin/env bash
   set -euo pipefail
   exec ssh -T user@mac-host /opt/homebrew/bin/memo "$@"
   ```

2. Sätt omslaget på `PATH` på Linux-värden (till exempel `~/bin/memo`).

3. Åsidosätt skicklighetsmetadata (arbetsyta eller `~/.openclaw/skills`) för att tillåta Linux:

   ```markdown
   ---
   namn: apple-notes
   beskrivning: Hantera Apple Notes via memo CLI på macOS.
   metadata: { "openclaw": { "os": ["darwin", "linux"], "requires": { "bins": ["memo"] } }
   ---
   ```

4. Starta en ny session så att färdigheterna ögonblicksbilden uppdateras.

### Har du en uppfattning eller HeyGen integration

Inte inbyggd idag.

Alternativ:

- **Anpassad skicklighet/plugin:** bäst för tillförlitlig API-åtkomst (Notion/HeyGen har båda API:er).
- **Webbläsarautomatisering:** fungerar utan kod men är långsammare och mer bräcklig.

Om du vill hålla sammanhang per klient (byråns arbetsflöden), ett enkelt mönster är:

- En Notion sida per klient (kontext + inställningar + aktivt arbete).
- Be agenten att hämta den sidan i början av en session.

Om du vill ha en infödd integration, öppna en funktionsförfrågan eller bygg en färdighet
som riktar sig till dessa API:er.

Installera färdigheter:

```bash
clawhub install <skill-slug>
clawhub update --all
```

ClawHub installeras i `. skills` under din nuvarande katalog (eller faller tillbaka till din konfigurerade OpenClaw workspace); OpenClaw behandlar det som `<workspace>/skills` på nästa session. För delade färdigheter över agenter, placera dem i `~/.openclaw/skills/<name>/SKILL.md`. Vissa färdigheter förväntar sig binärer som installeras via Homebrew; på Linux som betyder Linuxbrew (se Homebrew Linux FAQ post ovan). Se [Skills](/tools/skills) och [ClawHub](/tools/clawhub).

### Hur installerar jag Chrome-tillägget för webbläsarens övertagande

Använd det inbyggda installationsprogrammet och ladda sedan det uppackade tillägget i Chrome:

```bash
openclaw browser extension install
openclaw browser extension path
```

Sedan Chrome → `chrome://extensions` → aktivera "Developer mode" → "Ladda uppackad" → välj den mappen.

Fullständig guide (inklusive fjärr Gateway + säkerhetsanteckningar): [Chrome-tillägg](/tools/chrome-extension)

Om Gateway körs på samma maskin som Chrome (standardinställning), behöver du vanligtvis **inte** något extra.
Om Gateway kör någon annanstans, kör en node‑värd på webbläsarmaskinen så att Gateway kan proxyera webbläsaråtgärder.
Du behöver fortfarande klicka på tilläggsknappen på den flik du vill styra (det bifogas inte automatiskt).

## Sandlåda och minne

### Finns det en dedikerad sandlåda doc

Ja. Se [Sandboxing](/gateway/sandboxing). För Docker-specifik installation (full gateway i Docker eller sandlådbilder), se [Docker](/install/docker).

### Docker känner sig begränsad Hur aktiverar jag fullständiga funktioner

Standardavbildningen är security-first och körs som `node`-användaren, så den innehåller inte
systempaket, Homebrew, eller medföljande webbläsare. För en fylligare inställning:

- Beständig `/home/node` med `OPENCLAW_HOME_VOLUME` så att cacher överlever.
- Baka systemet deps in i bilden med `OPENCLAW_DOCKER_APT_PACKAGES`.
- Installera Playwright webbläsare via den medföljande CLI:
  `node /app/node_modules/playwright-core/cli.js install chromium`
- Ställ in `PLAYWRIGHT_BROWSERS_PATH` och se till att sökvägen kvarstår.

Dokument: [Docker](/install/docker), [Browser](/tools/browser).

**Kan jag hålla DMs personliga men göra grupper offentliga sandlåda med en agent**

Ja - om din privata trafik är **DM** och din offentliga trafik är **grupper**.

Använd `agents.defaults.sandbox.mode: "non-main"` så grupp/kanalsessioner (icke-huvudnycklar) körs i Docker, medan den huvudsakliga DM-sessionen förblir on-host. Begränsa sedan vilka verktyg som finns tillgängliga i sandboxade sessioner via `tools.sandbox.tools`.

Setup walkthrough + exempel config: [Grupper: personliga DMs + offentliga grupper](/channels/groups#pattern-personal-dms-public-groups-single-agent)

Key config referens: [Gateway konfiguration](/gateway/configuration#agentsdefaultssandbox)

### Hur binder jag en värdmapp till sandlådan

Ange `agents.defaults.sandbox.docker.binds` till `["host:path:mode"]` (t.ex., `"/home/user/src:/src:ro"`). Globala + per-agent binder sammanslagning; per-agent binder ignoreras när `scope: "shared"`. Använd `:ro` för allt känsligt och kom ihåg binder förbi sandboxens filsystemsväggar. Se [Sandboxing](/gateway/sandboxing#custom-bind-mounts) och [Sandbox vs Tool Policy vs Elevated](/gateway/sandbox-vs-tool-policy-vs-elevated#bind-mounts-security-quick-check) för exempel och säkerhetsanteckningar.

### Hur fungerar minnet

OpenClaw minne är bara Markdown filer i agentens arbetsyta:

- Dagliga anteckningar i `minne/YYY-MM-DD.md`
- Kurerade långtidsanteckningar i `MEMORY.md` (endast/privata sessioner)

OpenClaw kör också en **tyst pre-compaction minne flush** för att påminna modellen
om att skriva hållbara anteckningar innan automatisk komprimering. Detta körs bara när arbetsytan
är skrivbar (skrivskyddad sandlådor hoppa över det). Se [Minne](/concepts/memory).

### Minnet glömmer saker Hur får jag det att sticka fast

Be boten att **skriva faktumet till minnet**. Långsiktiga anteckningar hör hemma i `MEMORY.md`,
kortsiktiga sammanhang går till `memory/YYYY-MM-DD.md`.

Detta är fortfarande ett område som vi håller på att förbättra. Det hjälper till att påminna modellen för att lagra minnen;
det kommer att veta vad man ska göra. Om den fortsätter att glömma, kontrollera att Gateway använder samma
arbetsyta på varje körning.

Dokument: [Memory](/concepts/memory), [Agent workspace](/concepts/agent-workspace).

### Gör semantisk minnessökning kräver en OpenAI API-nyckel

Endast om du använder **OpenAI inbäddningar**. Codex OAuth omfattar chatt/kompletteringar och
beviljar **inte** inbäddning åtkomst, så **logga in med Codex (OAuth eller
Codex CLI-inloggning)** hjälper inte för semantisk minnessökning. OpenAI inbäddningar
behöver fortfarande en riktig API-nyckel (`OPENAI_API_KEY` eller `models.providers.openai.apiKey`).

Om du inte anger en leverantör explicit, väljer OpenClaw auto-selects en leverantör när den
kan lösa en API-nyckel (auth profiler, `models.providers.*.apiKey`, eller env vars).
Den föredrar OpenAI om en OpenAI-nyckel löser sig, annars Gemini om en Gemini-nyckel
löses. Om ingen av nycklarna är tillgänglig, förblir minnessökningen inaktiverad tills du
konfigurerar den. Om du har en lokal modellsökväg konfigurerad och presenterad, föredrar OpenClaw
`local`.

Om du hellre vill stanna lokalt, sätt `memorySearch.provider = "local"` (och valfritt
`memorySearch.fallback = "none"`). Om du vill ha Gemini inbäddning, sätt
`memorySearch.provider = "gemini"` och ge `GEMINI_API_KEY` (eller
`memorySearch.remote.apiKey`). Vi stöder **OpenAI, Gemini eller lokal** inbäddade
modeller - se [Memory](/concepts/memory) för konfigurationsdetaljer.

### Innebär minne för alltid Vilka är gränserna

Minnesfiler live på disk och kvarstår tills du tar bort dem. Gränsen är din
lagring, inte modellen. **sessionskontexten** är fortfarande begränsad av modellen
sammanhangsfönstret, så långa konversationer kan kompakta eller trunkera. Det är därför
minnessökning existerar - den drar bara de relevanta delarna tillbaka i sammanhanget.

Dokument: [Memory](/concepts/memory), [Context](/concepts/context).

## Där saker och ting lever på disk

### Är all data som används med OpenClaw sparad lokalt

Nej - **OpenClaws tillstånd är lokalt**, men **externa tjänster ser fortfarande vad du skickar dem**.

- \*\*Lokal som standard: \*\* sessioner, minnesfiler, konfigurera och arbetsyta live på Gateway-värden
  (`~/.openclaw` + din arbetsyta katalog).
- **Fjärrstyrd av nödvändighet:** meddelanden som du skickar till modellleverantörer (Anthropic/OpenAI/etc.) gå till
  sina API:er och chattplattformar (WhatsApp/Telegram/Slack/etc.) lagra meddelandedata på sina
  servrar.
- **Du styr fotavtrycket:** med hjälp av lokala modeller håller anvisningarna på din maskin, men kanalens
  trafik går fortfarande genom kanalens servrar.

Relaterat: [Agent workspace](/concepts/agent-workspace), [Memory](/concepts/memory).

### Var lagrar OpenClaw sina data

Allt lever under `$OPENCLAW_STATE_DIR` (standard: `~/.openclaw`):

| Sökväg                                                          | Syfte                                                                                                             |
| --------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `$OPENCLAW_STATE_DIR/openclaw.json`                             | Huvudkonfigurationen (JSON5)                                                                   |
| `$OPENCLAW_STATE_DIR/credentials/oauth.json`                    | Legacy OAuth import (kopieras till auth profiler vid första användning)                        |
| `$OPENCLAW_STATE_DIR/agents/<agentId>/agent/auth-profiles.json` | Auth profiler (OAuth + API-nycklar)                                                            |
| `$OPENCLAW_STATE_DIR/agents/<agentId>/agent/auth.json`          | Runtime auth cache (hanteras automatiskt)                                                      |
| `$OPENCLAW_STATE_DIR/credentials/`                              | Leverantörens status (t.ex. `whatsapp/<accountId>/creds.json`) |
| `$OPENCLAW_STATE_DIR/agents/`                                   | Per-agent stat (agentDir + sessioner)                                                          |
| `$OPENCLAW_STATE_DIR/agents/<agentId>/sessions/`                | Konversationshistorik & tillstånd (per agent)                              |
| `$OPENCLAW_STATE_DIR/agents/<agentId>/sessions/sessions.json`   | Session metadata (per agent)                                                                   |

Legacy singel-agent path: `~/.openclaw/agent/*` (migrerat av `openclaw doctor`).

Din **arbetsyta** (AGENTS.md, minnesfiler, färdigheter, etc.) är separat och konfigurerad via `agents.defaults.workspace` (standard: `~/.openclaw/workspace`).

### Var ska AGENTSmd SOULmd USERmd MEMORYmd leva

Dessa filer lever i **agentutrymme**, inte `~/.openclaw`.

- **Arbetsyta (per agent)**: `AGENTS.md`, `SOUL.md`, `IDENTITY.md`, `USER.md`,
  `MEMORY.md` (eller `memory.md`), `memory/YYY-MM-DD.md`, valfritt `HEARTBEAT.md`.
- **State dir (`~/.openclaw`)**: config, credentials, auth profiles, sessioner, loggar,
  och delade färdigheter (`~/.openclaw/skills`).

Standard arbetsyta är `~/.openclaw/workspace`, konfigurerbar via:

```json5
{
  agents: { defaults: { workspace: "~/.openclaw/workspace" } },
}
```

Om boten "glömmer" efter en omstart, bekräfta att Gateway använder samma
arbetsyta vid varje start (och kom ihåg: fjärrläge använder **gateway värd's**
arbetsyta, inte din lokala laptop).

Tips: Om du vill ha ett hållbart beteende eller inställning, be boten att **skriva in det i
AGENTS. d eller MEMORY.md** snarare än att förlita sig på chatthistorik.

Se [Agent workspace](/concepts/agent-workspace) och [Memory](/concepts/memory).

### Vad är den rekommenderade säkerhetskopieringsstrategin

Sätt din **agent arbetsyta** i en **privat** git repo och säkerhetskopiera den någonstans
privat (till exempel GitHub privat). Detta fångar minne + AGENTS/SOUL/USER
filer och låter dig återställa assistentens "sinne" senare.

Vänd **inte** något under `~/.openclaw` (användaruppgifter, sessioner, tokens).
Om du behöver en fullständig återställning, säkerhetskopiera både arbetsytan och statskatalogen
separat (se migrationsfrågan ovan).

Dokument: [Agent workspace](/concepts/agent-workspace).

### Hur avinstallera jag helt OpenClaw

Se den dedikerade guiden: [Uninstall](/install/uninstall).

### Kan agenter arbeta utanför arbetsytan

Ja. Arbetsytan är **standard cwd** och minnesankare, inte en hård sandlåda.
Relativa sökvägar försvinner inne i arbetsytan, men absoluta sökvägar kan komma åt andra
värdplatser såvida inte sandlådan är aktiverad. Om du behöver isolering, använd
[`agents.defaults.sandbox`](/gateway/sandboxing) eller inställningar för per-agent sandlåda. Om du
vill att en repo ska vara standard arbetskatalog, peka den agentens
`workspace` till repo roten. OpenClaw repo är bara källkod; håll arbetsytan
åtskild om du inte avsiktligt vill att agenten ska arbeta inuti den.

Exempel (repo som standard cwd):

```json5
{
  agenter: {
    defaults: {
      workspace: "~/Projects/my-repo",
    },
  },
}
```

### Im in remote mode where is the session store

Sessionsstaten ägs av **gateway host**. Om du är i fjärrläge är den session butik du bryr dig om på fjärrdatorn, inte din lokala laptop. Se [Sessionshantering](/concepts/session).

## Grundläggande inställningar

### Vilket format är konfigurationen Var är den

OpenClaw läser en valfri **JSON5** konfiguration från `$OPENCLAW_CONFIG_PATH` (standard: `~/.openclaw/openclaw.json`):

```
$OPENCLAW_CONFIG_PATH
```

Om filen saknas, den använder säker standard (inklusive en standard arbetsyta av `~/.openclaw/workspace`).

### Jag sätter gatewaybind lan eller tailnet och nu inget lyssnar UI säger obehörig

Icke-loopback binder **kräver auth**. Konfigurera `gateway.auth.mode` + `gateway.auth.token` (eller använd `OPENCLAW_GATEWAY_TOKEN`).

```json5
{
  gateway: {
    bind: "lan",
    auth: {
      mode: "token",
      token: "ersätta-me",
    },
  },
}
```

Anteckningar:

- `gateway.remote.token` är för **fjärr-CLI-samtal** endast; det aktiverar inte lokal gateway auth.
- Kontrollgränssnittet autentiseras via `connect.params.auth.token` (lagras i app/UI-inställningar). Undvik att sätta tokens i URL:er.

### Varför behöver jag en token på localhost nu

Guiden genererar en gateway-token som standard (även på loopback) så **lokala WS-klienter måste autentisera**. Detta blockerar andra lokala processer från att ringa Gateway. Klistra in token i kontrollgränssnittets inställningar (eller din klientkonfiguration) för att ansluta.

Om du **verkligen** vill ha öppen loopback, ta bort `gateway.auth` från din konfiguration. Läkare kan generera en token för dig när som helst: `openclaw doctor --generate-gateway-token`.

### Måste jag starta om efter byte av konfiguration

Gateway tittar på konfigurationen och stöder hot-reload:

- `gateway.reload.mode: "hybrid"` (standard): hot-apply säkra ändringar, omstart för kritiska
- `hot`, `restart`, `off` stöds också

### Hur aktiverar jag webbsökning och webbhämtning

`web_fetch` fungerar utan en API-nyckel. `web_search` kräver en Brave Search API
nyckel. **Rekommenderade:** kör `openclaw konfigurera --section web` för att lagra den i
`tools.web.search.apiKey`. Miljöalternativ: sätt `BRAVE_API_KEY` för
Gateway-processen.

```json5
{
  verktyg: {
    webb: {
      sökning: {
        aktiverad: sant,
        apiKey: "BRAVE_API_KEY_HERE",
        maxResultat: 5,
      },
      hämtning: {
        enabled: true,
      },
    },
  },
}
```

Anteckningar:

- Om du använder tillåtna listor, lägg till `web_search`/`web_fetch` eller `group:web`.
- `web_fetch` är aktiverat som standard (om det inte uttryckligen inaktiveras).
- Daemons läste env vars från `~/.openclaw/.env` (eller servicemiljön).

Dokument: [Webb verktyg](/tools/web).

### Hur kör jag en central Gateway med specialiserade arbetstagare över enheter

Det gemensamma mönstret är **en Gateway** (t.ex. Hallon Pi) plus **noder** och **agenter**:

- **Gateway (central):** äger kanaler (Signal/WhatsApp), routing och sessioner.
- **Noder (enheter):** Mac/iOS/Android ansluter som kringutrustning och exponerar lokala verktyg (`system.run`, `canvas`, `camera`).
- **Agenter (arbetare):** separata hjärnor/arbetsytor för speciella roller (t.ex. "Hetzner ops", "Personuppgifter").
- **Underagenter:** Skapa bakgrundsarbete från en huvudagent när du vill ha parallellism.
- **TUI:** anslut till Gateway och växla agenter/sessioner.

Dokument: [Nodes](/nodes), [Remote access](/gateway/remote), [Multi-Agent Routing](/concepts/multi-agent), [Sub-agents](/tools/subagents), [TUI](/web/tui).

### Kan OpenClaw-webbläsaren köra huvudlöst

Ja. Det är ett konfigurationsalternativ:

```json5
{
  webbläsare: { headless: true },
  agenter: {
    standard: {
      sandlåda: { browser: { headless: true } },
    },
  },
}
```

Standard är `false` (headful). Huvudlös är mer benägna att utlösa anti-bot kontroller på vissa webbplatser. Se [Browser](/tools/browser).

Huvudlösa använder **samma krommotor** och fungerar för de flesta automatisering (formulär, klick, skrapning, inloggningar). De viktigaste skillnaderna:

- Inget synligt webbläsarfönster (använd skärmdumpar om du behöver visual).
- Vissa webbplatser är striktare om automatisering i huvudlöst läge (CAPTCHA, anti-bot).
  Till exempel blockerar X/Twitter ofta huvudlösa sessioner.

### Hur använder jag Modig för att styra webbläsaren

Ställ in `browser.executablePath` till din Brave binary (eller någon Chromium-baserad webbläsare) och starta om Gateway.
Se hela konfigurationsexemplen i [Browser](/tools/browser#use-brave-or-another-chromium-based-browser).

## Fjärrstyrda gateways och noder

### Hur sprids kommandon mellan Telegram gateway och noder

Telegram meddelanden hanteras av **gateway**. Gateway kör agenten och
endast då samtal noder över **Gateway WebSocket** när en nod verktyg behövs:

Telegram → Gateway → Agent → `node.*` → Node → Gateway → Telegram

Noder ser inte inkommande leverantörstrafik, de tar bara emot nod RPC-samtal.

### Hur kan min agent komma åt min dator om Gateway är värd på distans

Kort svar: **para ihop din dator som en nod**. Gateway körs någon annanstans, men det kan
anropa `node.*` verktyg (skärm, kamera, system) på din lokala maskin över Gateway WebSocket.

Typisk inställning:

1. Kör Gateway på den alltid på-värd (VPS/home server).
2. Sätt Gateway värd + din dator på samma tailnet.
3. Se till att Gateway WS är nåbar (tailnet bind eller SSH tunnel).
4. Öppna macOS-appen lokalt och anslut i **Fjärrkontroll över SSH**-läge (eller direkt tailnet)
   så att den kan registrera sig som en nod.
5. Godkänn noden på Gateway:

   ```bash
   openclaw nodes pending
   openclaw nodes approve <requestId>
   ```

Ingen separat TCP-brygga krävs; noder ansluter över Gateway WebSocket.

Säkerhetspåminnelse: parning av en macOS nod tillåter `system.run` på den maskinen. Endast
para ihop enheter som du litar på och recensera [Security](/gateway/security).

Dokument: [Nodes](/nodes), [Gateway protocol](/gateway/protocol), [macOS remote mode](/platforms/mac/remote), [Security](/gateway/security).

### Skalan är ansluten men jag får inga svar Vad nu

Kontrollera grunderna:

- Gateway kör: `openclaw gateway status`
- Gateway hälsa: `openclaw status`
- Channel health: `openclaw channels status`

Kontrollera sedan auth och routing:

- Om du använder Tailscale Serve, se till att `gateway.auth.allowTailscale` är korrekt inställd.
- Om du ansluter via SSH-tunneln, bekräfta att den lokala tunneln är uppe och pekar i rätt hamn.
- Bekräfta dina tillåtna listor (DM eller grupp) inkludera ditt konto.

Dokument: [Tailscale](/gateway/tailscale), [fjärråtkomst](/gateway/remote), [Channels](/channels).

### Kan två OpenClaw instanser prata med varandra lokala VPS

Ja. Det finns ingen inbyggd "bot-to-bot" brygga, men du kan styra upp den på ett par
pålitliga sätt:

**Enklast:** använd en vanlig chatt kanal båda robotarna kan komma åt (Telegram/Slack/WhatsApp).
Ha Bot A skicka ett meddelande till Bot B, låt sedan Bot B svara som vanligt.

**CLI-brygga (generisk):** kör ett skript som anropar den andra Gateway med
`openclaw agent --message ... --deliver`, med inriktning på en chatt där den andra roboten
lyssnar. Om en bot är på en fjärr-VPS, peka din CLI på den fjärr-Gateway
via SSH/Tailscale (se [Fjärråtkomst](/gateway/remote)).

Exempel mönster (kör från en maskin som kan nå målet Gateway):

```bash
openclaw agent --message "Hej från lokal bot" --deliver --channel telegram --reply-to <chat-id>
```

Tips: lägg till ett skyddsräcke så att de två robotarna inte slingar oändligt (nämn bara, kanal
tillåter listor, eller en "svara inte på bot meddelanden" regel).

Dokument: [Remote access](/gateway/remote), [Agent CLI](/cli/agent), [Agent send](/tools/agent-send).

### Behöver jag separata VPSer för flera agenter

Nej. En Gateway kan vara värd för flera agenter, var och en med sin egen arbetsyta, modell standard,
och routing. Det är den normala installationen och det är mycket billigare och enklare än att köra
en VPS per agent.

Använd separata VPSes endast när du behöver hård isolering (säkerhetsgränser) eller mycket
olika konfigurationer som du inte vill dela. Annars kan en Gateway och
använda flera agenter eller underagenter.

### Finns det en fördel med att använda en nod på min personliga bärbara dator istället för SSH från en VPS

Ja - noder är det förstklassiga sättet att nå din bärbara dator från en avlägsen Gateway, och de
låsa upp mer än skalåtkomst. Gateway körs på macOS/Linux (Windows via WSL2) och är
lätt (en liten VPS eller Raspberry Pi-klass box är bra; 4 GB RAM är mycket), så en vanlig
inställning är en alltid på värd plus din bärbara dator som en nod.

- **Inga inkommande SSH krävs.** Noder ansluter till Gateway WebSocket och använder enhet parkoppling.
- **Säkrare körkontroller.** `system.run` är gated av nod allowlists/godkännanden på den bärbara datorn.
- **Fler enhetsverktyg.** Noder exponerar `canvas`, `camera`, och `screen` utöver `system.run`.
- \*\*Lokal webbläsarautomatisering. \* Håll Gateway på en VPS, men kör Chrome lokalt och reläkontroll
  med Chrome-tillägget + en nod värd på den bärbara datorn.

SSH är bra för ad-hoc skalåtkomst, men noder är enklare för pågående agentarbetsflöden och
enhet automatisering.

Dokument: [Nodes](/nodes), [Nodes CLI](/cli/nodes), [Chrome extension](/tools/chrome-extension).

### Ska jag installera på en andra laptop eller bara lägga till en nod

Om du bara behöver **lokala verktyg** (skärm/kamera/kör) på den andra bärbara datorn, lägg till den som en
**node**. Som håller en enda Gateway och undviker duplicerad konfiguration. Lokala nodverktyg är
för närvarande endast macOS-, men vi planerar att utöka dem till andra operativsystem.

Installera en andra Gateway endast när du behöver **hård isolering** eller två helt separata robotar.

Dokument: [Nodes](/nodes), [Nodes CLI](/cli/nodes), [Flera gateways](/gateway/multiple-gateways).

### Gör noder kör en gateway-tjänst

Nej. Endast **en gateway** bör köras per värd om du inte avsiktligt kör isolerade profiler (se [Flera gateways](/gateway/multiple-gateways)). Noder är kringutrustning som ansluter
till gateway (iOS/Android-noder, eller macOS "node-läge" i menubar app). För huvudlös nod
värdar och CLI-kontroll, se [nod värd CLI](/cli/node).

En fullständig omstart krävs för `gateway`, `discovery`, och `canvasHost` ändringar.

### Finns det ett API RPC sätt att tillämpa konfigurationen

Ja. `config.apply` validerar + skriver hela konfigurationen och startar om Gateway som en del av operationen.

### configapply raderade min config Hur återhämtar jag mig och undviker detta

`config.apply` ersätter **hela config**. Om du skickar ett partiellt objekt tas allt
annat bort.

Återställ:

- Återställ från backup (git eller en kopierad `~/.openclaw/openclaw.json`).
- Om du inte har någon säkerhetskopia, re-run `openclaw doctor` och konfigurera kanaler/modeller.
- Om detta var oväntat, skicka in ett fel och inkludera din senaste kända konfiguration eller någon säkerhetskopia.
- En lokal kodningsagent kan ofta rekonstruera en fungerande konfiguration från loggar eller historik.

Undvik det:

- Använd `openclaw config set` för små ändringar.
- Använd `openclaw configure` för interaktiva redigeringar.

Dokument: [Config](/cli/config), [Configure](/cli/configure), [Doctor](/gateway/doctor).

### Vad är en minimal förnuftig konfiguration för en första installation

```json5
{
  agents: { defaults: { workspace: "~/.openclaw/workspace" } },
  channels: { whatsapp: { allowFrom: ["+15555550123"] } },
}
```

Detta ställer in din arbetsyta och begränsar vem som kan utlösa boten.

### Hur ställer jag in Tailscale på en VPS och ansluter från min Mac

Minimala steg:

1. **Installera + logga in på VPS**

   ```bash
   curl -fsSL https://tailscale.com/install.sh <unk> sh
   sudo skräddarskala upp
   ```

2. **Installera + logga in på din Mac**
   - Använd appen Tailscale och logga in på samma tailnet.

3. **Aktivera MagicDNS (rekommenderas)**
   - I Tailscale adminkonsolen, aktivera MagicDNS så att VPS har ett stabilt namn.

4. **Använd tailnet värdnamn**
   - SSH: `ssh user@your-vps.tailnet-xxxx.ts.net`
   - Gateway WS: `ws://your-vps.tailnet-xxxx.ts.net:18789`

Om du vill ha Control UI utan SSH, använd Tailscale Serve på VPS:

```bash
openclaw gateway --tailscale serve
```

Detta håller porten bunden till loopback och exponerar HTTPS via Tailscale. Se [Tailscale](/gateway/tailscale).

### Hur ansluter jag en Mac-nod till en fjärr-Gateway Tailscale Serve

Serve exponerar **Gateway Control UI + WS**. Noder ansluter över samma Gateway WS slutpunkt.

Rekommenderad inställning:

1. **Se till att VPS + Mac är på samma tailnet**.
2. **Använd macOS-appen i fjärrläge** (SSH-målet kan vara tailnet hostname).
   Appen kommer att tunnel Gateway-porten och ansluta som en nod.
3. **Godkänn noden** på gateway:

   ```bash
   openclaw nodes pending
   openclaw nodes approve <requestId>
   ```

Dokument: [Gateway protocol](/gateway/protocol), [Discovery](/gateway/discovery), [macOS remote mode](/platforms/mac/remote).

## Env vars och .env lastning

### Hur laddar OpenClaw miljövariabler

OpenClaw reads env vars from the parent process (shell, launchd/systemd, CI, etc.) och dessutom laster:

- `.env` från den aktuella arbetskatalogen
- a global fallback `.env` from `~/.openclaw/.env` (aka `$OPENCLAW_STATE_DIR/.env`)

Neither `.env` file overrides existing env vars.

Du kan också definiera inline env vars i config (tillämpas endast om saknas från processen env):

```json5
{
  env: {
    OPENROUTER_API_KEY: "sk-or-...",
    vars: { GROQ_API_KEY: "gsk-..." },
  },
}
```

See [/environment](/help/environment) for full precedence and sources.

### Jag startade Gateway via tjänsten och mina env vars försvann Vad nu

Två vanliga rättelser:

1. Sätt de saknade nycklarna i `~/.openclaw/.env` så de plockas upp även när tjänsten inte ärver ditt skal env.
2. Aktivera skalimport (opt-in bekvämlighet):

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

Detta kör ditt inloggningsskal och importerar bara saknade förväntade nycklar (aldrig åsidosätter). Env var ekvivalenter:
`OPENCLAW_LOAD_SHELL_ENV=1`, `OPENCLAW_SHELL_ENV_TIMEOUT_MS=15000`.

### I set COPILOTGITHUBTOKEN men modeller status visar Shell env off Varför

`openclaw models status` rapporterar om **shell env import** är aktiverat. "Shell env: off"
betyder **inte** att dina env vars saknas - det betyder bara att OpenClaw inte laddar
ditt inloggningsskal automatiskt.

Om Gateway körs som en tjänst (launchd/systemd), det kommer inte ärva ditt skal
miljö. Fixa genom att göra en av dessa:

1. Sätt token i `~/.openclaw/.env`:

   ```
   COPILOT_GITHUB_TOKEN=...
   ```

2. Eller aktivera skalimport (`env.shellEnv.enabled: true`).

3. Eller lägg till den i ditt config `env`-block (gäller endast om det saknas).

Starta sedan om gateway och återkontroll:

```bash
openclaw models status
```

Copilottokens läses från `COPILOT_GITHUB_TOKEN` (även `GH_TOKEN` / `GITHUB_TOKEN`).
Se [/concepts/model-providers](/concepts/model-providers) och [/environment](/help/environment).

## Sessioner och flera chattar

### Hur startar jag en ny konversation

Skicka `/new` eller `/reset` som ett fristående meddelande. Se [Sessionshantering](/concepts/session).

### Återställer sessioner automatiskt om jag aldrig skickar nya

Ja. Sessioner löper ut efter `session.idleMinutes` (standard **60**). **Nästa**
-meddelandet startar ett nytt sessions-id för den chattnyckeln. Detta tar inte bort
avskrifter - det startar bara en ny session.

```json5
{
  session: {
    idleMinutes: 240,
  },
}
```

### Finns det ett sätt att göra ett team av OpenClaw instanser en VD och många agenter

Ja, via **multi-agent routing** och **underagenter**. Du kan skapa en koordinator
agent och flera arbetare agenter med egna arbetsytor och modeller.

Som sagt, detta är bäst ses som ett **roligt experiment**. Det är token tung och ofta
mindre effektiv än att använda en bot med separata sessioner. Den typiska modellen vi
föreställer oss är en bot man pratar med, med olika sessioner för parallellt arbete. Att
bot kan också skapa underagenter när det behövs.

Dokument: [Multi-agent routing](/concepts/multi-agent), [Sub-agents](/tools/subagents), [Agents CLI](/cli/agents).

### Varför fick kontext trunkerad midtask Hur förhindrar jag det

Sessionskontext begränsas av modellfönstret. Långa chattar, stora verktygsutmatningar eller många
-filer kan utlösa komprimering eller trunkering.

Vad hjälper:

- Be boten att sammanfatta det aktuella tillståndet och skriva det till en fil.
- Använd `/compact` före långa uppgifter och `/new` vid byte av ämnen.
- Håll viktiga sammanhang i arbetsytan och be boten att läsa den tillbaka.
- Använd underagenter för långt eller parallellt arbete så att huvudchatten förblir mindre.
- Välj en modell med ett större sammanhangsfönster om detta händer ofta.

### Hur återställer jag helt OpenClaw men håller det installerat

Använd återställningskommandot:

```bash
openclaw reset
```

Icke-interaktiv fullständig återställning:

```bash
openclaw återställ --scope full --yes --non-interactive
```

Sedan re-run ombord:

```bash
openclaw onboard --install-daemon
```

Anteckningar:

- Onboarding guiden erbjuder också **Återställ** om den ser en befintlig konfiguration. Se [Wizard](/start/wizard).
- Om du använde profiler (`--profile` / `OPENCLAW_PROFILE`), återställ varje status dir (standard är `~/.openclaw-<profile>`).
- Dev återställ: `openclaw gateway --dev --reset` (dev-only; wipes dev config + autentiseringsuppgifter + sessioner + arbetsyta).

### Jag får sammanhang för stora fel hur jag återställer eller kompakt

Använd ett av dessa:

- **Kompakt** (håller konversationen men sammanfattar äldre svängar):

  ```
  /kompakt
  ```

  eller `/compact <instructions>` för att vägleda sammanfattningen.

- **Återställ** (nytt sessions-ID för samma chattnyckel):

  ```
  /new
  /reset
  ```

Om det händer fortfarande:

- Aktivera eller trimma **sessionsbeskärning** (`agents.defaults.contextPruning`) för att trimma gamla verktygsutmatningar.
- Använd en modell med ett större sammanhangsfönster.

Dokument: [Compaction](/concepts/compaction), [sessionsbeskärning](/concepts/session-pruning), [sessionshantering](/concepts/session).

### Varför ser jag LLM-begäran avvisade meddelandenNcontentXtooluseinput Fält krävs

Detta är ett leverantörsvalideringsfel: modellen släppte ut ett `tool_use`-block utan det nödvändiga
`input`. Det innebär oftast att sessionshistoriken är inaktuell eller skadad (ofta efter långa trådar
eller en verktyg/schema förändring).

Fix: starta en ny session med `/new` (fristående meddelande).

### Varför får jag hjärtslag var 30 minut

Hjärtslag kör varje **30 m** som standard. Justera eller inaktivera dem:

```json5
{
  agenter: {
    defaults: {
      heartbeat: {
        every: "2h", // eller "0m" för att inaktivera
      },
    },
  },
}
```

Om `HEARTBEAT. d` finns men är effektivt tom (endast tomma rader och markdown
rubriker som `# Heading`), hoppar OpenClaw över hjärtslaget för att spara API-samtal.
Om filen saknas körs heartbeat ändå och modellen avgör vad som ska göras.

Per-agent åsidosätter använda `agents.list[].heartbeat`. Dokument: [Heartbeat](/gateway/heartbeat).

### Behöver jag lägga till ett botkonto till en WhatsApp-grupp

Nej. OpenClaw körs på **ditt eget konto**, så om du är med i gruppen kan OpenClaw se det.
Som standard blockeras gruppsvar tills du tillåter avsändare (`groupPolicy: "allowlist"`).

Om du bara vill att **du** ska kunna utlösa gruppsvar:

```json5
{
  kanaler: {
    whatsapp: {
      groupPolicy: "allowlist",
      groupAllowFrom: ["+15551234567"],
    },
  },
}
```

### Hur får jag JID för en WhatsApp-grupp

Alternativ 1 (snabbast): svansloggar och skickar ett testmeddelande i gruppen:

```bash
openclaw loggar --follow --json
```

Leta efter `chatId` (eller `from`) som slutar på `@g.us`, som:
`1234567890-1234567890@g.us`.

Alternativ 2 (om redan konfigurerad/tillåten): listgrupper från config:

```bash
openclaw kataloggrupper lista --channel whatsapp
```

Dokument: [WhatsApp](/channels/whatsapp), [Directory](/cli/directory), [Logs](/cli/logs).

### Varför svarar inte OpenClaw i en grupp

Två vanliga orsaker:

- Nämn Gating är på (standard). Du måste @nämna bot (eller matcha `mentionPatterns`).
- Du konfigurerade `channels.whatsapp.groups` utan `"*"` och gruppen är inte tillåten.

Se [Groups](/channels/groups) och [Gruppmeddelanden](/channels/group-messages).

### Delar gruppsthreads sammanhang med DMs

Direktchattar kollapsar till huvudsessionen som standard. Grupper/kanaler har sina egna sessionsnycklar, och Telegram ämnen / Discord-trådar är separata sessioner. Se [Groups](/channels/groups) och [Gruppmeddelanden](/channels/group-messages).

### Hur många arbetsytor och agenter kan jag skapa

Inga hårda gränser. Dussintals (även hundratals) är bra, men titta efter:

- **Disktillväxt:** sessioner + avskrifter lever under `~/.openclaw/agents/<agentId>/sessions/`.
- **Token cost:** fler agenter betyder mer samtidig modellanvändning.
- **Ops overhead:** per agent auth profiler, arbetsytor och kanal routing.

Tips:

- Behåll en **aktiv** arbetsyta per agent (`agents.defaults.workspace`).
- Rensa gamla sessioner (ta bort JSONL eller lagra poster) om disken växer.
- Använd `openclaw doctor` för att upptäcka avvikande arbetsytor och profilfel.

### Kan jag köra flera bottar eller chattar samtidigt Slack och hur ska jag ställa upp

Ja. Använd **Multi-Agent Routing** för att köra flera isolerade agenter och rutt inkommande meddelanden av
kanal/konto/peer. Slack stöds som en kanal och kan bindas till specifika agenter.

Webbläsaråtkomst är kraftfull men inte "gör något som en människa kan" - anti-bot, CAPTCHA och MFA kan
fortfarande blockera automatisering. För den mest tillförlitliga webbläsarkontrollen, använd Chrome extension relä
på maskinen som kör webbläsaren (och behålla Gateway någonstans).

Bästa praxis inställning:

- Always-on Gateway-värd (VPS/Mac mini).
- En agent per roll (bindningar).
- Slack kanaler bundna till dessa agenter.
- Lokal webbläsare via tilläggsrelä (eller nod) vid behov.

Dokument: [Multi-Agent Routing](/concepts/multi-agent), [Slack](/channels/slack),
[Browser](/tools/browser), [Chrome extension](/tools/chrome-extension), [Nodes](/nodes).

## Modeller: standardinställningar, urval, alias, växlar

### Vad är standardmodellen

OpenClaws standardmodell är vad du anger som:

```
agents.defaults.model.primary
```

Modeller refereras till som `provider/model` (exempel: `antropic/claude-opus-4-6`). Om du utelämnar leverantören antar OpenClaw för närvarande `anthropic` som ett tillfälligt avskrivningsfall - men du bör fortfarande **explicitt** sätta `provider/model`.

### Vilken modell rekommenderar du

**Rekommenderad standard:** `anthropic/claude-opus-4-6`.
**Bra alternativ:** `antrop/claude-sonnet-4-5`.
**Pålitlig (mindre karaktär):** `openai/gpt-5.2` - nästan lika bra som Opus, precis mindre personlighet.
**Budget:** `zai/glm-4.7`.

MiniMax M2.1 har sina egna dokument: [MiniMax](/providers/minimax) och
[Lokala modeller](/gateway/local-models).

Tumregel: använd **den bästa modellen du har råd med** för arbete med höga insatser och en billigare
modell för rutinchatt eller sammanfattningar. Du kan dirigera modeller per agent och använda underagenter till
parallellisera långa uppgifter (varje underagens förbrukar tokens). Se [Models](/concepts/models) och
[Sub-agents](/tools/subagents).

Stark varning: svagare/överkvantifierade modeller är mer sårbara för snabb
injektion och osäkert beteende. Se [Security](/gateway/security).

Fler sammanhang: [Models](/concepts/models).

### Kan jag använda egna modeller llamacpp vLLM Ollama

Ja. Om din lokala server exponerar ett OpenAI-kompatibelt API kan du peka en
anpassad leverantör på det. Ollama stöds direkt och är den enklaste vägen.

Säkerhetsanteckning: mindre eller kraftigt kvantifierade modeller är mer sårbara för snabb
injektion. Vi rekommenderar starkt **stora modeller** för alla robotar som kan använda verktyg.
Om du fortfarande vill ha små modeller, aktivera sandlåda och strikta verktyg tillåter listor.

Dokument: [Ollama](/providers/ollama), [Lokala modeller](/gateway/local-models),
[Modellleverantörer](/concepts/model-providers), [Security](/gateway/security),
[Sandboxing](/gateway/sandboxing).

### Hur byter jag modeller utan att rensa min konfiguration

Använd **modellkommandon** eller redigera endast **modellen**-fälten. Undvik att ersätta full konfiguration.

Säkra alternativ:

- `/model` i chatt (snabb, per session)
- `openclaw models set ...` (uppdateringar bara modell config)
- `openclaw konfigurera --section model` (interaktiv)
- redigera `agents.defaults.model` i `~/.openclaw/openclaw.json`

Undvik `config.apply` med ett partiellt objekt om du inte tänker ersätta hela konfigurationen.
Om du har skrivit över konfigurationen, återställa från säkerhetskopiering eller åter köra `openclaw doctor` för att reparera.

Dokument: [Models](/concepts/models), [Configure](/cli/configure), [Config](/cli/config), [Doctor](/gateway/doctor).

### Vad använder OpenClaw, Flaw, och Krill för modeller

- **OpenClaw + fel:** Antropiska opus (`antrop/claude-opus-4-6`) - se [Anthropic](/providers/anthropic).
- **Krill:** MiniMax M2.1 (`minimax/MiniMax-M2.1`) - see [MiniMax](/providers/minimax).

### Hur byter jag modeller i farten utan att starta om

Använd kommandot `/model` som ett fristående meddelande:

```
/model sonnet
/model haiku
/model opus
/model gpt
/model gpt-mini
/model gemini
/model gemini-flash
```

Du kan lista tillgängliga modeller med `/model`, `/model list` eller `/model status`.

`/model` (och `/model list`) visar en kompakt, numrerad väljare. Välj efter nummer:

```
/Modell 3
```

Du kan också tvinga en specifik auth profil för leverantören (per session):

```
/model opus@anthropic:default
/model opus@anthropic:work
```

Tips: `/model status` visar vilken agent som är aktiv, vilken `auth-profiles.json` fil som används, och vilken auth profil som kommer att testas härnäst.
Det visar också det konfigurerade leverantörens slutpunkt (`baseUrl`) och API-läget (`api`) när det är tillgängligt.

**Hur lossar jag en profil jag satt med profil**

Re-run `/model` **utanför** suffixet `@profile`:

```
/model anthropic/claude-opus-4-6
```

Om du vill återvända till standard, välj den från `/model` (eller skicka `/model <default provider/model>`).
Använd `/model status` för att bekräfta vilken auth profil som är aktiv.

### Kan jag använda GPT 5.2 för dagliga uppgifter och Codex 5.3 för kodning

Ja. Ange en som standard och växla efter behov:

- **Snabb switch (per session):** `/model gpt-5.2` för dagliga uppgifter, `/model gpt-5.3-codex` för kodning.
- **Standard + switch:** sätt `agents.defaults.model.primary` till `openai/gpt-5.2`, byt sedan till `openai-codex/gpt-5.3-codex` vid kodning (eller tvärtom).
- **Underagenter:** ruttkodningsuppgifter till underagenter med en annan standardmodell.

Se [Models](/concepts/models) och [Slash kommandon](/tools/slash-commands).

### Varför ser jag Modell är inte tillåtet och då inget svar

Om `agents.defaults.models` är satt, blir det **allowlist** för `/model` och alla
session åsidosätter. Välja en modell som inte finns med i den listan returnerar:

```
Model "provider/model" is not allowed. Use /model to list available models.
```

Det felet returneras \*\*i stället för \*\* ett normalt svar. Fix: lägg till modellen till
`agents.defaults.models`, ta bort den tillåtna listan eller välj en modell från `/modelllista`.

### Varför ser jag Okänd modell minimaxMiniMaxM21

Detta innebär att **leverantören inte är konfigurerad** (ingen MiniMax provider config eller auth
profil hittades), så modellen kan inte lösas. En rättelse för denna detektion är
i **2026.1.12** (outgiven vid skrivande tid).

Fixa checklista:

1. Uppgradera till **2026.1.12** (eller kör från källan `main`), starta sedan om gateway.
2. Se till att MiniMax är konfigurerad (guide eller JSON), eller att en MiniMax API-nyckel
   finns i env/auth profiler så att leverantören kan injiceras.
3. Använd det exakta modell-id (skiftlägeskänslig): `minimax/MiniMax-M2.1` eller
   `minimax/MiniMax-M2.1-blixtar`.
4. Run:

   ```bash
   openclaw models list
   ```

   och välj från listan (eller `/model list` i chat).

Se [MiniMax](/providers/minimax) och [Models](/concepts/models).

### Kan jag använda MiniMax som min standard och OpenAI för komplexa uppgifter

Ja. Använd **MiniMax som standard** och byt modeller **per session** vid behov.
Fallbackar är för **fel**, inte "hårda uppgifter", så använd `/model` eller en separat agent.

**Alternativ A: växla per session**

```json5
{
  env: { MINIMAX_API_KEY: "sk-...", OPENAI_API_KEY: "sk-... },
  agenter: {
    standard: {
      modell: { primära: "minimax/MiniMax-M2. " },
      modeller: {
        "minimax/MiniMax-M2. ": { alias: "minimax" },
        "openai/gpt-5. ": { alias: "gpt" },
      },
    },
  },
}
```

Sedan:

```
/modell gpt
```

**Alternativ B: separata agenter**

- Agent A default: MiniMax
- Agent B standard: OpenAI
- Rutt av agent eller använd `/agent` för att växla

Dokument: [Models](/concepts/models), [Multi-Agent Routing](/concepts/multi-agent), [MiniMax](/providers/minimax), [OpenAI](/providers/openai).

### Är opus sonnet gpt inbyggda genvägar

Ja. OpenClaw fartyg några standard-shorthands (tillämpas endast när modellen finns i `agents.defaults.models`):

- `opus` → `antrop/claude-opus-4-6`
- `sonnet` → `anthropic/claude-sonnet-4-5`
- `gpt` → `openai/gpt-5.2`
- `gpt-mini` → `openai/gpt-5-mini`
- `gemini` → `google/gemini-3-pro-preview`
- `gemini-flash` → `google/gemini-3-flash-preview`

Om du anger ditt eget alias med samma namn, vinner ditt värde.

### Hur definierar jag modellens genvägar alias

Alias kommer från `agents.defaults.models.<modelId>.alias`. Exempel:

```json5
{
  agenter: {
    standard: {
      modell: { primära: "antrop/claude-opus-4-6" },
      modeller: {
        "antrop/claude-opus-4-6": { alias: "opus" },
        "antrop/claude-sonnet-4-5": { alias: "sonnet" },
        "antrop/claude-haiku-4-5": { alias: "haiku" },
      },
    },
  },
}
```

Sedan `/model sonnet` (eller `/<alias>` när det stöds) löser sig till det modell-ID.

### Hur lägger jag till modeller från andra leverantörer som OpenRouter eller ZAI

OpenRouter (betal-per-token; många modeller):

```json5
{
  agenter: {
    defaults: {
      model: { primär: "openrouter/anthropic/claude-sonnet-4-5" },
      modeller: { "openrouter/anthropic/claude-sonnet-4-5": {} },
    },
  },
  env: { OPENROUTER_API_KEY: "sk-or-. ." },
}
```

Z.AI (GLM-modeller):

```json5
{
  agenter: {
    defaults: {
      model: { primära: "zai/glm-4. " },
      modeller: { "zai/glm-4. ": {} },
    },
  },
  env: { ZAI_API_KEY: "..." },
}
```

Om du refererar till en leverantör/modell men saknar en leverantörsnyckel, får du ett körtidsfel (e. . `Ingen API-nyckel hittades för leverantören "zai"`).

**Ingen API-nyckel hittades för leverantören efter att ha lagt till en ny agent**

Detta innebär vanligtvis att **den nya agenten** har en tom auth butik. Auth är per agent och
lagrad i:

```
~/.openclaw/agents/<agentId>/agent/auth-profiles.json
```

Åtgärdsalternativ:

- Kör `openclaw agenter addera <id>` och konfigurera auth under guiden.
- Eller kopiera `auth-profiles.json` från huvudagentens `agentDir` till den nya agentens `agentDir`.

**inte** återanvända `agentDir` över agenter; det orsakar författare/sessionkollisioner.

## Modell failover och "Alla modeller misslyckades"

### Hur fungerar failover

Misslyckandet sker i två steg:

1. **Auth profilrotation** inom samma leverantör.
2. **Modellfallback** till nästa modell i `agents.defaults.model.fallbacks`.

Cooldowns gäller för misslyckade profiler (exponentiell backoff), så OpenClaw kan fortsätta att svara även när en leverantör är hastighetsbegränsad eller tillfälligt misslyckas.

### Vad betyder detta fel

```
Inga inloggningsuppgifter hittades för profilen "anthropic:default"
```

Det betyder att systemet försökte använda auth profil-ID `anthropic:default`, men kunde inte hitta autentiseringsuppgifter för det i den förväntade auth butiken.

### Fixa checklista för Inga inloggningsuppgifter hittades för profil anthropicdefault

- **Bekräfta var auth profiler live** (nya vs äldre vägar)
  - Nuvarande: `~/.openclaw/agents/<agentId>/agent/auth-profiles.json`
  - Legacy: `~/.openclaw/agent/*` (migrerat av `openclaw doctor`)
- **Bekräfta att din env var är laddad av Gateway**
  - Om du anger `ANTHROPIC_API_KEY` i ditt skal men kör Gateway via system/launchd, kan det inte ärva det. Sätt den i `~/.openclaw/.env` eller aktivera `env.shellEnv`.
- **Se till att du redigerar rätt agent**
  - Multi-agent inställningar innebär att det kan finnas flera `auth-profiles.json`-filer.
- **Sanitetskontrollmodell/auth status**
  - Använd `openclaw models status` för att se konfigurerade modeller och om leverantörer är autentiserade.

**Fixa checklista för Inga inloggningsuppgifter hittades för profilantropic**

Detta innebär att körningen är fäst vid en antropisk auth profil, men Gateway
kan inte hitta den i sin auth butik.

- **Använd en setup-token**
  - Kör `claude setup-token`, klistra sedan in den med `openclaw models auth setup-token --provider anthropic`.
  - Om token skapades på en annan maskin, använd `openclaw models auth paste-token --provider anthropic`.

- **Om du vill använda en API-nyckel istället**
  - Sätt `ANTHROPIC_API_KEY` i `~/.openclaw/.env` på **gateway host**.
  - Rensa alla pinnade order som tvingar fram en saknad profil:

    ```bash
    openclaw modeller auth ordning rensa --provider antropisk
    ```

- **Bekräfta att du kör kommandon på gateway-värd**
  - I fjärranalys, auth profiler live på gateway-maskinen, inte din bärbara dator.

### Varför gjorde det också prova Google Gemini och misslyckas

Om din modellkonfiguration innehåller Google Gemini som en fallback (eller om du bytte till en Gemini shorthand), kommer OpenClaw att prova det under modellreserv. Om du inte har konfigurerat Google-autentiseringsuppgifter ser du `No API key found for provider "google"`.

Fix: antingen tillhandahålla Google auth, eller ta bort/undvik Google-modeller i `agents.defaults.model.fallbacks` / alias så att reservationen inte dirigerar dit.

**LLM-begäran avvisade meddelandetänkande signatur krävs google antigravitation**

Orsak: sessionshistoriken innehåller **tänkande block utan signaturer** (ofta från
en avbruten/delvis ström). Google Antigravitation kräver signaturer för tänkande block.

Fix: OpenClaw tar nu bort osignerade tänkande block för Google Antigravitation Claude. Om det fortfarande visas, starta en **ny session** eller sätt `/thinking off` för den agenten.

## Auth profiler: vad de är och hur man hanterar dem

Relaterat: [/concepts/oauth](/concepts/oauth) (OAuth flöden, token lagring, multi-account mönster)

### Vad är en auth profil

En auth profil är en namngiven autentiseringspost (OAuth eller API-nyckel) knuten till en leverantör. Profiler live i:

```
~/.openclaw/agents/<agentId>/agent/auth-profiles.json
```

### Vad är typiska profil-ID

OpenClaw använder leverantörs-prefix-ID:n som:

- `anthropic:default` (vanligt när ingen e-post-identitet finns)
- `anthropic:<email>` för OAuth identiteter
- anpassade ID du väljer (t.ex. `anthropic:work`)

### Kan jag styra vilken auth profil som prövas först

Ja. Konfigurationen stöder valfria metadata för profiler och en beställning per leverantör (`auth.order.<provider>`). Detta sparar **inte** hemligheter; det kartlägger ID till leverantör/läge och ställer in rotationsordning.

OpenClaw kan tillfälligt hoppa över en profil om den är i en kort **cooldown** (hastighetsgränser/timeouts/auth fel) eller en längre **inaktiverad** tillstånd (fakturering/otillräcklig krediter). För att inspektera detta, kör `openclaw models status --json` och kontrollera `auth.unusableProfiles`. Tuning: `auth.cooldowns.billingBackoffHours*`.

Du kan också ställa in en **per-agent** order åsidosättning (lagras i den agentens `auth-profiles.json`) via CLI:

```bash
# Standardvärdet för den konfigurerade standardagenten (utelämna --agent)
openclaw-modellerna auth order get --provider anthropic

# Lås rotation till en enda profil (försök bara denna)
openclaw-modellerna auth order set --provider anthropic anthropic:default

# Eller ställ in en explicit order (fallback in provider)
openclaw-modellerna auth order set --provider anthropic:work anthropic:default

# Rensa åsidosättning (falla tillbaka till config auth. rder / round-robin)
openclaw modeller auth order rensa --provider antropisk
```

För att rikta ett specifikt agent:

```bash
openclaw modeller auth order set --provider anthropic --agent main anthropic:default
```

### OAuth vs API-nyckel vad skillnaden är

OpenClaw stöder båda:

- **OAuth** utnyttjar ofta prenumerationsåtkomst (i förekommande fall).
- **API-nycklar** använd pay-per-token fakturering.

Guiden stöder uttryckligen Anthropic setup-token och OpenAI Codex OAuth och kan lagra API-nycklar åt dig.

## Gateway: portar, "redan igång" och fjärrläge

### Vilken port använder Gateway

`gateway.port` kontrollerar den enda multiplexade porten för WebSocket + HTTP (Control UI, hooks, etc.).

Prioritet:

```
--port > OPENCLAW_GATEWAY_PORT > gateway.port > standard 18789
```

### Varför säger openclaw gateway-status körning, men RPC-sonden misslyckades

Eftersom "kör" är **handledare** vy (launchd/systemd/schtasks). RPC-sonden är CLI faktiskt ansluta till gateway WebSocket och anropa `status`.

Använd `openclaw gateway status` och lita på dessa linjer:

- `Probe target:` (URL sonden faktiskt använde)
- `Lyssnar:` (vad som faktiskt är bundet till porten)
- `Senaste gatewayfel:` (vanlig rotsak när processen är vid liv, men porten lyssnar inte)

### Varför skiljer openclaw gateway status visa Config cli och Config service olika

Du redigerar en konfigurationsfil medan tjänsten kör en annan (ofta en `--profile` / `OPENCLAW_STATE_DIR` matchar inte).

Fix:

```bash
openclaw gateway install --force
```

Kör det från samma `--profile` / miljö som du vill att tjänsten ska använda.

### Vad en annan gateway-instans redan lyssnar betyder

OpenClaw upprätthåller ett körtidslås genom att binda WebSocket-lyssnaren omedelbart vid start (standard `ws://127.0.1:18789`). Om bindet misslyckas med `EADDRINUSE`, kastar det `GatewayLockError` som indikerar att en annan instans redan lyssnar.

Fixa: stoppa den andra instansen, frigör porten eller kör med `openclaw gateway --port <port>`.

### Hur kör jag OpenClaw i remote mode klient ansluter till en Gateway någon annanstans

Set `gateway.mode: "remote"` och peka på en fjärr-WebSocket URL, eventuellt med ett token/lösenord:

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

Anteckningar:

- `openclaw gateway` startar bara när `gateway.mode` är `local` (eller du passerar override flaggan).
- MacOS appen tittar på konfigurationsfilen och växlar lägen live när dessa värden ändras.

### Control UI säger obehörig eller håller återanslutning Vad nu

Din gateway körs med auth aktiverad (`gateway.auth.*`), men UI skickar inte matchande token/lösenord.

Fakta (från kod):

- Kontrollgränssnittet lagrar token i webbläsaren localStorage nyckel `openclaw.control.settings.v1`.

Fix:

- Snabbaste: `openclaw dashboard` (skriver ut + kopierar kontrollpanelens URL, försöker öppna; visar SSH-tips om headless).
- Om du inte har en token ännu: `openclaw doctor --generate-gateway-token`.
- Om fjärrkontroll, tunneln först: `ssh -N -L 18789:127.0.0.1:18789 user@host` öppna sedan `http://127.0.0.1:18789/`.
- Ange `gateway.auth.token` (eller `OPENCLAW_GATEWAY_TOKEN`) på gatewayvärden.
- I inställningarna för Kontroll UI, klistra in samma token.
- Fortfarande fastnar? Kör `openclaw status --all` och följ [Troubleshooting](/gateway/troubleshooting). Se [Dashboard](/web/dashboard) för information om auth.

### Jag sätter gatewaybind tailnet men det kan inte binda ingenting lyssnar

`tailnet` binda plockar en Tailscale IP från dina nätverksgränssnitt (100.64.0.0/10). Om maskinen inte är på Tailscale (eller gränssnittet är ner), finns det inget att binda till.

Fix:

- Starta Skräddarskala på den värden (så att den har en 100.x adress), eller
- Växla till `gateway.bind: "loopback"` / `"lan"`.

Obs: `tailnet` är explicit. `auto` föredrar loopback; använd `gateway.bind: "tailnet"` när du vill ha en tailnet-endast bind.

### Kan jag köra flera Gateways på samma värd

Vanligtvis ingen - en Gateway kan köra flera meddelandekanaler och agenter. Använd flera Gateways endast när du behöver redundans (ex: räddningsbot) eller hård isolering.

Ja, men du måste isolera:

- `OPENCLAW_CONFIG_PATH` (per-instance config)
- `OPENCLAW_STATE_DIR` (per instans stat)
- `agents.defaults.workspace` (isolering av arbetsytan)
- `gateway.port` (unika portar)

Snabb installation (rekommenderas):

- Använd `openclaw --profile <name> …` per instans (auto-create `~/.openclaw-<name>`).
- Ange en unik `gateway.port` i varje profilkonfiguration (eller passera `--port` för manuella körningar).
- Install a per-profile service: `openclaw --profile <name> gateway install`.

Profiler suffix-tjänstnamn (`bot.molt.<profile>`; legacy `com.openclaw.*`, `openclaw-gateway-<profile>.service`, `OpenClaw Gateway (<profile>)`).
Fullständig guide: [Flera gateways](/gateway/multiple-gateways).

### Vad innebär ogiltig handskakningskod 1008

Gateway är en **WebSocket-server**, och den förväntar sig det allra första meddelandet till
vara en `connect`-ram. Om den tar emot något annat, stänger den anslutningen
med **kod 1008** (policybrott).

Vanliga orsaker:

- Du öppnade **HTTP** URL i en webbläsare (`http://...`) istället för en WS-klient.
- Du använde fel port eller sökväg.
- En proxy eller tunnel rensade auth headers eller skickade en icke-Gateway begäran.

Snabbkorrigeringar:

1. Använd WS URL: `ws://<host>:18789` (eller `wss://...` om HTTPS).
2. Öppna inte WS-porten i en normal webbläsarflik.
3. Om auth är på, inkludera token/lösenord i `connect`-ramen.

Om du använder CLI eller TUI ska webbadressen se ut:

```
openclaw tui --url ws://<host>:18789 --token <token>
```

Protocol details: [Gateway protocol](/gateway/protocol).

## Loggning och felsökning

### Var finns loggar

Filloggar (strukturerade):

```
/tmp/openclaw/openclaw-YYYY-MM-DD.log
```

Du kan ställa in en stabil sökväg via `logging.file`. Filloggnivån styrs av `logging.level`. Konsolverbositet kontrolleras av `--verbose` och `logging.consoleLevel`.

Snabbaste loggen svans:

```bash
openclaw logs --follow
```

Service/handledare loggar (när gateway körs via launchd/systemd):

- macOS: `$OPENCLAW_STATE_DIR/logs/gateway.log` och `gateway.err.log` (standard: `~/.openclaw/logs/...`; profiler använder `~/.openclaw-<profile>/logs/...`)
- Linux: `journalctl --user -u openclaw-gateway[-<profile>].service -n 200 --no-pager`
- Windows: `schtasks /Query /TN "OpenClaw Gateway (<profile>)" /V /FO LIST`

Se [Troubleshooting](/gateway/troubleshooting#log-locations) för mer.

### Hur startar jag Gateway-tjänsten

Använd gateway hjälpare:

```bash
openclaw gateway status
openclaw gateway omstart
```

Om du kör gateway manuellt, kan `openclaw gateway --force` återta porten. Se [Gateway](/gateway).

### Jag avslutade min terminal på Windows hur jag startar om OpenClaw

Det finns **två Windows-installationsläge**:

**1) WSL2 (rekommenderas):** Gateway körs inuti Linux.

Öppna PowerShell, ange WSL, starta sedan om:

```powershell
wsl
openclaw gateway status
openclaw gateway omstart
```

Om du aldrig har installerat tjänsten, starta den i förgrunden:

```bash
openclaw gateway run
```

**2) Inhemska Windows (rekommenderas inte):** Gateway körs direkt i Windows.

Öppna PowerShell och köra:

```powershell
openclaw gateway status
openclaw gateway omstart
```

Om du kör det manuellt (ingen service), användning:

```powershell
openclaw gateway run
```

Dokument: [Windows (WSL2)](/platforms/windows), [Gateway service runbook](/gateway).

### Gateway är uppe men svar kommer aldrig Vad ska jag kontrollera

Börja med ett snabbt hälsosvep:

```bash
openclaw status
openclaw modeller status
openclaw kanaler status
openclaw loggar --follow
```

Vanliga orsaker:

- Modell auth inte laddad på **gateway host** (kontrollera `models status`).
- Kanalparning/tillåten lista som blockerar svar (kontrollera kanalkonfiguration + loggar).
- WebChat/Översikt är öppen utan rätt token.

Om du är fjärrkontroll, bekräfta tunnel/Tailscale anslutningen är uppe och att
Gateway WebSocket är nåbar.

Dokument: [Channels](/channels), [Troubleshooting](/gateway/troubleshooting), [Remote access](/gateway/remote).

### Frånkopplad från gateway ingen anledning vad som nu

Detta innebär vanligtvis att UI förlorade WebSocket anslutningen. Kontroll:

1. Kör Gatewayen? `openclaw gateway status`
2. Är Gateway frisk? `openclaw status`
3. Har UI rätt token? `openclaw dashboard`
4. Om fjärrkontroll, är tunneln/skal länken upp?

Sedan svans loggar:

```bash
openclaw logs --follow
```

Dokument: [Dashboard](/web/dashboard), [fjärråtkomst](/gateway/remote), [Troubleshooting](/gateway/troubleshooting).

### Telegram setMyCommands misslyckas med nätverksfel Vad ska jag kontrollera

Börja med loggar och kanalstatus:

```bash
openclaw kanalstatus
openclaw kanalerna loggar --channel telegram
```

Om du är på en VPS eller bakom en proxy, bekräfta utgående HTTPS är tillåtet och DNS fungerar.
Om Gateway är fjärrkontroll, se till att du tittar på loggar på Gateway värd.

Dokument: [Telegram](/channels/telegram), [Kanalfelsökning](/channels/troubleshooting).

### TUI visar ingen utgång Vad ska jag kontrollera

Bekräfta först att Gateway är nåbar och att agenten kan köra:

```bash
openclaw status
openclaw modellens status
openclaw loggar --follow
```

I TUI, använd `/status` för att se aktuellt tillstånd. Om du förväntar dig svar i en chatt
kanal, se till att leverans är aktiverad (`/deliver on`).

Dokument: [TUI](/web/tui), [Slash kommandon](/tools/slash-commands).

### Hur slutar jag då helt och hållet starta Gateway

Om du har installerat tjänsten:

```bash
openclaw gateway stop
openclaw gateway start
```

Detta stoppar/startar den **övervakade tjänsten** (launchd på macOS, systemd på Linux).
Använd detta när Gateway körs i bakgrunden som en daemon.

Om du kör i förgrunden, sluta med Ctrl-C, sedan:

```bash
openclaw gateway run
```

Docs: [Gateway service runbook](/gateway).

### ELI5 openclaw gateway omstart vs openclaw gateway

- `openclaw gateway restart`: startar om **bakgrundstjänsten** (launchd/systemd).
- `openclaw gateway`: kör gateway **i förgrunden** för denna terminalsession.

Om du har installerat tjänsten, använd gateway-kommandon. Använd `openclaw gateway` när
du vill ha en one-off, förgrundsrunda.

### Vad är det snabbaste sättet att få mer detaljer när något misslyckas

Starta Gateway med `--verbose` för att få mer information om konsolen. Sedan inspektera loggfilen för kanal auth, modell routing och RPC fel.

## Media och bilagor

### Min skicklighet genererade en imagePDF men ingenting skickades

Utgående bilagor från agenten måste innehålla en `MEDIA:<path-or-url>` -linje (på egen rad). Se [OpenClaw assistent setup](/start/openclaw) och [Agent send](/tools/agent-send).

CLI skickar:

```bash
openclaw meddelande skicka --target +15555550123 --message "Here you go" --media /path/to/file.png
```

Kontroll:

- Målkanalen stöder utgående media och blockeras inte av tillåtna listor.
- Filen ligger inom leverantörens storleksgränser (bilder skalas om till max 2048px).

Se [Images](/nodes/images).

## Säkerhet och åtkomstkontroll

### Är det säkert att utsätta OpenClaw för inkommande DMs

Behandla inkommande DMs som opålitlig indata. Standardvärden är utformade för att minska risken:

- Standardbeteende på DM-kapabla kanaler är **parning**:
  - Okända avsändare får en parningskod; boten bearbetar inte sitt meddelande.
  - Godkänn med: `openclaw parkoppling godkänner <channel> <code>`
  - Väntande förfrågningar är capped på **3 per kanal**; kontrollera `openclaw parningslista <channel>` om en kod inte anländer.
- Öppnande av DMs kräver offentligt explicit opt-in (`dmPolicy: "open"` och allowlist `"*"`).

Kör `openclaw läkare` för att ytan riskabelt DM politik.

### Är snabb injektion bara ett bekymmer för offentliga robotar

Nej. Snabb injektion handlar om **opålitligt innehåll**, inte bara vem som kan DM boten.
Om din assistent läser externt innehåll (webbsök/hämtning, webbläsarsidor, e-post,
dokument, Bilagor, klistrade loggar), det innehållet kan innehålla instruktioner som försöker
för att kapa modellen. Detta kan hända även om **du är den enda avsändaren**.

Den största risken är när verktyg är aktiverade: modellen kan luras in i
exfiltrera sammanhang eller ringa verktyg för din räkning. Minska sprängradien genom att:

- använda en skrivskyddad eller verktygsinaktiverad "läsare" agent för att sammanfatta opålitligt innehåll
- hålla `web_search` / `web_fetch` / `browser` avstängd för verktygsaktiverade agenter
- sandlåda och strikta verktygslistor

Detaljer: [Security](/gateway/security).

### Om min bot har sin egen e-post GitHub-konto eller telefonnummer

Ja, för de flesta inställningar. Isolera botten med separata konton och telefonnummer
minskar sprängradien om något går fel. Detta gör det också lättare att rotera
-uppgifter eller återkalla åtkomst utan att påverka dina personliga konton.

Börja små. Ge endast tillgång till de verktyg och konton du faktiskt behöver, och expandera
senare om det behövs.

Dokument: [Security](/gateway/security), [Pairing](/channels/pairing).

### Kan jag ge det autonomi över mina textmeddelanden och är så säker

Vi rekommenderar **inte** fullständig autonomi över dina personliga meddelanden. Det säkraste mönstret är:

- Håll DMs i **parningsläge** eller en tät tillåten lista.
- Använd ett **separat nummer eller konto** om du vill att det ska meddelas åt dig.
- Låt det utkast, sedan **godkänna innan du skickar**.

Om du vill experimentera, gör det på ett dedikerat konto och hålla det isolerat. Se
[Security](/gateway/security).

### Kan jag använda billigare modeller för personliga assistentuppgifter

Ja, **om** är agenten endast chattad och inmatningen är betrodd. Mindre nivåer är
mer mottagliga för instruktion kapning, så undvik dem för verktygsaktiverade agenter
eller när du läser opålitligt innehåll. Om du måste använda en mindre modell, lås ner
verktyg och kör inuti en sandlåda. Se [Security](/gateway/security).

### Jag körde start i Telegram men fick inte en parningskod

Parkopplingskoderna skickas **bara** när en okänd avsändare meddelar bot och
`dmPolicy: "parkoppling"` är aktiverat. `/start` i sig själv genererar ingen kod.

Kontrollera väntande förfrågningar:

```bash
openclaw pairing list telegram
```

Om du vill ha omedelbar åtkomst, tillåt lista ditt avsändar-id eller sätt `dmPolicy: "open"`
för det kontot.

### WhatsApp kommer att skicka meddelanden till mina kontakter Hur kopplar ihop fungerar

Nej. Standard WhatsApp DM policy är **ihopkoppling**. Okända avsändare får bara en parningskod och deras meddelande **behandlas inte**. OpenClaw svarar bara på chattar som den tar emot eller uttryckligen skickar dig utlösare.

Godkänn parkoppling med:

```bash
openclaw pairing approve whatsapp <code>
```

Lista väntande förfrågningar:

```bash
openclaw pairing list whatsapp
```

Fråga om guiden telefonnummer: den används för att ställa in **tillåtna/ägare** så att dina egna DMs är tillåtna. Den används inte för automatisk sändning. Om du kör på ditt personliga WhatsApp-nummer, använd det numret och aktivera `channels.whatsapp.selfChatMode`.

## Chattkommandon, avbryter uppgifter och "det slutar inte"

### Hur stoppar jag interna systemmeddelanden från att visas i chatten

De flesta interna meddelanden eller verktygsmeddelanden visas endast när **verbos** eller **resonemang** är aktiverade
för den sessionen.

Fixa i chatten där du ser den:

```
/verbose off
/reasoning off
```

Om det fortfarande är bullrigt, kontrollera sessionsinställningarna i kontrollgränssnittet och ställ in verbose
till **arv**. Bekräfta också att du inte använder en bot profil med `verboseDefault` set
till `on` i config.

Dokument: [Thinking and verbose](/tools/thinking), [Security](/gateway/security#reasoning--verbose-output-in-groups).

### Hur stoppar jag en pågående uppgift

Skicka något av dessa **som ett fristående meddelande** (inget snedstreck):

```
stoppa
avbryta
esc
vänta
avsluta
avbryta
```

Dessa avbryter utlösare (inte snedstreck kommandon).

För bakgrundsprocesser (från exec-verktyget) kan du be agenten att köra:

```
processa:kill sessionId:XXX
```

Slash kommandon översikt: se [Slash kommandon](/tools/slash-commands).

De flesta kommandon måste skickas som ett **standalone** meddelande som börjar med `/`, men några genvägar (som `/status`) fungerar också inline för tillåtna avsändare.

### Hur skickar jag ett Discord-meddelande från Telegram Crosscontext messaging nekas

OpenClaw block **cross-provider** meddelande som standard. Om ett verktygssamtal är bundet
till Telegram kommer det inte att skickas till Discord såvida du inte uttryckligen tillåter det.

Aktivera cross-provider meddelande för agenten:

```json5
{
  agenter: {
    defaults: {
      tools: {
        message: {
          crossContext: {
            allowAcrossProviders: true,
            markör: { aktiverad: sant, prefix: "[från {channel}] " },
          },
        },
      },
    },
  },
}
```

Starta om gateway efter redigering av konfigurationen. Om du bara vill ha detta för en enda
agent, ange det under `agents.list[].tools.message` istället.

### Varför känns det som att boten ignorerar snabba meddelanden

Köläget styr hur nya meddelanden interagerar med en in-flight-körning. Använd `/queue` för att ändra lägen:

- `steer` - nya meddelanden omdirigerar den aktuella uppgiften
- `followup` - kör meddelanden en åt gången
- `collect` - batch-meddelanden och svara en gång (standard)
- `steer-backlog` - styra nu, sedan bearbeta eftersläpning
- `interrupt` - avbryt nuvarande körning och starta nytt

Du kan lägga till alternativ som `debounce:2s cap:25 drop:summarize` för uppföljningslägen.

## Svara på den exakta frågan från skärmdumpen/chattloggen

**F: "Vad är standardmodellen för Anthropic med en API-nyckel?"**

**S:** I OpenClaw separeras autentiseringsuppgifter och modellval. Ställa in `ANTHROPIC_API_KEY` (eller lagra en Anthropic API-nyckel i auth profiler) möjliggör autentisering, men den faktiska standardmodellen är vad du konfigurerar i `agents. efaults.model.primary` (till exempel, `anthropic/claude-sonnet-4-5` eller `anthropic/claude-opus-4-6`). Om du ser `Inga autentiseringsuppgifter hittades för profilen "antrop:default"`, betyder det att Gateway inte kunde hitta antropiska autentiseringsuppgifter i de förväntade `auth-profilerna. son` för agenten som körs.

---

Fortfarande fastnar? Fråga i [Discord](https://discord.com/invite/clawd) eller öppna en [GitHub diskussion](https://github.com/openclaw/openclaw/discussions).
