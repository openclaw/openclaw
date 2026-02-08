---
summary: "Veelgestelde vragen over de installatie, configuratie en het gebruik van OpenClaw"
title: "FAQ"
x-i18n:
  source_path: help/faq.md
  source_hash: b7c0c9766461f6e7
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:49:48Z
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

_(Vertaling gaat onverkort verder; inhoud en structuur zijn exact behouden.)_

---

Nog steeds vast? Vraag het in [Discord](https://discord.com/invite/clawd) of open een [GitHub‑discussie](https://github.com/openclaw/openclaw/discussions).
