---
summary: "Veelgestelde vragen over de installatie, configuratie en het gebruik van OpenClaw"
title: "FAQ"
---

# FAQ

Snelle antwoorden plus diepere probleemoplossing voor praktijksituaties (lokale dev, VPS, multi‑agent, OAuth/API‑sleutels, model‑failover). Voor runtime‑diagnostiek, zie [Problemen oplossen](/gateway/troubleshooting). Voor de volledige config‑referentie, zie [Configuratie](/gateway/configuration).

## Inhoudsopgave

- [Snelle start en eerste installatie]
  - [Ik zit vast, wat is de snelste manier om los te komen?](#im-stuck-whats-the-fastest-way-to-get-unstuck)
  - [Wat is de aanbevolen manier om OpenClaw te installeren en in te stellen?](#whats-the-recommended-way-to-install-and-set-up-openclaw)
  - [Hoe open ik het dashboard na onboarding?](#how-do-i-open-the-dashboard-after-onboarding)
  - [Hoe authenticeer ik het dashboard (token) op localhost versus remote?](#how-do-i-authenticate-the-dashboard-token-on-localhost-vs-remote)
  - [Welke runtime heb ik nodig?](#what-runtime-do-i-need)
  - [Draait het op Raspberry Pi?](#does-it-run-on-raspberry-pi)
  - [Tips voor Raspberry Pi‑installaties?](#any-tips-for-raspberry-pi-installs)
  - [Het blijft hangen op "wake up my friend" / onboarding komt niet door. Wat nu?](#it-is-stuck-on-wake-up-my-friend-onboarding-will-not-hatch-what-now)
  - [Kan ik mijn setup migreren naar een nieuwe machine (Mac mini) zonder onboarding opnieuw te doen?](#can-i-migrate-my-setup-to-a-new-machine-mac-mini-without-redoing-onboarding)
  - [Waar zie ik wat er nieuw is in de laatste versie?](#where-do-i-see-what-is-new-in-the-latest-version)
  - [Ik kan docs.openclaw.ai niet openen (SSL‑fout). Wat nu?](#i-cant-access-docsopenclawai-ssl-error-what-now)
  - [Wat is het verschil tussen stable en beta?](#whats-the-difference-between-stable-and-beta)
  - [Hoe installeer ik de beta‑versie, en wat is het verschil tussen beta en dev?](#how-do-i-install-the-beta-version-and-whats-the-difference-between-beta-and-dev)
  - [Hoe probeer ik de nieuwste bits?](#how-do-i-try-the-latest-bits)
  - [Hoe lang duren installatie en onboarding meestal?](#how-long-does-install-and-onboarding-usually-take)
  - [Installer vastgelopen? Hoe krijg ik meer feedback?](#installer-stuck-how-do-i-get-more-feedback)
  - [Windows‑installatie zegt git niet gevonden of openclaw niet herkend](#windows-install-says-git-not-found-or-openclaw-not-recognized)
  - [De docs beantwoorden mijn vraag niet — hoe krijg ik een beter antwoord?](#the-docs-didnt-answer-my-question-how-do-i-get-a-better-answer)
  - [Hoe installeer ik OpenClaw op Linux?](#how-do-i-install-openclaw-on-linux)
  - [Hoe installeer ik OpenClaw op een VPS?](#how-do-i-install-openclaw-on-a-vps)
  - [Waar zijn de cloud/VPS‑installatiegidsen?](#where-are-the-cloudvps-install-guides)
  - [Kan ik OpenClaw vragen zichzelf te updaten?](#can-i-ask-openclaw-to-update-itself)
  - [Wat doet de onboarding‑wizard eigenlijk?](#what-does-the-onboarding-wizard-actually-do)
  - [Heb ik een Claude‑ of OpenAI‑abonnement nodig om dit te draaien?](#do-i-need-a-claude-or-openai-subscription-to-run-this)
  - [Kan ik een Claude Max‑abonnement gebruiken zonder API‑sleutel](#can-i-use-claude-max-subscription-without-an-api-key)
  - [Hoe werkt Anthropic "setup-token"‑auth?](#how-does-anthropic-setuptoken-auth-work)
  - [Waar vind ik een Anthropic setup-token?](#where-do-i-find-an-anthropic-setuptoken)
  - [Ondersteunen jullie Claude‑abonnementsauth (Claude Pro of Max)?](#do-you-support-claude-subscription-auth-claude-pro-or-max)
  - [Waarom zie ik `HTTP 429: rate_limit_error` van Anthropic?](#why-am-i-seeing-http-429-ratelimiterror-from-anthropic)
  - [Wordt AWS Bedrock ondersteund?](#is-aws-bedrock-supported)
  - [Hoe werkt Codex‑auth?](#how-does-codex-auth-work)
  - [Ondersteunen jullie OpenAI‑abonnementsauth (Codex OAuth)?](#do-you-support-openai-subscription-auth-codex-oauth)
  - [Hoe stel ik Gemini CLI OAuth in](#how-do-i-set-up-gemini-cli-oauth)
  - [Is een lokaal model oké voor casual chats?](#is-a-local-model-ok-for-casual-chats)
  - [Hoe houd ik gehost modelverkeer in een specifieke regio?](#how-do-i-keep-hosted-model-traffic-in-a-specific-region)
  - [Moet ik een Mac Mini kopen om dit te installeren?](#do-i-have-to-buy-a-mac-mini-to-install-this)
  - [Heb ik een Mac mini nodig voor iMessage‑ondersteuning?](#do-i-need-a-mac-mini-for-imessage-support)
  - [Als ik een Mac mini koop om OpenClaw te draaien, kan ik die verbinden met mijn MacBook Pro?](#if-i-buy-a-mac-mini-to-run-openclaw-can-i-connect-it-to-my-macbook-pro)
  - [Kan ik Bun gebruiken?](#can-i-use-bun)
  - [Telegram: wat hoort er in `allowFrom`?](#telegram-what-goes-in-allowfrom)
  - [Kunnen meerdere mensen één WhatsApp‑nummer gebruiken met verschillende OpenClaw‑instanties?](#can-multiple-people-use-one-whatsapp-number-with-different-openclaw-instances)
  - [Kan ik een "fast chat"‑agent en een "Opus for coding"‑agent draaien?](#can-i-run-a-fast-chat-agent-and-an-opus-for-coding-agent)
  - [Werkt Homebrew op Linux?](#does-homebrew-work-on-linux)
  - [Wat is het verschil tussen de hackable (git)‑installatie en npm‑installatie?](#whats-the-difference-between-the-hackable-git-install-and-npm-install)
  - [Kan ik later wisselen tussen npm‑ en git‑installaties?](#can-i-switch-between-npm-and-git-installs-later)
  - [Moet ik de Gateway op mijn laptop of op een VPS draaien?](#should-i-run-the-gateway-on-my-laptop-or-a-vps)
  - [Hoe belangrijk is het om OpenClaw op een dedicated machine te draaien?](#how-important-is-it-to-run-openclaw-on-a-dedicated-machine)
  - [Wat zijn de minimale VPS‑vereisten en aanbevolen OS?](#what-are-the-minimum-vps-requirements-and-recommended-os)
  - [Kan ik OpenClaw in een VM draaien en wat zijn de vereisten](#can-i-run-openclaw-in-a-vm-and-what-are-the-requirements)
- [Wat is OpenClaw?](#what-is-openclaw)
  - [Wat is OpenClaw, in één alinea?](#what-is-openclaw-in-one-paragraph)
  - [Wat is de waardepropositie?](#whats-the-value-proposition)
  - [Ik heb het net opgezet, wat moet ik eerst doen](#i-just-set-it-up-what-should-i-do-first)
  - [Wat zijn de vijf belangrijkste dagelijkse use‑cases voor OpenClaw](#what-are-the-top-five-everyday-use-cases-for-openclaw)
  - [Kan OpenClaw helpen met lead‑gen, outreach, advertenties en blogs voor een SaaS](#can-openclaw-help-with-lead-gen-outreach-ads-and-blogs-for-a-saas)
  - [Wat zijn de voordelen ten opzichte van Claude Code voor webontwikkeling?](#what-are-the-advantages-vs-claude-code-for-web-development)
- [Skills en automatisering](#skills-and-automation)
  - [Hoe pas ik skills aan zonder de repo te vervuilen?](#how-do-i-customize-skills-without-keeping-the-repo-dirty)
  - [Kan ik skills laden vanuit een aangepaste map?](#can-i-load-skills-from-a-custom-folder)
  - [Hoe kan ik verschillende modellen gebruiken voor verschillende taken?](#how-can-i-use-different-models-for-different-tasks)
  - [De bot bevriest bij zwaar werk. Hoe besteed ik dat uit?](#the-bot-freezes-while-doing-heavy-work-how-do-i-offload-that)
  - [Cron of herinneringen vuren niet af. Wat moet ik controleren?](#cron-or-reminders-do-not-fire-what-should-i-check)
  - [Hoe installeer ik skills op Linux?](#how-do-i-install-skills-on-linux)
  - [Kan OpenClaw taken volgens schema of continu op de achtergrond draaien?](#can-openclaw-run-tasks-on-a-schedule-or-continuously-in-the-background)
  - [Kan ik Apple macOS‑only skills vanaf Linux draaien?](#can-i-run-apple-macos-only-skills-from-linux)
  - [Hebben jullie een Notion‑ of HeyGen‑integratie?](#do-you-have-a-notion-or-heygen-integration)
  - [Hoe installeer ik de Chrome‑extensie voor browser takeover?](#how-do-i-install-the-chrome-extension-for-browser-takeover)
- [Sandboxing en geheugen](#sandboxing-and-memory)
  - [Is er een aparte sandboxing‑doc?](#is-there-a-dedicated-sandboxing-doc)
  - [Hoe bind ik een hostmap in de sandbox?](#how-do-i-bind-a-host-folder-into-the-sandbox)
  - [Hoe werkt geheugen?](#how-does-memory-work)
  - [Geheugen vergeet steeds dingen. Hoe laat ik het blijven hangen?](#memory-keeps-forgetting-things-how-do-i-make-it-stick)
  - [Blijft geheugen voor altijd bestaan? Wat zijn de limieten?](#does-memory-persist-forever-what-are-the-limits)
  - [Vereist semantische geheugenz oek een OpenAI API‑sleutel?](#does-semantic-memory-search-require-an-openai-api-key)
- [Waar dingen op schijf staan](#where-things-live-on-disk)
  - [Wordt alle data die met OpenClaw wordt gebruikt lokaal opgeslagen?](#is-all-data-used-with-openclaw-saved-locally)
  - [Waar slaat OpenClaw zijn data op?](#where-does-openclaw-store-its-data)
  - [Waar moeten AGENTS.md / SOUL.md / USER.md / MEMORY.md staan?](#where-should-agentsmd-soulmd-usermd-memorymd-live)
  - [Wat is de aanbevolen back‑upstrategie?](#whats-the-recommended-backup-strategy)
  - [Hoe verwijder ik OpenClaw volledig?](#how-do-i-completely-uninstall-openclaw)
  - [Kunnen agents buiten de werkruimte werken?](#can-agents-work-outside-the-workspace)
  - [Ik zit in remote mode — waar is de sessieopslag?](#im-in-remote-mode-where-is-the-session-store)
- [Config‑basis](#config-basics)
  - [Welk formaat heeft de config? Waar staat die?](#what-format-is-the-config-where-is-it)
  - [Ik heb `gateway.bind: "lan"` (of `"tailnet"`) ingesteld en nu luistert niets / de UI zegt unauthorized](#i-set-gatewaybind-lan-or-tailnet-and-now-nothing-listens-the-ui-says-unauthorized)
  - [Waarom heb ik nu een token nodig op localhost?](#why-do-i-need-a-token-on-localhost-now)
  - [Moet ik herstarten na het wijzigen van de config?](#do-i-have-to-restart-after-changing-config)
  - [Hoe schakel ik web search (en web fetch) in?](#how-do-i-enable-web-search-and-web-fetch)
  - [config.apply heeft mijn config gewist. Hoe herstel ik dit en voorkom ik het?](#configapply-wiped-my-config-how-do-i-recover-and-avoid-this)
  - [Hoe draai ik een centrale Gateway met gespecialiseerde workers over apparaten heen?](#how-do-i-run-a-central-gateway-with-specialized-workers-across-devices)
  - [Kan de OpenClaw‑browser headless draaien?](#can-the-openclaw-browser-run-headless)
  - [Hoe gebruik ik Brave voor browserbesturing?](#how-do-i-use-brave-for-browser-control)
- [Remote gateways en nodes](#remote-gateways-and-nodes)
  - [Hoe verspreiden opdrachten zich tussen Telegram, de gateway en nodes?](#how-do-commands-propagate-between-telegram-the-gateway-and-nodes)
  - [Hoe kan mijn agent mijn computer benaderen als de Gateway extern wordt gehost?](#how-can-my-agent-access-my-computer-if-the-gateway-is-hosted-remotely)
  - [Tailscale is verbonden maar ik krijg geen antwoorden. Wat nu?](#tailscale-is-connected-but-i-get-no-replies-what-now)
  - [Kunnen twee OpenClaw‑instanties met elkaar praten (lokaal + VPS)?](#can-two-openclaw-instances-talk-to-each-other-local-vps)
  - [Heb ik aparte VPS’en nodig voor meerdere agents](#do-i-need-separate-vpses-for-multiple-agents)
  - [Is er een voordeel aan het gebruiken van een node op mijn persoonlijke laptop in plaats van SSH vanaf een VPS?](#is-there-a-benefit-to-using-a-node-on-my-personal-laptop-instead-of-ssh-from-a-vps)
  - [Draaien nodes een gateway‑service?](#do-nodes-run-a-gateway-service)
  - [Is er een API / RPC‑manier om config toe te passen?](#is-there-an-api-rpc-way-to-apply-config)
  - [Wat is een minimale "zinsvolle" config voor een eerste installatie?](#whats-a-minimal-sane-config-for-a-first-install)
  - [Hoe stel ik Tailscale in op een VPS en verbind ik vanaf mijn Mac?](#how-do-i-set-up-tailscale-on-a-vps-and-connect-from-my-mac)
  - [Hoe verbind ik een Mac‑node met een remote Gateway (Tailscale Serve)?](#how-do-i-connect-a-mac-node-to-a-remote-gateway-tailscale-serve)
  - [Moet ik op een tweede laptop installeren of gewoon een node toevoegen?](#should-i-install-on-a-second-laptop-or-just-add-a-node)
- [Env vars en .env‑laden](#env-vars-and-env-loading)
  - [Hoe laadt OpenClaw omgevingsvariabelen?](#how-does-openclaw-load-environment-variables)
  - ["Ik startte de Gateway via de service en mijn env vars zijn verdwenen." Wat nu?](#i-started-the-gateway-via-the-service-and-my-env-vars-disappeared-what-now)
  - [Ik heb `COPILOT_GITHUB_TOKEN` ingesteld, maar de modellenstatus toont "Shell env: off." Waarom?](#i-set-copilotgithubtoken-but-models-status-shows-shell-env-off-why)
- [Sessies en meerdere chats](#sessions-and-multiple-chats)
  - [Hoe start ik een nieuw gesprek?](#how-do-i-start-a-fresh-conversation)
  - [Resetten sessies automatisch als ik nooit `/new` stuur?](#do-sessions-reset-automatically-if-i-never-send-new)
  - [Is er een manier om een team van OpenClaw‑instanties te maken met één CEO en veel agents](#is-there-a-way-to-make-a-team-of-openclaw-instances-one-ceo-and-many-agents)
  - [Waarom werd context midden in een taak afgekapt? Hoe voorkom ik dat?](#why-did-context-get-truncated-midtask-how-do-i-prevent-it)
  - [Hoe reset ik OpenClaw volledig maar houd ik het geïnstalleerd?](#how-do-i-completely-reset-openclaw-but-keep-it-installed)
  - [Ik krijg "context too large"‑fouten — hoe reset of comprimeer ik?](#im-getting-context-too-large-errors-how-do-i-reset-or-compact)
  - [Waarom zie ik "LLM request rejected: messages.N.content.X.tool_use.input: Field required"?](#why-am-i-seeing-llm-request-rejected-messagesncontentxtooluseinput-field-required)
  - [Waarom krijg ik elke 30 minuten heartbeat‑berichten?](#why-am-i-getting-heartbeat-messages-every-30-minutes)
  - [Moet ik een "bot‑account" toevoegen aan een WhatsApp‑groep?](#do-i-need-to-add-a-bot-account-to-a-whatsapp-group)
  - [Hoe krijg ik de JID van een WhatsApp‑groep?](#how-do-i-get-the-jid-of-a-whatsapp-group)
  - [Waarom antwoordt OpenClaw niet in een groep?](#why-doesnt-openclaw-reply-in-a-group)
  - [Delen groepen/threads context met DM’s?](#do-groupsthreads-share-context-with-dms)
  - [Hoeveel werkruimtes en agents kan ik aanmaken?](#how-many-workspaces-and-agents-can-i-create)
  - [Kan ik meerdere bots of chats tegelijk draaien (Slack), en hoe stel ik dat in?](#can-i-run-multiple-bots-or-chats-at-the-same-time-slack-and-how-should-i-set-that-up)
- [Modellen: standaardwaarden, selectie, aliassen, wisselen](#models-defaults-selection-aliases-switching)
  - [Wat is het "standaardmodel"?](#what-is-the-default-model)
  - [Welk model raden jullie aan?](#what-model-do-you-recommend)
  - [Hoe wissel ik van model zonder mijn config te wissen?](#how-do-i-switch-models-without-wiping-my-config)
  - [Kan ik zelfgehoste modellen gebruiken (llama.cpp, vLLM, Ollama)?](#can-i-use-selfhosted-models-llamacpp-vllm-ollama)
  - [Welke modellen gebruiken OpenClaw, Flawd en Krill?](#what-do-openclaw-flawd-and-krill-use-for-models)
  - [Hoe wissel ik modellen on‑the‑fly (zonder herstart)?](#how-do-i-switch-models-on-the-fly-without-restarting)
  - [Kan ik GPT 5.2 gebruiken voor dagelijkse taken en Codex 5.3 voor coderen](#can-i-use-gpt-52-for-daily-tasks-and-codex-53-for-coding)
  - [Waarom zie ik "Model … is not allowed" en daarna geen antwoord?](#why-do-i-see-model-is-not-allowed-and-then-no-reply)
  - [Waarom zie ik "Unknown model: minimax/MiniMax-M2.1"?](#why-do-i-see-unknown-model-minimaxminimaxm21)
  - [Kan ik MiniMax als standaard gebruiken en OpenAI voor complexe taken?](#can-i-use-minimax-as-my-default-and-openai-for-complex-tasks)
  - [Zijn opus / sonnet / gpt ingebouwde snelkoppelingen?](#are-opus-sonnet-gpt-builtin-shortcuts)
  - [Hoe definieer/overschrijf ik model‑snelkoppelingen (aliassen)?](#how-do-i-defineoverride-model-shortcuts-aliases)
  - [Hoe voeg ik modellen toe van andere providers zoals OpenRouter of Z.AI?](#how-do-i-add-models-from-other-providers-like-openrouter-or-zai)
- [Model‑failover en "All models failed"](#model-failover-and-all-models-failed)
  - [Hoe werkt failover?](#how-does-failover-work)
  - [Wat betekent deze fout?](#what-does-this-error-mean)
  - [Fix‑checklist voor `No credentials found for profile "anthropic:default"`](#fix-checklist-for-no-credentials-found-for-profile-anthropicdefault)
  - [Waarom probeerde het ook Google Gemini en faalde?](#why-did-it-also-try-google-gemini-and-fail)
- [Auth‑profielen: wat ze zijn en hoe je ze beheert](#auth-profiles-what-they-are-and-how-to-manage-them)
  - [Wat is een auth‑profiel?](#what-is-an-auth-profile)
  - [Wat zijn typische profiel‑ID’s?](#what-are-typical-profile-ids)
  - [Kan ik bepalen welk auth‑profiel eerst wordt geprobeerd?](#can-i-control-which-auth-profile-is-tried-first)
  - [OAuth versus API‑sleutel: wat is het verschil?](#oauth-vs-api-key-whats-the-difference)
- [Gateway: poorten, "already running" en remote mode](#gateway-ports-already-running-and-remote-mode)
  - [Welke poort gebruikt de Gateway?](#what-port-does-the-gateway-use)
  - [Waarom zegt `openclaw gateway status` `Runtime: running` maar `RPC probe: failed`?](#why-does-openclaw-gateway-status-say-runtime-running-but-rpc-probe-failed)
  - [Waarom toont `openclaw gateway status` `Config (cli)` en `Config (service)` verschillend?](#why-does-openclaw-gateway-status-show-config-cli-and-config-service-different)
  - [Wat betekent "another gateway instance is already listening"?](#what-does-another-gateway-instance-is-already-listening-mean)
  - [Hoe draai ik OpenClaw in remote mode (client verbindt met een Gateway elders)?](#how-do-i-run-openclaw-in-remote-mode-client-connects-to-a-gateway-elsewhere)
  - [De Control UI zegt "unauthorized" (of blijft reconnecten). Wat nu?](#the-control-ui-says-unauthorized-or-keeps-reconnecting-what-now)
  - [Ik heb `gateway.bind: "tailnet"` ingesteld maar hij kan niet binden / niets luistert](#i-set-gatewaybind-tailnet-but-it-cant-bind-nothing-listens)
  - [Kan ik meerdere Gateways op dezelfde host draaien?](#can-i-run-multiple-gateways-on-the-same-host)
  - [Wat betekent "invalid handshake" / code 1008?](#what-does-invalid-handshake-code-1008-mean)
- [Logging en debuggen](#logging-and-debugging)
  - [Waar zijn logs?](#where-are-logs)
  - [Hoe start/stop/herstart ik de Gateway‑service?](#how-do-i-startstoprestart-the-gateway-service)
  - [Ik heb mijn terminal op Windows gesloten — hoe herstart ik OpenClaw?](#i-closed-my-terminal-on-windows-how-do-i-restart-openclaw)
  - [De Gateway is up maar antwoorden komen nooit aan. Wat moet ik controleren?](#the-gateway-is-up-but-replies-never-arrive-what-should-i-check)
  - ["Disconnected from gateway: no reason" — wat nu?](#disconnected-from-gateway-no-reason-what-now)
  - [Telegram setMyCommands faalt met netwerkfouten. Wat moet ik controleren?](#telegram-setmycommands-fails-with-network-errors-what-should-i-check)
  - [TUI toont geen uitvoer. Wat moet ik controleren?](#tui-shows-no-output-what-should-i-check)
  - [Hoe stop ik de Gateway volledig en start ik hem daarna weer?](#how-do-i-completely-stop-then-start-the-gateway)
  - [ELI5: `openclaw gateway restart` vs `openclaw gateway`](#eli5-openclaw-gateway-restart-vs-openclaw-gateway)
  - [Wat is de snelste manier om meer details te krijgen als iets faalt?](#whats-the-fastest-way-to-get-more-details-when-something-fails)
- [Media en bijlagen](#media-and-attachments)
  - [Mijn skill genereerde een afbeelding/PDF, maar er werd niets verzonden](#my-skill-generated-an-imagepdf-but-nothing-was-sent)
- [Beveiliging en toegangsbeheer](#security-and-access-control)
  - [Is het veilig om OpenClaw bloot te stellen aan inkomende DM’s?](#is-it-safe-to-expose-openclaw-to-inbound-dms)
  - [Is prompt injection alleen een zorg voor publieke bots?](#is-prompt-injection-only-a-concern-for-public-bots)
  - [Moet mijn bot een eigen e‑mail, GitHub‑account of telefoonnummer hebben](#should-my-bot-have-its-own-email-github-account-or-phone-number)
  - [Kan ik het autonomie geven over mijn sms‑berichten en is dat veilig](#can-i-give-it-autonomy-over-my-text-messages-and-is-that-safe)
  - [Kan ik goedkopere modellen gebruiken voor persoonlijke assistent‑taken?](#can-i-use-cheaper-models-for-personal-assistant-tasks)
  - [Ik heb `/start` uitgevoerd in Telegram maar kreeg geen koppelingscode](#i-ran-start-in-telegram-but-didnt-get-a-pairing-code)
  - [WhatsApp: zal het mijn contacten berichten? Hoe werkt koppelen?](#whatsapp-will-it-message-my-contacts-how-does-pairing-work)
- [Chatopdrachten, taken afbreken en "het stopt niet"](#chat-commands-aborting-tasks-and-it-wont-stop)
  - [Hoe voorkom ik dat interne systeemberichten in de chat verschijnen](#how-do-i-stop-internal-system-messages-from-showing-in-chat)
  - [Hoe stop/annuleer ik een lopende taak?](#how-do-i-stopcancel-a-running-task)
  - [Hoe stuur ik een Discord‑bericht vanuit Telegram? ("Cross‑context messaging denied")](#how-do-i-send-a-discord-message-from-telegram-crosscontext-messaging-denied)
  - [Waarom voelt het alsof de bot snelle berichten "negeert"?](#why-does-it-feel-like-the-bot-ignores-rapidfire-messages)

## Eerste 60 seconden als er iets kapot is

1. **Snelle status (eerste check)**

   ```bash
   openclaw status
   ```

   Snelle lokale samenvatting: OS + update, bereikbaarheid van gateway/service, agents/sessies, providerconfig + runtime‑problemen (wanneer de gateway bereikbaar is).

2. **Plakbaar rapport (veilig om te delen)**

   ```bash
   openclaw status --all
   ```

   Read‑only diagnose met log‑tail (tokens gemaskeerd).

3. **Daemon + poortstatus**

   ```bash
   openclaw gateway status
   ```

   Toont supervisor‑runtime versus RPC‑bereikbaarheid, de probe‑doel‑URL en welke config de service waarschijnlijk gebruikte.

4. **Diepe probes**

   ```bash
   openclaw status --deep
   ```

   Draait gateway‑healthchecks + provider‑probes (vereist een bereikbare gateway). Zie [Health](/gateway/health).

5. **Tail de nieuwste log**

   ```bash
   openclaw logs --follow
   ```

   Als RPC down is, val terug op:

   ```bash
   tail -f "$(ls -t /tmp/openclaw/openclaw-*.log | head -1)"
   ```

   Bestandslogs staan los van servicelogs; zie [Logging](/logging) en [Problemen oplossen](/gateway/troubleshooting).

6. **Run de doctor (reparaties)**

   ```bash
   openclaw doctor
   ```

   Repareert/migreert config/state + draait healthchecks. Zie [Doctor](/gateway/doctor).

7. **Gateway‑snapshot**

   ```bash
   openclaw health --json
   openclaw health --verbose   # shows the target URL + config path on errors
   ```

   Vraagt de draaiende gateway om een volledige snapshot (alleen WS). Zie [Health](/gateway/health).

## Snelle start en eerste installatie

### Im stuck whats the fastest way to get unstuck

Gebruik een lokale AI‑agent die **je machine kan zien**. Dat is veel effectiever dan vragen
in Discord, omdat de meeste "ik zit vast"‑gevallen **lokale config‑ of omgevingsproblemen** zijn
die helpers op afstand niet kunnen inspecteren.

- **Claude Code**: [https://www.anthropic.com/claude-code/](https://www.anthropic.com/claude-code/)
- **OpenAI Codex**: [https://openai.com/codex/](https://openai.com/codex/)

Deze tools kunnen de repo lezen, opdrachten uitvoeren, logs inspecteren en helpen je
machine‑niveau setup te repareren (PATH, services, rechten, auth‑bestanden). Geef ze de
**volledige broncheckout** via de hackable (git)‑installatie:

```bash
curl -fsSL https://openclaw.ai/install.sh | bash -s -- --install-method git
```

Dit installeert OpenClaw **vanuit een git‑checkout**, zodat de agent de code + docs kan lezen en
kan redeneren over de exacte versie die je draait. Je kunt altijd later terugschakelen naar stable
door de installer opnieuw te draaien zonder `--install-method git`.

Tip: vraag de agent om de fix **te plannen en te begeleiden** (stap‑voor‑stap), en voer daarna
alleen de noodzakelijke opdrachten uit. Dat houdt wijzigingen klein en makkelijker te auditen.

Als je een echte bug of fix ontdekt, dien dan een GitHub‑issue in of stuur een PR:
[https://github.com/openclaw/openclaw/issues](https://github.com/openclaw/openclaw/issues)
[https://github.com/openclaw/openclaw/pulls](https://github.com/openclaw/openclaw/pulls)

Begin met deze opdrachten (deel uitvoer wanneer je om hulp vraagt):

```bash
openclaw status
openclaw models status
openclaw doctor
```

Wat ze doen:

- `openclaw status`: snelle snapshot van gateway/agent‑health + basisconfig.
- `openclaw models status`: controleert provider‑auth + modelbeschikbaarheid.
- `openclaw doctor`: valideert en repareert veelvoorkomende config/state‑problemen.

Andere nuttige CLI‑checks: `openclaw status --all`, `openclaw logs --follow`,
`openclaw gateway status`, `openclaw health --verbose`.

Snelle debug‑lus: [Eerste 60 seconden als er iets kapot is](#eerste-60-seconden-als-er-iets-kapot-is).
Installatiedocs: [Installeren](/install), [Installer‑flags](/install/installer), [Updaten](/install/updating).

### Wat is de aanbevolen manier om OpenClaw te installeren en in te stellen

De repo raadt lopende vanaf de bron aan en gebruik de onboarding wizard:

```bash
curl -fsSL https://openclaw.ai/install.sh github.com/bash
openclaw onboard --install-daemon
```

De wizard kan ook UI assets automatisch maken. Na onboarding runt u meestal de Gateway op poort **18789**.

Uit bron (bijdragers/dev):

```bash
git clone https://github.com/openclaw/openclaw.git
cd openclaw
pnpm install
pnpm build
pnpm ui:build # auto-installs UI deps op eerste run
openclaw onboard
```

Als je nog geen globale installatie hebt, voer deze dan uit via `pnpm openclaw onboard`.

### Hoe open ik het dashboard na onboarding

De wizard opent uw browser met een schone (niet-tokende) dashboard URL direct na onboarding en drukt ook de link in de samenvatting. Houd dat tabblad open; als het niet gestart is, kopieer/plak dan de afgedrukte URL op dezelfde machine.

### Hoe authenticeer ik het dashboard token op localhost vs remote

**Localhost (dezelfde machine):**

- Open `http://127.0.0.1:18789/`.
- Als het om authentiek vraagt, plak het token van `gateway.auth.token` (of `OPENCLAW_GATEWAY_TOKEN`) in Control UI-instellingen.
- Haal het op van de gateway host: `openclaw config get gateway.auth.token` (of genereer één: `openclaw doctor --generate-gateway-token`).

**Niet op localhost:**

- **Tailscale Serve** (aanbevolen): houd bind loopback, voer de `openclaw gateway --tailscale serve`, open `https://<magicdns>/`. Als `gateway.auth.allowTailscale` is `true`, identiteitsheaders vragen om authenticatie (geen token).
- **Tailnet bind**: voer `openclaw gateway --bind tailnet --token "<token>"`, open `http://<tailscale-ip>:18789/`, plak token in dashboard instellingen.
- **SSH tunnel**: `ssh -N -L 18789:127.0.1:18789 user@host` en open vervolgens `http://127.0.0.1:18789/` en plak de token in de Control UI-instellingen.

Zie [Dashboard](/web/dashboard) en [Weboppervlaktes](/web) voor bindmodi en autorisatiegegevens.

### Welke runtime heb ik nodig

Node **>= 22** is vereist. `pnpm` wordt aanbevolen. Bun is **niet aangeraden** voor de Gateway.

### Werkt het op de Raspberry Pi

Ja. De Gateway is lichtgewicht - docs list **512MB-1GB RAM**, **1 core**, en ongeveer **500MB**
schijf
als genoeg voor persoonlijk gebruik, en merk op dat een **Raspberry Pi 4 het kan uitvoeren**.

Als je extra hoofdkamer wilt (logs, media, andere diensten), **2GB wordt aanbevolen**, maar het is
geen moeilijk minimum.

Tip: een kleine Pi/VPS kan de Gateway hosten en je kunt **nodes** koppelen op je laptop/phone voor
lokale scherm/camera/canvas of commando-uitvoering. Zie [Nodes](/nodes).

### Alle tips voor de Raspberry Pi installeren

Korte versie: het werkt, maar verwacht ruwe randen.

- Gebruik een **64-bit** OS en bewaar node >= 22.
- Liever de **hackable (git) installaties** zodat je de logs kunt zien en snel kunt updaten.
- Begin zonder kanalen/vaardigheden, voeg ze één voor één toe.
- Als je rare binaire problemen raakt, is het meestal een **ARM compatibiliteit** probleem.

Documenten: [Linux](/platforms/linux), [Install](/install).

### Het zit vast wanneer het wakker wordt mijn vriend onboarding niet zal hatch Wat nu

Dat scherm is afhankelijk van de bereikbaarheid en authenticatie van de Gateway. De TUI stuurt ook automatisch
"Wakker, mijn vriend!" bij de eerste hoed. Als je die lijn ziet met **geen antwoord**
en tokens blijven bij 0, dan loopt de agent nooit door.

1. Herstart de Gateway:

```bash
openclaw gateway restart
```

2. Status controleren + auth:

```bash
openclaw status
openclaw modelstatus
openclaw logs --follow
```

3. Als het nog steeds hangt, uitvoeren:

```bash
openclaw doctor
```

Als de Gateway op afstand is, zorg er dan voor dat de tunnel/Tailscale verbinding omhoog is en dat de UI
wordt gewezen op de juiste Gateway. Zie [Remote access](/gateway/remote).

### Kan ik mijn installatie overzetten naar een nieuwe Mac mini machine zonder onboarding opnieuw te doen

Ja. Kopieer de **state directory** en **workspace**, en voer vervolgens doctor een keer uit. Deze
houdt je bot "exact hetzelfde" (geheugen, sessie-geschiedenis, auth, en kanaal
staat) zo lang je **beide** locaties kopieert:

1. Installeer OpenClaw op de nieuwe machine.
2. Kopieer `$OPENCLAW_STATE_DIR` (standaard: `~/.openclaw`) van de oude machine.
3. Kopieer jouw werkruimte (standaard: `~/.openclaw/workspace`).
4. Voer `openclaw doctor` uit en herstart de Gateway service.

Dat bewaart config, autorisatieprofielen, WhatsApp creds, sessies en geheugen. Als u in
externe modus bent, vergeet dan niet dat de gateway eigenaar is van de sessie-winkel en de werkruimte.

**Belangrijk:** als u alleen uw werkruimte naar GitHub verbindt/pusht, neemt u
up **geheugen + bootstrap bestanden**, maar **niet** sessiegeschiedenis of auth. Die live
onder `~/.openclaw/` (bijvoorbeeld `~/.openclaw/agents/<agentId>/sessions/`).

Opgepast: [Migrating](/install/migrating), [Waar dingen op schijf leven](/help/faq#where-does-openclaw-store-its-data),
[Agent werkruimte](/concepts/agent-workspace), [Doctor](/gateway/doctor),
[Externe modus](/gateway/remote).

### Waar zie ik wat nieuw is in de laatste versie

Check de GitHub changelog:
[https://github.com/openclaw/openclaw/blob/main/CHANGELOG.md](https://github.com/openclaw/openclaw/blob/main/CHANGELOG.md)

De nieuwste inzendingen staan bovenaan de lijst. Als de bovenste sectie is gemarkeerd met **Unreleased**, is de volgende verouderde
sectie de laatst verzonden versie. Invoer wordt gegroepeerd op **Highlights**, **Wijzigingen** en
**Vastheden** (plus docs/andere secties indien nodig).

### I cant access docs.openclaw.ai SSL error What now

Sommige Comcast/Xfinity verbindingen blokkeren ten onrechte `docs.openclaw.ai` via Xfinity
Advanced Security. Schakel het uit of sta lijst `docs.openclaw.ai`, dan opnieuw uit. Meer
detail: [Troubleshooting](/help/troubleshooting#docsopenclawai-shows-an-ssl-error-comcastxfinity).
Help ons het deblokkeren door hier te rapporteren: [https://spa.xfinity.com/check_url_status](https://spa.xfinity.com/check_url_status).

Als je de site nog steeds niet kunt bereiken, zijn de documenten gespiegeld op GitHub:
[https://github.com/openclaw/openclaw/tree/main/docs](https://github.com/openclaw/openclaw/tree/main/docs)

### Wat is het verschil tussen stabiliteit en bèta

**Stabiel** en **beta** zijn **npm dist-tags**, niet gescheiden code lijnen:

- `latest` = stabiel
- `beta` = vroeg bouwen voor testen

Wij verzenden bouwen naar **beta**, test hen, en zodra een build solide is, **promoten we
die dezelfde versie naar `latest`**. Dat is waarom beta en stabiel naar de
**dezelfde versie** kunnen wijken.

Zie wat veranderd is:
[https://github.com/openclaw/openclaw/blob/main/CHANGELOG.md](https://github.com/openclaw/openclaw/blob/main/CHANGELOG.md)

### Hoe installeer ik de beta versie en wat het verschil is tussen beta en dev

**Beta** is de npm dist-tag `beta` (kan overeenkomen met `latest`).
**Dev** is de bewegende hoofd van `main` (git); wanneer gepubliceerd, gebruikt het de npm dist-tag `dev`.

One-liners (macOS/Linux):

```bash
curl -fsSL --proto '=https' --tlsv1.2 https://openclaw.ai/install.sh Kofbash -s -- --beta
```

```bash
curl -fsSL --proto '=https' --tlsv1.2 https://openclaw.ai/install.sh Kofbash -s -- --install-method git
```

Windows installatieprogramma (PowerShell):
[https://openclaw.ai/install.ps1](https://openclaw.ai/install.ps1)

Meer detail: [Development channels](/install/development-channels) en [Installer flags](/install/installer).

### Hoe lang het installeren en onboarden gewoonlijk duurt

Ruwe handleiding:

- **Installeren:** 2-5 minuten
- **Onboarding:** 5-15 minuten afhankelijk van hoeveel kanalen/modellen u configureert

Als het hangt, gebruik dan [Installer stuck](/help/faq#installer-stuck-how-do-i-get-more-feedback)
en de snelle debug loop in [Im vast](/help/faq#im-stuck--whats-the-fastest-way-to-get-unstuck).

### Hoe probeer ik de laatste bits

Twee opties:

1. **Dev kanaal (git checkout):**

```bash
openclaw update --channel dev
```

Dit schakelt over naar de `main` branch en update vanaf de bron.

2. **Hackable install (vanaf de installatiewebsite):**

```bash
curl -fsSL https://openclaw.ai/install.sh | bash -s -- --install-method git
```

Dat geeft je een lokale repo die je kunt bewerken, en dan updaten via git.

Als je liever een schone kloon manueel gebruikt:

```bash
git clone https://github.com/openclaw/openclaw.git
cd openclaw
pnpm install
pnpm build
```

Docs: [Update](/cli/update), [Development channels](/install/development-channels),
[Install](/install).

### Installer bleef vastzitten hoe ik meer feedback krijg

Herstart het installatieprogramma met **uitgebreide uitvoer**:

```bash
curl -fsSL https://openclaw.ai/install.sh reached. bash -s -- --verbose
```

Beta installatie met verbod:

```bash
curl -fsSL https://openclaw.ai/install.sh reached. bash -s -- --beta --verbose
```

Voor een hackable (git) installatie:

```bash
curl -fsSL https://openclaw.ai/install.sh ★bash -s -- --install-method git --verbose
```

Meer opties: [Installer flags](/install/installer).

### Windows installatie zegt git niet gevonden of openclaw niet herkend

Twee algemene Windows-problemen:

**1) npm error spawn git / git niet gevonden**

- Installeer **Git voor Windows** en zorg ervoor dat `git` op je PATH staat.
- Sluit en open PowerShell opnieuw en start daarna het installatieprogramma opnieuw uit.

**2) openclaw wordt niet herkend na installatie**

- De globale map van je npm bin staat niet op PATH.

- Controleer het pad:

  ```powershell
  npm config get prefix
  ```

- Zorg ervoor dat `<prefix>\\bin` op PATH staat (op de meeste systemen is het `%AppData%\\npm`).

- Sluit en heropen PowerShell na het bijwerken van PATH.

Als u de soepelste Windows installatie wilt, gebruik dan **WSL2** in plaats van native Windows.
Documenten: [Windows](/platforms/windows).

### De documentatie gaf geen antwoord op mijn vraag hoe ik een beter antwoord krijg

Gebruik de **hackable (git) installatie** zodat je de volledige bron en docs lokaal hebt, en vraag dan
je bot (of Claude/Codex) _uit die map_ zodat het de repo en antwoord precies kan lezen.

```bash
curl -fsSL https://openclaw.ai/install.sh | bash -s -- --install-method git
```

Meer detail: [Install](/install) en [Installer flags](/install/installer).

### Hoe installeer ik OpenClaw op Linux

Kort antwoord: volg de Linux-handleiding en voer daarna de onboarding-wizard uit.

- Linux snel pad + service installeren: [Linux](/platforms/linux).
- Volledige loopbaan: [Aan de slag](/start/getting-started).
- Installer + updates: [Installeren & updates](/install/updating).

### Hoe installeer ik OpenKlauw op een VPS

Alle Linux VPS werkt. Installeer op de server en gebruik vervolgens SSH/Tailscale om de Gateway te bereiken.

Handleidingen: [exe.dev](/install/exe-dev), [Hetzner](/install/hetzner), [Fly.io](/install/fly).
Externe toegang: [Gateway remote](/gateway/remote).

### Waar zijn de cloudVPS-installatiehandleidingen

Wij houden een **hosting hub** bij met de gemeenschappelijke providers. Kies er een en volg de handleiding:

- [VPS hosting](/vps) (alle providers op één plaats)
- [Fly.io](/install/fly)
- [Hetzner](/install/hetzner)
- [exe.dev](/install/exe-dev)

Hoe het in de cloud werkt: de **Gateway draait op de server**, en u krijgt het
via uw laptop/telefoon via de Control UI (of Tailscale/SSH). Uw staat + werkruimte
live op de server, behandelt de host als de bron van de waarheid en back-up ervan.

Je kunt **nodes** (Mac/iOS/Android/headless) koppelen aan die cloud Gateway om
lokale scherm/camera/canvas te openen of commando's uit te voeren op je laptop terwijl je de
Gateway in de cloud houdt.

Hub: [Platforms](/platforms). Externe toegang: [Gateway remote](/gateway/remote).
Nodes: [Nodes](/nodes), [Nodes CLI](/cli/nodes).

### Mag ik OpenClaw vragen zichzelf te updaten

Kort antwoord: **mogelijk, niet aanbevolen**. De update-flow kan de
Gateway (welke de actieve sessie laat zien) opnieuw opstarten, kan een clean git checkout nodig hebben en
kan om bevestiging vragen. Veilig: voer updates uit vanuit een shell als de operator.

Gebruik de CLI:

```bash
openclaw update
openclaw update status
openclaw update --channel stableeable dev
openclaw update --tag <dist-tag|version>
openclaw update --no-herstart
```

Als je moet automatiseren voor een agent:

```bash
openclaw update --yes --no-herstart
openclaw gateway herstart
```

Documenten: [Update](/cli/update), [Updating](/install/updating).

### Wat doet de onboarding wizard eigenlijk

`openclaw onboard` is het aanbevolen pad in te stellen. In **lokale modus** loopt het door:

- **Model/auth setup** (Anthropic **setup-token** aanbevolen voor Claude abonnementen, OpenAI Codex OAuth ondersteund, API keys optional, LM Studio lokale modellen ondersteund)
- **Workspace** locatie + bootstrap bestanden
- **Gateway settings** (bind/port/auth/tailscale)
- **Providers** (WhatsApp, Telegram, Discord, Mattermost (plugin), Signal, iMessage)
- **Daemon installatie** (LaunchAgent op macOS; systemd user unit op Linux/WSL2)
- **Gezondheidscontrole** en **vaardigheden** selectie

Het waarschuwt ook als uw geconfigureerde model onbekend is of authentiek ontbreekt.

### Heb ik een Claude of OpenAI-abonnement nodig om dit uit te voeren

Nee. U kunt OpenClaw uitvoeren met **API keys** (Anthropic/OpenAI/anderen) of met
**lokale modellen** zodat uw gegevens op uw apparaat blijven. Abonnementen (Claude
Pro/Max of OpenAI Codex) zijn optionele manieren om deze providers te authenticeren.

Docs: [Anthropic](/providers/anthropic), [OpenAI](/providers/openai),
[Lokale modellen](/gateway/local-models), [Models](/concepts/models).

### Kan ik het Claude Max abonnement gebruiken zonder een API-sleutel

Ja. Je kunt inloggen met een **setup-token**
in plaats van een API-sleutel. Dit is het inschrijvingspad.

Claude Pro/Max abonnementen **bevatten geen API-sleutel**, dus dit is de juiste
voor abonnementsaccounts. Belangrijk: u moet met
Anthropic controleren of dit gebruik is toegestaan volgens hun abonnementsbeleid en -voorwaarden.
Als u de meest expliciete en ondersteunde weg wilt, gebruik dan een Anthropische API-sleutel.

### Hoe werkt de Anthropische setuptoken

`claude setup-token` genereert een **token string** via de Claude Code CLI (het is niet beschikbaar in de webconsole). Je kunt het uitvoeren op **elke machine**. Kies **Anthropic token (plak setup-token)** in de wizard of plak het met `openclaw models auth paste-token --provider anthropic`. De token wordt opgeslagen als een autorisatieprofiel voor de **antthropic** provider en wordt gebruikt als een API-sleutel (geen auto-vernieuwen). Meer detail: [OAuth](/concepts/oauth).

### Waar vind ik een antropische setuptoken

Het is **niet** in de Anthropische Console. De setup-token wordt gegenereerd door de **Claude Code CLI** op **elke machine**:

```bash
claude setup-token
```

Kopieer het token dat het afdrukt, kies dan **Anthropic token (plak setup-token)** in de wizard. Als u het wilt uitvoeren op de gateway host, gebruik dan `openclaw models auth-token --provider anthropic`. Als je `claude setup-token` elders hebt uitgevoerd, plak je het op de gateway host met `openclaw models auth-token --provider anthropic`. Zie [Anthropic](/providers/anthropic).

### Steunt u de passie van een Claude abonnement (lengtegraad Pro of Max)

Ja - via **setup-token**. OpenClaw hergebruikt niet langer Claude Code CLI OAuth tokens; gebruik een setup-token of een Anthropische API-sleutel. Genereer de token overal en plak deze op de gateway host. Zie [Anthropic](/providers/anthropic) en [OAuth](/concepts/oauth).

Opmerking: de toegang tot Claude subscription wordt bepaald door Anthropad. Voor productie of multi-user workloads, zijn API keys meestal de veiligste keuze.

### Waarom zie ik HTTP 429 ratelimiterror van Anthropische

Dat betekent dat jouw **Anthropische quota/tarieflimiet** uitgeput is voor het huidige venster. Als u
een **Claude abonnement** (setup-token of Claude Code OAuth) gebruikt, wacht op het venster
reset of upgrade uw abonnement. Als u een **Anthropic API key** gebruikt, controleer dan de Anthropic Console
voor gebruik en facturering en verhoog de limieten indien nodig.

Tip: stel een **fallback model** in zodat OpenClaw kan blijven antwoorden terwijl een provider beperkt is.
Zie [Models](/cli/models) en [OAuth](/concepts/oauth).

### Is AWS Bedrock ondersteund

Ja - via pi-ai's **Amazon Bedrock (Converse)** provider met **handmatige config**. U moet AWS referenties / regio opgeven op de gateway host en een Bedrock provider-invoer toevoegen in uw modelconfig. Zie [Amazon Bedrock](/providers/bedrock) en [Model providers](/providers/models). Als u liever een beheerde key flow, is een compatibele OpenAI-proxy voor Bedrock nog steeds een geldige optie.

### Hoe werkt Codex Auth

OpenClaw ondersteunt **OpenAI Code (Codex)** via OAuth (ChatGPT sign-in). De wizard kan de OAuth flow uitvoeren en zal het standaardmodel instellen op `openai-codex/gpt-5.3-codex` indien nodig. Zie [Model providers](/concepts/model-providers) en [Wizard](/start/wizard).

### Steunt u OpenAI-abonnement authauth-Codex OAuth

Ja. OpenClaw ondersteunt volledig **OpenAI Code (Codex) abonnement OAuth**. De wizard
kan de OAuth flow voor je uitvoeren.

Zie [OAuth](/concepts/oauth), [Model providers](/concepts/model-providers) en [Wizard](/start/wizard).

### Hoe stel ik Gemini CLI OAuth in

Gemini CLI gebruikt een **plugin authenticatie stroom**, geen cliënt-id of geheim in `openclaw.json`.

Stappen:

1. Activeer de plugin: `openclaw plugins mogelijk google-gemini-cli-auth`
2. Inloggen: `openclaw models auth login --provider google-gemini-cli --set-default`

Deze bewaart OAuth tokens in authprofielen op de gateway host. Gegevens: [aanbieders van modelleren](/concepts/model-providers).

### Is een lokaal model OK voor casual chats

Meestal niet. Openklauwen heeft behoefte aan grote context + sterke veiligheid; kleine kaarten snoeien en lekken. Als het nodig is, voer de **grootste** MiniMax M2.1 build uit die lokaal (LM Studio) en zie [/gateway/local-models](/gateway/local-models). Kleinere modellen/gekwantificeerde modellen verhogen het uitwerprisico - zie [Security](/gateway/security).

### Hoe houd ik modelverkeer in een bepaalde regio

Kies geregelde eindpunten. OpenRouter stelt Amerikaanse opties bloot aan MiniMax, Kimi en GLM; kies de door de VS gehoste variant om gegevens in de regio te bewaren. U kunt nog steeds Anthropic/OpenAI tonen met behulp van `models.mode: "merge"`, dus fallbacks blijven beschikbaar terwijl u de regionale provider die u selecteert respecteert.

### Moet ik een Mac Mini kopen om dit te installeren

Nee. OpenClaw draait op macOS of Linux (Windows via WSL2). Een Mac mini is optioneel - sommige mensen
kopen er een als een altijd-on host, maar een kleine VPS, thuisserver of Raspberry Pi-class box werkt ook.

Je hebt alleen een Mac nodig **voor macOS-alleen-tools**. Voor iMessage, gebruik [BlueBubbles](/channels/bluebubbles) (aanbevolen) - de BlueBubbles server draait op elke Mac, en de Gateway kan draaien op Linux of elders. Als u andere macOS-alleen tools wilt, voer de Gateway uit op een Mac of koppel een macOS-node.

Docs: [BlueBubbles](/channels/bluebubbles), [Nodes](/nodes), [Mac externe modus] (/platforms/mac/remote).

### Heb ik een Mac mini nodig voor iMessage ondersteuning

U heeft **sommige macOS-apparaat** nodig die ingelogd zijn in berichten. Het hoeft **niet** een Mac mini -
te zijn. **Use [BlueBubbles](/channels/bluebubbles)** (aanbevolen) voor iMessage - de BlueBubbles server draait op macOS, terwijl de Gateway kan draaien op Linux of elders.

Gemeenschappelijke opstellingen:

- Voer de Gateway uit op Linux/VPS, en voer de BlueBubbles server uit op elke Mac die ingelogd is in Messages.
- Voer alles uit op de Mac als je de eenvoudigste enkelvoudige machine installatie wilt.

Documenten: [BlueBubbles](/channels/bluebubbles), [Nodes](/nodes),
[Mac externe modus](/platforms/mac/remote).

### Als ik een Mac mini koop om OpenClaw uit te voeren, kan ik deze verbinden met mijn MacBook Pro

Ja. De **Mac mini kan de Gateway** runnen en uw MacBook Pro kan verbinden als een
**node** (gezellig apparaat). Nodes voeren de poort niet uit - ze bieden extra
mogelijkheden zoals scherm/camera/canvas en `system.run` op dat apparaat.

Algemeen patroon:

- Gateway op de Mac mini (altijd).
- MacBook Pro voert de macOS-app of een node host uit en paren naar de Gateway.
- Gebruik `openclaw nodes status` / `openclaw nodes list` om het te zien.

Documentatie: [Nodes](/nodes), [Nodes CLI](/cli/nodes).

### Kan ik Bun gebruiken

Bun wordt **niet aanbevolen**. We zien runtime bugs, vooral met WhatsApp en Telegram.
Gebruik **Geen** voor stabiele gateways.

Als u nog steeds met Bunde wilt experimenteren, doe het dan op een niet-productie gateway
zonder WhatsApp/Telegram.

### Telegram wat in staat is vanaf

`channels.telegram.allowFrom` is **de Telegram gebruiker ID van de menselijke afzender** (numeric, aanbevolen) of `@username`. Het is niet de bot gebruikersnaam.

Veiliger (geen bot van derden):

- DM je bot, voer dan `openclaw logs --follow` uit en lees `van.id`.

Officiële Bot API:

- DM je bot, bel dan `https://api.telegram.org/bot<bot_token>/getUpdates` en lees `message.from.id`.

Derden (minder privé):

- DM `@userinfobot` or `@getidsbot`.

Zie [/channels/telegram](/channels/telegram#access-control-dms--groups).

### Kan meerdere mensen een WhatsApp-nummer gebruiken met verschillende OpenClaw instanties

Ja, via **multi-agent routing**. Koppel elke afzender zijn WhatsApp **DM** (peer `kind: "dm", afzender E. 64 zoals `+15551234567`) tot een andere `agentId`, zodat elke persoon zijn eigen werk- en sessiewinkel krijgt. Antwoorden komen nog steeds van het **zelfde WhatsApp account**, en de DM access control (`channels.whatsapp.dmPolicy`/`channels.whatsapp.allowFrom\`) is globaal per WhatsApp account. Zie [Multi-Agent Routing](/concepts/multi-agent) en [WhatsApp](/channels/whatsapp).

### Kan ik een snelle chatagent en een Opus voor coderingsagent runnen

Ja. Gebruik multi-agent routing: geef elke agent zijn eigen standaard model, en verbind dan inkomende routes (provider-account of specifieke peers) met elke agent. Voorbeeld configuratie leeft in [Multi-Agent Routing](/concepts/multi-agent). Zie ook [Models](/concepts/models) en [Configuration](/gateway/configuration).

### Werkt Homebrew op Linux

Ja. Homebrew ondersteunt Linux (Linuxbrew). Snelle start:

```bash
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
echo 'eval "$(/home/linuxbrew/.linuxbrew/bin/brew shellenv)"' >> ~/.profile
eval "$(/home/linuxbrew/.linuxbrew/bin/brew shellenv)"
brew install <formula>
```

Als je OpenClaw via het systeem draait, zorg er dan voor dat de service PATH `/home/linuxbrew/.linuxbrew/bin` (of je brew prefix) bevat dus `brew`-geïnstalleerde tools resolve in niet-login shells.
Recente builds maken ook gebruik van algemene gebruikers bin dirs op Linux systeemservices (bijvoorbeeld `~/.local/bin`, `~/.npm-global/bin`, `~/.local/share/pnpm`, `~/. un/bin`) en eer `PNPM_HOME`, `NPM_CONFIG_PREFIX`, `BUN_INSTALL`, `VOLTA_HOME`, `ASDF_DATA_DIR`, `NVM_DIR`, en `FNM_DIR` indien ingevuld.

### Wat is het verschil tussen de hackable git installatie en npm install

- **Hackable (git) installatie:** volledig source checkout, aanpasbaar, het beste voor bijdragers.
  Je kunt lokaal builds uitvoeren en code/documenten patchen.
- **npm installeren:** global CLI install, no repo, best voor "just run it."
  Updates zijn afkomstig van npm dist-tags.

Docs: [Aan de slag](/start/getting-started), [Updating](/install/updating).

### Kan ik schakelen tussen npm en git installeert later

Ja. Installeer de andere smaken en voer Doctor dan uit zodat de gateway-servicepunten bij de nieuwe ingang.
Dit **verwijdert je gegevens niet** - het verandert alleen de OpenClaw-code installatie. Jouw staat
(`~/.openclaw`) en werkruimte (`~/.openclaw/workspace`) blijft onaangeraakt.

Van npm → git:

```bash
git clone https://github.com/openclaw/openclaw.git
cd openclaw
pnpm install
pnpm build
openclaw doctor
openclaw gateway herstart
```

Van git → npm:

```bash
npm install -g openclaw@latest
openclaw doctor
openclaw gateway herstart
```

Doctor detecteert een gateway service onjuiste punten en biedt aan om de service config te herschrijven zodat deze overeenkomt met de huidige installatie (gebruik `--repair` in automatisering).

Backup tips: zie [Backup strategy](/help/faq#whats-the-recommended-backup-strategy).

### Moet ik de Gateway uitvoeren op mijn laptop of een VPS

Kort antwoord: **als je 24/7 betrouwbaarheid wilt, gebruik dan een VPS**. Als je de
laagste frictie wilt en je ok bent met slapen/herstarten, voer het lokaal uit.

**Laptop (lokale Gateway)**

- **Pros:** geen serverkosten, directe toegang tot lokale bestanden, live browser venster.
- **Cons:** slaap/netwerk drops = verbreken de verbindingen, OS updates/reboots onderbreken, moeten wakker blijven.

**VPS / wolken**

- **Pros:** altijd een stabiel netwerk, geen laptop slaapproblemen, makkelijker te blijven draaien.
- **Cons:** draaien vaak headless (schermafbeeldingen gebruiken), externe bestandstoegang, SSH voor updates.

**OpenClaw-specifieke notitie:** WhatsApp/Telegram/Slack/Mattermost (plugin)/Discord werken prima vanuit een VPS. De enige echte uitruil is **headless browser** tegen een zichtbaar venster. Zie [Browser](/tools/browser).

**Aanbevolen standaard:** VPS als u de gateway eerder had verbroken. Lokale is geweldig wanneer je de Mac actief gebruikt en lokale bestandstoegang of UI automatisering met een zichtbare browser wil.

### Hoe belangrijk het is om OpenClaw te runnen op een toegewijde machine

Niet vereist, maar **aanbevolen voor betrouwbaarheid en isolatie**.

- **Toegewijde host (VPS/Mac mini/Pi):** altijds, minder slaap/reboot onderbrekingen, schonere permissies, makkelijker te blijven uitvoeren.
- **Shared laptop/desktop:** prima voor testen en actief gebruik, maar verwacht pauzes als de machine slaapt of update.

Als je het beste van beide werelden wilt, houd de Gateway op een speciale host en koppel uw laptop als een **node** voor lokale scherm/camera/exec tools. Zie [Nodes](/nodes).
Voor veiligheidsbegeleiding lees [Security](/gateway/security).

### Wat zijn de minimale VPS-vereisten en aanbevolen OS

Openklauwen is lichtgewicht. Voor een standaard Gateway + één chatkanaal:

- **Absolute minimum:** 1 vCPU, 1GB RAM, ~500MB schijf.
- **Aanbevolen:** 1-2 vCPU, 2GB RAM of meer voor kopkamer (logs, media, meerdere kanalen). Node tools en browser automatisering kan bron honger hebben.

OS: gebruik **Ubuntu LTS** (of een moderne Debian/Ubuntu). Het installatiepad voor Linux is daar het beste getest

Docs: [Linux](/platforms/linux), [VPS hosting](/vps).

### Kan ik OpenClaw uitvoeren in een VM en wat zijn de vereisten

Ja. Behandel een VM hetzelfde als een VPS: het moet altijd aanstaan, bereikbaar, en heb genoeg
RAM voor de Gateway en elke kanaal die u inschakelt.

Basislijn begeleiding:

- **Absolute minimum:** 1 vCPU, 1GB RAM.
- **Aanbevolen:** 2GB RAM of meer als u meerdere kanalen, browser automatisering of media tools gebruikt.
- **OS:** Ubuntu LTS of een andere moderne Debian/Ubuntu.

Als je op Windows bent, **WSL2 is de makkelijkste VM-stijl setup** en heeft het beste gereedschap
compatibiliteit. Zie [Windows](/platforms/windows), [VPS hosting](/vps).
Als je macOS gebruikt in een VM, zie dan [macOS VM](/install/macos-vm).

## Wat is OpenClaw?

### Wat is Openklauwen in één alinea

OpenClaw is een persoonlijke AI-assistent die je op je eigen apparaten runt. Het reageert op de messaging surfaces die je al gebruikt (WhatsApp, Telegram, Slack, Mattermost (plugin), Discord, Google Chat, Signal, iMessage, WebChat) en kan ook stemmen + een live Canvas op ondersteunde platformen doen. De **Gateway** is het altijd-on control plan; de assistent is het product.

### Wat is het voorstel voor een waarde

OpenClaw is niet alleen maar een Claude wrapper. Het is een **lokal-first control plane** waarmee u een
die in staat stelt een assistent te draaien op **uw eigen hardware**, bereikbaar in de chat apps die u al gebruikt met
statelijke sessies, geheugen en tools - zonder controle over je workflows naar een gehoste
SaaS.

Hoogtepunten:

- **Uw apparaten, uw gegevens:** voeren Gateway uit waar u wilt (Mac, Linux, VPS) en behouden de
  werkruimte + sessiegeschiedenis lokaal.
- **Echte kanalen, geen web sandbox:** WhatsApp/Telegram/Slack/Discord/Signal/iMessage/etc,
  plus mobiele stem en Canvas op ondersteunde platformen.
- **Model-agnostic:** gebruikt Anthropic, OpenAI, MiniMax, OpenRouter, enz., met per-agent routing
  en mislukken.
- **Lokale optie:** gebruikt lokale modellen, zodat **alle gegevens op jouw apparaat kunnen blijven** als je dat wilt.
- **Multi-agent routing:** afzonderlijke agents per kanaal, account, of taak, elk met zijn eigen
  werkruimte en standaarden.
- **Open source en hackable:** inspecteren, uitbreiden en zelf host zonder leverancierslock-in.

Docs: [Gateway](/gateway), [Channels](/channels), [Multi-agent](/concepts/multi-agent),
[Memory](/concepts/memory).

### Ik heb het net opgezet wat ik eerst moet doen

Goede eerste projecten:

- Bouw een website (WordPress, Shopify, of een eenvoudige statische site).
- Prototype een mobiele app (omlijnd, schermen, API-abonnement).
- Bestanden en mappen organiseren (opruimen, namen, taggen).
- Verbind Gmail en automatiseer samenvattingen of opvolgingen.

Het kan grote taken verwerken, maar het werkt het beste wanneer je ze opsplitst in fases en
gebruik subagenten voor parallelle werkzaamheden.

### Wat zijn de vijf meest dagelijkse gebruiksgevallen voor OpenClaw

Elke dag wint er meestal zo uit:

- **Persoonlijke briefingen:** samenvattingen van inbox, kalender en nieuws waar je om geeft.
- **Onderzoek en opstellen:** snel onderzoek, samenvattingen en eerste ontwerpen voor e-mails of documenten.
- **Herinneringen en opvolgingen:** cron of heartbeat gejaagde prikkels en checklisten.
- **Browser automatisering:** invulformulieren, verzamelen van gegevens en herhalende webtaken.
- **Cross device coördination:** stuur een taak vanaf je telefoon, laat de Gateway het op een server uitvoeren en krijg de resultaten weer in de chat.

### Kan OpenClaw helpen met lead gen outreach advertenties en blogs voor een SaaS

Ja voor **onderzoek, kwalificatie en opstellen**. Het kan websites scannen, shortlists,
samenvattingsmogelijkheden maken en outreach of concepten voor advertentie kopiëren schrijven.

Voor **outreach of ad runs**, houd een mens in de lus. Vermijd spam, volg de lokale wetgeving en het
platform beleid en bekijk iets voordat het wordt verzonden. Het veiligste patroon is
OpenKlauw ontwerp te laten maken en u goedkeurt.

Documenten: [Security](/gateway/security).

### Wat zijn de voordelen ten opzichte van Claude Code voor webontwikkeling?

OpenClaw is een **persoonlijke assistent** en coördinatielaag, niet een IDE-vervanging. Gebruik
Claude Code of Codex voor de snelste directe coderingslus in een repo. Use OpenClaw when you
want durable memory, cross-device access, and tool orchestration.

Voordelen:

- **Persistent geheugen + workspace** tussen sessies
- **Multi-platform toegang** (WhatsApp, Telegram, TUI, WebChat)
- **Gereedschap orchestratie** (browser, bestanden, plannen, hooks)
- **Always-on Gateway** (wordt uitgevoerd op een VPS, interactie overal aanwezig)
- **Nodes** voor lokale browser/scherm / camera/exec

Showcase: [https://openclaw.ai/showcase](https://openclaw.ai/showcase)

## Vaardigheden en automatisering

### Hoe pas ik vaardigheden aan zonder de repo vies te houden

Gebruik beheerde overrides in plaats van repo kopiëren. Zet je wijzigingen in `~/.openclaw/vaardigheden/<name>/SKILL.md` (of voeg een map toe via `skills.load.extraDirs` in `~/.openclaw/openclaw.json`). Precedence is `<workspace>/vaardigheden` > `~/.openclaw/vaardigheden` > gebundeld, dus beheerde overrides zonder Git aan te raken. Alleen upstream-waardige bewerkingen moeten in de repo wonen en erbuiten gaan als PR.

### Kan ik de vaardigheden van een eigen map laden

Ja. Voeg extra mappen toe via `skills.load.extraDirs` in `~/.openclaw/openclaw.json` (laagste precedent). Standaard voorrang resterend: `<workspace>/vaardigheden` → `~/.openclaw/vaardigheden` → gebundeld → `vaardighedens.load.extraDirs`. `clawhub` installeert standaard in `./vaardigheden`, welke OpenClaw behandelt als `<workspace>/vaardigheden`.

### Hoe kan ik verschillende modellen gebruiken voor verschillende taken

Vandaag zijn de ondersteunde patronen zijn:

- **Cron jobs**: geïsoleerde jobs kunnen een `model` override per job instellen.
- **Sub-agents**: route taken naar aparte agenten met verschillende standaardmodellen.
- **On-demand wissel**: gebruik `/model` om op elk moment het huidige sessie model te veranderen.

Zie [Cron jobs](/automation/cron-jobs), [Multi-Agent Routing](/concepts/multi-agent) en [Slash commands](/tools/slash-commands).

### De bot bevriest tijdens zwaar werk Hoe kan ik dat deladen

Gebruik **sub-agents** voor lange of parallelle taken. Sub-agenten worden uitgevoerd in hun eigen sessie,
geeft een samenvatting en houd uw hoofdchat responsief.

Vraag je bot om "een sub-agent voor deze taak te spawnen" of `/subagents` te gebruiken.
Gebruik `/status` in de chat om te zien wat de Gateway nu doet (en of het bezet is).

Token tip: lange taken en sub-agenten verbruiken beide tokens. Stel een
goedkoper model in voor sub-agenten via `agents.defaults.subagents.model`.

Documenten: [Sub-agents](/tools/subagents).

### Cron of herinneringen vuren niet af wat ik moet controleren

Cron draait binnen het Gateway proces. Als de Gateway niet continu draait,
geplande taken worden niet uitgevoerd.

Checklist:

- Bevestig dat cron is ingeschakeld (`cron.enabled`) en `OPENCLAW_SKIP_CRON` niet is ingesteld.
- Controleer of de Gateway 24/7 draait (geen slaap/restarts).
- Verifieer de tijdzone instellingen voor de job (`--tz` vs host timezone).

Debug:

```bash
openclaw cron run <jobId> --force
openclaw cron draait --id <jobId> --limit 50
```

Docs: [Cron jobs](/automation/cron-jobs), [Cron vs Heartbeat](/automation/cron-vs-heartbeat).

### Hoe installeer ik vaardigheden op Linux

Gebruik **ClawHub** (CLI) of laat vaardigheden vallen in je werkruimte. De macOS-Skills UI is niet beschikbaar op Linux.
Blader door vaardigheden van [https://clawhub.com](https://clawhub.com).

Installeer de ClawHub CLI (Kies één pakket manager):

```bash
npm i -g clawhub
```

```bash
pnpm add -g clawhub
```

### Kan OpenClaw taken uitvoeren op een schema of continu op de achtergrond

Ja. Gebruik de Gateway scheduler:

- **Cron jobs** voor geplande of terugkerende taken (aanhouden bij herstarten).
- **Heartbeat** voor "hoofd sessie" periodieke controles.
- **Geïsoleerde banen** voor autonome agenten die samenvattingen posten of uitleveren aan chats.

Docs: [Cron jobs](/automation/cron-jobs), [Cron vs Heartbeat](/automation/cron-vs-heartbeat),
[Heartbeat](/gateway/heartbeat).

### Kan ik Apple macOS-vaardigheden uitvoeren vanuit Linux?

Niet rechtstreeks. macOS vaardigheden zijn gediend door `metadata.openclaw.os` plus vereiste binarissen, en vaardigheden verschijnen alleen in het systeem prompt wanneer ze in aanmerking komen voor de **Gateway host**. In Linux, `darwin`-only vaardigheden (zoals `apple-notes`, `apple-reminders`, `things-mac`) zal niet laden tenzij je de gating overschrijft.

Je hebt drie ondersteunde patronen:

\*\*Optie A - draai de Gateway op een Mac (eenvoudig). \*
Voer de Gateway uit waar de macOS-binaries bestaan, en maak vervolgens verbinding met Linux in [externe modus] (#how-do-i-run-openclaw-in-remote-mode-client-connects-to-a-gateway-elsewhere) of over Tailschaal. De vaardigheden worden normaal geladen omdat de Gateway host macOS is.

\*\*Optie B - gebruik een macOS-node (geen SSH). \*
Voer de Gateway uit op Linux, geef een macOS-node (menubar app), en zet **Node Run Commando** op "Altijd Ask" of "Altijd toestaan" op de Mac. Openklauw kan macOS-exclusieve vaardigheden als in aanmerking komen wanneer de vereiste binaries bestaan op de node. De agent gebruikt deze vaardigheden via de `nodes` tool. Als je "Altijd Ask" kiest en "Altijd toestaan" in de prompt deze opdracht toevoegt aan de lijst met allowres.

\*\*Optie C - proxy macOS binaries over SSH (geavanceerd). \*
Houd de Gateway op Linux, maar maak de vereiste CLI binaries op SSH wrappers die op een Mac worden uitgevoerd. Overschrijft vervolgens de vaardigheid om Linux toe te staan, zodat het subsidieerbaar blijft.

1. Maak een SSH wrapper voor de binary (voorbeeld: `memo` voor Apple Notes):

   ```bash
   #!/usr/bin/env bash
   set -euo pipefail
   exec ssh -T user@mac-host /opt/homebrew/bin/memo "$@"
   ```

2. Plaats het wrapper op `PATH` op de Linux-host (bijvoorbeeld `~/bin/memo`).

3. Overschrijf de vaardigheden metadata (werkruimte of `~/.openclaw/vaardigheden`) om Linux toe te staan:

   ```markdown
   ---
   naam: apple-notes
   omschrijving: Beheer Apple Notes via de memo CLI op macOS.
   metadata: { "openclaw": { "os": ["darwin", "linux"], "vereist": { "bins": ["memo"] }
   ---
   ```

4. Start een nieuwe sessie zodat de vaardigheden momentopname vernieuwt.

### Heb je een Notion of HeyGen integratie

Niet ingebouwd vandaag.

Opties:

- **Aangepaste vaardigheid / plugin:** beste voor betrouwbare API toegang (Notion/HeyGen beide hebben API's).
- **Browser automatisering:** werkt zonder code, maar is langzamer en kwetsbaarder.

Als u de context per client wilt behouden (agency workflows), is er een eenvoudig patroon is:

- Eén kennisgevingspagina per klant (context + voorkeuren + actief werk).
- Vraag de agent om die pagina op te halen aan het begin van een sessie.

Als je een native integratie wilt, open dan een feature verzoek of bouw een vaardigheid
gericht op die API's.

Installeer vaardigheden:

```bash
clawhub installatie <skill-slug>
clawhub update --all
```

ClawHub installeert in `. vaardigheden onder uw huidige map (of val terug naar uw geconfigureerde OpenJuridische Werkruimte); OpenClaw behandelt dat als `<workspace>/vaardigheden`tijdens de volgende sessie. Voor gedeelde vaardigheden tussen agents, plaats ze in`~/.openclaw/vaardigheden/<name>/SKILL.md\`. Sommige vaardigheden verwachten binaries geïnstalleerd via Homebrew; op Linux wat betekent Linuxbrew (Zie de Homebrew Linux FAQ invoer hierboven). Zie [Skills](/tools/skills) en [ClawHub](/tools/clawhub).

### Hoe installeer ik de Chrome extensie voor browser overname

Gebruik het ingebouwde installatieprogramma en laad daarna de uitgepakte extensie in Chrome:

```bash
openclaw browser extension install
openclaw browser extension path
```

Vervolgens Chrome → `chrome://extensions` → "Ontwikkelaarsmodus" → "Laad uitgepakt" → kies die map.

Volledige handleiding (inclusief externe Gateway + beveiligingsnotities): [Chrome extension](/tools/chrome-extension)

Als de Gateway op dezelfde machine als Chrome draait (standaard instelling), heb je meestal **niet** extra nodig.
Als de Gateway elders draait, start dan een node-host op de browsermachine zodat de Gateway browseracties kan proxieën.
U moet nog steeds op de extensie knop klikken op het tabblad dat u wilt besturen (het is niet automatisch toevoegen).

## Sandboxen en geheugen

### Is er een toegewijde sandboxing doc

Ja. Zie [Sandboxing](/gateway/sandboxing). Voor Docker-specifieke setup (volledige gateway in Docker of sandbox-afbeeldingen), zie [Docker](/install/docker).

### Docker voelt zich beperkt hoe ik volledige functies kan inschakelen

The default image is security-first and runs as the `node` user, so it does not
include system packages, Homebrew, or bundled browsers. Voor een vollere setup:

- Houd `/home/node` aan met `OPENCLAW_HOME_VOLUME` zodat caches overleven.
- Bake systeem dekt in de afbeelding met `OPENCLAW_DOCKER_APT_PACKAGES`.
- Installeer Playwright browsers via de gebundelde CLI:
  `node /app/node_modules/playwright-core/cli.js install chromium`
- Zet `PLAYWRIGHT_BROWSERS_PATH` en zorg ervoor dat het pad aanhoudt.

Documenten: [Docker](/install/docker), [Browser](/tools/browser).

**Kan ik DMs persoonlijk houden, maar maak publieke sandboxed met één agent**

Ja - als uw privé-verkeer **DMs** is en uw openbaar verkeer **groepen** is.

Gebruik `agents.defaults.sandbox.mode: "niet-main"` dus groep/kanaal sessies (niet-hoofdsleutels) worden in Docker uitgevoerd, terwijl de belangrijkste DM sessie op host blijft. Beperk vervolgens welke tools er beschikbaar zijn in sandboxed sessies via `tools.sandbox.tools`.

Setup uitleg + voorbeeld configuratie: [Groups: persoonlijke DMs + openbare groepen](/channels/groups#pattern-personal-dms-public-groups-single-agent)

Sleutelconfiguratie referentie: [Gateway configuratie](/gateway/configuration#agentsdefaultssandbox)

### Hoe koppel ik een host-map in de sandbox

Zet `agents.defaults.sandbox.docker.binds` naar `["host:path:mode"]` (bijv. `"/home/user/src:/src:ro"`). Globale + per-agent bindt samengevoegd; per-agent binds worden genegeerd wanneer `scope: "Gedeeld"`. Gebruik `:ro` voor alles wat gevoelig ligt en onthoud bindingen die de sandbox filewalls omzeilen. Zie [Sandboxing](/gateway/sandboxing#custom-bind-mounts) en [Sandbox vs Tool Policy vs Elevated](/gateway/sandbox-vs-tool-policy-vs-elevated#bind-mounts-security-quick-check) voor voorbeelden en veiligheidsnotities.

### Hoe werkt geheugengeheugen

OpenKlauw geheugen is gewoon Markdown bestanden in de medewerkerworkspace:

- Dagelijkse notities in `memory/YY-MM-DD.md`
- Gebogen langetermijnnotities in `MEMORY.md` (alleen hoofd/privésessies)

OpenClaw voert ook een **stille pre-compactie geheugenflush** uit om het model
eraan te herinneren om duurzame notities te schrijven voordat auto-compactie wordt uitgevoerd. Dit werkt alleen wanneer de werkruimte
beschrijfbaar is (alleen-lezen sandboxen overslaan het). Zie [Memory](/concepts/memory).

### Geheugen blijft dingen vergeten hoe ik het stok maak

Vraag de bot om het feit **naar het geheugen te schrijven**. Lange tijd notities horen in `MEMORY.md`,
korte termijn context gaat in `memory/YYYY-MM-D.md`.

Dit is een terrein waarop we nog steeds vooruitgang boeken. Het helpt het model eraan te herinneren om herinneringen op te slaan;
het zal weten wat te doen. Als het blijft vergeten, controleer dan dat de Gateway dezelfde
werkruimte gebruikt bij elke uitvoering.

Docs: [Memory](/concepts/memory), [Agent werkruimte](/concepts/agent-workspace).

### Vereist semantische zoekopdrachten voor een OpenAI API-sleutel

Alleen als je **OpenAI embedds** gebruikt. Codex OAuth dekt chat/aanvullingen en
geeft **geen** toegang tot insluitingen dus **inloggen met Codex (OAuth of de
Codex CLI login** helpt niet bij het zoeken naar semantische geheugen. OpenAI ingesloten
heeft nog steeds een echte API key nodig (`OPENAI_KEY` of `models.providers.openai.apiKey`).

Als je een provider niet expliciet instelt, selecteert OpenClaw automatisch een provider wanneer deze
een API-sleutel kan oplossen (auth-profielen, `models.providers.*.apiKey`, of env vars).
Het geeft de voorkeur aan OpenAI als een OpenAI sleutel oplost, anders Gemini als een Gemini key
oplost. Als geen van beide sleutel beschikbaar is, blijft het zoeken naar geheugen uitgeschakeld totdat u
configureert. If you have a local model path configured and present, OpenClaw
prefers `local`.

Als u lokaal blijft, zet `memorySearch.provider = "local"` (en optioneel
`memorySearch.fallback = "geen"). Als u Gemini wilt embedden, zet dan
`memorySearch.provider = "gemini"`en geef`GEMINI_API_KEY`(of`memorySearch.remote.apiKey\`). Wij ondersteunen **OpenAI, Gemini of local** inbedding
modellen - zie [Memory](/concepts/memory) voor de setup details.

### Houdt geheugen voor altijd wat de grenzen zijn

Geheugenbestanden blijven live op schijf staan totdat u ze verwijdert. De limiet is je
opslag, niet het model. De **sessie context** is nog steeds beperkt door het model
context venster, zodat lange gesprekken kunnen compacteren of truncate. Daarom bestaat
geheugen zoeken - het haalt alleen de relevante onderdelen terug naar de context.

Documenten: [Memory](/concepts/memory), [Context](/concepts/context).

## Waar dingen op de schijf leven

### Is alle data gebruikt met OpenClaw lokaal opgeslagen

Nee - **OpenCA's staat is lokaal**, maar **externe diensten zien nog steeds wat je verstuurt**.

- \*\*Standaard lokale sessies, geheugenbestanden, config, en workspace live op de Gateway host
  (`~/.openclaw` + je workspace directory).
- **Afstandsbediening noodzakelijk:** berichten die je naar modelleveranciers stuurt (Anthropic/OpenAI/etc.) ga naar
  hun API's en chat platforms (WhatsApp/Telegram/Slack/etc.) sla berichtgegevens op op hun
  servers.
- **Je bepaalt de voetafdruk:** met behulp van lokale modellen houdt prompts op je machine bij, maar kanaal
  verkeer loopt nog steeds door de servers van het kanaal.

Relateerd: [Agent workspace](/concepts/agent-workspace), [Memory](/concepts/memory).

### Waar bewaart OpenClaw zijn gegevens

Alles leeft onder `$OPENCLAW_STATE_DIR` (standaard: `~/.openclaw`):

| Pad                                                             | Doel                                                                                             |
| --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `$OPENCLAW_STATE_DIR/openclaw.json`                             | Hoofd configuratie (JSON5)                                                    |
| `$OPENCLAW_STATE_DIR/credentials/oauth.json`                    | Oudere OAuth import (gekopieerd naar autorisatieprofielen bij eerste gebruik) |
| `$OPENCLAW_STATE_DIR/agents/<agentId>/agent/auth-profiles.json` | Auth profielen (OAuth + API-sleutels)                                         |
| `$OPENCLAW_STATE_DIR/agents/<agentId>/agent/auth.json`          | Runtime auth-cache (automatisch beheerd)                                      |
| `$OPENCLAW_STATE_DIR/credentials/`                              | Provider state (bijv. `whatsapp/<accountId>/creds.json`)      |
| `$OPENCLAW_STATE_DIR/agents/`                                   | Status per agent (agentDir + sessies)                                         |
| `$OPENCLAW_STATE_DIR/agents/<agentId>/sessions/`                | Gespreksgeschiedenis & status (per agent)                 |
| `$OPENCLAW_STATE_DIR/agents/<agentId>/sessions/sessions.json`   | Sessie metagegevens (per agent)                                               |

Legacy single-agent pad: `~/.openclaw/agent/*` (gemigreerd door `openclaw doctor`).

Uw **werkruimte** (AGENTS.md, geheugenbestanden, vaardigheden etc.) is gescheiden en geconfigureerd via `agents.defaults.workspace` (standaard: `~/.openclaw/workspace`).

### Waar moet AGENTSmd SOULmd USERmd MEMORYmd live

Deze bestanden wonen in de **agent workspace**, niet `~/.openclaw`.

- **Workspace (per agent)**: `AGENTS.md`, `SOUL.md`, `IDENTITY.md`, `USER.md`,
  `MEMORY.md` (of `memory.md`), `memory/YYYY-MM-D.md`, vrijwillig `HEARTBEAT.md`.
- **State dir (`~/.openclaw`)**: config, referenties, authprofielen, sessies, logs
  en gedeelde vaardigheden (`~/.openclaw/vaardigheden`).

Standaard werkruimte is `~/.openclaw/workspace`, configureerbaar via:

```json5
{
  agents: { defaults: { workspace: "~/.openclaw/workspace" } },
}
```

Als de bot "vergeten" na een herstart, bevestig dat de Gateway dezelfde
werkruimte gebruikt bij elke start (en onthoud: externe modus gebruikt de **gateway hosts**
werkruimte, niet je lokale laptop).

Tip: if you want a durable behavior or preference, ask the bot to **write it into
AGENTS.md or MEMORY.md** rather than relying on chat history.

Zie [Agent werkruimte](/concepts/agent-workspace) en [Memory](/concepts/memory).

### Wat is de aanbevolen back-upstrategie

Zet je **agent workspace** in een **privé** git repo en maak een backup ergens
privé (bijvoorbeeld GitHub private). Hiermee neemt u geheugen op + AGENTS/SOUL/GEBRUIK
bestanden, en kunt u de "mind" van de assistent later herstellen.

Doe **niet** iets onder `~/.openclaw` (referenties, sessies, tokens).
Als u een volledige herstel nodig heeft, maakt u afzonderlijk een reservekopie van zowel de werkruimte als de staatmap
(zie bovenstaande migratiekoptie).

Documenten: [Agent workspace](/concepts/agent-workspace).

### Hoe kan ik OpenCAD volledig deïnstalleren

Zie de toegewijde handleiding: [Uninstall](/install/uninstall).

### Kan agenten werken buiten de werkruimte

Ja. De werkruimte is de **standaard cwd** en geheugenanker, geen harde sandbox.
Relatieve paden oplossen binnen de werkruimte, maar absolute paden hebben toegang tot andere
host locaties, tenzij sandboxing is ingeschakeld. Als je je isolatie nodig hebt, gebruik dan
[`agents.defaults.sandbox`](/gateway/sandboxing) of sandbox-instellingen. Als u
wilt dat een repo de standaard werkmap is, richt dan die agent 's
`workspace` naar de repo root. De OpenClaw repo is gewoon broncode; houd de
werkruimte gescheiden, tenzij je er bewust in wilt werken.

Voorbeeld (repo als standaard cwd):

```json5
{
  agents: {
    defaults: {
      workspace: "~/Projects/my-repo",
    },
  },
}
```

### Ik ben in externe modus waar de sessie-winkel aanwezig is

Sessie status is eigendom van de **gateway host**. Als je in externe modus bent, is de sessie-winkel waar je aan geeft, niet je lokale laptop. Zie [Sessie beheer](/concepts/session).

## Basisinstellingen configureren

### Welk formaat is de configuratie waar het is

OpenClaw leest een optionele **JSON5** configuratie van `$OPENCLAW_CONFIG_PATH` (standaard: `~/.openclaw/openclaw.json`):

```
$OPENCLAW_CONFIG_PATH
```

Als het bestand ontbreekt, gebruikt het safe-ish standaarden (inclusief een standaard werkruimte van `~/.openclaw/workspace`).

### Ik stel gatewaybind of tailnet in en niets luistert nu naar de UI zegt ongeautoriseerd

Non-loopback binds **vereist authentiek nodig**. Configureer `gateway.auth.mode` + `gateway.auth.token` (of gebruik `OPENCLAW_GATEWAY_TOKEN`).

```json5
{
  gateway: {
    bind: "lan",
    auth: {
      modus: "token",
      token: "replace-me",
    },
  },
}
```

Notities:

- `gateway.remote.token` is alleen voor **remote CLI calls** ; het maakt geen lokale gateway auth.
- De Control UI authenticeert via `connect.params.auth.token` (opgeslagen in app/UI instellingen). Vermijd het plaatsen van tokens in URL's.

### Waarom heb ik nu een token nodig op localhost

De wizard genereert standaard een gateway token (zelfs bij loopback) zodat **lokale WS cliënten zich moeten authenticeren**. Dit blokkeert andere lokale processen door het aanroepen van de Gateway. Plak het token in de Control UI-instellingen (of uw client config) om verbinding te maken.

Als je **echt** de open loop terug wilt, verwijder dan `gateway.auth` uit je config. Doctor kan altijd een token voor u genereren: `openclaw doctor --generate-gateway-token`.

### Moet ik herstarten na het wijzigen van configuratie

De Gateway kijkt naar de config en ondersteunt hot-reload:

- `gateway.reload.mode: "hybrid"` (standaard): hot-apply veilige veranderingen, herstart voor kritieke veranderingen
- `hot`, `restart`, `off` zijn ook ondersteund

### Hoe schakel ik webzoeken en webophalen in

`web_fetch` werkt zonder een API-sleutel. `web_search` vereist een Brave Search API
sleutel. **Aanbevolen:** Voer `openclaw configureren --section web` uit om het op te slaan in
`tools.web.search.apiKey`. alternatief: zet `BRAVE_API_KEY` voor het
Gateway proces.

```json5
{
  tools: {
    web: {
      search: {
        enabled: true,
        apiKey: "BRAVE_API_KEY_HERE",
        maxResultaten: 5,
      },
      Ophalen: {
        enabled: true,
      },
    },
  },
}
```

Notities:

- Als u allowlists gebruikt, voeg dan `web_search`/`web_fetch` of `group:web` toe.
- `web_fetch` is standaard ingeschakeld (tenzij expliciet uitgeschakeld).
- Daemons lezen env vars van `~/.openclaw/.env` (of de service omgeving).

Documentatie: [Web tools](/tools/web).

### Hoe beheer ik een centrale Gateway met gespecialiseerde werkers op verschillende apparaten

Het gebruikelijke patroon is **één Gateway** (bijv. Raspberry Pi) plus **nodes** en **agents**:

- **Gateway (central):** heeft kanaal (Signal/WhatsApp), routering en sessies.
- **Nodes (apparaten):** Macs/iOS/Android verbinden als randapparatuur en laten lokale hulpmiddelen (`system.run`, `canvas`, `camera`).
- **Agents (werknemers):** scheiden hersen/werkruimtes voor speciale rollen (bijv. "Hetzner ops", "Persoonlijke gegevens").
- **Sub-agents:** spawn achtergrondwerk van een hoofdagent wanneer je parallellie wilt.
- **TUI:** verbind met de Gateway en wissel agents/sessies.

Docs: [Nodes](/nodes), [Externe toegang](/gateway/remote), [Multi-Agent Uitgang](/concepts/multi-agent), [Sub-agents](/tools/subagents), [TUI](/web/tui).

### Kan de OpenClaw browser headless werken

Ja. Het is een configuratieoptie:

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

Standaard is `false` (headful). Headless zal waarschijnlijker anti-bot controles op sommige sites veroorzaken. Zie [Browser](/tools/browser).

Headless gebruikt de **dezelfde Chromium engine** en werkt voor de meeste automatisering (formulieren, klikken, scraping, aanmelden). De belangrijkste verschillen:

- Geen zichtbaar browservenster (gebruik screenshots als u visueel nodig hebt).
- Sommige sites zijn strenger over automatisering in headless mode (CAPTCHAs, anti-bot).
  Bijvoorbeeld, X/Twitter blokkeert vaak headless sessions.

### Hoe gebruik ik Brave voor browserbeheer

Stel `browser.executablePath` in op je Brave binary (of een Chromiumgebaseerde browser) en herstart de Gateway.
Bekijk de volledige configuratievoorbeelden in [Browser](/tools/browser#use-brave-or-another-chromium-based-browser).

## Externe gateways en knooppunten

### Hoe opdrachten propageren tussen Telegram de gateway en nodes

Telegram-berichten worden behandeld door de **gateway**. De gateway voert de agent en
alleen dan nodes uit over de **Gateway WebSocket** wanneer een node tool nodig is:

Telegram → Gateway → Agent → `node.*` → node → Gateway → Telegram

Nodes zien geen inkomende providerverkeer, ze ontvangen alleen node RPC oproepen.

### Hoe kan mijn agent toegang krijgen tot mijn computer als de Gateway op afstand wordt gehost

Kort antwoord: **Koppel uw computer als een knooppunt**. De Gateway loopt elders, maar het kan
Hulpmiddelen (scherm, camera, systeem) op uw lokale machine aanroepen via de Gateway WebSocket.

Typische setup:

1. Voer de Gateway uit op de altijd host (VPS/home server).
2. Zet de Gateway host + uw computer op hetzelfde kletter.
3. Zorg ervoor dat de Gateway WS bereikbaar is (tailnet verbinding of SSH tunnel).
4. Open de macOS-app lokaal en verbind met **Externe via SSH** modus (of direct tailnet)
   zodat het kan registreren als een node.
5. Goedkeuren van het knooppunt op de poort:

   ```bash
   openclaw nodes pending
   openclaw nodes approve <requestId>
   ```

Er is geen aparte TCP-bridge nodig; nodes verbinden over de Gateway WebSocket.

Beveiligingsherinnering: het koppelen van een macOS node staat `system.run` toe op die machine. Alleen
apparaten die u vertrouwt, en review [Security](/gateway/security).

Docs: [Nodes](/nodes), [Gateway protocol](/gateway/protocol), [macOS remote mode] (/platforms/mac/remote), [Security](/gateway/security).

### Tailscale is verbonden maar ik krijg geen antwoorden in wat nu

Controleer de basiss:

- Gateway wordt uitgevoerd: `openclaw gateway status`
- Gateway gezondheid: `openclaw status`
- Kanaal gezondheid: `openclaw channels status`

Verifieer vervolgens de authenticatie en routing:

- Als u Tailscale Serve gebruikt, zorg ervoor dat `gateway.auth.allowTailscale` correct is ingesteld.
- Als u verbinding maakt met de SSH-tunnel, bevestig dan dat de tunnel omhoog is en punten in de juiste poort.
- Bevestig uw toegestane lijsten (DM of groep) inclusief uw account.

Docs: [Tailscale](/gateway/tailscale), [Externe toegang](/gateway/remote), [Channels](/channels).

### Kan twee OpenClaw-instanties met elkaar praten, lokale VPS

Ja. Er is geen ingebouwde "bot-to-bot" bridge, maar je kunt het op een paar
betrouwbare manieren draagen:

**Eenvoudig:** gebruikt een normaal chatkanaal waar beide bots toegang hebben (Telegram/Slack/WhatsApp).
Laat Bot A een bericht sturen naar Bot B, en laat Bot B antwoord zoals gebruikelijk.

**CLI bridge (algemeen):** voeren een script uit dat de andere Gateway met
`openclaw agent --message ... --deliver`, gericht op een chat waar de andere bot
naar luistert. Als één bot op een externe VPS staat, richt dan naar uw CLI op die externe Gateway
via SSH/Tailscale (zie [Remote access](/gateway/remote)).

Voorbeeld patroon (uitgevoerd vanuit een machine die de doel Gateway kan bereiken):

```bash
openclaw agent --message "Hello from local bot" --deliver --channel telegram --reply-to <chat-id>
```

Tip: voeg een bewakings-regel toe zodat de twee bots niet eindeloos herhalen (enkel vermeld, kanaal
allowlists, of een "Niet antwoorden op bot berichten" regel).

Docs: [Externe toegang](/gateway/remote), [Agent CLI](/cli/agent), [Agent send](/tools/agent-send).

### Heb ik aparte VPSes nodig voor meerdere agenten

Nee. Een Gateway kan meerdere agenten hosten, elk met zijn eigen werkruimte, modelstandaarden,
en routering. Dat is de normale setup en het is veel goedkoper en eenvoudiger dan
één VPS per agent uitvoeren.

Gebruik aparte VPSes alleen wanneer je een harde isolatie (veiligheidsgrenzen) of heel
verschillende configuraties nodig hebt die je niet wilt delen. Anders houd één Gateway en
gebruik meerdere agenten of sub-agents.

### Is er een voordeel voor het gebruiken van een node op mijn persoonlijke laptop in plaats van SSH van een VPS

Ja - knooppunten zijn de eersteklas manier om je laptop te bereiken vanaf een externe gateway, en ze
ontgrendelen meer dan shell toegang. De Gateway draait op macOS/Linux (Windows via WSL2) en is
licht gewicht (een kleine VPS of Raspberry Pi-class box is prima; 4 GB RAM is overvloed, dus een gemeenschappelijke
instelling is een altijd actieve host plus uw laptop als node.

- **Er is geen inkomende SSH nodig.** Nodes verbinden met de Gateway WebSocket en gebruiken de toestelpairing.
- **Safer executie controles.** `system.run` is gegated by node laat lists/approvals toe op die laptop.
- **Meer apparaattools.** Nodes legt `canvas`, `camera`, en `screen` bloot aan `system.run`.
- \*\*Lokale browser automatisering. \* Houd de Gateway op een VPS, maar gebruik Chrome lokaal en relay controle
  met de Chrome extensie + een node host op de laptop.

SSH is prima voor ad-hocshell-toegang, maar nodes zijn eenvoudiger voor lopende agent workflows en
apparaat automatisering.

Docs: [Nodes](/nodes), [Nodes CLI](/cli/nodes), [Chrome extension](/tools/chrome-extension).

### Moet ik installeren op een tweede laptop of gewoon een node toevoegen

Als je alleen **lokale gereedschappen** (scherm/camera/exec) nodig hebt op de tweede laptop, voeg het toe als een
**node**. Dat houdt een enkele Gateway en vermijdt gedupliceerde configuratie. Lokale node tools zijn
momenteel alleen macOS, maar we zijn van plan om ze uit te breiden naar andere OS's.

Installeer alleen een tweede Gateway wanneer je een **hard isolatie** of twee volledige afzonderlijke bots nodig hebt.

Docs: [Nodes](/nodes), [Nodes CLI](/cli/nodes), [Meerdere gateways](/gateway/multiple-gateways).

### Voer knooppunten uit een gateway-service

Nee. Alleen **één gateway** mag worden uitgevoerd per host tenzij u opzettelijk geïsoleerde profielen uitvoert (zie [Meerdere gateways](/gateway/multiple-gateways)). Nodes zijn periferieën die
verbinden met de gateway (iOS/Android nodes, of macOS "node mode" in de menubar app). Voor headless node
hosts en CLI control zie [Node host CLI](/cli/node).

Een volledige herstart is vereist voor `gateway`, `discovery`, en `canvasHost` veranderingen.

### Is er een API RPC manier om config toe te passen

Ja. `config.apply` valideert + schrijft de volledige configuratie en herstart de Gateway als onderdeel van de bewerking.

### configureer de configuratie hoe ik herstel en vermijd dit

`config.apply` vervangt de **gehele config**. Als je een partiële object stuurt, wordt alle
andere verwijderd.

Herstel:

- Herstellen vanaf back-up (git of een gekopieerde `~/.openclaw/openclaw.json`).
- Als u geen back-up heeft, herstart dan `openclaw doctor` en configureer kanalen/modellen.
- Als dit onverwacht was, meld dan een bug aan en voeg uw laatst bekende configuratie of een back-up toe.
- Een lokale coderingsmedewerker kan vaak een werkende configuratie reconstrueren vanuit logboeken of geschiedenis.

Vermijd het:

- Gebruik 'openclaw config set' voor kleine wijzigingen.
- Gebruik `openclaw geconfigureer` voor interactieve bewerkingen.

Documenten: [Config](/cli/config), [Configure](/cli/configure), [Doctor](/gateway/doctor).

### Wat is een minimale sane configuratie voor een eerste installatie

```json5
{
  agents: { defaults: { workspace: "~/.openclaw/workspace" } },
  channels: { whatsapp: { allowFrom: ["+15555550123"] } },
}
```

Dit stelt je werkruimte in en beperkt de vraag wie de bot mag triggeren.

### Hoe stel ik Tailscale in op een VPS en verbind ik met mijn Mac

Minimale stappen:

1. **Installeer + login op de VPS**

   ```bash
   curl -fsSL https://tailscale.com/install.sh fting sh
   sudo tailscale up
   ```

2. **Installeer + login op je Mac**
   - Gebruik de Tailscale app en log in met hetzelfde pinnet.

3. **MagicDNS inschakelen (aanbevolen)**
   - Schakel MagicDNS in in in de Tailscale admin console, dus de VPS heeft een stabiele naam.

4. **Gebruik de tailnet hostnaam**
   - SSH: `ssh user@your-vps.tailnet-xxxx.ts.net`
   - Gateway WS: `ws://your-vps.tailnet-xxxx.ts.net:18789`

Als u de Control UI wilt zonder SSH, gebruik dan Tailscale Serve op de VPS:

```bash
openclaw gateway --tailscale serve
```

Dit houdt de gateway gebonden aan lussen en stelt HTTPS bloot via Tailschaal. Zie [Tailscale](/gateway/tailscale).

### Hoe verbind ik een Mac-knooppunt met een externe Gateway Tailscale Serve

Serveer de **Gateway Control UI + WS**. Nodes verbinden over hetzelfde Gateway WS eindpunt.

Aanbevolen instelling:

1. **Zorg ervoor dat de VPS + Mac op hetzelfde tailnet zitten**.
2. **Gebruik de macOS app in externe modus** (SSH target kan de tailnet hostname zijn).
   De app zal de Gateway poort tunen verbinden als een node.
3. **Het knooppunt goedkeuren** op de gateway:

   ```bash
   openclaw nodes pending
   openclaw nodes approve <requestId>
   ```

Docs: [Gateway protocol](/gateway/protocol), [Discovery](/gateway/discovery), [macOS remote mode] (/platforms/mac/remote).

## Env vars en .env laden

### Hoe laden OpenClaw omgevingsvariabelen

OpenClaw leest omgevingsvariabelen uit het bovenliggende proces (shell, launchd/systemd, CI, enz.) en extra laden:

- `.env` van de huidige werkmap
- een globale fallback `.env` uit `~/.openclaw/.env` (oftewel `$OPENCLAW_STATE_DIR/.env`)

Geen van beide `.env`-bestanden overschrijft bestaande env vars.

U kunt ook inline env vars in configuratie definiëren (alleen toegepast als deze ontbreekt in het proces env):

```json5
{
  env: {
    OPENROUTER_API_KEY: "sk-of-...",
    vars: { GROQ_API_KEY: "gsk-..." },
  },
}
```

Zie [/environment](/help/environment) voor volledige prioriteit en bronnen.

### Ik begon de Gateway via de service en mijn env-vars verdween wat nu is

Twee algemene fixes:

1. Plaats de ontbrekende sleutels in `~/.openclaw/.env`, dus ze worden opgepakt, zelfs als de service je shell env niet erft.
2. shell import inschakelen (opt-in convenience):

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

Dit voert uw login shell uit en importeert alleen ontbrekende verwachte sleutels (nooit overrides). Env var equivalents:
`OPENCLAW_LOAD_SHELL_ENV=1`, `OPENCLAW_SHELL_ENV_TIMEOUT_MS=15000`.

### Ik zet COPILOTGITHUBTOKE, maar modellen status toont Shell env af waarom

`openclaw models status` rapporteert of **shell env import** is ingeschakeld. "Shell env: uit"
betekent **niet** dat je env-vars ontbreekt - het betekent gewoon dat OpenClaw niet automatisch zal laden
je inlogshell.

Als de Gateway werkt als een service (launchd/systemd), zal het uw shell
omgeving niet overnemen. Oplossen door één van deze te doen:

1. Plaats het token in `~/.openclaw/.env`:

   ```
   COPILOT_GITHUB_TOKEN=...
   ```

2. Of schakel shell import in (`env.shellEnv.enabled: true`).

3. Of voeg het toe aan uw config `env` blok (alleen van toepassing als deze ontbreekt).

Herstart daarna de gateway en controleer opnieuw:

```bash
openclaw models status
```

Copilot tokens worden gelezen uit `COPILOT_GITHUB_TOKEN` (ook `GH_TOKEN` / `GITHUB_TOKEN`).
Zie [/concepts/model-providers](/concepts/model-providers) en [/environment](/help/environment).

## Sessies en meerdere chats

### Hoe begin ik een nieuw gesprek

Verstuur `/new` of `/reset` als een standalone bericht. Zie [Sessie beheer](/concepts/session).

### Sessies automatisch resetten als ik nooit een nieuwe verstuur

Ja. Sessies verlopen na `session.idleMinutes` (standaard **60**). Het **volgende** bericht
start een nieuwe sessie id voor die chat key. Dit verwijdert
transcripten niet - het begint gewoon een nieuwe sessie.

```json5
{
  sessie: {
    idleMinutes: 240,
  },
}
```

### Is er een manier om een team van OpenClaw instanties één CEO en veel agenten te maken

Ja, via **multi-agent routing** en **sub-agents**. U kunt één coördinator
agent en meerdere medewerkers aanmaken met hun eigen werkruimtes en modellen.

Dat gezegd hebbende, dit kan het best gezien worden als een **leuk experiment**. Het is token heavy en vaak
minder efficiënt dan het gebruik van één bot met aparte sessies. Het typische model dat wij
envision is één bot waar je mee praat, met verschillende sessies voor parallelle werkzaamheden. Die
bot kan ook sub-agenten spawnen wanneer nodig.

Docs: [Multi-agent routing](/concepts/multi-agent), [Sub-agents](/tools/subagents), [Agents CLI](/cli/agents).

### Waarom is de context ingekapseld midtask Hoe kan ik het voorkomen

Sessie context is beperkt door het modelvenster. Lange chats, grote uitgangen van tool of veel
bestanden kunnen kompas of verbrokkeling activeren.

Wat helpt:

- Vraag de bot om de huidige status samen te vatten en naar een bestand te schrijven.
- Gebruik `/compact` voor lange taken, en `/new` bij het wisselen van onderwerpen.
- Houd belangrijke context in de werkruimte en vraag de bot om het terug te lezen.
- Gebruik sub-agenten voor lang of parallel werk, dus de hoofdchat blijft kleiner.
- Kies een model met een groter contextvenster als dit vaak gebeurt.

### Hoe kan ik OpenClaw volledig resetten maar houd het geïnstalleerd

Gebruik de reset opdracht:

```bash
openclaw reset
```

Niet-interactieve volledige reset:

```bash
openclaw reset --scope vol--yes --niet-interactief
```

Herlaad dan de onboard:

```bash
openclaw onboard --install-daemon
```

Notities:

- De wizard onboarding biedt ook **Reset** aan als er een bestaande configuratie wordt gezien. Zie [Wizard](/start/wizard).
- Als u profielen (`--profile` / `OPENCLAW_PROFILE`) heeft gebruikt, reset elke status dir (standaard zijn `~/.openclaw-<profile>`).
- Dev reset: `openclaw gateway --dev --reset` (dev-only; wipes dev config + credentials + sessions + workspace).

### Im get context too large errors how do I reset or compact

Gebruik een van deze:

- **Compact** (houdt het gesprek bij, maar geeft een overzicht van oudere draaien):

  ```
  /compact
  ```

  of `/compact <instructions>` om de samenvatting te begeleiden.

- **Herstellen** (verse sessie-ID voor dezelfde chatsleutel):

  ```
  /nieuwe
  /reset
  ```

Als het blijft gebeuren:

- In- of aanpassen van **sessie pruning** (`agents.defaults.contextPruning`) om de oude tool te trimmen.
- Gebruik een model met een groter contextvenster.

Docs: [Compaction](/concepts/compaction), [Sessie afluister](/concepts/session-pruning), [Sessie management](/concepts/session).

### Waarom zie ik dat LLM verzoek berichtenNcontentXtooluseinput veld vereist is

Dit is een provider validatie fout: het model heeft een `tool_use` blok uitgestoten zonder de vereiste
`input`. Meestal betekent dit dat de sessiegeschiedenis verouderd of beschadigd is (vaak na lange threads
of een verandering van gereedschap/schema).

Oplossing: start een nieuwe sessie met `/new` (zelfstandig bericht).

### Waarom krijg ik elke 30 minuten hartstochtelijke berichten

Heartbeats lopen standaard elke **30m**. Afstemmen of uitschakelen:

```json5
{
  agents: {
    defaults: {
      heartbeat: {
        elke: "2h", // of "0m" om
      },
    },
  },
 } uit te schakelen
```

Als `HEARTBEAT.md` bestaat maar effectief leeg is (alleen lege regels en
markdown-koppen zoals `# Heading`), slaat OpenClaw de heartbeat-run over om
API-aanroepen te besparen.
Als het bestand ontbreekt, draait de heartbeat nog steeds en beslist het model wat te doen.

Overtredingen per agent gebruiken `agents.list[].heartbeat`. Documenten: [Heartbeat](/gateway/heartbeat).

### Moet ik een bot-account toevoegen aan een WhatsApp-groep

Nee. OpenClaw draait op **uw eigen account**, dus als u deel uitmaakt van de groep, kan OpenClaw het zien.
Standaard worden groepsantwoorden geblokkeerd totdat je afzenders toestaat (\`groupPolicy: "allowlist").

Als je wilt dat alleen **jij** de mogelijkheid heeft om groepsantwoorden te activeren:

```json5
{
  channels: {
    whatsapp: {
      groepbeleid: "allowlist",
      groupAllowFrom: ["+15551234567"],
    },
  },
}
```

### Hoe krijg ik de JID van een WhatsApp-groep

Optie 1 (snelste): st): staart logs en verzend een testbericht in de groep:

```bash
openclaw logs --volg --json
```

Zoek naar `chatId` (of `van`) eindigend in `@g.us`, zoals:
`1234567890-1234567890-1234567890@g.us`.

Optie 2 (indien al geconfigureerd/toegestaan): groepen weergeven van configuratie:

```bash
openclaw directory groepen lijst --channel whatsapp
```

Documenten: [WhatsApp](/channels/whatsapp), [Directory](/cli/directory), [Logs](/cli/logs).

### Waarom geen OpenFax antwoord in een groep

Twee algemene oorzaken:

- Vermelding gating is ingeschakeld (standaard). Je moet @mention de bot (of overeenkomen met `mentionPatterns`).
- Je hebt `channels.whatsapp.groups` geconfigureerd zonder `"*"` en de groep is niet toegestaan.

Zie [Groups](/channels/groups) en [Groep berichten](/channels/group-messages).

### Deel groepen de context met DM's

Direct chats klappen standaard naar de hoofdsessie. Groepen/kanalen hebben hun eigen sessiesleutels, en Telegram onderwerpen / Discord threads zijn aparte sessies. Zie [Groups](/channels/groups) en [Groep berichten](/channels/group-messages).

### Hoeveel werkruimtes en agenten kan ik aanmaken

Geen harde grenzen. Tientallen (zelfs honderdsten) zijn prima, maar let op:

- **Schijfgroei:** sessies + transcripts live onder `~/.openclaw/agents/<agentId>/sessions/`.
- **Token kosten:** meer agenten betekent een gelijktijdig modelgebruik.
- **Opt voorbij:** per agent auth-profielen, werkruimtes en kanaalrouteringen.

Tips:

- Behoud een **actieve** werkruimte per agent (`agents.defaults.workspace`).
- Verwijder oude sessies (verwijder JSONL of winkelinnen) als de schijf groeit.
- Gebruik 'openclaw doctor' om verraderlijke werkruimtes en profielafwijkingen te vinden.

### Kan ik meerdere bots of chats tegelijk uitvoeren op Slack en hoe moet ik dat instellen

Ja. Gebruik **Multi-Agent Routing** om meerdere geïsoleerde agenten uit te voeren en inkomende berichten door
channel/account/peer. Slack wordt ondersteund als kanaal en kan aan specifieke agenten worden gekoppeld.

Browser toegang is krachtig, maar "doe niks wat een mens kan" - anti-bot, CAPTCHA's en MFA kunnen
de automatisering nog blokkeren. Voor de meest betrouwbare browsercontrole, gebruik het relay van de Chrome-extensie
op de machine die de browser uitvoert (en behoud de Gateway overal).

Best-oefeningen instellen:

- Always-on Gateway host (VPS/Mac mini).
- Eén agent per rol (binding).
- Slack kanal(en) gebonden aan deze agents.
- Lokale browser via extensie relay (of een node) indien nodig.

Docs: [Multi-Agent Routing](/concepts/multi-agent), [Slack](/channels/slack),
[Browser](/tools/browser), [Chrome extensie](/tools/chrome-extension), [Nodes](/nodes).

## Models: standaarden, selectie, aliassen, wisselen

### Wat is het standaardmodel

Het standaardmodel van OpenClaw is wat u instelt als:

```
agents.defaults.model.primary
```

Models worden verwezen naar `provider/model` (voorbeeld: `anthropic/claude-opus-4-6`). Als je de provider weglaat neemt OpenClaw momenteel `antthropic` als een tijdelijke deprecation fallback - maar je zou nog steeds **expliciet** moeten instellen `provider/model`.

### Welk model adviseert u

**Standaard aanbevolen:** `anthropic/claude-opus-4-6`.
**Goed alternatief:** `anthropic/claude-sonnet-4-5`.
**Betrouwbaar (minder teken):** `openai/gpt-5.2` - bijna zo goed als Opus, gewoon minder persoonlijkheid.
**Budget:** `zai/glm-4.7`.

MiniMax M2.1 heeft zijn eigen documenten: [MiniMax](/providers/minimax) en
[Lokale modellen](/gateway/local-models).

Regel van diumb: gebruik het **beste model dat je je kunt veroorloven** voor hoogwaardige arbeid en een goedkoper
model voor routinematige chat of samenvattingen. You can route models per agent and use sub-agents to
parallelize long tasks (each sub-agent consumes tokens). Zie [Models](/concepts/models) en
[Sub-agents](/tools/subagents).

Sterke waarschuwing: zwakker/overgekwantificeerde modellen zijn kwetsbaarder voor prompte
injectie en onveilig gedrag. Zie [Security](/gateway/security).

Meer context: [Models](/concepts/models).

### Mag ik zelfhoste modellen llamacpp vLM Ollama gebruiken

Ja. Als uw lokale server een OpenAI-compatibele API blootstelt, kunt u er een
aangepaste provider op aanwijzen. Ollama wordt rechtstreeks ondersteund en is de eenvoudigste weg.

Beveiligingsnotitie: kleinere of zwaar gekwantificeerde modellen zijn kwetsbaarder voor prompte
injectie. We raden **grote modellen** sterk aan voor elke bot die tools kan gebruiken.
Als je nog steeds kleine modellen wilt, schakel sandboxing en strikte tool toe met lijsten.

Docs: [Ollama](/providers/ollama), [Lokale modellen](/gateway/local-models),
[Model providers](/concepts/model-providers), [Security](/gateway/security),
[Sandboxing](/gateway/sandboxing).

### Hoe kan ik van model wisselen zonder mijn configuratie te wissen

Gebruik **model commands** of bewerk alleen de **model** velden. Vermijd volledige configuratie vervangingen.

Veilige opties:

- `/model` in de chat (snel, per-session)
- `openclaw modellen set ...` (update alleen model config)
- `openclaw configureren --sectie-model` (interactief)
- bewerk `agents.defaults.model` in `~/.openclaw/openclaw.json`

Vermijd `config.apply` met een gedeeltelijk object tenzij je van plan bent om de hele configuratie te vervangen.
Als je de configuratie wel had overschreven, terugzetten van een back-up of opnieuw uitvoeren van `openclaw doctor` om te repareren.

Docs: [Models](/concepts/models), [Configure](/cli/configure), [Config](/cli/config), [Doctor](/gateway/doctor).

### Wat gebruiken OpenClaw, Flawd en Krill voor modellen

- **OpenKlauw + Flawd:** Anthropic Opus (`anthropic/claude-opus-4-6`) - zie [Anthropic](/providers/anthropic).
- **Krill:** MiniMax M2.1 (`minimax/MiniMax-M2.1`) - see [MiniMax](/providers/minimax).

### Hoe verander ik modellen in de gulp zonder te herstarten

Gebruik het `/model` commando als een zelfstandig bericht:

```
/model sonnet
/model haiku
/model opus
/model gpt
/model gpt-mini
/model gemini
/model gemini-flash
```

Je kan beschikbare modellen opsommen met `/model`, `/model list`, of `/model status`.

`/model` (en `/model lijst`) toont een compact, genummerde kiezer. Op nummer selecteren:

```
/model 3
```

Je kunt ook een specifiek autorisatieprofiel afdwingen voor de provider (per sessie):

```
/model opus@anthropic:standaard
/model opus@anthropic:work
```

Tip: `/model status` laat zien welke agent actief is, welk `auth-profiles.json` bestand wordt gebruikt, en welk auth profiel later zal worden geprobeerd.
Het toont ook het geconfigureerde eindpunt van de provider (`baseUrl`) en API modus (`api`) wanneer beschikbaar.

**Hoe maak ik een profiel los dat ik heb ingesteld met profiel**

Herstart `/model` **zonder** het `@profile` suffix:

```
/model antropic/claude-opus-4-6
```

Als u terug wilt naar de standaard, kies dan uit `/model` (of verstuur `/model <default provider/model>`).
Gebruik `/model status` om te bevestigen welk authentieke profiel actief is.

### Kan ik GPT 5.2 gebruiken voor dagelijkse taken en Codex 5.3 voor codering

Ja. Stel deze in als standaard en wissel indien nodig:

- **Snel wisselen (per sessie):** `/model gpt-5.2` voor dagelijkse taken, `/model gpt-5.3-codex` voor coderen.
- **Standaard + switch:** zet `agents.defaults.model.primary` op `openai/gpt-5.2`, en schakel daarna over naar `openai-codex/gpt-5.3-codex` bij het programmeren (of de andere manier).
- **Sub-agents:** route coderingstaken naar sub-agenten met een ander standaardmodel.

Zie [Models](/concepts/models) en [Slash commands](/tools/slash-commands).

### Waarom zie ik dat het model niet is toegestaan en vervolgens geen antwoord is

Als `agents.defaults.models` is ingesteld, wordt de **allowlist** voor `/model` en elke
sessie overrides. Een model kiezen dat niet in die lijst terugkeert:

```
Model "provider/model" is not allowed. Use /model to list available models.
```

Die fout wordt **in plaats van** een normaal antwoord teruggegeven. Fix: voeg het model toe aan
`agents.defaults.models`, verwijder de allowlist, of kies een model uit `/model lijst`.

### Waarom zie ik onbekende model minimaxMiniMaxM21

Dit betekent dat de **provider niet is geconfigureerd** (geen MiniMax provider configuratie of authenticatie
profiel is gevonden), dus kan het model niet worden opgelost. Een fix voor deze detectie is
in **2026.1.12** (niet vrijgegeven op het moment van het schrijven).

Herstel checklist:

1. Upgrade naar **2026.1.12** (of run vanaf de bron `main`), herstart daarna de gateway.
2. Zorg ervoor dat MiniMax is geconfigureerd (wizard of JSON), of dat een MiniMax API key
   bestaat in env/auth profielen zodat de provider kan worden geïnjecteerd.
3. Gebruik het exacte model id (hoofdlettergevoelig): `minimax/MiniMax-M2.1` of
   `minimax/MiniMax-M2.1-lightning`.
4. Run:

   ```bash
   openclaw models list
   ```

   en kies uit de lijst (of `/model lijst` in de chat).

Zie [MiniMax](/providers/minimax) en [Models](/concepts/models).

### Kan ik MiniMax als mijn standaard en OpenAI gebruiken voor complexe taken

Ja. Gebruik **MiniMax als de standaard** en wissel modellen **per sessie** wanneer nodig.
Fallbacks zijn voor **fouten**, niet "harde taken," dus gebruik `/model` of een aparte agent.

**Optie A: schakelaar per sessie**

```json5
{
  env: { MINIMAX_API_KEY: "sk-...", OPENAI_API_KEY: "sk-... },
  agents: {
    defaults: {
      model: { primary: "minimax/MiniMax-M2. " },
      models: {
        "minimax/MiniMax-M2. ": { alias: "minimax" },
        "openai/gpt-5. ": { alias: "gpt" },
      },
    },
  },
}
```

Daarna:

```
/model gpt
```

**Optie B: gescheiden agents**

- Agent Een standaard: MiniMax
- Standaard Agent B: OpenAI
- Route per agent of gebruik `/agent` om te wisselen

Docs: [Models](/concepts/models), [Multi-Agent Routing](/concepts/multi-agent), [MiniMax](/providers/minimax), [OpenAI](/providers/openai).

### Zijn opus sonnet gpt ingebouwde snelkoppelingen

Ja. OpenClaw stuurt een paar standaard kustjes (alleen toegepast wanneer het model bestaat in `agents.defaults.models`):

- `opus` → `anthropic/claude-opus-4-6`
- `sonnet` → `anthropic/claude-sonnet-4-5`
- `gpt` → `openai/gpt-5.2`
- `gpt-mini` → `openai/gpt-5-mini`
- `gemini` → `google/gemini-3-pro-preview`
- `gemini-flash` → `google/gemini-3-flash-preview`

Als je je eigen alias met dezelfde naam instelt, wint je waarde.

### Hoe definieer ik model snelkoppelingen aliassen

Aliassen komen van `agents.defaults.models.<modelId>.alias`. Voorbeeld:

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

Vervolgens lost `/model sonnet` (of `/<alias>` wanneer ondersteund) dat model ID op.

### Hoe voeg ik modellen toe van andere aanbieders, zoals OpenRouter of ZAI

OpenRouter (pay-per-token; vele modellen):

```json5
{
  agents: {
    defaults: {
      model: { primary: "openrouter/anthropic/claude-sonnet-4-5" },
      models: { "openrouter/anthropic/claude-sonnet-4-5": {} },
    },
  },
  env: { OPENROUTER_API_KEY: "sk-of-. ." },
}
```

Z.AI (GLM modellen):

```json5
{
  agents: {
    defaults: {
      model: { primary: "zai/glm-4. " },
      models: { "zai/glm-4. ": {} },
    },
  },
  env: { ZAI_API_KEY: "..." },
}
```

Als je naar een provider/model verwijst, maar de vereiste provider-sleutel ontbreekt, krijg je een runtime authenticatiefout (bijv. . \`Geen API-sleutel gevonden voor provider "zai").

**Geen API-sleutel gevonden voor provider na het toevoegen van een nieuwe agent**

Dit betekent meestal dat de **nieuwe agent** een lege autorisatiewinkel heeft. Authenticatie is per agent en
opgeslagen in:

```
~/.openclaw/agents/<agentId>/agent/auth-profiles.json
```

Oplossingsopties:

- Voer `openclaw agents add <id>` uit en configureer de authenticatie tijdens de wizard.
- Of kopieer `auth-profiles.json` van de hoofd agent `agentDir` naar de nieuwe agent's `agentDir`.

Gebruik **niet** `agentDir` over agents; het veroorzaakt authen/sessie botsingen.

## Model faalt en "Alle modellen zijn mislukt"

### Hoe het werk mislukt

Mislukking gebeurt in twee fasen:

1. **Auth profiel rotatie** binnen dezelfde provider.
2. **Model-fallback** naar het volgende model in `agents.defaults.model.fallbacks`.

Cooldowns zijn van toepassing op falende profielen (exponentiële backoff), zodat OpenClaw kan blijven reageren, zelfs als een aanbieder beperkt tarief heeft of tijdelijk niet werkt.

### Wat betekent deze fout

```
Geen inloggegevens gevonden voor profiel "antthropic:standaard"
```

Het betekent dat het systeem geprobeerd heeft om het autorisatieprofiel ID `anthropic:default` te gebruiken, maar het kon geen referenties vinden in de verwachte autorisatiewinkel.

### Herstel checklist voor geen inloggegevens gevonden voor standaard profiel antropics

- **Bevestig waar de autorisatieprofielen leven** (nieuwe vs oude paden)
  - Huidige: `~/.openclaw/agents/<agentId>/agent/auth-profiles.json`
  - Legacy: `~/.openclaw/agent/*` (gemigreerd door `openclaw doctor`)
- **Bevestig dat uw env-var is geladen door de Gateway**
  - Als je `ANTHROPIC_API_KEY` in je shell zet maar de Gateway uitvoert via systemd/launchd, dan erft het misschien niet. Zet het in `~/.openclaw/.env` of schakel `env.shellEnv` in.
- **Zorg ervoor dat je de juiste agent bewerkt**
  - Multi-agent setups betekenen dat er meerdere `auth-profiles.json` bestanden kunnen zijn.
- **Sanity-check model/auth-status**
  - Gebruik `openclaw modellen status` om geconfigureerde modellen te zien en of aanbieders geauthenticeerd zijn.

**Herstel checklist voor geen inloggegevens gevonden voor profiel antropic**

Dit betekent dat de run is vastgezet aan een Anthropic auth-profiel, maar de Gateway
kan het niet vinden in zijn auth-winkel.

- **Gebruik een setup-token**
  - Voer `claude setup-token` uit en plak het dan met `openclaw models auth-setup-token --provider anthropic`.
  - Als de token is gemaakt op een andere machine, gebruik dan `openclaw models auth-paste-token --provider antthropic`.

- **Als je in plaats daarvan een API-sleutel wilt gebruiken**
  - Zet `ANTHROPIC_API_KEY` in `~/.openclaw/.env` op de **gateway host**.
  - Verwijder een vastgezette volgorde die een ontbrekend profiel vereist:

    ```bash
    openclaw modellen orde duidelijk --provider antropic
    ```

- **Bevestig dat je commando's uitvoert op de gateway host**
  - In de externe modus leven autorisatieprofielen op de communicatie-eenheidmachine, niet uw laptop.

### Waarom heeft het ook Google Gemini geprobeerd en mislukt

Als uw modelconfiguratie Google Gemini bevat als een terugval (of u bent overgestapt naar een Gemini shorthand), zal OpenClaw het proberen tijdens het terugvallen van het model. Als u Google-referenties niet hebt geconfigureerd, ziet u `Geen API-sleutel gevonden voor provider "google"`.

Fixing: verstrekt Google auth, of vermijd Google modellen in `agents.defaults.model.fallbacks` / aliases zodat deze niet meer kunnen worden gebruikt.

**LLM verzoek heeft bericht gedachten-handtekening afgewezen vereist google antigravity**

Oorzaak: de sessiegeschiedenis bevat **denkende blokken zonder handtekeningen** (vaak van
een afgebroken/gedeeltelijke stream). Google Antigravity vereist handtekeningen voor gedachtenblokken.

Correctie: OpenKlauw verwijdert nu niet-ondertekende gedachtenblokken voor Google Antigravity Claude. Als het nog steeds verschijnt, start dan een **nieuwe sessie** of zet `/thinking off` voor die agent.

## Auth profielen: wat zijn ze en hoe ze te beheren

Opgepast: [/concepts/oauth](/concepts/oauth) (OAuth stroom, token opslag, multi-account patronen)

### Wat is een autorisatieprofiel

Een authenticatieprofiel is een referentie-record (OAuth of API-sleutel) gekoppeld aan een provider. Profielen leven in:

```
~/.openclaw/agents/<agentId>/agent/auth-profiles.json
```

### Wat zijn typische profiel IDs

OpenFax gebruikt provider-prefix-ID's zoals:

- `anthropic:default` (algemeen wanneer er geen e-mailidentiteit is)
- `anthropic:<email>` voor OAuth identiteiten
- aangepaste IDs die u kiest (bv. `anthropic:werk`)

### Kan ik bepalen welk autorisatieprofiel eerst wordt geprobeerd

Ja. Configuratie ondersteunt optionele metadata voor profielen en een bestelling per provider (`auth.order.<provider>`). Dit bevat **niet** winkelgeheimen; het brengt IDs naar provider/mode en zet rotatie volgorde.

OpenKlauw kan tijdelijk een profiel overslaan als het zich in een korte **afkoeltijd** bevindt (tarieflimieten/timeouts/autorisatiefouten) of een langere **uitgeschakeld** status (facturering/onvoldoende kredieten). Om dit te inspecteren, voer `openclaw modellen status --json` uit en controleer `auth.unusableProfiles`. Tuning: `auth.cooldowns.billingBackoffHours*`.

Je kunt ook een **per agent** order override instellen (opgeslagen in de `auth-profiles.json`) via de CLI:

```bash
# Standaard ingesteld op de geconfigureerde standaard agent (omit --agent)
openclaw models auth-order get --provider antropic

# Lock rotatie naar een enkel profiel (alleen deze gebruiken)
openclaw models auth order set --providerantthropic antthropic:standaard

# Of stel een expliciete volgorde in (val terug binnen provider)
openclaw models auth set --provider antthropic:anwork thropic:default

# Clear override (val terug naar de auth. Rder / robine)
Regel modellen duidelijk order --provider antropic
```

Om een specifieke medewerker te richten:

```bash
openclaw modellen authentieke volgorde ingesteld --provider antropic --agent main antthropic:standaard
```

### OAuth vs API-sleutel wat het verschil is

OpenClaw ondersteunt beide:

- **OAuth** gebruikt vaak abonnementstoegang (indien van toepassing).
- **API keys** gebruiken pay-per-token facturering.

De wizard ondersteunt expliciet Anthropic setup-token en OpenAI Codex OAuth en kan API-sleutels voor u opslaan.

## Poort: poort: poort: "al running" en externe modus

### Welke poort gebruikt de Gateway

`gateway.port` controleert de enkele multiplexed poort voor WebSocket + HTTP (Bestuur UI, hooks, etc.).

Voorrang:

```
--poort > OPENCLAW_GATEWAY_PORT > gateway.port > standaard 18789
```

### Waarom zegt openclaw gateway status dat Runtime draait maar RPC probe mislukt

Omdat "running" de **supervisors** weergave is (launchd/systemd/schtasks). De RPC-probe is de CLI eigenlijk verbinding met de gateway WebSocket en `status` aanroepen.

Gebruik `openclaw gateway status` en vertrouw deze lijnen:

- `Probe target:` (de URL die de echt probe gebruikt)
- `Luistering:` (wat is eigenlijk gebonden aan de poort)
- `Last gateway fout:` (veel voorkomende hoofdoorzaak wanneer het proces in leven is maar de poort niet luistert)

### Waarom geeft de status van de gateway Config cli en Config service anders weer

U bewerkt een configuratiebestand terwijl de service wordt uitgevoerd op een andere (vaak een `--profile` / `OPENCLAW_STATE_DIR` mismatch).

Fix:

```bash
openclaw gateway installeren --force
```

Voer dat uit vanuit dezelfde `--profile` / omgeving die je de service wilt gebruiken.

### Wat doet een andere gateway instantie al luistert betekent

OpenClaw forceert een runtime lock door de WebSocket listener onmiddellijk te koppelen bij het opstarten (standaard `ws://127.0.1:18789`). Als de bind mislukt met `EADDRINUSE`, geeft het `GatewayLockError` wat aangeeft dat een andere instantie al luistert.

Fix: stop de andere instantie, maak de haven vrij of loop met `openclaw gateway --port <port>`.

### Hoe start ik OpenClaw in externe modus client verbindt met een Gateway elders

Stel `gateway.mode: "remote"` in en richt naar een externe WebSocket URL, optioneel met een token/wachtwoord:

```json5
{
  gateway: {
    mode: "remote",
    remote: {
      url: "ws://gateway.tailnet:18789",
      token: "your-token",
      wachtwoord: "your-password",
    },
  },
}
```

Notities:

- 'openclaw gateway' start alleen wanneer 'gateway.mode' is 'lokaal' is (of je door de override flag).
- De macOS app kijkt naar het configuratiebestand en schakelt live om deze waarden te wijzigen.

### De Control UI zegt ongeautoriseerd of blijft verbinden wat nu is

Uw gateway draait met authenticatie ingeschakeld (`gateway.auth.*`), maar de UI stuurt niet de overeenkomende token/wachtwoord.

Feiten (van code):

- De Control UI slaat het token op in de browser localStorage key `openclaw.control.settings.v1`.

Fix:

- Fastest: `openclaw dashboard` (print + kopieert de dashboard URL, probeert te openen; toont SSH hint als headless).
- Als u nog geen token heeft: `openclaw doctor --generate-gateway-token`.
- Als je op afstand bent, tunnel eerst: `ssh -N -L 18789:127.0.1:18789 user@host` en open `http://127.0.1:18789/`.
- Zet `gateway.token` (of `OPENCLAW_GATEWAY_TOKEN`) op de gateway host.
- Plak in de controle-UI-instellingen dezelfde token.
- Nog steeds vast? Voer `openclaw status --all` uit en volg [Troubleshooting](/gateway/troubleshooting). Zie [Dashboard](/web/dashboard) voor autorisatiegegevens.

### Ik stel gatewaybind tailnet in, maar kan niets luistert

`tailnet` bind kiest een Tailscale IP van je netwerkinterfaces (100.64.0.0/10). Als de machine niet op Tailscale staat (of de interface is omlaag), is er niets om aan te binden.

Fix:

- Start Tailscale op die host (dus het heeft een 100,x adres), of
- Schakel over naar `gateway.bind: "loopback"` / `"lan"`.

Opmerking: `tailnet` is expliciet. `auto` geeft de voorkeur aan een lus; gebruik `gateway.bind: "tailnet"` wanneer je een tailnet-only bind wilt.

### Kan ik meerdere Gateways uitvoeren op dezelfde host

Meestal geen - één Gateway kan meerdere messaging kanalen en agenten gebruiken. Gebruik meerdere gateways alleen als je ontslag nodig hebt (ex: reddingsbo) of hard isolatie.

Ja, maar je moet je isoleren:

- `OPENCLAW_CONFIG_PATH` (per instantie config)
- `OPENCLAW_STATE_DIR` (staat per instantie)
- `agents.defaults.workspace` (werkruimte isolatie)
- `gateway.port` (unieke ports)

Snelle setup (aanbevolen):

- Gebruik `openclaw --profile <name> …` per instantie (auto-creëert `~/.openclaw-<name>`).
- Stel een unieke `gateway.port` in voor elke profielconfiguratie (of passeer `--port` voor handmatige runs).
- Install a per-profile service: `openclaw --profile <name> gateway install`.

Profielen achtervoegsel servicenamen (`bot.molt.<profile>`; legacy `com.openclaw.*`, `openclaw-gateway-<profile>.service`, `OpenClaw Gateway (<profile>)`).
Volledige gids: [Multiple gateways](/gateway/multiple-gateways).

### Wat betekent ongeldige handshakecode 1008

De Gateway is een **WebSocket server**, en verwacht dat het allereerste bericht
een `connect` frame zal zijn. Als het iets anders ontvangt, sluit het de verbinding
met **code 1008** (beleidsovertreding).

Veelvoorkomende oorzaken:

- U heeft de **HTTP** URL geopend in een browser (`http://...`) in plaats van een WS client.
- U heeft de verkeerde poort of het pad gebruikt.
- Een proxy of tunnel heeft een autorisatieheaders verwijderd of een niet-Gateway verzoek gestuurd.

Snelle reparaties:

1. Gebruik de WS URL: `ws://<host>:18789` (of `wss://...` if HTTPS).
2. Open de WS poort niet op een normaal browser tabblad.
3. Als de authenticatie ingeschakeld is, voeg dan de token/wachtwoord toe in het `connect` kader.

Als je de CLI of TUI gebruikt, moet de URL er als volgt uitzien:

```
openclaw tui --url ws://<host>:18789 --token <token>
```

Protocoldetails: [Gateway-protocol](/gateway/protocol).

## Loggen en debuggen

### Waar zijn de logs

Bestandslogs (gestructureerd):

```
/tmp/openclaw/openclaw-YYYY-MM-DD.log
```

U kunt een stabiel pad instellen via `logging.file`. Logboek niveau wordt beheerd door `logging.level`. Console verbosity wordt bestuurd door `--verbose` en `logging.consoleLevel`.

Snelste log staart:

```bash
openclaw logs --follow
```

Service/supervisor logs (wanneer de gateway wordt uitgevoerd via launchd/systemd):

- macOS: `$OPENCLAW_STATE_DIR/logs/gateway.log` en `gateway.err.log` (standaard: `~/.openclaw/logs/...`; profielen gebruiken `~/.openclaw-<profile>/logs/...`)
- Linux: `journalctl --user -u openclaw-gateway[-<profile>].service -n 200 --no-pager`
- Windows: \`schtasks /Query /TN "OpenClaw Gateway (<profile>)" /V /FO LIST"

Zie [Troubleshooting](/gateway/troubleshooting#log-locations) voor meer.

### Hoe start ik de Gateway service op

Gebruik de gateway helpers:

```bash
openclaw gateway status
openclaw gateway herstart
```

Als u de gateway handmatig uitvoert, kan `openclaw gateway --force` de poort terugvorderen. Zie [Gateway](/gateway).

### Ik heb mijn terminal gesloten op Windows hoe ik OpenClaw herstart

Er zijn **twee Windows installatie modi**:

**1) WSL2 (aanbevolen):** de Gateway draait in Linux.

Open PowerShell, voer WSL, en start dan opnieuw:

```powershell
wsl
openclaw gateway status
openclaw gateway herstart
```

Als u de service nooit hebt geïnstalleerd, start deze dan in de voorgrond:

```bash
openclaw gateway run
```

**2) Inheemse Windows (niet aanbevolen):** de Gateway draait direct in Windows.

Open PowerSchelp en draait:

```powershell
openclaw gateway status
openclaw gateway herstart
```

Als je het handmatig uitvoert (geen service), gebruik dan:

```powershell
openclaw gateway run
```

Docs: [Windows (WSL2)](/platforms/windows), [Gateway service runbook](/gateway).

### De Gateway is opgestart, maar de antwoorden komen nooit binnen en dat moet ik controleren

Begin met een snelle gezondheids-sweep:

```bash
openclaw status
openclaw modelstatus
openclaw status
openclaw logs --follow
```

Veelvoorkomende oorzaken:

- Model authenticatie is niet geladen op de **gateway host** (controleer `modellen status`).
- Kanaal koppelen / blokkeren van lijsten (controleer kanaal config + logs).
- WebChat/Dashboard is geopend zonder de juiste token.

If you are remote, confirm the tunnel/Tailscale connection is up and that the
Gateway WebSocket is reachable.

Docs: [Channels](/channels), [Troubleshooting](/gateway/troubleshooting), [Externe toegang](/gateway/remote).

### Verbinding met gateway verbroken geen reden wat nu is

Dit betekent meestal dat de UI de WebSocket-verbinding verloren heeft. Controleer:

1. Is de Gateway runnen? `openclaw gateway status`
2. Is de Gateway gezond? `openclaw status`
3. Heeft de UI de juiste sleutel? `openclaw dashboard`
4. Indien afstandsbediening, is de tunnel/Tailscale link?

Vervolgens staart logboeken:

```bash
openclaw logs --follow
```

Docs: [Dashboard](/web/dashboard), [Externe toegang](/gateway/remote), [Troubleshooting](/gateway/troubleshooting).

### Telegram setMyCommands mislukt met netwerkfouten Wat moet ik controleren

Start met logs en kanaalstatus:

```bash
openclaw kanaal status
openclaw channels logs --channel telegram
```

Als u op een VPS zit of achter een proxy staat, bevestig dan dat uitgaande HTTPS is toegestaan en dat DNS-werkt.
Als de Gateway op afstand is, zorg ervoor dat je naar logs kijkt op de Gateway host.

Docs: [Telegram](/channels/telegram), [Channel troubleshooting](/channels/troubleshooting).

### TUI toont geen uitvoer wat ik moet controleren

Bevestig eerst dat de Gateway bereikbaar is en dat de agent kan draaien:

```bash
openclaw status
openclaw modelstatus
openclaw logs --follow
```

In de TUI, gebruik `/status` om de huidige status te zien. Als je antwoorden verwacht in een chat
kanaal, zorg er dan voor dat bezorging is ingeschakeld (`/deliver aan`).

Docs: [TUI](/web/tui), [Slash commands](/tools/slash-commands).

### Hoe stop ik volledig met de Gateway

Als je de service hebt geïnstalleerd:

```bash
openclaw gateway stop
openclaw gateway start
```

Dit stopt/start de **toezichtservice** (start op macOS, systeem op Linux).
Gebruik dit wanneer de Gateway draait op de achtergrond als een daemon.

Als je op de voorgrond draait, stop dan met Ctrl-C, dan:

```bash
openclaw gateway run
```

Docs: [Gateway service runbook](/gateway).

### ELI5 openclaw gateway herstart vs openclaw gateway

- `openclaw gateway herstart`: herstart de **achtergrondservice** (launchd/systemd).
- `openclaw gateway`: runt de gateway **in de voorgronds** voor deze terminale sessie.

Als u de service heeft geïnstalleerd, gebruik dan de gateway-commando's. Gebruik `openclaw gateway` als
je een eenmalige voorgrond uitvoering wilt.

### Wat is de snelste manier om meer details te krijgen wanneer iets mislukt

Start de Gateway met `--verbose` om meer console-details te krijgen. Bekijk vervolgens het logbestand voor kanaalauth, modelroutering en RPC fouten.

## Media en bijlagen

### Mijn vaardigheid genereerde een imagePDF maar er werd niets verzonden

Uitgaande bijlagen van de agent moeten een `MEDIA:<path-or-url>` regel bevatten (op zijn eigen regel). Zie [Openklauw assistent setup](/start/openclaw) en [Agent send](/tools/agent-send).

CLI verzenden:

```bash
openclaw bericht verstuurd--target +155550123 --bericht "Hier ga je" --media /path/naar/file.png
```

Ook controleren:

- Het doelkanaal ondersteunt uitgaande media en wordt niet geblokkeerd door allowlists.
- Het bestand is binnen de maximale grootte van de provider (afbeeldingen worden aangepast tot maximaal 2048px).

Zie [Images](/nodes/images).

## Beveiligings- en toegangsbeheer

### Is het veilig om OpenClaw bloot te stellen aan inkomende DM's

Behandel inkomende DM's als niet-vertrouwde input. Standaardwaarden zijn ontworpen om het risico te verminderen:

- Standaard gedrag op DM-capable kanalen is **pairing**:
  - Onbekende afzenders ontvangen een koppelcode; de bot verwerkt hun bericht niet.
  - Goedkeuren met: `openclaw pairing <channel> <code>`
  - In behandeling zijnde verzoeken worden gecentreerd op **3 per kanaal**; controleer `openclaw pairing list <channel>` als er geen code is binnengekomen.
- Openen van DMs vereist publiekelijk expliciete opt-in (`dmPolicy: "open"` en allowlist \`\*").

Voer `openclaw doctor` uit naar opperrisico DM beleid.

### Is directe injectie alleen een zorg voor openbare bots

Nee. Injectie van vragen gaat over **niet-vertrouwde inhoud**, niet alleen wie de bot kan versturen.
Als uw assistent externe inhoud leest (webzoeken/ophalen, browserpagina's, e-mails,
documenten, bijlagen, geplakte logs), die inhoud instructies kunnen bevatten die
proberen het model te kapen. Dit kan gebeuren, zelfs als **jij de enige verzender bent**.

Het grootste risico is wanneer gereedschap is ingeschakeld: het model kan in de
exfiltrerende context worden misleid of namens jou gereedschappen worden aangeroepen. Verklein de blastradius door:

- met behulp van een alleen-lezen of tool-uitgeschakeld "lezer" agent om niet-vertrouwde inhoud samen te vatten
- het behoud van `web_search` / `web_fetch` / `browser` uit voor tool-enabled agents
- Zandboxen en strikte tool toegestane lijsten

Details: [Security](/gateway/security).

### Moet mijn bot zijn eigen e-mail GitHub account of telefoonnummer hebben

Ja, voor de meeste opties. Het isoleren van de bot met afzonderlijke accounts en telefoonnummers
vermindert de hoog-straal als er iets misgaat. Dit maakt het ook makkelijker om
referenties te draaien of toegang in te trekken zonder uw persoonlijke accounts te beïnvloeden.

Start klein. Geef alleen toegang tot de tools en accounts die je echt nodig hebt en breidt
later uit indien nodig.

Documenten: [Security](/gateway/security), [Pairing](/channels/pairing).

### Mag ik hem autonomie geven over mijn sms-berichten en is zo veilig

Wij raden **niet** aan om volledige autonomie te geven over jouw persoonlijke berichten. Het veiligste patroon is:

- Houd DM's in **pairing mode** of een korte allowlist.
- Gebruik een **apart nummer of account** als je wilt dat het namens jou berichten stuurt.
- Laat het ontwerp opstellen, vervolgens **goedkeuren voordat je het verzenden**.

Als je wilt experimenteren, doe het op een dedicated account en houd het geïsoleerd. Zie
[Security](/gateway/security).

### Kan ik goedkopere modellen gebruiken voor persoonlijke assistenten taken

Ja, **als** de agent alleen chat-only is en de invoer is vertrouwd. Kleinere niveaus zijn
vatbaar voor instructie kaping, vermijd ze voor tool-enabled agents
of wanneer je niet-vertrouwde inhoud leest. Als u een kleiner model moet gebruiken, sluit
gereedschap aan en voer het in een zandbak uit. Zie [Security](/gateway/security).

### Ik begon in Telegram maar kreeg geen koppelcode

Koppelingscodes worden **alleen** verzonden wanneer een onbekende afzender de bot en
`dmPolicy: "pairing"` is ingeschakeld. `/start` genereert op zich geen code.

Controleer openstaande verzoeken:

```bash
openclaw pairing list telegram
```

Als u directe toegang wilt, laat dan uw afzender-id toe of zet `dmPolicy: "open"`
voor dat account.

### WhatsApp zal het bericht sturen naar mijn contacten Hoe werk wordt gekoppeld

Nee. Standaard WhatsApp DM beleid is **pairing**. Onbekende afzenders krijgen alleen een koppelcode en hun bericht is **niet verwerkt**. OpenKlauw antwoordt alleen op chats die het ontvangt of stuurt je expliciet de trigger.

Koppeling goedkeuren met:

```bash
openclaw pairing goedkeuren whatsapp <code>
```

Toon openstaande verzoeken:

```bash
openclaw pairing list whatsapp
```

Wizard telefoonnummer melding: het wordt gebruikt om uw **allowlist/owner** in te stellen, zodat uw eigen DMs zijn toegestaan. Het wordt niet gebruikt om automatisch te verzenden. Als je op je persoonlijke WhatsApp-nummer draait, gebruik dan dat nummer en schakel `channels.whatsapp.selfChatMode` in.

## Chat opdrachten, taken afbreken, en "het zal niet stoppen"

### Hoe kan ik voorkomen dat interne systeemberichten in de chat worden weergegeven

De meeste interne of tool berichten verschijnen alleen wanneer **verboden** of **redenen** is ingeschakeld
voor die sessie.

Repareer in de chat waar je het ziet:

```
/verbose uit
/reden uit
```

Als het nog steeds lawaai is, controleer dan de sessie-instellingen in de Control UI en stel uitgebreide
in op **erf**. Bevestig ook dat je geen bot profiel gebruikt met `verboseDefault` set
op `on` in config.

Docs: [denken en verboden](/tools/thinking), [Security](/gateway/security#reasoning--verbose-output-in-groups).

### Hoe stop ik een lopende taak

Stuur een van deze **als een zelfstandige bericht** (geen slash):

```
stop
af te breken
esc
wacht
sluit
onderbreken
```

Dit zijn afgebroken triggers (niet slash commands).

Voor achtergrondprocessen (vanuit de exec tool) kan je de agent vragen om uit te voeren:

```
procesactie:kill sessionId:XXX
```

Overzicht Flash commando's: zie [Slash commands](/tools/slash-commands).

De meeste commando's moeten worden verzonden als een **standalone** bericht dat begint met `/`, maar een paar snelkoppelingen (zoals `/status`) werken ook inline voor allowlisted afzenders.

### Hoe verstuur ik een Discord-bericht van Telegram Crosscontext bericht geweigerd

OpenKlauw blokkeert standaard **cross-provider** berichten. Als een tool gesprek is gebonden
aan Telegram, zal het niet naar Discord sturen tenzij je het expliciet toestaat.

Cross-provider berichten voor de agent inschakelen:

```json5
{
  agents: {
    defaults: {
      tools: {
        message: {
          crossContext: {
            allowAcrossProviders: true,
            markering: { enabled: true prefix: "[van {channel}] " },
          },
        },
      },
    },
  },
}
```

Herstart de gateway na het bewerken van de configuratie. Als je dit alleen wilt voor een
agent, kun je het in plaats daarvan onder `agents.list[].tools.message`.

### Waarom voelt het alsof de bot het snelle bericht negeert

Wachtrij modus bepaalt hoe nieuwe berichten omgaan met een in-flight run. Gebruik `/wachtrij` om de modus te wijzigen:

- `steer` - nieuwe berichten omleiden de huidige taak
- `followup` - voer een bericht per keer uit
- `collect` - batch berichten en beantwoord eenmalig (standaard)
- `steer-backlog` - stuurer nu, en verwerk dan de backlog
- `interrupt` - annuleer huidige uitvoering en start frisse

Je kunt opties toevoegen zoals `debounce:2s cap:25 drop:summarize` voor de followup modi.

## Beantwoord de exacte vraag uit het schermafbeeld/chatlogboek

**Q: "Wat is het standaardmodel voor Anthropic met een API-sleutel?"**

**A:** In OpenClaw, referenties en modelselectie zijn gescheiden van elkaar. `ANTHROPIC_API_KEY` instellen (of een Anthropic API-sleutel opslaan in autorisatieprofielen) maakt authenticatie mogelijk, maar het werkelijke standaardmodel is wat je configureert in `agents. efaults.model.primary` (bijvoorbeeld, `anthropic/claude-sonnet-4-5` of `anthropic/claude-opus-4-6`). Als u `Geen referenties gevonden hebt voor het profiel "antthropic:default"`, dan betekent dit dat de Gateway geen Anthropic referenties kan vinden in de verwachte `auth-profielen. son` voor de agent die loopt.

---

Nog steeds vast? Vraag het in [Discord](https://discord.com/invite/clawd) of open een [GitHub‑discussie](https://github.com/openclaw/openclaw/discussions).
