---
summary: "Ofte stillede spørgsmål om OpenClaw-opsætning, -konfiguration og -brug"
title: "FAQ"
---

# FAQ

Hurtige svar plus dybere fejlfinding for den virkelige verden opsætninger (lokal dev, VPS, multi-agent, OAuth/API nøgler, model failover). For diagnosticering af driftstid, se [Troubleshooting](/gateway/troubleshooting). Vedrørende den fulde konfigurationsreference, se [Configuration](/gateway/configuration)

## Indholdsfortegnelse

- [Hurtig start og første-gangs opsætning]
  - [Jeg sidder fast – hvad er den hurtigste måde at komme videre på?](#im-stuck-whats-the-fastest-way-to-get-unstuck)
  - [Hvad er den anbefalede måde at installere og opsætte OpenClaw på?](#whats-the-recommended-way-to-install-and-set-up-openclaw)
  - [Hvordan åbner jeg dashboardet efter introduktion?](#how-do-i-open-the-dashboard-after-onboarding)
  - [Hvordan autentificerer jeg dashboardet (token) på localhost vs remote?](#how-do-i-authenticate-the-dashboard-token-on-localhost-vs-remote)
  - [Hvilket runtime har jeg brug for?](#what-runtime-do-i-need)
  - [Kører det på Raspberry Pi?](#does-it-run-on-raspberry-pi)
  - [Nogle tips til Raspberry Pi-installationer?](#any-tips-for-raspberry-pi-installs)
  - [Det sidder fast på "vågne op min ven" / onboarding vil ikke luge. Hvad nu?](#it-is-stuck-on-wake-up-my-friend-onboarding-will-not-hatch-what-now)
  - [Kan jeg migrere min opsætning til en ny maskine (Mac mini) uden at gentage introduktionen?](#can-i-migrate-my-setup-to-a-new-machine-mac-mini-without-redoing-onboarding)
  - [Hvor kan jeg se, hvad der er nyt i den seneste version?](#where-do-i-see-what-is-new-in-the-latest-version)
  - [Jeg kan ikke få adgang til docs.openclaw.ai (SSL fejl). Hvad nu?](#i-cant-access-docsopenclawai-ssl-error-what-now)
  - [Hvad er forskellen på stable og beta?](#whats-the-difference-between-stable-and-beta)
  - [Hvordan installerer jeg beta-versionen, og hvad er forskellen på beta og dev?](#how-do-i-install-the-beta-version-and-whats-the-difference-between-beta-and-dev)
  - [Hvordan prøver jeg de nyeste bits?](#how-do-i-try-the-latest-bits)
  - [Hvor lang tid tager installation og introduktion typisk?](#how-long-does-install-and-onboarding-usually-take)
  - [Installer fast? Hvordan får jeg mere feedback?](#installer-stuck-how-do-i-get-more-feedback)
  - [Windows-installation siger git ikke fundet eller openclaw ikke genkendt](#windows-install-says-git-not-found-or-openclaw-not-recognized)
  - [Dokumentationen besvarede ikke mit spørgsmål – hvordan får jeg et bedre svar?](#the-docs-didnt-answer-my-question-how-do-i-get-a-better-answer)
  - [Hvordan installerer jeg OpenClaw på Linux?](#how-do-i-install-openclaw-on-linux)
  - [Hvordan installerer jeg OpenClaw på en VPS?](#how-do-i-install-openclaw-on-a-vps)
  - [Hvor er cloud/VPS-installationsguides?](#where-are-the-cloudvps-install-guides)
  - [Kan jeg bede OpenClaw om at opdatere sig selv?](#can-i-ask-openclaw-to-update-itself)
  - [Hvad gør introduktionsguiden egentlig?](#what-does-the-onboarding-wizard-actually-do)
  - [Skal jeg have et Claude- eller OpenAI-abonnement for at køre dette?](#do-i-need-a-claude-or-openai-subscription-to-run-this)
  - [Kan jeg bruge Claude Max-abonnement uden en API-nøgle](#can-i-use-claude-max-subscription-without-an-api-key)
  - [Hvordan fungerer Anthropic "setup-token"-autentificering?](#how-does-anthropic-setuptoken-auth-work)
  - [Hvor finder jeg et Anthropic setup-token?](#where-do-i-find-an-anthropic-setuptoken)
  - [Understøtter I Claude-abonnementsautentificering (Claude Pro eller Max)?](#do-you-support-claude-subscription-auth-claude-pro-or-max)
  - [Hvorfor ser jeg `HTTP 429: rate_limit_error` fra Anthropic?](#why-am-i-seeing-http-429-ratelimiterror-from-anthropic)
  - [Er AWS Bedrock understøttet?](#is-aws-bedrock-supported)
  - [Hvordan fungerer Codex-autentificering?](#how-does-codex-auth-work)
  - [Understøtter I OpenAI-abonnementsautentificering (Codex OAuth)?](#do-you-support-openai-subscription-auth-codex-oauth)
  - [Hvordan opsætter jeg Gemini CLI OAuth](#how-do-i-set-up-gemini-cli-oauth)
  - [Er en lokal model OK til afslappede chats?](#is-a-local-model-ok-for-casual-chats)
  - [Hvordan holder jeg hostet modeltrafik i en bestemt region?](#how-do-i-keep-hosted-model-traffic-in-a-specific-region)
  - [Skal jeg købe en Mac Mini for at installere dette?](#do-i-have-to-buy-a-mac-mini-to-install-this)
  - [Skal jeg bruge en Mac mini for iMessage-understøttelse?](#do-i-need-a-mac-mini-for-imessage-support)
  - [Hvis jeg køber en Mac mini til at køre OpenClaw, kan jeg forbinde den til min MacBook Pro?](#if-i-buy-a-mac-mini-to-run-openclaw-can-i-connect-it-to-my-macbook-pro)
  - [Kan jeg bruge Bun?](#can-i-use-bun)
  - [Telegram: hvad skal stå i `allowFrom`?](#telegram-what-goes-in-allowfrom)
  - [Kan flere personer bruge ét WhatsApp-nummer med forskellige OpenClaw-instanser?](#can-multiple-people-use-one-whatsapp-number-with-different-openclaw-instances)
  - [Kan jeg køre en "hurtig chat"-agent og en "Opus til kodning"-agent?](#can-i-run-a-fast-chat-agent-and-an-opus-for-coding-agent)
  - [Virker Homebrew på Linux?](#does-homebrew-work-on-linux)
  - [Hvad er forskellen på den hackbare (git) installation og npm-installationen?](#whats-the-difference-between-the-hackable-git-install-and-npm-install)
  - [Kan jeg senere skifte mellem npm- og git-installationer?](#can-i-switch-between-npm-and-git-installs-later)
  - [Bør jeg køre Gateway på min laptop eller en VPS?](#should-i-run-the-gateway-on-my-laptop-or-a-vps)
  - [Hvor vigtigt er det at køre OpenClaw på en dedikeret maskine?](#how-important-is-it-to-run-openclaw-on-a-dedicated-machine)
  - [Hvad er minimumskravene til VPS og anbefalet OS?](#what-are-the-minimum-vps-requirements-and-recommended-os)
  - [Kan jeg køre OpenClaw i en VM, og hvad er kravene?](#can-i-run-openclaw-in-a-vm-and-what-are-the-requirements)
- [Hvad er OpenClaw?](#what-is-openclaw)
  - [Hvad er OpenClaw, i ét afsnit?](#what-is-openclaw-in-one-paragraph)
  - [Hvad er værdiforslaget?](#whats-the-value-proposition)
  - [Jeg har lige sat det op – hvad skal jeg gøre først?](#i-just-set-it-up-what-should-i-do-first)
  - [Hvad er de fem vigtigste hverdagsbrugsscenarier for OpenClaw](#what-are-the-top-five-everyday-use-cases-for-openclaw)
  - [Kan OpenClaw hjælpe med lead gen outreach, annoncer og blogs for en SaaS](#can-openclaw-help-with-lead-gen-outreach-ads-and-blogs-for-a-saas)
  - [Hvad er fordelene vs Claude Code til webudvikling?](#what-are-the-advantages-vs-claude-code-for-web-development)
- [Skills og automatisering](#skills-and-automation)
  - [Hvordan tilpasser jeg skills uden at holde repoet beskidt?](#how-do-i-customize-skills-without-keeping-the-repo-dirty)
  - [Kan jeg indlæse skills fra en brugerdefineret mappe?](#can-i-load-skills-from-a-custom-folder)
  - [Hvordan kan jeg bruge forskellige modeller til forskellige opgaver?](#how-can-i-use-different-models-for-different-tasks)
  - [Den bot fryser, mens du gør tungt arbejde. Hvordan aflæsser jeg dette?](#the-bot-freezes-while-doing-heavy-work-how-do-i-offload-that)
  - [Cron eller påmindelser affyrer ikke. Hvad skal jeg tjekke?](#cron-or-reminders-do-not-fire-what-should-i-check)
  - [Hvordan installerer jeg skills på Linux?](#how-do-i-install-skills-on-linux)
  - [Kan OpenClaw køre opgaver efter en tidsplan eller kontinuerligt i baggrunden?](#can-openclaw-run-tasks-on-a-schedule-or-continuously-in-the-background)
  - [Kan jeg køre Apple macOS-only skills fra Linux?](#can-i-run-apple-macos-only-skills-from-linux)
  - [Har I en Notion- eller HeyGen-integration?](#do-you-have-a-notion-or-heygen-integration)
  - [Hvordan installerer jeg Chrome-udvidelsen til browser takeover?](#how-do-i-install-the-chrome-extension-for-browser-takeover)
- [Sandboxing og hukommelse](#sandboxing-and-memory)
  - [Findes der en dedikeret sandboxing-dokumentation?](#is-there-a-dedicated-sandboxing-doc)
  - [Hvordan binder jeg en værtsmappe ind i sandboxen?](#how-do-i-bind-a-host-folder-into-the-sandbox)
  - [Hvordan fungerer hukommelse?](#how-does-memory-work)
  - [Hukommelse bliver ved med at glemme ting. Hvordan gør jeg det stick?](#memory-keeps-forgetting-things-how-do-i-make-it-stick)
  - [Fortsætter hukommelsen for evigt? Hvad er grænserne?](#does-memory-persist-forever-what-are-the-limits)
  - [Kræver semantisk hukommelsessøgning en OpenAI API-nøgle?](#does-semantic-memory-search-require-an-openai-api-key)
- [Hvor tingene ligger på disken](#where-things-live-on-disk)
  - [Gemmes alle data, der bruges med OpenClaw, lokalt?](#is-all-data-used-with-openclaw-saved-locally)
  - [Hvor gemmer OpenClaw sine data?](#where-does-openclaw-store-its-data)
  - [Hvor skal AGENTS.md / SOUL.md / USER.md / MEMORY.md ligge?](#where-should-agentsmd-soulmd-usermd-memorymd-live)
  - [Hvad er den anbefalede backupstrategi?](#whats-the-recommended-backup-strategy)
  - [Hvordan afinstallerer jeg OpenClaw fuldstændigt?](#how-do-i-completely-uninstall-openclaw)
  - [Kan agenter arbejde uden for workspace?](#can-agents-work-outside-the-workspace)
  - [Jeg er i remote mode – hvor er session store?](#im-in-remote-mode-where-is-the-session-store)
- [Konfigurationsbasics](#config-basics)
  - [Hvilket format er konfigurationen? Hvor er det?](#what-format-is-the-config-where-is-it)
  - [Jeg satte `gateway.bind: "lan"` (eller `"tailnet"`), og nu lytter intet / UI siger unauthorized](#i-set-gatewaybind-lan-or-tailnet-and-now-nothing-listens-the-ui-says-unauthorized)
  - [Hvorfor skal jeg bruge et token på localhost nu?](#why-do-i-need-a-token-on-localhost-now)
  - [Skal jeg genstarte efter ændring af konfiguration?](#do-i-have-to-restart-after-changing-config)
  - [Hvordan aktiverer jeg websøgning (og web fetch)?](#how-do-i-enable-web-search-and-web-fetch)
  - [config.apply udslettet min config. Hvordan gendanner jeg mig og undgår dette?](#configapply-wiped-my-config-how-do-i-recover-and-avoid-this)
  - [Hvordan kører jeg en central Gateway med specialiserede workers på tværs af enheder?](#how-do-i-run-a-central-gateway-with-specialized-workers-across-devices)
  - [Kan OpenClaw-browseren køre headless?](#can-the-openclaw-browser-run-headless)
  - [Hvordan bruger jeg Brave til browserkontrol?](#how-do-i-use-brave-for-browser-control)
- [Remote gateways og noder](#remote-gateways-and-nodes)
  - [Hvordan udbredes kommandoer mellem Telegram, gatewayen og noder?](#how-do-commands-propagate-between-telegram-the-gateway-and-nodes)
  - [Hvordan kan min agent få adgang til min computer, hvis Gateway er hostet eksternt?](#how-can-my-agent-access-my-computer-if-the-gateway-is-hosted-remotely)
  - [Tailscale er tilsluttet, men jeg får ingen svar. Hvad nu?](#tailscale-is-connected-but-i-get-no-replies-what-now)
  - [Kan to OpenClaw-instanser tale med hinanden (lokal + VPS)?](#can-two-openclaw-instances-talk-to-each-other-local-vps)
  - [Skal jeg bruge separate VPS’er til flere agenter](#do-i-need-separate-vpses-for-multiple-agents)
  - [Er der en fordel ved at bruge en node på min personlige laptop i stedet for SSH fra en VPS?](#is-there-a-benefit-to-using-a-node-on-my-personal-laptop-instead-of-ssh-from-a-vps)
  - [Kører noder en gateway-tjeneste?](#do-nodes-run-a-gateway-service)
  - [Findes der en API/RPC-måde at anvende konfiguration på?](#is-there-an-api-rpc-way-to-apply-config)
  - [Hvad er en minimal “fornuftig” konfiguration til en første installation?](#whats-a-minimal-sane-config-for-a-first-install)
  - [Hvordan opsætter jeg Tailscale på en VPS og forbinder fra min Mac?](#how-do-i-set-up-tailscale-on-a-vps-and-connect-from-my-mac)
  - [Hvordan forbinder jeg en Mac-node til en remote Gateway (Tailscale Serve)?](#how-do-i-connect-a-mac-node-to-a-remote-gateway-tailscale-serve)
  - [Skal jeg installere på en anden laptop eller bare tilføje en node?](#should-i-install-on-a-second-laptop-or-just-add-a-node)
- [Miljøvariabler og .env-indlæsning](#env-vars-and-env-loading)
  - [Hvordan indlæser OpenClaw miljøvariabler?](#how-does-openclaw-load-environment-variables)
  - ["Jeg startede Gateway via tjenesten og min env vars forsvundet." Hvad nu?](#i-started-the-gateway-via-the-service-and-my-env-vars-disappeared-what-now)
  - [Jeg satte `COPILOT_GITHUB_TOKEN`, men modelstatus viser "Shell env: off." Hvorfor?](#i-set-copilotgithubtoken-but-models-status-shows-shell-env-off-why)
- [Sessioner og flere chats](#sessions-and-multiple-chats)
  - [Hvordan starter jeg en frisk samtale?](#how-do-i-start-a-fresh-conversation)
  - [Nulstilles sessioner automatisk, hvis jeg aldrig sender `/new`?](#do-sessions-reset-automatically-if-i-never-send-new)
  - [Er der en måde at lave et team af OpenClaw-instanser med én CEO og mange agenter](#is-there-a-way-to-make-a-team-of-openclaw-instances-one-ceo-and-many-agents)
  - [Hvorfor fik kontekst trunkeret mid-opgave? Hvordan forhindrer jeg det?](#why-did-context-get-truncated-midtask-how-do-i-prevent-it)
  - [Hvordan nulstiller jeg OpenClaw fuldstændigt men beholder installationen?](#how-do-i-completely-reset-openclaw-but-keep-it-installed)
  - [Jeg får “context too large”-fejl – hvordan nulstiller eller komprimerer jeg?](#im-getting-context-too-large-errors-how-do-i-reset-or-compact)
  - [Hvorfor ser jeg “LLM request rejected: messages.N.content.X.tool_use.input: Field required”?](#why-am-i-seeing-llm-request-rejected-messagesncontentxtooluseinput-field-required)
  - [Hvorfor får jeg hjerteslag meddelelser hvert 30. minut?](#why-am-i-getting-heartbeat-messages-every-30-minutes)
  - [Skal jeg tilføje en “botkonto” til en WhatsApp-gruppe?](#do-i-need-to-add-a-bot-account-to-a-whatsapp-group)
  - [Hvordan får jeg JID’et for en WhatsApp-gruppe?](#how-do-i-get-the-jid-of-a-whatsapp-group)
  - [Hvorfor svarer OpenClaw ikke i en gruppe?](#why-doesnt-openclaw-reply-in-a-group)
  - [Deler grupper/tråde kontekst med DMs?](#do-groupsthreads-share-context-with-dms)
  - [Hvor mange workspaces og agenter kan jeg oprette?](#how-many-workspaces-and-agents-can-i-create)
  - [Kan jeg køre flere bots eller chats samtidig (Slack), og hvordan bør jeg sætte det op?](#can-i-run-multiple-bots-or-chats-at-the-same-time-slack-and-how-should-i-set-that-up)
- [Modeller: standarder, valg, aliaser, skift](#models-defaults-selection-aliases-switching)
  - [Hvad er “standardmodellen”?](#what-is-the-default-model)
  - [Hvilken model anbefaler I?](#what-model-do-you-recommend)
  - [Hvordan skifter jeg model uden at slette min konfiguration?](#how-do-i-switch-models-without-wiping-my-config)
  - [Kan jeg bruge self-hosted modeller (llama.cpp, vLLM, Ollama)?](#can-i-use-selfhosted-models-llamacpp-vllm-ollama)
  - [Hvilke modeller bruger OpenClaw, Flawd og Krill?](#what-do-openclaw-flawd-and-krill-use-for-models)
  - [Hvordan skifter jeg model on the fly (uden genstart)?](#how-do-i-switch-models-on-the-fly-without-restarting)
  - [Kan jeg bruge GPT 5.2 til daglige opgaver og Codex 5.3 til kodning](#can-i-use-gpt-52-for-daily-tasks-and-codex-53-for-coding)
  - [Hvorfor ser jeg "Model … er ikke tilladt" og så intet svar?](#why-do-i-see-model-is-not-allowed-and-then-no-reply)
  - [Hvorfor ser jeg “Unknown model: minimax/MiniMax-M2.1”?](#why-do-i-see-unknown-model-minimaxminimaxm21)
  - [Kan jeg bruge MiniMax som standard og OpenAI til komplekse opgaver?](#can-i-use-minimax-as-my-default-and-openai-for-complex-tasks)
  - [Er opus / sonnet / gpt indbyggede genveje?](#are-opus-sonnet-gpt-builtin-shortcuts)
  - [Hvordan definerer/overstyrer jeg modelgenveje (aliaser)?](#how-do-i-defineoverride-model-shortcuts-aliases)
  - [Hvordan tilføjer jeg modeller fra andre udbydere som OpenRouter eller Z.AI?](#how-do-i-add-models-from-other-providers-like-openrouter-or-zai)
- [Model-failover og “All models failed”](#model-failover-and-all-models-failed)
  - [Hvordan fungerer failover?](#how-does-failover-work)
  - [Hvad betyder denne fejl?](#what-does-this-error-mean)
  - [Tjekliste til `No credentials found for profile "anthropic:default"`](#fix-checklist-for-no-credentials-found-for-profile-anthropicdefault)
  - [Hvorfor prøvede den også Google Gemini og fejlede?](#why-did-it-also-try-google-gemini-and-fail)
- [Auth-profiler: hvad de er, og hvordan du administrerer dem](#auth-profiles-what-they-are-and-how-to-manage-them)
  - [Hvad er en auth-profil?](#what-is-an-auth-profile)
  - [Hvad er typiske profil-id’er?](#what-are-typical-profile-ids)
  - [Kan jeg styre, hvilken auth-profil der prøves først?](#can-i-control-which-auth-profile-is-tried-first)
  - [OAuth vs API-nøgle: hvad er forskellen?](#oauth-vs-api-key-whats-the-difference)
- [Gateway: porte, “allerede kører”, og remote mode](#gateway-ports-already-running-and-remote-mode)
  - [Hvilken port bruger Gateway?](#what-port-does-the-gateway-use)
  - [Hvorfor siger `openclaw gateway status` `Runtime: running` men `RPC probe: failed`?](#why-does-openclaw-gateway-status-say-runtime-running-but-rpc-probe-failed)
  - [Hvorfor viser `openclaw gateway status` `Config (cli)` og `Config (service)` forskelligt?](#why-does-openclaw-gateway-status-show-config-cli-and-config-service-different)
  - [Hvad betyder “another gateway instance is already listening”?](#what-does-another-gateway-instance-is-already-listening-mean)
  - [Hvordan kører jeg OpenClaw i remote mode (klient forbinder til en Gateway et andet sted)?](#how-do-i-run-openclaw-in-remote-mode-client-connects-to-a-gateway-elsewhere)
  - [The Control UI siger "unauthorized" (eller holder genforbindelse). Hvad nu?](#the-control-ui-says-unauthorized-or-keeps-reconnecting-what-now)
  - [Jeg satte `gateway.bind: "tailnet"` men den kan ikke binde / intet lytter](#i-set-gatewaybind-tailnet-but-it-cant-bind-nothing-listens)
  - [Kan jeg køre flere Gateways på samme vært?](#can-i-run-multiple-gateways-on-the-same-host)
  - [Hvad betyder “invalid handshake” / kode 1008?](#what-does-invalid-handshake-code-1008-mean)
- [Logning og debugging](#logging-and-debugging)
  - [Hvor er logs?](#where-are-logs)
  - [Hvordan starter/stopper/genstarter jeg Gateway-tjenesten?](#how-do-i-startstoprestart-the-gateway-service)
  - [Jeg lukkede min terminal på Windows – hvordan genstarter jeg OpenClaw?](#i-closed-my-terminal-on-windows-how-do-i-restart-openclaw)
  - [Porten er oppe men svar kommer aldrig. Hvad skal jeg tjekke?](#the-gateway-is-up-but-replies-never-arrive-what-should-i-check)
  - [“Disconnected from gateway: no reason” – hvad nu?](#disconnected-from-gateway-no-reason-what-now)
  - [Telegram setMyCommands fejler med netværksfejl. Hvad skal jeg tjekke?](#telegram-setmycommands-fails-with-network-errors-what-should-i-check)
  - [TUI viser intet output. Hvad skal jeg tjekke?](#tui-shows-no-output-what-should-i-check)
  - [Hvordan stopper jeg fuldstændigt og starter derefter Gateway?](#how-do-i-completely-stop-then-start-the-gateway)
  - [ELI5: `openclaw gateway restart` vs `openclaw gateway`](#eli5-openclaw-gateway-restart-vs-openclaw-gateway)
  - [Hvad er den hurtigste måde at få flere detaljer, når noget fejler?](#whats-the-fastest-way-to-get-more-details-when-something-fails)
- [Medier og vedhæftninger](#media-and-attachments)
  - [Min skill genererede et billede/PDF, men intet blev sendt](#my-skill-generated-an-imagepdf-but-nothing-was-sent)
- [Sikkerhed og adgangskontrol](#security-and-access-control)
  - [Er det sikkert at eksponere OpenClaw for indgående DMs?](#is-it-safe-to-expose-openclaw-to-inbound-dms)
  - [Er prompt injection kun et problem for offentlige bots?](#is-prompt-injection-only-a-concern-for-public-bots)
  - [Bør min bot have sin egen e-mail, GitHub-konto eller telefonnummer](#should-my-bot-have-its-own-email-github-account-or-phone-number)
  - [Kan jeg give den autonomi over mine tekstbeskeder, og er det sikkert](#can-i-give-it-autonomy-over-my-text-messages-and-is-that-safe)
  - [Kan jeg bruge billigere modeller til personlige assistentopgaver?](#can-i-use-cheaper-models-for-personal-assistant-tasks)
  - [Jeg kørte `/start` i Telegram, men fik ingen parringskode](#i-ran-start-in-telegram-but-didnt-get-a-pairing-code)
  - [WhatsApp: vil det sende mine kontakter? Hvordan virker parring?](#whatsapp-will-it-message-my-contacts-how-does-pairing-work)
- [Chatkommandoer, afbrydelse af opgaver og “den stopper ikke”](#chat-commands-aborting-tasks-and-it-wont-stop)
  - [Hvordan stopper jeg interne systembeskeder i at blive vist i chat](#how-do-i-stop-internal-system-messages-from-showing-in-chat)
  - [Hvordan stopper/annullerer jeg en kørende opgave?](#how-do-i-stopcancel-a-running-task)
  - [Hvordan sender jeg en Discord besked fra Telegram? ("Cross-context messaging denied")](#how-do-i-send-a-discord-message-from-telegram-crosscontext-messaging-denied)
  - [Hvorfor føles det, som om botten “ignorerer” hurtige beskeder?](#why-does-it-feel-like-the-bot-ignores-rapidfire-messages)

## Første 60 sekunder, hvis noget er brudt

1. **Hurtig status (første kontrol)**

   ```bash
   openclaw status
   ```

   Hurtig lokal oversigt: OS + opdatering, gateway/service reachability, agenter/sessioner, udbyder config + runtime issues (når gateway er nået).

2. **Indsætbar rapport (sikker at dele)**

   ```bash
   openclaw status -- all
   ```

   Skrivebeskyttet diagnose med log tail (tokens redacted).

3. **Dæmon + port state**

   ```bash
   openclaw gateway status
   ```

   Viser supervisor runtime vs RPC reachability, sonden mål-URL, og som konfigurerer den tjeneste, der er sandsynligt anvendt.

4. **Dyb probe**

   ```bash
   openclaw status -- deep
   ```

   Kører gateway sundhedstjek + udbyder sonder (kræver en nås gateway). Se [Health](/gateway/health).

5. **Hale den seneste log**

   ```bash
   openclaw logs --follow
   ```

   Hvis RPC er nede, falder tilbage til:

   ```bash
   hale -f "$(ls -t /tmp/openclaw/openclaw-*.log-head -1)"
   ```

   Fillogs er adskilt fra tjenestelogger; se [Logging](/logging) og [Troubleshooting](/gateway/troubleshooting).

6. **Kør lægen (reparationer)**

   ```bash
   openclaw doctor
   ```

   Reparationer/migrerer config/state + kører sundhedstjek. Se [Doctor](/gateway/doctor).

7. **Gateway snapshot**

   ```bash
   openclaw sundhed --json
   openclaw sundhed --verbose # viser målet URL + config sti på fejl
   ```

   Spørger om den kørende gateway for et fuldt øjebliksbillede (kun WS). Se [Health](/gateway/health).

## Hurtig start og første-gangs opsætning

### Im fast hvad der er den hurtigste måde at komme i gang

Brug en lokal AI-agent, der **kan se din maskine**. Det er langt mere effektivt end at spørge
i Discord, fordi de fleste "jeg sidder fast" sager er \*\* lokal konfig eller miljø problemer\*\* at
eksterne hjælpere ikke kan inspicere.

- **Claude Code**: [https://www.anthropic.com/claude-code/](https://www.anthropic.com/claude-code/)
- **OpenAI Codex**: [https://openai.com/codex/](https://openai.com/codex/)

Disse værktøjer kan læse repo, køre kommandoer, inspicere logs, og hjælpe med at løse din maskinniveau
opsætning (PATH, tjenester, tilladelser, autoritationsfiler). Giv dem den **full source checkout** via
hackable (git) installation:

```bash
curl -fsSL https://openclaw.ai/install.sh ¤ bash -s -- --install-method git
```

Dette installerer OpenClaw **fra en git checkout**, så agenten kan læse koden + docs og
grund om den præcise version, du kører. Du kan altid skifte tilbage til stabil senere
ved at køre installationsprogrammet igen uden `--install-method git`.

Tip: bed agenten om at **planlægge og overvåge** rettelsen (trin-for-trin), og udfør derefter kun de
nødvendige kommandoer. Det gør ændringerne små og lettere at kontrollere.

Hvis du opdager en rigtig fejl eller rettelse, så send en GitHub problemstilling eller send en PR:
[https://github.com/openclaw/openclaw/issues](https://github.com/openclaw/openclaw/issues)
[https://github.com/openclaw/openclaw/pulls](https://github.com/openclaw/openclaw/pulls)

Start med disse kommandoer (del output, når du beder om hjælp):

```bash
openclaw status
openclaw model status
openclaw doctor
```

Hvad de gør:

- `openclaw status`: hurtig snapshot af gateway/agent sundhed + grundlæggende config.
- `openclaw modeller status`: kontrol udbyder auth + model tilgængelighed.
- `openclaw doktor`: validerer og reparerer fælles konfig/stat problemer.

Andre nyttige CLI checks: `openclaw status --all`, `openclaw logs --follow`,
`openclaw gateway status`, `openclaw health --verbose`.

Hurtig debug loop: [Første 60 sekunder, hvis noget er brudt](#first-60-seconds-if-somethings-broken).
Installer docs: [Install](/install), [Installer flags] (/install/installer), [Updating](/install/updating).

### Hvad er den anbefalede måde at installere og oprette OpenClaw

Repo anbefaler at køre fra kilde og bruge onboarding guiden:

```bash
curl -fsSL https://openclaw.ai/install.sh ¤ bash
openclaw onboard --install-daemon
```

Guiden kan også bygge UI aktiver automatisk. Efter onboarding kører du typisk Gateway på port **18789**.

Fra kilde (bidragydere/dev):

```bash
git clone https://github.com/openclaw/openclaw.git
cd openclaw
pnpm install
pnpm build
pnpm ui:build # auto-installs UI deps on first run
openclaw onboard
```

Hvis du ikke har en global installation endnu, skal du køre den via `pnpm openclaw onboard`.

### Hvordan åbner jeg instrumentbrættet efter onboarding

Guiden åbner din browser med en ren (ikke-tokeniseret) dashboard URL lige efter onboarding og også udskriver linket i oversigten. Hold denne fane åben, hvis den ikke startede, kopiér / indsæt den trykte URL på den samme maskine.

### Hvordan godkender jeg dashboard-token på localhost vs remote

**Localhost (samme maskine):**

- Åben `http://127.0.0.1:18789/`.
- Hvis det beder om auth, indsæt token fra `gateway.auth.token` (eller `OPENCLAW_GATEWAY_TOKEN`) i Control UI indstillinger.
- Hent det fra gateway vært: `openclaw config få gateway.auth.token` (eller generere en: `openclaw læge --generate-gateway-token`).

**Ikke på localhost:**

- **Tailscale Serve** (anbefales): hold bind loopback, run `openclaw gateway --tailscale serve`, open `https://<magicdns>/`. Hvis `gateway.auth.allowTailscale` er `true`, identitetsoverskrifter opfylder auth (ingen token).
- **Tailnet bind**: Kør `openclaw gateway --bind tailnet --token "<token>"`, åben `http://<tailscale-ip>:18789/`, indsæt token i dashboard indstillinger.
- **SSH tunnel**: `ssh -N -L 18789:127.0.0.1:18789 user@host` derefter åbne `http://127.0.0.1:18789/` og indsætte token i Control UI indstillinger.

Se [Dashboard](/web/dashboard) og [Weboverflader] (/web) for bind tilstande og auth detaljer.

### Hvilken køretid har jeg brug for

Indholdselement **>= 22** er påkrævet. `pnpm` anbefales. Bun er **anbefales ikke** for porten.

### Kører det på Raspberry Pi

Ja. Gatewayen er let - docs liste **512MB-1GB RAM**, **1 kerne**, og omkring **500MB**
disk som nok til personlig brug, og bemærk, at en **Raspberry Pi 4 kan køre det**.

Hvis du vil have ekstra headroom (logs, medier, andre tjenester), anbefales \*\*2GB \*\*, men det er
ikke et hårdt minimum.

Tip: En lille Pi/VPS kan være vært for Gateway, og du kan parre **noder** på din bærbare computer/telefon til
lokal skærm/kamera/kanvas eller kommandoudførelse. Se [Nodes](/nodes).

### Eventuelle tips til Raspberry Pi installeres

Kort version: det virker, men forventer rå kanter.

- Brug en **64-bit** OS og behold Node >= 22.
- Foretræk den \*\* hackable (git) installere \*\* så du kan se logs og opdatere hurtigt.
- Start uden kanaler / færdigheder, derefter tilføje dem én efter én.
- Hvis du rammer underlige binære problemer, er det normalt et **ARM-kompatibilitet** problem.

Dokumenter: [Linux](/platforms/linux), [Install](/install).

### Det sidder fast på vågne op min ven onboarding vil ikke klække Hvad nu

Denne skærm afhænger af, at Gateway kan nås og godkendes. TUI sender også
"Vågn op, min ven!" automatisk på første luge. Hvis du ser denne linje med **intet svar**
og tokens ophold på 0, er agenten aldrig kørt.

1. Genstart Gateway:

```bash
openclaw gateway restart
```

2. Kontroller status + auth:

```bash
openclaw status
openclaw model status
openclaw logs --follow
```

3. Hvis det stadig hænger, løbet:

```bash
openclaw doctor
```

Hvis Gateway er fjern, skal du sikre, at forbindelsen mellem tunnelen og Tailscale er oppe og at UI
peges på den rigtige Gateway. Se [Remote access](/gateway/remote).

### Kan jeg migrere min opsætning til en ny maskine Mac mini uden at redoing onboarding

Ja. Kopier **statsmappen** og **arbejdsområde**, og kør derefter Læge en gang. Denne
holder din bot "nøjagtig den samme" (hukommelse, sessionshistorik, auth, og kanal
-tilstand), så længe du kopierer **begge** placeringer:

1. Installer OpenClaw på den nye maskine.
2. Kopier `$OPENCLAW_STATE_DIR` (standard: `~/.openclaw`) fra den gamle maskine.
3. Kopier dit arbejdsområde (standard: `~/.openclaw/workspace`).
4. Kør `openclaw doktor` og genstart Gateway tjenesten.

Det bevarer config, auth profiler, WhatsApp creds, sessioner og hukommelse. Hvis du er i
fjerntilstand, så husk gatewayværten ejer sessionsbutikken og arbejdsområdet.

**Vigtigt:** hvis du kun begår/skubber dit arbejdsområde til GitHub, bakker du
op **hukommelse + bootstrap filer**, men **ikke** sessionshistorik eller auth. De levende
under `~/.openclaw/` (f.eks. `~/.openclaw/agents/<agentId>/sessions/`).

Relaterede: [Migrating](/install/migrating), [Hvor ting bor på disk] (/help/faq#where-does-openclaw-store-its-data)
[Agent workspace](/concepts/agent-workspace), [Doctor](/gateway/doctor),
[Remote mode](/gateway/remote).

### Hvor kan jeg se, hvad der er nyt i den seneste version

Tjek GitHub changelog:
[https://github.com/openclaw/openclaw/blob/main/CHANGELOG.md](https://github.com/openclaw/openclaw/blob/main/CHANGELOG.md)

Nyeste poster er øverst. Hvis den øverste sektion er markeret **Unreleased**, er den næste daterede
sektion den seneste afsendte version. Indgange er grupperet efter **Højdepunkter**, **Ændringer**, og
**Rettelser** (plus docs/andre sektioner, når det er nødvendigt).

### Jeg har ikke adgang docs.openclaw.ai SSL fejl Hvad nu

Nogle Comcast/Xfinity forbindelser ukorrekt blokere `docs.openclaw.ai` via Xfinity
Advanced Security. Deaktivér det eller tillad `docs.openclaw.ai`, prøv derefter. Flere
detaljer: [Troubleshooting](/help/troubleshooting#docsopenclawai-shows-an-ssl-error-comcastxfinity).
Please help us unblock it by reporting here: [https://spa.xfinity.com/check_url_status](https://spa.xfinity.com/check_url_status).

Hvis du stadig ikke kan nå hjemmesiden, bliver dokumenterne spejlet på GitHub:
[https://github.com/openclaw/openclaw/tree/main/docs](https://github.com/openclaw/openclaw/tree/main/docs)

### Hvad er forskellen mellem stabil og beta

**Stable** og **beta** er **npm dist-tags**, ikke separate kodelinjer:

- `senest` = stabil
- `beta` = tidlig udbygning til test

Vi sender bygget til **beta**, test dem, og når en bygning er solid, vi **fremme
den samme version til `senest`**. Derfor kan beta og stabil pege på
**samme version**.

Se hvad der ændret:
[https://github.com/openclaw/openclaw/blob/main/CHANGELOG.md](https://github.com/openclaw/openclaw/blob/main/CHANGELOG.md)

### Hvordan installerer jeg betaversionen og hvad forskellen mellem beta og dev

**Beta** er npm dist-tag 'beta' (kan matche 'seneste').
**Dev** er det bevægelige hoved for `main` (git); når det offentliggøres, bruger det npm dist-tag `dev`.

One-liners (macOS/Linux):

```bash
curl -fsSL --proto '=https' --tlsv1.2 https://openclaw.ai/install.sh ¤ bash -s -- --beta
```

```bash
curl -fsSL --proto '=https' --tlsv1.2 https://openclaw.ai/install.sh ¤ bash -s -- --install-method git
```

Windows installer (PowerShell):
[https://openclaw.ai/install.ps1](https://openclaw.ai/install.ps1)

Flere detaljer: [Udviklingskanaler](/install/development-channels) og [Installer flags](/install/installer).

### Hvor lang tid installerer og onboarding normalt tage

Rough guide:

- **Installér:** 2-5 minutter
- **Onboarding:** 5-15 minutter afhængigt af hvor mange kanaler/modeller du konfigurerer

Hvis den hænger, brug [Installer fastgjort](/help/faq#installer-stuck-how-do-i-get-more-feedback)
og den hurtige debug loop i [Im fastgjort](/help/faq#im-stuck--whats-the-fastest-way-to-get-unstuck).

### Hvordan kan jeg prøve de seneste bits

To muligheder:

1. **Dev kanal (git checkout):**

```bash
openclaw update -- channel dev
```

Dette skifter til `main` grenen og opdateringer fra kilden.

2. **Kan ikke installeres (fra installationswebstedet):**

```bash
curl -fsSL https://openclaw.ai/install.sh ¤ bash -s -- --install-method git
```

Det giver dig en lokal repo du kan redigere, og derefter opdatere via git.

Hvis du foretrækker en ren klon manuelt, brug:

```bash
git klone https://github.com/openclaw/openclaw.git
cd openclaw
pnpm install
pnpm build
```

Docs: [Update](/cli/update), [Udviklingskanaler] (/install/development-channels),
[Install](/install).

### Installationsprogrammet sidder fast Hvordan får jeg mere feedback

Genkør installationsprogrammet med **verbose output**:

```bash
curl -fsSL https://openclaw.ai/install.sh ¤ bash -s -- --verbose
```

Beta installation med verbose:

```bash
curl -fsSL https://openclaw.ai/install.sh ¤ bash -s -- --beta --verbose
```

For en hackbar (git) installation:

```bash
curl -fsSL https://openclaw.ai/install.sh ¤ bash -s -- --install-method git --verbose
```

Flere valgmuligheder: [Installer flags](/install/installer).

### Windows installation siger git ikke fundet eller openclaw ikke genkendt

To almindelige Windows-problemer:

**1) npm error spawn git / git not found**

- Installer **Git til Windows** og sørg for, at `git` er på din PATH.
- Luk og genåbn PowerShell, og kør derefter installationsprogrammet igen.

**2) openclaw er ikke genkendt efter installation**

- Din globale mappe, npm er ikke på PATH.

- Tjek stien:

  ```powershell
  npm config get prefix
  ```

- Sikre at `<prefix>\\bin` er på PATH (på de fleste systemer er det `%AppData%\\npm`).

- Luk og genåbn PowerShell efter opdatering af PATH.

Hvis du vil have den glatteste Windows-opsætning, så brug \*\* WSL2\*\* i stedet for native Windows.
Dokumenter: [Windows](/platforms/windows).

### Dokumenterne besvarede ikke mit spørgsmål, hvordan får jeg et bedre svar

Brug den \*\* hackable (git) installere \*\* så du har den fulde kilde og dokumenter lokalt, så spørg
din bot (eller Claude/Codex) _fra denne mappe_ så den kan læse repo og svare præcist.

```bash
curl -fsSL https://openclaw.ai/install.sh ¤ bash -s -- --install-method git
```

Flere detaljer: [Install](/install) og [Installer-flag] (/install/installer).

### Hvordan installerer jeg OpenClaw på Linux

Kort svar: Følg Linux-guiden, og kør derefter onboarding-guiden.

- Linux hurtig sti + service install: [Linux](/platforms/linux).
- Fuld walkthrough: [Kom i gang](/start/getting-started).
- Installation + opdateringer: [Installer & opdateringer] (/install/updating).

### Hvordan installerer jeg OpenClaw på en VPS

Alle Linux VPS virker. Installér på serveren, og brug derefter SSH / Tailscale til at nå gatewayen.

Guides: [exe.dev](/install/exe-dev), [Hetzner](/install/hetzner), [Fly.io](/install/fly).
Fjernadgang: [Gateway remote](/gateway/remote).

### Hvor er cloudVPS installationsguider

Vi har et \*\* hosting hub\*\* med de fælles udbydere. Vælg en og følg vejledningen:

- [VPS hosting](/vps) (alle udbydere på ét sted)
- [Fly.io](/install/fly)
- [Hetzner](/install/hetzner)
- [exe.dev](/install/exe-dev)

Sådan fungerer det i skyen: **Gateway kører på serveren**, og du får adgang til det
fra din bærbare computer/telefon via Control UI (eller Tailscale/SSH). Din stat + arbejdsområde
lever på serveren, så behandl værten som kilden til sandheden og sikkerhedskopiere den.

Du kan parre **noder** (Mac/iOS/Android/headless) med denne cloud Gateway for at få adgang til
lokal skærm/kamera/lærred eller køre kommandoer på din bærbare computer, mens du holder
Gateway i skyen.

Hub: [Platforms](/platforms). Fjernadgang: [Gateway remote](/gateway/remote).
Nodes: [Nodes](/nodes), [Nodes CLI](/cli/nodes).

### Kan jeg bede OpenClaw om at opdatere sig selv

Kort svar: **muligt, anbefales ikke**. Opdateringsflowet kan genstarte
Gateway (som falder den aktive session), kan have brug for en ren git checkout, og
kan bede om bekræftelse. Sikkere: kør opdateringer fra en skal som operatør.

Brug CLI:

```bash
openclaw update
openclaw update status
openclaw update --channel stable-Fi betaţdev
openclaw update --tag <dist-tag|version>
openclaw update --no-genstart
```

Hvis du skal automatisere fra en agent:

```bash
openclaw opdatering --yes --no-genstart
openclaw gateway genstart
```

Dokumenter: [Update](/cli/update), [Updating](/install/updating).

### Hvad gør onboarding guiden faktisk gøre

`openclaw onboard` er den anbefalede opsætningssti. I **lokal tilstand** går den dig gennem:

- **Model/auth setup** (Antropisk **setup-token** anbefales for Claude abonnementer, OpenAI Codex OAuth understøttes, API nøgler valgfri, LM Studio lokale modeller understøttes)
- **Arbejdsområde** placering + bootstrap filer
- **Gatewayindstillinger** (bind/port/auth/tailscale)
- **Udbydere** (WhatsApp, Telegram, Discord, Mattermost (plugin), Signal, iMessage)
- **Dæmon installer** (LaunchAgent på macOS; systemd brugerenhed på Linux/WSL2)
- **Sundhedstjek** og **færdigheder** valg

Det advarer også, hvis din konfigurerede model er ukendt eller mangler auth.

### Behøver jeg et Claude eller OpenAI abonnement for at køre dette

Nej. Du kan køre OpenClaw med **API-nøgler** (Anthropic/OpenAI/andre) eller med
\*\*Lokale modeller \*\*så dine data forbliver på din enhed. Abonnementer (Claude
Pro/Max eller OpenAI Codex) er valgfrie måder at godkende disse udbydere.

Dokumenter: [Anthropic](/providers/anthropic), [OpenAI](/providers/openai),
[Lokale modeller] (/gateway/local-models), [Models](/concepts/models).

### Kan jeg bruge Claude Max abonnement uden en API-nøgle

Ja. Du kan godkende med en **setup-token**
i stedet for en API-nøgle. Dette er abonnementsstien.

Claude Pro/Max abonnementer \*\*omfatter ikke en API-nøgle \*\*, så dette er den
korrekte metode for abonnementskonti. Vigtigt: du skal bekræfte med
Antropic at denne brug er tilladt i henhold til deres abonnementspolitik og vilkår.
Hvis du vil have den mest eksplicit, understøttet sti, skal du bruge en antropisk API-nøgle.

### Hvordan virker Anthropic setuptoken auth arbejde

`claude setup-token` genererer en **token streng** via Claude Code CLI (det er ikke tilgængeligt i web-konsollen). Du kan køre det på \*\*enhver maskine \*\*. Vælg **Antropisk token (indsæt setup-token)** i guiden eller indsæt den med `openclaw modeller auth paste-token --provider anthropic`. Token gemmes som en auth profil for **anthropic**-udbyderen og bruges som en API-nøgle (ingen auto-opdatering). Flere detaljer: [OAuth](/concepts/oauth).

### Hvor finder jeg en Antropisk setuptoken

Det er **ikke** i den antropiske konsol. Opsætningstoken genereres af **Claude Code CLI** på **enhver maskine**:

```bash
claude setup-token
```

Kopier den token den udskriver, og vælg derefter **Anthropic token (indsæt setup-token)** i guiden. Hvis du ønsker at køre det på gateway vært, skal du bruge `openclaw modeller auth setup-token --provider anthropic`. Hvis du kørte `claude setup-token` andre steder, indsæt det på gateway vært med `openclaw modeller auth paste-token --provider anthropic`. Se [Anthropic](/providers/anthropic).

### Understøtter du Claude abonnement auth (Claude Pro eller Max)

Ja - via **setup-token**. OpenClaw genbruger ikke længere Claude Code CLI OAuth tokens; brug en setup-token eller en Anthropic API-nøgle. Generer token hvor som helst og indsæt det på gateway værten. Se [Anthropic](/providers/anthropic) og [OAuth](/concepts/oauth).

Bemærk: Adgang til Claude abonnement er underlagt Anthropic's vilkår. Til produktion eller flerbruger arbejdsbyrder, API-nøgler er normalt det sikrere valg.

### Hvorfor ser jeg HTTP 429 ratelimiterror fra Antropic

Det betyder, at din **Antropiske kvote/hastighedsgrænse** er opbrugt til det aktuelle vindue. Hvis du
bruger et **Claude abonnement** (setup-token eller Claude Code OAuth), så vent på vinduet til
nulstille eller opgradere dit abonnement. Hvis du bruger en **Antropisk API-nøgle**, så tjek den Antropiske Konsol
for brug/fakturering og hæv grænserne efter behov.

Tip: indstil en \*\* fallback model \*\* så OpenClaw kan blive ved med at svare, mens en udbyder er rate-begrænset.
Se [Models](/cli/models) og [OAuth](/concepts/oauth).

### Understøttes af AWS Bedrock

Ja - via pi-ai's **Amazon Bedrock (Converse)** udbyder med **manuel konfiguration**. Du skal levere AWS legitimationsoplysninger / region på gateway vært og tilføje en Bedrock udbyder post i dine modeller config. Se [Amazon Bedrock](/providers/bedrock) og [Modeludbydere](/providers/models). Hvis du foretrækker en håndteret nøglestrøm, er en OpenAI-kompatibel proxy foran Bedrock stadig en gyldig mulighed.

### Hvordan virker Codex auth

OpenClaw understøtter **OpenAI kode (Codex)** via OAuth (ChatGPT tegn). Guiden kan køre OAuth flow og vil indstille standardmodellen til `openai-codex/gpt-5.3-codex` når det er relevant. Se [Modeludbydere](/concepts/model-providers) og [Wizard](/start/wizard).

### Understøtter du OpenAI abonnement auth Codex OAuth

Ja. OpenClaw understøtter fuldt ud **OpenAI-kode (Codex) abonnement OAuth**. Onboarding guiden
kan køre OAuth flow for dig.

Se [OAuth](/concepts/oauth), [Modeludbydere] (/concepts/model-providers) og [Wizard](/start/wizard).

### Hvordan opretter jeg Gemini CLI OAuth

Gemini CLI bruger en **plugin auth flow**, ikke et klient id eller hemmelig i `openclaw.json`.

Trin:

1. Aktiver plugin'et: 'openclaw plugins aktiverer google-gemini-cli-auth'
2. Log ind: `openclaw models auth login --provider google-gemini-cli --set-default`

Dette gemmer OAuth tokens i auth profiler på gateway værten. Detaljer: [Model udbydere](/concepts/model-providers).

### Er en lokal model OK til afslappede chats

Normalt nr. OpenClaw har brug for stor kontekst + stærk sikkerhed; små kort afkortet og lækage. Hvis du skal køre, kør den **største** MiniMax M2.1 bygge du kan lokalt (LM Studio) og se [/gateway/local-models](/gateway/local-models). Små/kvantiserede modeller øger risikoen for hurtig injektion - se [Security](/gateway/security).

### Hvordan kan jeg holde hosted model trafik i en bestemt region

Vælg region-fastgjorte endepunkter. OpenRouter udsætter USA-hostede muligheder for MiniMax, Kimi og GLM; vælg den US-hostede variant for at holde data i regionen. Du kan stadig liste Anthropic/OpenAI sammen med disse ved hjælp af `models.mode: "merge"` så fallbacks forbliver tilgængelige, samtidig med at den regionerede udbyder, du vælger, respekteres.

### Skal jeg købe en Mac Mini for at installere dette

Nej. OpenClaw kører på macOS eller Linux (Windows via WSL2). En Mac mini er valgfri - nogle mennesker
købe en som en altid vært, men en lille VPS, hjemmeserver, eller Raspberry Pi-class boks fungerer også.

Du behøver kun en Mac **til MacOS-værktøjer**. For iMessage, brug [BlueBubbles](/channels/bluebubbles) (anbefales) - BlueBubbles serveren kører på enhver Mac, og Gateway kan køre på Linux eller andre steder. Hvis du vil have andre MacOS-værktøjer, skal du køre Gateway på en Mac eller parre en macOS-knude.

Dokumenter: [BlueBubbles](/channels/bluebubbles), [Nodes](/nodes), [Mac-fjerntilstand] (/platforms/mac/remote)

### Har jeg brug for en Mac mini til iMessage support

Du skal bruge **nogle macOS enhed** logget ind Beskeder. Det gør **ikke** behøver at være en Mac mini -
enhver Mac fungerer. **Brug [BlueBubbles](/channels/bluebubbles)** (anbefales) til iMessage - BlueBubbles-serveren kører på macOS, mens Gateway kan køre på Linux eller andre steder.

Almindelige opsætninger:

- Kør Gateway på Linux/VPS, og kør BlueBubbles-serveren på enhver Mac, der er logget ind på meddelelser.
- Kør alt på Mac, hvis du vil have den enkleste single-machine setup.

Dokumenter: [BlueBubbles](/channels/bluebubbles), [Nodes](/nodes),
[Mac fjerntilstand] (/platforms/mac/remote).

### Hvis jeg køber en Mac mini til at køre OpenClaw kan jeg forbinde den til min MacBook Pro

Ja. Den **Mac mini kan køre Gateway**, og din MacBook Pro kan oprette forbindelse som en
**node** (ledsagerenhed). Knuder kører ikke Gateway - de giver ekstra
kapaciteter som skærm/kamera/lærred og `system.run` på denne enhed.

Almindeligt mønster:

- Gateway på Mac mini (altid-på).
- MacBook Pro kører macOS app eller en node vært og par til Gateway.
- Brug `openclaw nodes status` / `openclaw nodes list` for at se det.

Dokumentation: [Nodes](/nodes), [Nodes CLI](/cli/nodes).

### Kan jeg bruge Bun

Bun er **anbefales ikke**. Vi ser runtime bugs, især med WhatsApp og Telegram.
Brug **Node** til stabile gateways.

Hvis du stadig ønsker at eksperimentere med Bun, gøre det på en ikke-produktion gateway
uden WhatsApp/Telegram.

### Telegram hvad der går i allowFrom

`channels.telegram.allowFrom` er **den menneskelige afsenders Telegram bruger ID** (numerisk, anbefales) eller `@username`. Det er ikke bot brugernavn.

Sikrere (ingen tredjepartsbot):

- DM din bot, derefter køre `openclaw logs --follow` og læse `from.id`.

Officiel Bot API:

- DM din bot, ring derefter til `https://api.telegram.org/bot<bot_token>/getopdatering` og læs `message.from.id`.

Tredjepart (mindre privat):

- DM `@userinfobot` eller `@getidsbot`.

Se [/channels/telegram](/channels/telegram#access-control-dms--groups).

### Kan flere mennesker bruge en WhatsApp nummer med forskellige OpenClaw forekomster

Ja, via **multi-agent routing**. Bind hver afsenders WhatsApp **DM** (peer `kind: "dm"`, afsender E. 64 ligesom `+15551234567`) til en anden `agentId`, så hver person får deres egen arbejdsområde og session butik. Svar kommer stadig fra den \*\*samme WhatsApp konto \*\*, og DM adgangskontrol (`channels.whatsapp.dmPolicy` / `channels.whatsapp.allowFrom`) er global per WhatsApp konto. Se [Multi-Agent Routing](/concepts/multi-agent) og [WhatsApp](/channels/whatsapp).

### Kan jeg køre en hurtig chat agent og en Opus for kodning agent

Ja. Brug multi-agent routing: giv hver agent sin egen standardmodel, og bind derefter indgående ruter (udbyderkonto eller specifikke peers) til hver agent. Eksempel på config lever i [Multi-Agent Routing](/concepts/multi-agent). Se også [Models](/concepts/models) og [Configuration](/gateway/configuration).

### Gør Homebrew arbejde på Linux

Ja. Homebrew understøtter Linux (Linuxbrew). Hurtig opsætning:

```bash
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
echo 'eval "$(/home/linuxbrew/.linuxbrew/bin/brew shellenv)"' >> ~/.profile
eval "$(/home/linuxbrew/.linuxbrew/bin/brew shellenv)"
bryg installere <formula>
```

Hvis du kører OpenClaw via systemd, skal du sikre, at tjenesten PATH indeholder `/home/linuxbrew/.linuxbrew/bin` (eller dit brygge præfiks) så `bryg“-installerede værktøjer løser i ikke-login-skaller.
Nylige bygger også forberede almindelige bruger bin dirs på Linux systemd tjenester (for eksempel `~/.local/bin`, `~/.npm-global/bin`, `~/.local/share/pnpm`, `~/. un/bin`) og ære `PNPM_HOME`, `NPM_CONFIG_PREFIX`, `BUN_INSTALL`, `VOLTA_HOME`, `ASDF_DATA_DIR`, `NVM_DIR`, og `FNM_DIR\` når de er sat.

### Hvad er forskellen mellem hackable git installere og npm installere

- **Hackable (git) installere:** full source checkout, redigerbare, bedst for bidragydere.
  Du kører bygger lokalt og kan patch kode / docs.
- **npm installér:** global CLI installer, ingen repo, bedst til "bare køre det."
  Opdateringer kommer fra npm dist-tags.

Dokumenter: [Kom i gang](/start/getting-started), [Updating](/install/updating).

### Kan jeg skifte mellem npm og git installerer senere

Ja. Installere den anden smag, derefter køre Doctor så gateway service punkter på det nye indgangspunkt.
Dette \*\* sletter ikke dine data\*\* - det ændrer kun OpenClaw koden installation. Din tilstand
(`~/.openclaw`) og arbejdsrum (`~/.openclaw/workspace`) forbliver uberørt.

Fra npm → git:

```bash
git klone https://github.com/openclaw/openclaw.git
cd openclaw
pnpm install
pnpm build
openclaw doctor
openclaw gateway genstart
```

Fra git → npm:

```bash
npm install -g openclaw@latest
openclaw doctor
openclaw gateway genstart
```

Læge registrerer en gateway service entrypoint uoverensstemmelse og tilbyder at omskrive tjenesten config til at matche den aktuelle installation (brug `--repair` i automatisering).

Backup tips: se [Backup strategi](/help/faq#whats-the-recommended-backup-strategy).

### Skal jeg køre Gateway på min bærbare computer eller en VPS

Kort svar: **Hvis du ønsker 24/7 pålidelighed, brug en VPS**. Hvis du vil have
laveste friktion og du er okay med søvn/genstart, skal du køre det lokalt.

**Laptop (lokal Gateway)**

- **Pros:** ingen server omkostninger, direkte adgang til lokale filer, live browser vindue.
- **Cons:** Dvale/netværkssænkninger = afbrydelser, OS-opdateringer/genstart afbryder, skal forblive vågen.

**VPS / cloud**

- **Pros:** altid-on, stabilt netværk, ingen problemer med laptop-søvn, lettere at holde kørende.
- **Cons:** Kør ofte headless (brug skærmbilleder), kun fjernfiladgang, SSH for opdateringer.

**OpenClaw-specifik note:** WhatsApp/Telegram/Slack/Mattermost (plugin)/Discord alle fungerer fint fra en VPS. Den eneste reelle handel off er \*\* hovedløs browser\*\* vs et synligt vindue. Se [Browser](/tools/browser).

**Anbefalet standard:** VPS, hvis du havde lukket gateway før. Lokal er fantastisk, når du aktivt bruger Mac og ønsker lokal fil adgang eller UI automatisering med en synlig browser.

### Hvor vigtigt er det at køre OpenClaw på en dedikeret maskine

Ikke påkrævet, men **anbefales til pålidelighed og isolering**.

- **Dedikeret vært (VPS/Mac mini/Pi):** altid, færre søvn/genstart afbrydelser, renere tilladelser, lettere at holde kørende.
- **Delt laptop/desktop:** helt fint til test og aktiv brug, men forventer pauser, når maskinen sover eller opdateringer.

Hvis du ønsker det bedste fra begge verdener, holde Gateway på en dedikeret vært og parre din bærbare computer som en **node** til lokal skærm/kamera/exec værktøjer. Se [Nodes](/nodes).
For sikkerhedsvejledning, læs [Security](/gateway/security).

### Hvad er de minimale VPS krav og anbefalede OS

OpenClaw er let. For en grundlæggende Gateway + en chatkanal:

- **Absolut minimum:** 1 vCPU, 1GB RAM, ~500MB disk.
- **Anbefalet:** 1-2 vCPU, 2GB RAM eller mere til headroom (logs, media, multiple kanaler). Node værktøjer og browser automatisering kan være ressource sultne.

OS: brug **Ubuntu LTS** (eller enhver moderne Debian/Ubuntu). Linux-installationsstien er bedst testet der.

Dokumenter: [Linux](/platforms/linux), [VPS hosting] (/vps).

### Kan jeg køre OpenClaw i en VM og hvad er kravene

Ja. Behandle en VM det samme som en VPS: det skal altid være tændt, nås og har nok
RAM til Gateway og alle kanaler, du aktiverer.

Baseline vejledning:

- **Absolut minimum:** 1 vCPU, 1GB RAM.
- **Anbefalet:** 2GB RAM eller mere, hvis du kører flere kanaler, browser automation eller medier værktøjer.
- **OS:** Ubuntu LTS eller en anden moderne Debian/Ubuntu.

Hvis du er på Windows, er \*\*WSL2 den nemmeste VM stil opsætning \*\* og har den bedste værktøj
kompatibilitet. Se [Windows](/platforms/windows), [VPS hosting] (/vps).
Hvis du kører macOS i en VM, se [macOS VM] (/install/macos-vm).

## Hvad er OpenClaw?

### Hvad er OpenClaw i et afsnit

OpenClaw er en personlig AI assistent, du kører på dine egne enheder. Det svarer på de meddelelsesflader, du allerede bruger (WhatsApp, Telegram, Slack, Mattermost (plugin), Discord, Google Chat, Signal, iMessage, WebChat) og kan også stemme + et live lærred på understøttede platforme. **Gateway** er det altid-on kontrolplan; assistenten er produktet.

### Hvad er det værdiforslag

OpenClaw er ikke "blot en Claude wrapper." Det er et \*\* local-first control plan\*\* der lader dig køre en
stand assistent på **din egen hardware**, nås fra de chat-apps, du allerede bruger, med
stateful sessions, hukommelse og værktøjer - uden at give kontrol over dine arbejdsgange til en hosted
SaaS.

Highlights:

- **Dine enheder, dine data:** kør Gatewayen, uanset hvor du ønsker (Mac, Linux, VPS) og behold
  arbejdsområde + sessionshistorik lokalt.
- **Rigtige kanaler, ikke en web-sandkasse:** WhatsApp/Telegram/Slack/Discord/Signal/iMessage/etc,
  plus mobil stemme og lærred på understøttede platforme.
- **Model-agnostik:** brug Anthropic, OpenAI, MiniMax, OpenRouter, osv., med per-agent routing
  og failover.
- **Lokal tilvalg:** kør lokale modeller, så **alle data kan forblive på din enhed** hvis du vil.
- **Multi-agent routing:** separate agenter pr. kanal, konto eller opgave, hver med sin egen
  arbejdsområde og standard.
- **Open source og hackable:** inspicere, udvide, og selv-vært uden leverandør lock-in.

Dokumenter: [Gateway](/gateway), [Channels](/channels), [Multi-agent](/concepts/multi-agent),
[Memory](/concepts/memory).

### Jeg har lige oprettet det, hvad skal jeg gøre først

Gode første projekter:

- Byg en hjemmeside (WordPress, Shopify, eller en simpel statisk websted).
- Prototype en mobil app (omrids, skærme, API plan).
- Organiser filer og mapper (oprydning, navngivning, tagging).
- Tilslut Gmail og automatisér resuméer eller opfølgninger.

Det kan håndtere store opgaver, men det virker bedst, når du opdeler dem i faser, og
bruge underagenter til parallelt arbejde.

### Hvad er de øverste fem hverdagssager for OpenClaw

Hverdagsgevinster ser normalt ud:

- **Personlige briefinger:** resuméer af indbakke, kalender og nyheder, du bekymrer dig om.
- **Forskning og udkast:** hurtig forskning, resuméer og første udkast til e-mails eller dokumenter.
- **Påmindelser og følg op:** cron eller hjerteslag drevet nudges og checklister.
- **Browserautomatisering:** udfyldning af formularer, indsamling af data og gentagelse af webopgaver.
- **Kryds enhedskoordination:** send en opgave fra din telefon, lad Gateway køre den på en server, og få resultatet tilbage i chatten.

### Kan OpenClaw hjælpe med bly gen outreach annoncer og blogs til en SaaS

Ja for **forskning, kvalifikation og udkast**. Det kan scanne websteder, bygge shortlists,
opsummere prospekter, og skrive outreach eller annoncekopier kladder.

For **outreach eller ad runs**, hold et menneske i løkken. Undgå spam, følge lokale love og
platform politikker, og gennemgå noget, før det sendes. Det sikreste mønster er at lade
OpenClaw udkast og du godkender.

Dokumenter: [Security](/gateway/security).

### Hvad er fordelene vs Claude Code for webudvikling

OpenClaw er et **personlig assistent** og koordinationslag, ikke en IDE-udskiftning. Brug
Claude Code eller Codex til den hurtigste direkte kodning loop i en repo. Brug OpenClaw når du
ønsker holdbar hukommelse, adgang på tværs af enheder og værktøj orkestration.

Fordele:

- **Vedvarende hukommelse + arbejdsområde** på tværs af sessioner
- **Adgang til flere platforme** (WhatsApp, Telegram, TUI, WebChat)
- **Værktøj orkestration** (browser, filer, planlægning, kroge)
- **Always-on Gateway** (kør på en VPS, interagere fra hvor som helst)
- **Noder** for lokal browser/skærm/kamera/exec

Showcase: [https://openclaw.ai/showcase](https://openclaw.ai/showcase)

## Færdigheder og automatisering

### Hvordan kan jeg tilpasse færdigheder uden at holde repo beskidte

Brug håndterede overskrivninger i stedet for at redigere repo kopien. Placer dine ændringer i `~/.openclaw/skills/<name>/SKILL.md` (eller tilføj en mappe via `skills.load.extraDirs` i `~/.openclaw/openclaw.json`). Præcedens er `<workspace>/skills` > `~/.openclaw/skills` > bundtet, så managed overrides sejr uden at røre git. Kun upstream-værdige redigeringer bør leve i repo og gå ud som PRs.

### Kan jeg indlæse færdigheder fra en brugerdefineret mappe

Ja. Tilføj ekstra mapper via `skills.load.extraDirs` i `~/.openclaw/openclaw.json` (laveste præcedens). Standard forrang tilbage: `<workspace>/skills` → `~/.openclaw/skills` → bundtet → `skills.load.extraDirs`. `clawhub` installerer i `./skills` som standard, som OpenClaw behandler som `<workspace>/skills`.

### Hvordan kan jeg bruge forskellige modeller til forskellige opgaver

I dag er de understøttede mønstre:

- **Cron job**: isolerede job kan indstille en `model` tilsidesætte pr job.
- **Underagenter**: rute opgaver til at adskille agenter med forskellige standardmodeller.
- **On-demand switch**: brug `/model` til at skifte den aktuelle session model til enhver tid.

Se [Cron job](/automation/cron-jobs), [Multi-Agent Routing](/concepts/multi-agent) og [Slash kommandoer](/tools/slash-commands).

### Den bot fryser, mens du gør tungt arbejde Hvordan kan jeg aflade, at

Brug **underagenter** til lange eller parallelle opgaver. Sub-agenter kører i deres egen session,
returnerer et resumé, og holde din vigtigste chat responsive.

Bed din bot om at "spawne en underagent til denne opgave" eller bruge `/underagenter`.
Brug `/status` i chat for at se, hvad Gateway gør lige nu (og om det er optaget).

Token tip: lange opgaver og sub-agenter begge forbruge tokens. Hvis omkostningerne er en bekymring, indstil en
billigere model for sub-agenter via `agents.defaults.subagents.model`.

Dokumenter: [Sub-agents](/tools/subagents).

### Cron eller påmindelser ikke affyre Hvad skal jeg tjekke

Cron kører inde i Gateway processen. Hvis Gateway ikke kører kontinuerligt, vil
planlagte job ikke køre.

Tjekliste:

- Bekræft at cron er aktiveret (`cron.enabled`) og `OPENCLAW_SKIP_CRON` er ikke angivet.
- Kontroller, at Gateway kører 24/7 (ingen søvn / genstarter).
- Verificér tidszoneindstillinger for jobbet (`--tz` vs host tidszone).

Debug:

```bash
openclaw cron run <jobId> --force
openclaw cron kører --id <jobId> --limit 50
```

Docs: [Cron jobs](/automation/cron-jobs), [Cron vs Heartbeat](/automation/cron-vs-heartbeat).

### Hvordan installerer jeg færdigheder på Linux

Brug \*\*ClawHub \*\* (CLI) eller slip færdigheder ind i dit arbejdsområde. MacOS Skills UI er ikke tilgængelig på Linux.
Gennemse færdigheder på [https://clawhub.com](https://clawhub.com).

Installer ClawHub CLI (vælg en pakke manager):

```bash
npm i -g clawhub
```

```bash
pnpm add -g clawhub
```

### Kan OpenClaw køre opgaver på en tidsplan eller løbende i baggrunden

Ja. Brug Gateway scheduler:

- **Cron job** til planlagte eller tilbagevendende opgaver (fortsætter på tværs af genstarter).
- **Heartbeat** for "main session" periodiske kontroller.
- **Isolerede job** for autonome agenter, der sender oversigter eller leverer til chats.

Docs: [Cron jobs](/automation/cron-jobs), [Cron vs Heartbeat](/automation/cron-vs-heartbeat),
[Heartbeat](/gateway/heartbeat).

### Kan jeg køre Apple macOS færdigheder fra Linux?

Ikke direkte. macOS færdigheder er gated af `metadata.openclaw.os` plus krævede binære filer, og færdigheder vises kun i systemprompten, når de er berettiget på **Gateway vært**. På Linux vil `darwin`-only færdigheder (som `æble-notes`, `æble-påmindelser`, `things-mac`) ikke indlæse, medmindre du tilsidesætter gingerne.

Du har tre understøttede mønstre:

\*\*Mulighed A - kør Gateway på en Mac (simplest). \*
Kør Gateway hvor macOS binære filer findes, og tilslut derefter Linux i [fjerntilstand] (#how-do-i-run-openclaw-in-remote-mode-client-connects-to-a-gateway-elsewhere) eller via Tailscale. De færdigheder belastning normalt, fordi Gateway vært er macOS.

\*\*Mulighed B - brug en macOS knude (ingen SSH). \*
Kør Gateway på Linux, parr en macOS-node (menulinje-app), og sæt **Node Run kommandoer** til "Altid Ask" eller "Altid Tillad" på Mac. OpenClaw kan behandle macOS-kun færdigheder som kvalificerede, når de krævede binære filer findes på indholdselementet. Agenten kører disse færdigheder via `noder` værktøj. Hvis du vælger "Altid Ask", tilføjer godkendelse af "Altid Tillad" i prompten denne kommando til tilladslisten.

\*\*Mulighed C - proxy macOS binære filer over SSH (avanceret). \*
Hold Gateway på Linux, men få de nødvendige CLI binære filer til SSH-indpakninger, der kører på en Mac. Så tilsidesætte færdighederne til at tillade Linux, så det forbliver berettiget.

1. Opret en SSH-wrapper for den binære (eksempel: `memo` for Apple Notes):

   ```bash
   #!/usr/bin/env bash
   set -euo pipefail
   exec ssh -T user@mac-host /opt/homebrew/bin/memo "$@"
   ```

2. Sæt wrapper på `PATH` på Linux-værten (for eksempel `~/bin/memo`).

3. Tilsidesæt færdigheds metadata (arbejdsområde eller `~/.openclaw/skills`) for at tillade Linux:

   ```markdown
   ---
   navn: æble-noter
   beskrivelse: Administrer Apple Notes via memo CLI på macOS.
   metadata: { "openclaw": { "os": ["darwin", "linux"], "requires": { "bins": ["memo"] } } }
   ---
   ```

4. Start en ny session, så de færdigheder snapshot opdateres.

### Har du en Notion eller HeyGen integration

Ikke indbygget i dag.

Muligheder:

- **Brugerdefineret færdighed / plugin:** bedst for pålidelig API adgang (Notion/HeyGen begge har API'er).
- **Browserautomatisering:** virker uden kode, men er langsommere og mere skrøbelige.

Hvis du ønsker at holde kontekst per klient (agentur arbejdsgange), et simpelt mønster er:

- En Notion side pr. klient (kontekst + præferencer + aktivt arbejde).
- Bed agenten om at hente siden ved starten af en session.

Hvis du vil have en indbygget integration, så åbn en funktionsanmodning eller opbyg en færdighed
rettet mod disse API'er.

Installer færdigheder:

```bash
clawhub installer <skill-slug>
clawhub update --all
```

ClawHub installeres i `. skills` under din nuværende mappe (eller falder tilbage til dit konfigurerede OpenClaw arbejdsrum); OpenClaw behandler det som `<workspace>/skills` på den næste session. For fælles færdigheder på tværs af agenter, placer dem i `~/.openclaw/skills/<name>/SKILL.md`. Nogle færdigheder forventer binære filer installeret via Homebrew; på Linux, der betyder Linuxbrew (se Homebrew Linux FAQ post ovenfor). Se [Skills](/tools/skills) og [ClawHub](/tools/clawhub).

### Hvordan kan jeg installere Chrome udvidelse til browser overtagelse

Brug den indbyggede installatør, og indlæs derefter den upakkede udvidelse i Chrome:

```bash
openclaw browser extension install
openclaw browser extension path
```

Så Chrome → `chrome://extensions` → aktiver "Udviklertilstand" → "Indlæs upakkede" → Vælg den mappe.

Fuld guide (herunder remote Gateway + security notes): [Chrome udvidelse](/tools/chrome-extension)

Hvis Gateway kører på den samme maskine som Chrome (standard opsætning), behøver du normalt \*\* ikke\*\* noget ekstra.
Hvis Gateway kører et andet sted, så kør en node-vært på browsermaskinen, så Gateway kan proxy’e browserhandlinger.
Du skal stadig klikke på udvidelsesknappen på den fane, du vil kontrollere (det er ikke automatisk vedhæftet).

## Sandboxing og hukommelse

### Er der en dedikeret sandboxing doc

Ja. Se [Sandboxing](/gateway/sandboxing). For Docker-specifik opsætning (fuld gateway i Docker eller sandkasse billeder), se [Docker](/install/docker).

### Docker føles begrænset Hvordan kan jeg aktivere fulde funktioner

Standardbilledet er sikkerhed-første og kører som `node` bruger, så det ikke
omfatter systempakker, Homebrew, eller bundtede browsere. For en fyldigere opsætning:

- Persist `/home/node` med `OPENCLAW_HOME_VOLUME` så caches overleve.
- Bake system dukker op i billedet med `OPENCLAW_DOCKER_APT_PACKAGES`.
- Installer Playwright browsere via den medfølgende CLI:
  `node /app/node_modules/playwright-core/cli.js installere chromium`
- Sæt `PLAYWRIGHT_BROWSERS_PATH` og sørg for, at stien er vedvarende.

Dokumenter: [Docker](/install/docker), [Browser](/tools/browser).

**Kan jeg holde DMs personlige men gøre grupper offentlige sandkasse med en agent**

Ja - hvis din private trafik er **DMs** og din offentlige trafik er **grupper**.

Brug `agents.defaults.sandbox.mode: "non-main"` so group/channel sessions (non-main keys) run in Docker, while the main DM session stays on-host. Derefter begrænse, hvilke værktøjer der er tilgængelige i sandboxed sessioner via `tools.sandbox.tools`.

Opsætning walkthrough + eksempel config: [Grupper: personlige DMs + offentlige grupper](/channels/groups#pattern-personal-dms-public-groups-single-agent)

Nøgle config reference: [Gateway konfiguration](/gateway/configuration#agentsdefaultssandbox)

### Hvordan binder jeg en værtsmappe ind i sandkassen

Sæt `agents.defaults.sandbox.docker.binds` til `["host:path:mode"]` (f.eks. `"/home/user/src:/src:ro"`). Global + per-agent binder fusion; per-agent bindinger ignoreres når `scope: "shared"`. Brug `:ro` for noget følsomt og huske binder omgå sandkassen filsystem vægge. Se [Sandboxing](/gateway/sandboxing#custom-bind-mounts) og [Sandbox vs Tool Policy vs Elevated] (/gateway/sandbox-vs-tool-policy-vs-elevated#bind-mounts-security-quick-check) for eksempler og sikkerhedsnoter.

### Hvordan hukommelsen virker

OpenClaw hukommelse er bare Markdown filer i agenten arbejdsområde:

- Daglige noter i `hukommelse/ÅÅÅÅ-MM-DD.md`
- Kuraterede langfristede noter i 'MEMORY.md' (kun main/private sessioner)

OpenClaw kører også en \*\* tavs pre-komprimering hukommelse flush\*\* for at minde model
til at skrive holdbare noter før auto-komprimering. Dette kører kun, når arbejdsområdet
er skrivbar (skrivebeskyttet sandkasser springe over det). Se [Memory](/concepts/memory).

### Hukommelse holder glemmer ting Hvordan gør jeg det stick

Bed botten om at **skrive det til hukommelsen**. Langfristede noter hører til i `MEMORY.md`,
kortfristede forhold går i `hukommelse/ÅÅÅÅ-MM-DD.md`.

Det er stadig et område, som vi er ved at forbedre. Det hjælper til at minde modellen til at gemme minder;
det vil vide, hvad de skal gøre. Hvis det bliver ved med at glemme, verificer Gateway ved hjælp af det samme
arbejdsområde på hvert løb.

Dokumenter: [Memory](/concepts/memory), [Agent arbejdsområde] (/concepts/agent-workspace).

### Kræver semantisk hukommelsessøgning en OpenAI API-nøgle

Kun hvis du bruger **OpenAI embeddings**. Codex OAuth dækker chat/færdiggørelser, og
giver **ikke** adgang til indlejringer så **log på med Codex (OAuth eller
Codex CLI login)** hjælper ikke til semantisk hukommelsessøgning. OpenAI embeddings
stadig brug for en reel API-nøgle (`OPENAI_API_KEY` eller `models.providers.openai.apiKey`).

Hvis du ikke indstiller en udbyder eksplicit, OpenClaw auto-vælger en udbyder, når det
kan løse en API-nøgle (auth profiler, `models.providers.*.apiKey`, eller env vars).
Det foretrækker OpenAI, hvis en OpenAI tasten løser , ellers Gemini, hvis en Gemini tasten
løser . Hvis ingen nøgle er tilgængelig, hukommelse søgning forbliver deaktiveret, indtil du
konfigurere det. Hvis du har en lokal model sti konfigureret og nærværende, OpenClaw
foretrækker `local`.

Hvis du hellere vil forblive lokalt, sæt `memorySearch.provider = "local"` (og eventuelt
`memorySearch.fallback = "none"`). Hvis du vil Gemini embeddings, sæt
`memorySearch.provider = "gemini"` og giv `GEMINI_API_KEY` (eller
`memorySearch.remote.apiKey`). Vi understøtter **OpenAI, Gemini eller local** indlejring af
modeller - se [Memory](/concepts/memory) for opsætningsoplysningerne.

### Er hukommelse fortsætter for evigt Hvad er grænserne

Hukommelsesfiler lever på disken og fortsætter indtil du sletter dem. Grænsen er dit
lager, ikke modellen. **sessionskontekst** er stadig begrænset af model
kontekstvinduet, så lange samtaler kan kompakte eller truncate. Det er derfor,
hukommelsessøgning eksisterer - det trækker kun de relevante dele tilbage i sammenhæng.

Dokumenter: [Memory](/concepts/memory), [Context](/concepts/context).

## Hvor ting bor på disken

### Anvendes alle data med OpenClaw gemt lokalt

Nej - **OpenClaw's state is local**, men **eksterne tjenester kan stadig se, hvad du sender dem**.

- **Lokal som standard:** sessioner, hukommelsesfiler, konfiguration og arbejdsområde live på Gateway host
  (`~/.openclaw` + din arbejdsområde mappe).
- **Fjernt af nødvendighed:** meddelelser, du sender til modeludbydere (Antropic/OpenAI/etc.) gå til
  deres API'er, og chat platforme (WhatsApp/Telegram/Slack/etc.) gemme besked data på deres
  servere.
- \*\* Du styrer fodaftryk:\*\* ved hjælp af lokale modeller holder forespørgsler på din maskine, men kanal
  trafik stadig går gennem kanalens servere.

Relaterede: [Agent arbejdsområde](/concepts/agent-workspace), [Memory](/concepts/memory).

### Hvor gemmer OpenClaw sine data

Alt lever under `$OPENCLAW_STATE_DIR` (standard: `~/.openclaw`):

| Sti                                                             | Formål                                                                                                          |
| --------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `$OPENCLAW_STATE_DIR/openclaw.json`                             | Hoved konfig (JSON5)                                                                         |
| `$OPENCLAW_STATE_DIR/credentials/oauth.json`                    | Ældre OAuth import (kopieret til auth profiler ved første brug)                              |
| `$OPENCLAW_STATE_DIR/agents/<agentId>/agent/auth-profiles.json` | Auth profiler (OAuth + API nøgler)                                                           |
| `$OPENCLAW_STATE_DIR/agents/<agentId>/agent/auth.json`          | Runtime auth cache (administreres automatisk)                                                |
| `$OPENCLAW_STATE_DIR/credentials/`                              | Leverandør status (f.eks. `whatsapp/<accountId>/creds.json`) |
| `$OPENCLAW_STATE_DIR/agents/`                                   | Peragent tilstand (agentDir + sessioner)                                                     |
| `$OPENCLAW_STATE_DIR/agents/<agentId>/sessions/`                | Samtalshistorik og tilstand (pr. agent)                                      |
| `$OPENCLAW_STATE_DIR/agents/<agentId>/sessions/sessions.json`   | Session metadata (pr. agent)                                                 |

Legacy single-agent sti: `~/.openclaw/agent/*` (migreret af `openclaw doctor`).

Dit **arbejdsrum** (AGENTS.md, hukommelsesfiler, færdigheder, osv.) er adskilt og konfigureret via `agents.defaults.workspace` (standard: `~/.openclaw/workspace`).

### Hvor skal AGENTSmd SOULmd USERmd MEMORYmd live

Disse filer lever i **agenten arbejdsområdet**, ikke `~/.openclaw`.

- **Arbejdsrum (pr. agent)**: `AGENTS.md`, `SOUL.md`, `IDENTITY.md`, `USER.md`,
  `MEMORY.md` (eller `hukommelse.md`), `hukommelse/ÅÅÅÅ-MM-DD.md`, valgfri `HEARTBEAT.md`.
- **State dir (`~/.openclaw`)**: config, legitimationsoplysninger, auth profiler, sessioner, logs,
  og delte færdigheder (`~/.openclaw/skills`).

Standard arbejdsområde er `~/.openclaw/workspace`, konfigurerbar via:

```json5
{
  agents: { defaults: { workspace: "~/.openclaw/workspace" } },
}
```

Hvis botten "glemmer" efter en genstart, bekræft at Gateway bruger det samme
arbejdsområde ved hver start (og husk: Fjerntilstand bruger **gateway host's**
arbejdsområde, ikke din lokale bærbare computer).

Tip: hvis du vil have en holdbar adfærd eller præference, så bed botten om at \*\* skrive den til
AGENTS. d eller MEMORY.md\*\* i stedet for at stole på chathistorik.

Se [Agent arbejdsområde](/concepts/agent-workspace) og [Memory](/concepts/memory).

### Hvad er den anbefalede backupstrategi

Sæt dit **agent arbejdsområde** i et **privat** git repo og sikkerhedskopiér det et eller andet sted
privat (f.eks. GitHub privat). Dette indfanger hukommelse + AGENTS/SOUL/USER
filer, og lader dig gendanne assistentens "sind" senere.

Gør **ikke** begå noget under `~/.openclaw` (legitimationsoplysninger, sessioner, tokens).
Hvis du har brug for en fuld gendannelse, skal du sikkerhedskopiere både arbejdsrummet og tilstandsmappen
separat (se migrationsspørgsmålet ovenfor).

Docs: [Agent arbejdsområde](/concepts/agent-workspace).

### Hvordan afinstallerer jeg helt OpenClaw

Se den dedikerede guide: [Uninstall](/install/uninstall).

### Kan agenter arbejde uden for arbejdsområdet

Ja. Arbejdsrummet er **standard cwd** og hukommelsesanker, ikke en hård sandkasse.
Relative stier løser inde i arbejdsområdet, men absolutte stier kan få adgang til andre
værtssteder, medmindre sandboxing er aktiveret. Hvis du har brug for isolation, brug
[`agents.defaults.sandbox`](/gateway/sandboxing) eller per-agent sandkasse indstillinger. Hvis du
vil have et repo til at være den standard arbejdsmappe, så peger agentens
'arbejdsrum' til repo roden. OpenClaw repo er kun kildekode; holde
arbejdsrum adskilt, medmindre du bevidst ønsker, at agenten skal arbejde inde i det.

Eksempel (repo som standard cwd):

```json5
{
  agenter: {
    defaults: {
      workspace: "~/Projects/my-repo",
    },
  },
}
```

### Im i fjerntilstand, hvor sessionsbutikken er

Session staten er ejet af **gateway host**. Hvis du er i fjerntilstand, er sessionsbutikken, du holder af, på fjernmaskinen, ikke din lokale bærbare computer. Se [Session management](/concepts/session).

## Grundlæggende konfigurationer

### Hvilket format er config Hvor er det

OpenClaw læser en valgfri **JSON5** config fra `$OPENCLAW_CONFIG_PATH` (standard: `~/.openclaw/openclaw.json`):

```
$OPENCLAW_CONFIG_PATH
```

Hvis filen mangler, bruger den sikre standarder (herunder et standard arbejdsområde på `~/.openclaw/workspace`).

### Jeg sætter gatewaybind lan eller tailnet og nu intet lytter UI siger uautoriseret

Ikke-loopback binder **kræver auth**. Konfigurer `gateway.auth.mode` + `gateway.auth.token` (eller brug `OPENCLAW_GATEWAY_TOKEN`).

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

Noter:

- `gateway.remote.token` er kun for **eksterne CLI opkald**; det aktiverer ikke lokal gateway auth.
- Kontrol-UI autentificerer via `connect.params.auth.token` (gemt i app/UI indstillinger). Undgå at sætte tokens i URL'er.

### Hvorfor har jeg brug for en token på localhost nu

Guiden genererer som standard en gateway-token (selv ved loopback), så **lokale WS-klienter skal autentificere**. Dette forhindrer andre lokale processer i at kalde Gatewayen. Indsæt token i Control UI indstillinger (eller din klient config) for at forbinde.

Hvis du **really** ønsker åben loopback, skal du fjerne `gateway.auth` fra din konfiguration. Læge kan generere en token for dig enhver tid: `openclaw læge --generate-gateway-token`.

### Skal jeg genstarte efter ændring af config

Gateway ure config og understøtter hot-reload:

- `gateway.reload.mode: "hybrid"` (default): hot-apply sikre ændringer, genstart for kritiske
- `hot`, `restart`, `off` understøttes også

### Hvordan aktiverer jeg websøgning og webhentning

`web_fetch` virker uden en API-nøgle. `web_search` kræver en Brave Search API
nøgle. **Anbefalet:** kør `openclaw configure --section web` for at gemme det i
`tools.web.search.apiKey`. Miljø alternativ: sæt `BRAVE_API_KEY` for
Gateway proces.

```json5
{
  værktøjer: {
    web: {
      search: {
        aktiveret: true,
        apiKey: "BRAVE_API_KEY_HERE",
        maxResultater: 5,
      },
      hente: {
        enabled: true,
      },
    },
  },
}
```

Noter:

- Hvis du bruger tilladte lister, tilføj `web_search`/`web_fetch` eller `group:web`.
- `web_fetch` er aktiveret som standard (medmindre det eksplicit deaktiveres).
- Dæmoner læse env vars fra `~/.openclaw/.env` (eller tjenestemiljø).

Docs: [Webværktøjer] (/tools/web).

### Hvordan kan jeg køre en central Gateway med specialiserede arbejdstagere på tværs af enheder

Det fælles mønster er **one Gateway** (f.eks. Raspberry Pi) plus **noder** og **agenter**:

- **Gateway (central):** ejer kanaler (Signal/WhatsApp), routing, og sessioner.
- **Nodes (enheder):** Macs/iOS/Android tilsluttes som perifere enheder og udsætter lokale værktøjer (`system.run`, `canvas`, `kamera`).
- **Agenter (arbejdere):** separate hjerner/arbejdsområder til særlige roller (f.eks. "Hetzner ops", "Persondata").
- **Sub-agents:** spawner baggrundsarbejde fra en hovedagent, når du ønsker parallelisme.
- **TUI:** Forbind til porten og skift agenter/sessioner.

Docs: [Nodes](/nodes), [Fjernadgang](/gateway/remote), [Multi-Agent Routing](/concepts/multi-agent), [Sub-agents](/tools/subagents), [TUI](/web/tui).

### Kan OpenClaw browser køre hovedløse

Ja. Det er en config mulighed:

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

Standard er 'falsk' (headful). Hovedløse er mere tilbøjelige til at udløse anti-bot kontrol på nogle websteder. Se [Browser](/tools/browser).

Headless bruger den \*\* samme Chrom motor \*\* og virker for de fleste automatisering (formularer, klik, skrabe, logins). De væsentligste forskelle:

- Intet synligt browservindue (brug skærmbilleder, hvis du har brug for visuelle).
- Nogle steder er strengere om automatisering i hovedløs tilstand (CAPTCHAs, anti-bot).
  For eksempel blokerer X/Twitter ofte hovedløse sessioner.

### Hvordan bruger jeg Brave til browserkontrol

Indstil `browser.executablePath` til din Brave binære (eller en Chrom-baseret browser) og genstart Gateway.
Se de fulde konfigurationseksempler i [Browser](/tools/browser#use-brave-or-another-chromium-based-browser).

## Fjern-gateways og indholdselementer

### Hvordan kommandoer udbrede mellem Telegram porten og knudepunkterne

Telegram beskeder håndteres af **gateway**. Gatewayen kører agenten og
og kalder derefter knudepunkter over **Gateway WebSocket** når et node-værktøj er nødvendigt:

Telegram → Gateway → Agent → `node.*` → Node → Gateway → Telegram

Nodes kan ikke se indgående udbyder trafik; de modtager kun node RPC opkald.

### Hvordan kan min agent få adgang til min computer, hvis Gateway er hostet eksternt

Kort svar: **parre din computer som knude**. Gateway kører andre steder, men det kan
kalde `node.*` værktøjer (skærm, kamera, system) på din lokale maskine over Gateway WebSocket.

Typisk opsætning:

1. Kør Gateway på den altid-on-vært (VPS/hjemmeserver).
2. Sæt Gateway vært + din computer på den samme hale.
3. Sørg for, at Gateway WS er tilgængelig (tailnet bind eller SSH tunnel).
4. Åbn macOS appen lokalt og tilslut i \*\*Remote over SSH \*\*-tilstand (eller direkte tailnet)
   , så den kan registrere sig som en node.
5. Godkend indholdselementet på Gateway:

   ```bash
   openclaw nodes pending
   openclaw nodes approve <requestId>
   ```

Ingen separat TCP bro er påkrævet; knudepunkter forbinde over Gateway WebSocket.

Sikkerhedspåmindelse: parring af en macOS node tillader `system.run` på denne maskine. Kun
par enheder, du stoler på, og gennemgå [Security](/gateway/security).

Docs: [Nodes](/nodes), [Gatewayprotokol] (/gateway/protocol), [MacOS remote mode](/platforms/mac/remote), [Security](/gateway/security).

### Skræddersy er tilsluttet, men jeg får ingen svar Hvad nu

Tjek det grundlæggende:

- Gateway kører: `openclaw gateway status`
- Gateway health: `openclaw status`
- Kanal sundhed: `openclaw channels status`

Kontroller derefter auth og routing:

- Hvis du bruger Tailscale Serve, så sørg for `gateway.auth.allowTailscale` er indstillet korrekt.
- Hvis du tilslutter via SSH-tunnel, skal du bekræfte, at den lokale tunnel er oppe og peger i den rigtige havn.
- Bekræft dine tilladelseslister (DM eller gruppe) inkluderer din konto.

Docs: [Tailscale](/gateway/tailscale), [Fjernadgang] (/gateway/remote), [Channels](/channels).

### Kan to OpenClaw instanser tale med hinanden lokale VPS

Ja. Der er ingen indbygget "bot-to-bot" bro, men du kan wire det op på nogle få
pålidelige måder:

**Enkelt:** Brug en normal chatkanal, begge bots kan tilgå (Telegram/Slack/WhatsApp).
Har Bot A sende en besked til Bot B, så lad Bot B svar som normalt.

**CLI bro (generisk):** Kør et script, der kalder den anden Gateway med
`openclaw agent --message ... --deliver`, målrette en chat, hvor den anden bot
lytter. Hvis én bot er på en ekstern VPS, skal du pege på din CLI på den eksterne Gateway
via SSH/Tailscale (se [Fjernadgang] (/gateway/remote).

Eksempel mønster (køre fra en maskine, der kan nå målet Gateway):

```bash
openclaw agent --message "Hej fra lokal bot" --deliver --channel telegram --reply-to <chat-id>
```

Tip: tilføje en guardrail så de to bots ikke løkke uendeligt (navnlig, kanal
tillader, eller en "ikke svare på bot meddelelser" regel).

Docs: [Fjernadgang](/gateway/remote), [Agent CLI](/cli/agent), [Agent send](/tools/agent-send).

### Behøver jeg separate VPSes til flere agenter

Nej. En Gateway kan være vært for flere agenter, hver med sit eget arbejdsområde, model standardindstillinger,
og routing. Det er den normale opsætning, og det er meget billigere og enklere end at køre
en VPS pr. agent.

Brug kun separate VPS'er, når du har brug for hård isolation (sikkerhedsgrænser) eller meget
forskellige konfigurationer, som du ikke ønsker at dele. Ellers skal der beholdes en Gateway og
bruge flere agenser eller underagenter.

### Er der en fordel at bruge en node på min personlige bærbare computer i stedet for SSH fra en VPS

Ja - knudepunkter er førsteklasses måde at nå din bærbare computer fra en ekstern Gateway, og de
låser op for mere end shell adgang. Gateway kører på macOS / Linux (Windows via WSL2) og er
letvægts (en lille VPS eller Raspberry Pi-class boks er fin; 4 GB RAM er plenty), så en fælles
opsætning er en altid vært plus din bærbare computer som en node.

- **Ingen indgående SSH krævet.** Knuder forbinder ud til Gateway WebSocket og brug enhedsparring.
- **Sikker udførelse kontroller.** `system.run` er gated af node allowlists/godkendelser på den bærbare computer.
- **Flere enhedsværktøjer.** Nodes udsætter `canvas`, `kamera`, og `skærm` ud over `system.run`.
- \*\*Lokal browserautomatisering. \* Hold porten på en VPS, men kør Chrome lokalt og relæ kontrol
  med Chrome udvidelse + en node vært på den bærbare computer.

SSH er fint for ad-hoc shell adgang, men knudepunkter er enklere for igangværende agent arbejdsgange og
enhed automatisering.

Docs: [Nodes](/nodes), [Nodes CLI] (/cli/nodes), [Chrome-udvidelse] (/tools/chrome-extension).

### Skal jeg installere på en anden bærbar computer eller bare tilføje en node

Hvis du kun har brug for **lokale værktøjer** (skærm/kamera/eksekvere) på den anden bærbare computer, så tilføj den som en
**node**. Det holder en enkelt Gateway og undgår duplikeret config. Lokale nodeværktøjer er
i øjeblikket makOS-kun, men vi planlægger at udvide dem til andre OS'er.

Installer kun en anden Gateway, når du har brug for **hård isolation** eller to fuldt separate bots.

Docs: [Nodes](/nodes), [Nodes CLI](/cli/nodes), [Multiple gateways](/gateway/multiple-gateways).

### Do nodes run a gateway service (Automatic Copy)

Nej. Kun **én gateway** bør køre pr. vært, medmindre du forsætligt kører isolerede profiler (se [Flere gateways](/gateway/multiple-gateways)). Knuder er perifere enheder, der forbinder
til gatewayen (iOS/Android-knudepunkter eller macOS "nodetilstand" i menulinjens app). For headless node
værter og CLI kontrol, se [Node host CLI](/cli/node).

En fuld genstart er påkrævet for ændringer i `gateway`, `discovery`, og \`canvasHost'.

### Er der en API RPC måde at anvende config

Ja. `config.apply` validerer + skriver den fulde config og genstarter Gateway som en del af operationen.

### configapply udslettet min config Hvordan gendanner jeg og undgå dette

`config.apply` erstatter **hele konfigurationen**. Hvis du sender et delvist objekt, er alt
andet fjernet.

Gendannelse:

- Gendan fra backup (git eller en kopieret `~/.openclaw/openclaw.json`).
- Hvis du ikke har nogen backup, re-run `openclaw doctor` og omkonfigurere kanaler / modeller.
- Hvis dette var uventet, skal du indsende en fejl og inkludere din sidste kendte config eller backup.
- En lokal kodning agent kan ofte rekonstruere en fungerende config fra logfiler eller historie.

Undgå det:

- Brug `openclaw config sæt` for små ændringer.
- Brug 'openclaw configure' til interaktive redigeringer.

Dokumenter: [Config](/cli/config), [Configure](/cli/configure), [Doctor](/gateway/doctor).

### Hvad er en minimal sane config for en første installation

```json5
{
  agents: { defaults: { workspace: "~/.openclaw/workspace" } },
  channels: { whatsapp: { allowFrom: ["+15555550123"] } },
}
```

Dette indstiller dit arbejdsområde og begrænser hvem der kan udløse boten.

### Hvordan har jeg oprettet Tailscale på en VPS og oprette forbindelse fra min Mac

Minimale trin:

1. **Installer + login på VPS**

   ```bash
   curl -fsSL https://tailscale.com/install.sh ¤ sh
   sudo tailscale up
   ```

2. **Installer + login på din Mac**
   - Brug Tailscale app'en og log ind på den samme hale.

3. **Aktiver MagicDNS (anbefalet)**
   - I Tailscale admin konsollen skal du aktivere MagicDNS, så VPS har et stabilt navn.

4. **Brug halenets værtsnavn**
   - SSH: `ssh user@your-vps.tailnet-xxxx.ts.net`
   - Gateway WS: `ws://your-vps.tailnet-xxxx.ts.net:18789`

Hvis du ønsker Control UI uden SSH, skal du bruge Tailscale Serve på VPS:

```bash
openclaw gateway --tailscale serve
```

Dette holder gateway bundet til loopback og udsætter HTTPS via Tailscale. Se [Tailscale](/gateway/tailscale).

### Hvordan kan jeg tilslutte en Mac node til en ekstern Gateway Tailscale Serve

Serveres udsætter **Gateway Control UI + WS**. Knuder forbinder over det samme Gateway WS endepunkt.

Anbefalet opsætning:

1. **Sørg for, at VPS + Mac er på det samme halen**.
2. \*\*Brug macOS appen i fjerntilstand \*\* (SSH mål kan være tailnet værtsnavn).
   Appen vil tunnelen Gateway porten og forbinde som en knude.
3. **Godkend indhold** på gateway:

   ```bash
   openclaw nodes pending
   openclaw nodes approve <requestId>
   ```

Docs: [Gateway protocol](/gateway/protocol), [Discovery](/gateway/discovery), [macOS remote mode](/platforms/mac/remote).

## Env vars and .env loading

### Hvordan gør OpenClaw belastning miljø variabler

OpenClaw læser miljøvariabler fra forældreprocessen (shell, launchd/systemd, CI, osv.) og desuden belastning:

- `.env` fra den aktuelle arbejdsmappe
- en global fallback `.env` fra `~/.openclaw/.env` (alias `$OPENCLAW_STATE_DIR/.env`)

Ingen af `.env`-filerne overskriver eksisterende miljøvariabler.

Du kan også definere inline env vars i config (anvendes kun, hvis der mangler i processen env):

```json5
{
  env: {
    OPENROUTER_API_KEY: "sk-or-...",
    vars: { GROQ_API_KEY: "gsk-..." },
  },
}
```

Se [/environment](/help/environment) for fuld præcedens og kilder.

### Jeg startede Gateway via tjenesten og min env vars forsvandt Hvad nu

To fælles rettelser:

1. Sæt de manglende nøgler i `~/.openclaw/.env` så de er samlet op, selv når tjenesten ikke arver din shell env.
2. Aktiver shell import (opt-in bekvemmelighed):

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

Dette kører din login-skal og importerer kun manglende forventede nøgler (aldrig tilsidesættelse). Env var ækvivalenter:
`OPENCLAW_LOAD_SHELL_ENV=1`, `OPENCLAW_SHELL_ENV_TIMEOUT_MS=15000`.

### Jeg indstiller COPILOTGITHUBTOKEN men modeller status viser Shell slukke Hvorfor

`openclaw model status` rapporterer, om **shell env import** er aktiveret. "Shell env: off"
betyder **ikke** din env vars mangler - det betyder blot, at OpenClaw ikke vil indlæse
din login shell automatisk.

Hvis Gateway kører som en tjeneste (launchd/systemd), vil det ikke arve dit shell
miljø. Løs ved at gøre en af disse:

1. Sæt token i `~/.openclaw/.env`:

   ```
   COPILOT_GITHUB_TOKEN=...
   ```

2. Eller aktiver shell import (`env.shellEnv.enabled: true`).

3. Eller tilføj den til din konfiguration 'env' blok (gælder kun, hvis mangler).

Genstart derefter porten og kontrol:

```bash
openclaw models status
```

Copilot tokens læses fra `COPILOT_GITHUB_TOKEN` (også `GH_TOKEN` / `GITHUB_TOKEN`).
Se [/concepts/model-providers](/concepts/model-providers) og [/environment](/help/environment).

## Sessioner og flere chats

### Hvordan starter jeg en ny samtale

Send `/new` eller `/reset` som en selvstændig besked. Se [Session management](/concepts/session).

### Nulstil sessioner automatisk, hvis jeg aldrig sender ny

Ja. Sessioner udløber efter `session.idleMinutes` (standard **60**). Meddelelsen **næste**
starter et nyt sessions-id for den pågældende chat-nøgle. Dette sletter ikke
transkripter - det starter bare en ny session.

```json5
{
  session: {
    idleMinutes: 240,
  },
}
```

### Er der en måde at gøre et team af OpenClaw tilfælde en CEO og mange agenter

Ja, via **multi-agent routing** og **sub-agenter**. Du kan oprette en koordinator
agent og flere medarbejdere med deres egne arbejdsområder og modeller.

Når det er sagt, er dette bedst ses som et **sjovt eksperiment**. Det er token tung og ofte
mindre effektiv end ved hjælp af en bot med separate sessioner. Den typiske model, vi
envision er en bot du taler med, med forskellige sessioner for parallelt arbejde. At
bot også kan spawne underagenter når det er nødvendigt.

Docs: [Multi-agent routing](/concepts/multi-agent), [Sub-agents](/tools/subagents), [Agenter CLI](/cli/agents).

### Hvorfor kontekst få trunkeret midopgave Hvordan kan jeg forhindre det

Sessionskontekst er begrænset af modelvinduet. Lange chats, store værktøjsudgange eller mange
filer kan udløse komprimering eller trunkering.

Hvad hjælper:

- Bed bot om at opsummere nuværende tilstand og skrive den til en fil.
- Brug `/compact` før lange opgaver, og `/new` når du skifter emner.
- Hold vigtig kontekst i arbejdsområdet og bed botten om at læse den tilbage.
- Brug underagenter til langt eller parallelt arbejde, så hovedchatten forbliver mindre.
- Vælg en model med et større kontekstvindue, hvis dette sker ofte.

### Hvordan kan jeg helt nulstille OpenClaw men holde det installeret

Brug kommandoen nulstilling:

```bash
openclaw reset
```

Ikke-interaktiv fuld nulstilling:

```bash
openclaw reset -- scope full -- yes --non-interactive
```

Derefter skal du køre om bord:

```bash
openclaw onboard --install-daemon
```

Noter:

- Onboarding-guiden tilbyder også **Nulstil** hvis den ser en eksisterende konfiguration. Se [Wizard](/start/wizard).
- Hvis du brugte profiler (`-- profile` / `OPENCLAW_PROFILE`), nulstilles hver tilstandsfejl (standardindstillinger er `~/.openclaw-<profile>`).
- Dev reset: `openclaw gateway --dev --reset` (dev-only; wipes dev config + legitimationsoplysninger + sessioner + arbejdsområde).

### Im få kontekst for store fejl, hvordan kan jeg nulstille eller kompakt

Brug en af disse:

- **Kompakt** (holder samtalen, men opsummerer ældre drejninger):

  ```
  /kompakt
  ```

  eller `/compact <instructions>` til vejledning af resuméet.

- **Nulstil** (frisk sessions-ID for den samme chatnøgle):

  ```
  /ny
  /reset
  ```

Hvis det bliver ved med at:

- Aktiver eller tune **sessions beskæring** (`agents.defaults.contextPruning`) for at trimme det gamle værktøjs output.
- Brug en model med et større kontekstvindue.

Docs: [Compaction](/concepts/compaction), [sessionsbeskæring] (/concepts/session-pruning), [sessionsstyring] (/concepts/session).

### Hvorfor ser jeg LLM anmodning afvist beskederNcontentXtooluseinput felt kræves

Dette er en valideringsfejl: Modellen udsendte en 'tool_use'-blok uden den krævede
`input`. Det betyder normalt, at sessionshistorikken er forsvundet eller ødelagt (ofte efter lange tråde
eller et værktøj / schema ændring).

Fix: Start en ny session med `/new` (standalone besked).

### Hvorfor får jeg hjerteslag beskeder hvert 30. minut

Hjertebanken kører som standard hver **30m**. Tune eller deaktivere dem:

```json5
{
  agenter: {
    standard: {
      hjerteslag: {
        hver: "2h", // eller "0m" for at deaktivere
      },
    },
  },
}
```

Hvis `HEARTBEAT. d` eksisterer, men er effektivt tom (kun tomme linjer og markdown
overskrifter som `# Overskrift`), OpenClaw springer hjerteslag køre for at gemme API opkald.
Hvis filen mangler, kører heartbeat stadig, og modellen beslutter, hvad der skal gøres.

Per-agent tilsidesætter bruge 'agents.list[].heartbeat\`. Dokumenter: [Heartbeat](/gateway/heartbeat).

### Skal jeg tilføje en bot konto til en WhatsApp gruppe

Nej. OpenClaw kører på \*\* din egen konto \*\*, så hvis du er i gruppen, OpenClaw kan se det.
Som standard blokeres gruppesvar indtil du tillader afsendere (`groupPolicy: "allowlist"`).

Hvis du kun vil have **du** til at kunne udløse gruppesvar:

```json5
{
  kanaler: {
    whatsapp: {
      groupPolicy: "allowlist",
      groupAllowFra: ["+15551234567"],
    },
  },
}
```

### Hvordan får jeg JID for en WhatsApp gruppe

Mulighed 1 (hurtigst): hale logs og sende en testmeddelelse i gruppen:

```bash
openclaw logs -- follow -- json
```

Kig efter `chatId` (eller `fra`) slutter i `@g.us`, som:
`1234567890-1234567890@g.us`.

Indstilling 2 (hvis allerede konfigureret/tilladt): liste grupper fra config:

```bash
openclaw directory grupper liste -- channel whatsapp
```

Dokumenter: [WhatsApp](/channels/whatsapp), [Directory](/cli/directory), [Logs](/cli/logs).

### Hvorfor ikke OpenClaw svar i en gruppe

To almindelige årsager:

- Omtale gating er slået til (standard). Du skal @mention bot (eller matche `mentionPatterns`).
- Du konfigurerede `channels.whatsapp.groups` uden `"*"` og gruppen er ikke tilladt.

Se [Groups](/channels/groups) og [Gruppemeddelelser] (/channels/group-messages).

### Do groupsthreads dele kontekst med DMs

Direkte chats kollapse til hovedsessionen som standard. Grupper/kanaler har deres egne sessionsnøgler, og Telegram emner / Discord tråde er separate sessioner. Se [Groups](/channels/groups) og [Gruppemeddelelser] (/channels/group-messages).

### Hvor mange arbejdsområder og agenter jeg kan oprette

Ingen hårde grænser. Snesevis (selv hundreder) er fine, men pas på:

- **Diskvækst:** sessioner + transkripter lever under `~/.openclaw/agents/<agentId>/sessions/`.
- **Token omkostninger:** flere agenter betyder mere samtidig brug af modeller.
- **Udelukker overhead:** Auth profiler, arbejdsområder og kanalrouting.

Tips:

- Behold et **aktiv** arbejdsområde pr. agent (`agents.defaults.workspace`).
- Fortryd gamle sessioner (slet JSONL eller gem indgange), hvis disken vokser.
- Brug `openclaw doktor` til at spotte omstrejfende arbejdsområder og profil uoverensstemmelser.

### Kan jeg køre flere bots eller chats på samme tid Slack og hvordan skal jeg sætte det op

Ja. Brug **Multi-Agent Routing** til at køre flere isolerede agenter og rute indgående beskeder af
kanal/konto/peer. Slack understøttes som en kanal og kan være bundet til specifikke agenter.

Browseradgang er kraftfuld, men ikke "gøre noget menneskeligt kan" - anti-bot, CAPTCHAs, og MFA kan
stadig blokere automatisering. For den mest pålidelige browser kontrol, skal du bruge Chrome extension relay
på den maskine, der kører browseren (og holde Gateway hvor som helst).

Opsætning af bedste praksis:

- Always-on Gateway vært (VPS/Mac mini).
- Én agent pr. rolle (bindinger).
- Slack channel(s) bundet til disse agenser.
- Lokal browser via udvidelse relay (eller en node) når det er nødvendigt.

Docs: [Multi-Agent Routing](/concepts/multi-agent), [Slack](/channels/slack),
[Browser](/tools/browser), [Chrome extension](/tools/chrome-extension), [Nodes](/nodes).

## Modeller: standardindstillinger, udvælgelse, aliaser, skift

### Hvad er standardmodellen

OpenClaw's standard model er hvad du har angivet som:

```
agents.defaults.model.primary
```

Modeller refereres til som `provider/model` (eksempel: `anthropic/claude-opus-4-6`). Hvis du udelader udbyderen, antager OpenClaw i øjeblikket `antropisk` som en midlertidig udfasning fallback - men du bør stadig **eksplicitt** sætte `provider/model`.

### Hvilken model anbefaler du

**Anbefalet standard:** `anthropic/claude-opus-4-6`.
**Godt alternativ:** `antropisk/claude-sonnet-4-5`.
**Pålidelig (mindre karakter):** `openai/gpt-5.2` - næsten lige så god som Opus, bare mindre personlighed.
**Budget:** `zai/glm-4.7`.

MiniMax M2.1 har sine egne dokumenter: [MiniMax](/providers/minimax) og
[Lokale modeller] (/gateway/local-models).

Regel for tommelfinger: Brug den \*\* bedste model, du kan betale\*\* for high-stakes arbejde, og en billigere
model til rutinemæssig chat eller resuméer. Du kan rute modeller pr agent og bruge sub-agenter til
parallelisere lange opgaver (hver sub-agent bruger tokens). Se [Models](/concepts/models) og
[Sub-agents](/tools/subagents).

Stærk advarsel: svagere/overkvantiserede modeller er mere sårbare over for hurtig
injektion og usikker adfærd. Se [Security](/gateway/security).

Mere kontekst: [Models](/concepts/models).

### Kan jeg bruge selvhostede modeller llamacpp vLLM Ollama

Ja. Hvis din lokale server udsætter en OpenAI-kompatibel API, kan du pege en
brugerdefineret udbyder på den. Ollama understøttes direkte og er den nemmeste vej.

Sikkerhedsbemærkning: mindre eller stærkt kvantiserede modeller er mere sårbare over for hurtig
injektion. Vi anbefaler kraftigt **store modeller** for enhver bot, der kan bruge værktøjer.
Hvis du stadig vil have små modeller, kan du aktivere sandboxing og strenge værktøjer.

Dokumenter: [Ollama](/providers/ollama), [Lokale modeller] (/gateway/local-models),
[Modeludbydere](/concepts/model-providers), [Security](/gateway/security),
[Sandboxing](/gateway/sandboxing).

### Hvordan kan jeg skifte modeller uden at tørre min config

Brug **modelkommandoer** eller rediger kun **model**-felterne. Undgå fuld config erstatninger.

Sikker valgmuligheder:

- `/model` i chat (hurtig, per session)
- `openclaw modeller sæt ...` (opdateringer bare model config)
- `openclaw configure -- section model` (interaktiv)
- redigere `agents.defaults.model` i `~/.openclaw/openclaw.json`

Undgå `config.apply` med en delvis objekt, medmindre du har til hensigt at erstatte hele konfigurationen.
Hvis du har overskrevet config, gendanne fra backup eller re-run `openclaw doctor` at reparere.

Dokumenter: [Models](/concepts/models), [Configure](/cli/configure), [Config](/cli/config), [Doctor](/gateway/doctor).

### Hvad gør OpenClaw, Flawd, og Krill bruge til modeller

- **OpenClaw + fold:** Antropisk Opus (`antropic/claude-opus-4-6`) - se [Anthropic](/providers/anthropic).
- **Krill:** MiniMax M2.1 (`minimax/MiniMax-M2.1`) - see [MiniMax](/providers/minimax).

### Hvordan kan jeg skifte modeller på fluen uden at genstarte

Brug kommandoen `/model` som en selvstændig meddelelse:

```
/model sonnet
/model haiku
/model opus
/model gpt
/model gpt-mini
/model gemini
/model gemini-flash
```

Du kan liste tilgængelige modeller med `/model`, `/model list`, eller `/model status`.

`/model` (og `/model list`) viser en kompakt, nummereret vælger. Vælg efter antal:

```
/model 3
```

Du kan også gennemtvinge en specifik auth profil for udbyderen (per session):

```
/model opus@anthropic:default
/model opus@anthropic:work
```

Tip: `/model status` viser hvilken agent der er aktiv, hvilken `auth-profiles.json` fil der bruges, og hvilken auth profil der vil blive afprøvet næste.
Det viser også den konfigurerede udbyder endpoint (`baseUrl`) og API mode (`api`) når tilgængelig.

**Hvordan frigør jeg en profil, jeg har indstillet med profil**

Genkør `/model` **uden** suffikset `@profile`:

```
/model antropisk/claude-opus-4-6
```

Hvis du ønsker at vende tilbage til standarden, skal du vælge den fra `/model` (eller sende `/model <default provider/model>`).
Brug `/model status` for at bekræfte, hvilken auth profil der er aktiv.

### Kan jeg bruge GPT 5.2 til daglige opgaver og Codex 5.3 til kodning

Ja. Sæt en som standard og skift efter behov:

- **Hurtig kontakt (pr. session):** `/model gpt-5.2` for daglige opgaver, `/model gpt-5.3-codex` for kodning.
- **Standard + switch:** sæt `agents.defaults.model.primary` til `openai/gpt-5.2`, skift derefter til `openai-codex/gpt-5.3-codex` ved kodning (eller den anden vej rundt).
- **Underagenter:** Rutekodningsopgaver til underagenter med en anden standardmodel.

Se [Models](/concepts/models) og [Slash kommandoer] (/tools/slash-commands).

### Hvorfor ser jeg Model er ikke tilladt og så ingen svar

Hvis `agents.defaults.models` er indstillet, bliver det **tilladt** for `/model` og enhver
session tilsidesættelser. Valg af en model, der ikke er i listen returnerer:

```
Model "provider/model" is not allowed. Use /model to list available models.
```

Denne fejl returneres **i stedet for** et normalt svar. Fix: Tilføj modellen til
`agents.defaults.models`, fjern tilladelseslisten, eller vælg en model fra `/model liste`.

### Hvorfor ser jeg ukendte modelminimaxMiniMaxM21

Det betyder, at **udbyderen ikke er konfigureret** (ingen MiniMax udbyder konfiguration eller auth
profil blev fundet), så modellen kan ikke løses. En rettelse til denne detektion er
i **2026.1.12** (ikke frigivet på skrivetidspunktet).

Ret tjekliste:

1. Opgrader til **2026.1.12** (eller kør fra kilde `main`), og genstart derefter gatewayen.
2. Sørg for, at MiniMax er konfigureret (guiden eller JSON), eller at en MiniMax API-nøgle
   findes i env/auth profiler, så udbyderen kan injiceres.
3. Benyt det nøjagtige model-id (case-sensitiv): 'minimax/MiniMax-M2.1' eller
   'minimax/MiniMax-M2.1-lightning'.
4. Run:

   ```bash
   openclaw models list
   ```

   og vælg fra listen (eller `/model listen` i chat).

Se [MiniMax](/providers/minimax) og [Models](/concepts/models).

### Kan jeg bruge MiniMax som standard og OpenAI til komplekse opgaver

Ja. Brug **MiniMax som standard** og skift modeller **per session** efter behov.
Fallbacks er for \*\*fejl \*\*, ikke "hårde opgaver", så brug `/model` eller en separat agent.

**Mulighed A: skift pr. session**

```json5
{
  env: { MINIMAX_API_KEY: "sk-...", OPENAI_API_KEY: "sk-... },
  agenter: {
    defaults: {
      model: { primary: "minimax/MiniMax-M2. " },
      modeller: {
        "minimax/MiniMax-M2. ": { alias: "minimax" },
        "openai/gpt-5. ": { alias: "gpt" },
      },
    },
  },
}
```

Derefter:

```
/model gpt
```

**Mulighed B: seperate agenter**

- Agent A default: MiniMax
- Agent B standard: OpenAI
- Rute efter agent eller brug `/agent` for at skifte

Dokumenter: [Models](/concepts/models), [Multi-Agent Routing] (/concepts/multi-agent), [MiniMax](/providers/minimax), [OpenAI](/providers/openai).

### Er opus sonnet gpt bygget tin genveje

Ja. OpenClaw skibe et par standard shorthands (kun anvendes når modellen findes i `agents.defaults.models`):

- `opus` → `antropisk/claude-opus-4-6`
- `sonnet` → `antropisk/claude-sonnet-4-5`
- `gpt` → `openai/gpt-5.2`
- `gpt-mini` → `openai/gpt-5-mini`
- `gemini` → `google/gemini-3-pro-preview`
- `gemini-flash` → `google/gemini-3-flash-preview`

Hvis du angiver dit eget alias med samme navn, vinder din værdi.

### Hvordan definerer jeg modelgenveje aliaser

Aliaser kommer fra `agents.defaults.models.<modelId>.alias`. Eksempel:

```json5
{
  agenter: {
    defaults: {
      model: { primary: "anthropic/claude-opus-4-6" },
      -modeller: {
        "anthropic/claude-opus-4-6": { alias: "opus" },
        "anthropic/claude-sonnet-4-5": { alias: "sonnet" },
        "anthropic/claude-haiku-4-5": { alias: "haiku" },
      },
    },
  },
}
```

Så `/model sonnet` (eller `/<alias>` når understøttet) løser til dette model ID.

### Hvordan tilføjer jeg modeller fra andre udbydere som OpenRouter eller ZAI

OpenRouter (pay-per-token; mange modeller):

```json5
{
  agenter: {
    defaults: {
      model: { primary: "openrouter/anthropic/claude-sonnet-4-5" },
      modeller: { "openrouter/anthropic/claude-sonnet-4-5": {} },
    },
  },
  env: { OPENROUTER_API_KEY: "sk-eller-. ." },
}
```

Z.AI (GLM-modeller):

```json5
{
  agenter: {
    defaults: {
      model: { primary: "zai/glm-4. " },
      modeller: { "zai/glm-4. ": {} },
    },
  },
  env: { ZAI_API_KEY: "..." },
}
```

Hvis du refererer til en udbyder/model, men den krævede udbyder nøgle mangler, får du en runtime auth fejl (f. eks. . `Ingen API-nøgle fundet for udbyderen "zai"`).

**Ingen API-nøgle fundet for udbyder efter tilføjelse af en ny agent**

Dette betyder normalt, at den **nye agent** har en tom auth store. Auth er per-agent og
lagres i:

```
~/.openclaw/agents/<agentId>/agent/auth-profiles.json
```

Løsningsmuligheder:

- Kør `openclaw agenter tilføje <id>` og konfigurere auth under guiden.
- Eller kopier `auth-profiles.json` fra hovedagentens `agentDir` til den nye agent's `agentDir`.

Må **ikke** genbruge 'agentDir' på tværs af agenter; det forårsager auth/session kollisioner.

## Modellen mislykkedes og "Alle modeller mislykkedes"

### Hvordan fungerer mislykket

Mislykket sker i to faser:

1. **Auth profil rotation** inden for samme udbyder.
2. **Model‑fallback** til den næste model i `agents.defaults.model.fallbacks`.

Nedkølinger gælder for svigtende profiler (eksponentiel backoff), så OpenClaw kan blive ved med at reagere, selv når en udbyder er rate-begrænset eller midlertidigt svigter.

### Hvad betyder denne fejl

```
Ingen legitimationsoplysninger fundet for profilen "anthropic:default"
```

Det betyder, at systemet forsøgte at bruge den auth profil ID `anthropic:default`, men kunne ikke finde legitimationsoplysninger for det i den forventede auth butik.

### Fix tjekliste for Ingen legitimationsoplysninger fundet for profil antropicdefault

- **Bekræft hvor auth profiler levende** (nye vs gamle stier)
  - Nuværende: `~/.openclaw/agents/<agentId>/agent/auth-profiles.json`
  - Legacy: `~/.openclaw/agent/*` (migreret af `openclaw doctor`)
- **Bekræft din env var er indlæst af Gateway**
  - Hvis du sætter `ANTHROPIC_API_KEY` i din skal, men kør Gateway via systemd/launchd, kan det ikke arve det. Sæt det i `~/.openclaw/.env` eller aktivér `env.shellEnv`.
- **Sørg for, at du redigerer den korrekte agent**
  - Multi-agent opsætninger betyder, at der kan være flere `auth-profiles.json` filer.
- **Sanity-check model/auth status**
  - Brug `openclaw modelstatus` for at se konfigurerede modeller, og om udbydere er autentiske.

**Fix tjekliste for ingen legitimationsoplysninger fundet for profil antropic**

Det betyder, at kørslen er fastgjort til en antropisk auth profil, men Gateway
kan ikke finde det i sin auth butik.

- **Brug en setup-token**
  - Kør `claude setup-token`, derefter indsætte det med `openclaw modeller auth setup-token --provider anthropic`.
  - Hvis token blev oprettet på en anden maskine, brug `openclaw modeller auth paste-token --provider anthropic`.

- **Hvis du ønsker at bruge en API-nøgle i stedet**
  - Sæt `ANTHROPIC_API_KEY` i `~/.openclaw/.env` på **gatewayværten**.
  - Ryd enhver fastgjort rækkefølge, der tvinger en manglende profil:

    ```bash
    openclaw modeller auth orden klar --provider antropisk
    ```

- **Bekræft at du kører kommandoer på gatewayens vært**
  - I fjernbetjening tilstand, auth profiler live på gateway maskine, ikke din bærbare computer.

### Hvorfor gjorde det også prøve Google Gemini og mislykkes

Hvis din model config omfatter Google Gemini som en fallback (eller du skiftede til en Gemini shorthand), OpenClaw vil prøve det under model fallback. Hvis du ikke har konfigureret Google-legitimationsoplysninger, vil du se `Ingen API-nøgle fundet for udbyderen "google"`.

Fix: enten give Google auth, eller fjerne / undgå Google modeller i `agents.defaults.model.fallbacks` / aliaser, så fallback ikke rute der.

**LLM anmodning afvist besked tænkende signatur kræves google antigravity**

Årsag: session historie indeholder \*\* tænkende blokke uden signaturer\*\* (ofte fra
en afbrudt/delvis strøm). Google Antigravity kræver signaturer til at tænke blokke.

Fix: OpenClaw strimler nu usignerede tænkning blokke til Google Antigravity Claude. Hvis det stadig forekommer, så start en **ny session** eller sæt `/thinking off` for den agent.

## Auth profiler: hvad de er, og hvordan man håndterer dem

Relaterede: [/concepts/oauth](/concepts/oauth) (OAuth flows, token storage, multi-account mønstre)

### Hvad er en auth profil

En auth profil er en navngivet legitimationsoplysninger (OAuth eller API-nøgle) bundet til en udbyder. Profiler live i:

```
~/.openclaw/agents/<agentId>/agent/auth-profiles.json
```

### Hvad er typiske profil-id'er

OpenClaw bruger udbyder-præfikserede id'er som:

- `antropic:default` (almindelig, når der ikke findes nogen e-mail-identitet)
- `antropisk:<email>` for OAuth identiteter
- tilpassede id'er du vælger (f.eks. `antropisk:work`)

### Kan jeg styre, hvilken auth profil er prøvet først

Ja. Config understøtter valgfri metadata for profiler og en bestilling pr. udbyder (`auth.order.<provider>`). Dette gør **ikke** gemme hemmeligheder; det kortlægger ID'er til udbyder/tilstand og indstiller rotation rækkefølge.

OpenClaw kan midlertidigt springe en profil, hvis den er i en kort **nedkøling** (hastighedsgrænser/timeouts/auth fejl) eller en længere **deaktiveret** tilstand (fakturering/utilstrækkelig kredit). For at inspicere dette, køre `openclaw modeller status --json` og kontrollere `auth.unusableProfiles`. Tuning: `auth.cooldowns.billingBackoffHours*`.

Du kan også angive en \*\* per-agent \*\* ordre tilsidesættelse (gemt i denne agent `auth-profiles.json`) via CLI:

```bash
# Defaults to the configured default agent (omit --agent)
openclaw models auth order get --provider anthropic

# Lås rotation til en enkelt profil (prøv kun dette)
openclaw modeller auth order set --provider anthropic anthropic:default

# Eller sæt en eksplicit ordre (fallback within provider)
openclaw modeller auth order set --provider anthropic anthropic:work anthropic:default

# Ryd overskrivning (fald tilbage til config auth. rder / round-robin)
openclaw modeller auth order clear --provider anthropic
```

For at målrette et specifikt lægemiddel:

```bash
openclaw modeller auth rækkefølge sæt --provider anthropic --agent vigtigste antropic: standard
```

### OAuth vs API nøgle hvad forskellen

OpenClaw støtter begge:

- **OAuth** udnytter ofte abonnementsadgang (hvis relevant).
- **API-nøgler** brug pay-per-token fakturering.

Guiden understøtter eksplicit antropisk setup-token og OpenAI Codex OAuth og kan gemme API-nøgler til dig.

## Gateway: porte, "allerede kørende" og fjerntilstand

### Hvad port gør Gateway brug

`gateway.port` styrer den enkelt multiplexed port til WebSocket + HTTP (Control UI, hooks, etc.).

Præcedens:

```
--port > OPENCLAW_GATEWAY_PORT > gateway.port > standard 18789
```

### Hvorfor gør openclaw gateway status siger Runtime kører, men RPC sonde mislykkedes

Fordi "kører" er **supervisor's**-visningen (launchd/systemd/schtasks). Den RPC sonde er CLI faktisk forbinder til gateway WebSocket og kalder `status`.

Brug 'openclaw gateway status' og stoler på disse linjer:

- `Probe mål:` (URL den probe faktisk anvendt)
- `Lytte:` (hvad der faktisk er bundet til havnen)
- `Sidste gateway error:` (almindelig rod årsag, når processen er i live, men porten lytter ikke)

### Hvorfor gør openclaw gateway status viser Config cli og Config service forskellige

Du redigerer en konfigurationsfil, mens tjenesten kører en anden (ofte en `-- profile` / `OPENCLAW_ STATE_ DIR` uoverensstemmelse).

Rettelse:

```bash
openclaw gateway install -- force
```

Kør det fra det samme `-- profile` / miljø du vil have tjenesten til at bruge.

### Hvad gør en anden gateway instans er allerede lytter betyde

OpenClaw håndhæver en runtime lås ved at binde WebSocket lytter straks ved opstart (standard `ws://127.0.0.1:18789`). Hvis bindingen mislykkes med `EADDRINUSE`, det kaster `GatewayLockError` angiver en anden instans allerede lytter.

Fix: stop den anden instans, frigøre havnen, eller køre med `openclaw gateway --port <port>`.

### Hvordan kører jeg OpenClaw i fjerntilstand klient forbinder til en Gateway andetsteds

Angiv `gateway.mode: "remote"` og punkt til en ekstern WebSocket URL, eventuelt med en token/password:

```json5
{
  gateway: {
    tilstand: "remote",
    remote: {
      url: "ws://gateway.tailnet:18789",
      token: "your-token",
      password: "your-password",
    },
  },
}
```

Noter:

- `openclaw gateway` starter kun, når `gateway.mode` er `local` (eller du passerer flaget).
- MacOS app ure config fil og skifter tilstande liver, når disse værdier ændres.

### Kontrol UI siger uautoriseret eller holder gentilslutning Hvad nu

Din gateway kører med auth aktiveret (`gateway.auth.*`), men UI sender ikke det matchende token / password.

Fakta (fra kode):

- Den Control UI gemmer token i browser localStorage nøgle `openclaw.control.settings.v1`.

Rettelse:

- Hurtigeste: `openclaw dashboard` (udskriver + kopierer dashboard URL, forsøger at åbne; viser SSH hint hvis headles).
- Hvis du ikke har en token endnu: `openclaw læge --generate-gateway-token`.
- Hvis fjernbetjening, tunnel først: `ssh -N -L 18789:127.0.0.1:18789 user@host` derefter åbne `http://127.0.0.1:18789/`.
- Sæt `gateway.auth.token` (eller `OPENCLAW_GATEWAY_TOKEN`) på gatewayværten.
- I Control UI indstillinger, indsæt det samme token.
- Stadig fast? Kør `openclaw status --all` og følg [Troubleshooting](/gateway/troubleshooting). Se [Dashboard](/web/dashboard) for auth detaljer.

### Jeg sætter gatewaybind tailnet, men det kan ikke binde intet lytter

`tailnet` bind henter en Tailscale IP fra dine netværksgrænseflader (100.64.0.0/10). Hvis maskinen ikke er på Tailscale (eller grænsefladen er nede), er der intet at binde til.

Rettelse:

- Start Tailscale på denne vært (så det har en 100.x adresse), eller
- Skift til `gateway.bind: "loopback"` / `"lan"`.

Bemærk: `tailnet` er eksplicit. `auto` foretrækker loopback; brug `gateway.bind: "tailnet"` når du vil have en tailnet-only bind.

### Kan jeg køre flere Gateways på samme vært

Normalt ingen - en Gateway kan køre flere messaging kanaler og agenter. Brug kun flere Gateways, når du har brug for redundans (ex: rescue bot) eller hård isolation.

Ja, men du skal isolere:

- `OPENCLAW_CONFIG_PATH` (pr. instans config)
- `OPENCLAW_STATE_DIR` (pr. instans-stat)
- `agents.defaults.workspace` (isolering af arbejdsrum)
- `gateway.port` (unikke porte)

Hurtig opsætning (anbefalet):

- Brug `openclaw --profile <name> …` per instans (auto-create `~/.openclaw-<name>`).
- Angiv en unik `gateway.port` i hver profil config (eller pass `--port` for manuelle kørsler).
- Install a per-profile service: `openclaw --profile <name> gateway install`.

Profiler suffiks servicenavne (`bot.molt.<profile>`; arv `com.openclaw.*`, `openclaw-gateway-<profile>.service`, `OpenClaw Gateway (<profile>)`).
Fuld guide: [Flere gateways](/gateway/multiple-gateways).

### Hvad betyder ugyldig håndtrykskode 1008

Gateway er en **WebSocket server**, og den forventer den allerførste besked til
være en `connect` ramme. Hvis den modtager noget andet, lukker den forbindelsen
med **kode 1008** (politisk overtrædelse).

Almindelige årsager:

- Du åbnede **HTTP** URL'en i en browser (`http://...`) i stedet for en WS-klient.
- Du brugte den forkerte port eller sti.
- En proxy eller tunnel strippet auth headers eller sendt en ikke-Gateway anmodning.

Hurtige rettelser:

1. Brug WS URL: `ws://<host>:18789` (eller `wss://...` hvis HTTPS).
2. Åbn ikke WS-porten i en normal browserfane.
3. Hvis auth er aktiveret, skal du inkludere token/password i 'connect'-rammen.

Hvis du bruger CLI eller TUI, skal URL'en se sådan ud:

```
openclaw tui --url ws://<host>:18789 --token <token>
```

Protocol details: [Gateway protocol](/gateway/protocol).

## Logning og fejlfinding

### Hvor er logs

Fillogger (struktureret):

```
/tmp/openclaw/openclaw-YYYY-MM-DD.log
```

Du kan angive en stabil sti via `logging.file`. Fillogniveau styres af `logging.level`. Konsol verbosity styres af `--verbose` og `logging.consoleLevel`.

Hurtigste loghale:

```bash
openclaw logs --follow
```

Service/supervisor logs (når gateway kører via launchd/systemd):

- macOS: `$OPENCLAW_STATE_DIR/logs/gateway.log` og `gateway.err.log` (standard: `~/.openclaw/logs/...`; profiler bruger `~/.openclaw-<profile>/logs/...`)
- Linux: `journalctl --user -u openclaw-gateway[-<profile>].service -n 200 --no-pager`
- Vinduer: `schtasks /Query /TN "OpenClaw Gateway (<profile>)" /V /FO LIST`

Se [Troubleshooting](/gateway/troubleshooting#log-locations) for mere.

### Hvordan starter jeg med at genstarte Gateway-tjenesten

Brug gateway hjælpere:

```bash
openclaw gateway status
openclaw gateway genstart
```

Hvis du kører gateway manuelt, kan `openclaw gateway --force` genvinde porten. Se [Gateway](/gateway).

### Jeg lukkede min terminal på Windows, hvordan genstarter jeg OpenClaw

Der er **to installationstilstande**:

**1) WSL2 (anbefalet):** Gateway kører inde i Linux.

Åbn PowerShell, indtast WSL, og genstart:

```powershell
wsl
openclaw gateway status
openclaw gateway genstart
```

Hvis du aldrig har installeret tjenesten, skal du starte den i forgrunden:

```bash
openclaw gateway run
```

**2) Indfødte Windows (anbefales ikke):** Gateway kører direkte i Windows.

Åbn PowerShell og kør:

```powershell
openclaw gateway status
openclaw gateway genstart
```

Hvis du kører det manuelt (ingen tjeneste), brug:

```powershell
openclaw gateway run
```

Docs: [Windows (WSL2)](/platforms/windows), [Gateway service runbook](/gateway).

### Porten er oppe men svar aldrig ankomme Hvad skal jeg tjekke

Start med en hurtig helbredsfeje:

```bash
openclaw status
openclaw modeller status
openclaw channels status
openclaw logs --follow
```

Almindelige årsager:

- Model auth ikke indlæst på **gateway host** (tjek `model status`).
- Kanal parring/tilladt blokering svar (tjek kanal config + logs).
- WebChat / Dashboard er åben uden den rigtige token.

Hvis du er fjern, bekræfte tunnel/Tailscale forbindelsen er oppe og at
Gateway WebSocket er opnåelig.

Dokumenter: [Channels](/channels), [Troubleshooting](/gateway/troubleshooting), [Fjernadgang] (/gateway/remote)

### Afbrudt fra gateway ingen grund hvad nu

Dette betyder normalt, at UI mistede WebSocket forbindelse. Tjek:

1. Er Gateway kørende? `openclaw gateway status`
2. Er Gateway sund? `openclaw status`
3. Har UI det rigtige token? `openclaw dashboard`
4. Hvis fjernbetjening, er linket tunnel/Tailscale så op?

Derefter hale logger:

```bash
openclaw logs --follow
```

Docs: [Dashboard](/web/dashboard), [Fjernadgang] (/gateway/remote), [Troubleshooting](/gateway/troubleshooting).

### Telegram setMyCommands mislykkes med netværksfejl Hvad skal jeg kontrollere

Start med logfiler og kanalstatus:

```bash
openclaw kanaler status
openclaw channels logs -- channel telegram
```

Hvis du er på en VPS eller bag en proxy, bekræfte udgående HTTPS er tilladt, og DNS værker.
Hvis Gateway er fjern, så sørg for at du kigger på logs på Gateway værten.

Docs: [Telegram](/channels/telegram), [Fejlfinding i kanalen](/channels/troubleshooting).

### TUI viser ingen output Hvad skal jeg kontrollere

Bekræft først, at porten er tilgængelig, og agenten kan køre:

```bash
openclaw status
openclaw model status
openclaw logs --follow
```

I TUI, bruge `/status` for at se den aktuelle tilstand. Hvis du forventer svar i en chat
kanal, sørg for levering er aktiveret (`/deliver on`).

Docs: [TUI](/web/tui), [Slash kommandoer] (/tools/slash-commands).

### Hvordan stopper jeg helt og holdent derefter starte Gateway

Hvis du har installeret tjenesten:

```bash
openclaw gateway stop
openclaw gateway start
```

Dette standser/starter den **overvågede service** (launchd på macOS, systemd på Linux).
Brug dette, når Gateway kører i baggrunden som en dæmon.

Hvis du kører i forgrunden, skal du stoppe med Ctrl-C, så:

```bash
openclaw gateway run
```

Docs: [Gateway service runbook](/gateway).

### ELI5 openclaw gateway genstart vs openclaw gateway

- `openclaw gateway restart`: genstarter **baggrundstjenesten** (launchd/systemd).
- `openclaw gateway`: kører porten **i forgrunden** for denne terminalsession.

Hvis du har installeret tjenesten, så brug gateway-kommandoerne. Brug 'openclaw gateway', når
du vil have en engangsrunde, forgrundskørsel.

### Hvad er den hurtigste måde at få flere detaljer, når noget mislykkes

Start Gateway med `--verbose` for at få flere konsoldetaljer. Derefter inspicere logfilen for kanal auth, model routing, og RPC fejl.

## Medier og vedhæftede filer

### Min dygtighed genererede en billedePDF, men intet blev sendt

Udgående vedhæftede filer fra agenten skal indeholde en linje »MEDIA:<path-or-url>(på sin egen linje). Se [OpenClaw assistent opsætning](/start/openclaw) og [Agent send](/tools/agent-send).

CLI sender:

```bash
openclaw besked send --target +15555550123 --message "Here you go" --media /path/to/file.png
```

Kontroller også:

- Målkanalen understøtter udgående medier og er ikke blokeret af tilladte lister.
- Filen er inden for udbyderens størrelsesgrænser (billederne er skaleret til max 2048px).

Se [Images](/nodes/images).

## Sikkerhed og adgangskontrol

### Er det sikkert at udsætte OpenClaw til indgående DMs

Behandl indgående DMs som ikke betroet input. Standarder er designet til at reducere risiko:

- Standard opførsel på DM-kompatible kanaler er **parring**:
  - Ukendte afsendere modtager en parringskode; botten behandler ikke deres besked.
  - Godkend med: `openclaw parring godkender <channel> <code>`
  - Afventende anmodninger er begrænset til \*\*3 pr. kanal \*\*; tjek `openclaw parring liste <channel>` hvis en kode ikke ankommer.
- Åbning af DM'er kræver eksplicit opt-in (`dmPolicy: "open"` og allowlist `"*"`).

Kør `openclaw doktor` til overflade risikable DM politikker.

### Er hurtig injektion kun en bekymring for offentlige bots

Nej. Øjeblikkelig injektion er omkring **untrusted content**, ikke kun hvem der kan DM bot.
Hvis din assistent læser eksternt indhold (websøgning/hentning, browsersider, e-mails,
docs, vedhæftede filer, indsatte logfiler), dette indhold kan indeholde instruktioner, der forsøger
for at kapre modellen. Dette kan ske, selvom **du er den eneste afsender**.

Den største risiko er, når værktøjer er aktiveret: modellen kan blive lokket til
exfiltrerende kontekst eller kalde værktøjer på dine vegne. Reducér blastradius ved:

- brug af en skrivebeskyttet eller værktøjs-deaktiveret "læser"-agent til at opsummere ikke-betroet indhold
- holde `web_ search` / `web_ fetch` / `browser` slukket for tool- aktiverede agenter
- sandboxing og strenge værktøj tillader lister

Detaljer: [Security](/gateway/security).

### Skal min bot have sin egen e-mail GitHub konto eller telefonnummer

Ja, for de fleste opsætninger. Isolering af botten med separate konti og telefonnumre
reducerer blast radius, hvis noget går galt. Dette gør det også lettere at rotere
legitimationsoplysninger eller tilbagekalde adgang uden at påvirke dine personlige konti.

Start lille. Giv kun adgang til de værktøjer og konti, du faktisk har brug for, og udvid
senere, hvis det kræves.

Dokumenter: [Security](/gateway/security), [Pairing](/channels/pairing).

### Kan jeg give det autonomi over mine tekstbeskeder og er det sikre

Vi anbefaler **ikke** fuld autonomi over dine personlige beskeder. Det sikreste mønster er:

- Hold DMs i **parringstilstand** eller en stram tilladelsesliste.
- Brug et \*\* separat nummer eller konto \*\* hvis du vil have det til besked på dine vegne.
- Lad det udkast, så **godkend før du sender**.

Hvis du ønsker at eksperimentere, gør det på en dedikeret konto og holde det isoleret. Se
[Security](/gateway/security)

### Kan jeg bruge billigere modeller til personlig assistent opgaver

Ja, **hvis** agenten er chat-only og input er betroet. Mindre niveauer er
mere modtagelige for instruktion kapring, så undgå dem for værktøjs-aktiverede agenter
eller når du læser ubetroet indhold. Hvis du skal bruge en mindre model, skal du låse ned
værktøjer og køre inde i en sandkasse. Se [Security](/gateway/security).

### Jeg løb start i Telegram men ikke fik en parringskode

Parringskoder sendes **kun**, når en ukendt afsender beskeder botten og
`dmPolicy: "pairing"` er aktiveret. `/start` i sig selv genererer ikke en kode.

Tjek ventende forespørgsler:

```bash
openclaw pairing list telegram
```

Hvis du ønsker øjeblikkelig adgang, tillad dit afsender-id eller sæt `dmPolicy: "open"`
for denne konto.

### WhatsApp vil det sende en besked til mine kontakter Hvordan parring fungerer

Nej. Standard WhatsApp DM politik er **parring**. Ukendte afsendere får kun en parringskode, og deres besked er **ikke behandlet**. OpenClaw svarer kun på chats den modtager eller eksplicit sender dig udløser.

Godkend parring med:

```bash
openclaw pairing approve whatsapp <code>
```

Liste over ventende forespørgsler:

```bash
openclaw pairing list whatsapp
```

Wizard telefonnummer prompt: det bruges til at indstille din **allowlist/owner**, så dine egne DMs er tilladt. Det bruges ikke til auto-afsendelse. Hvis du kører på dit personlige WhatsApp nummer, skal du bruge dette nummer og aktivere `channels.whatsapp.selfChatMode`.

## Chat kommandoer, afbryder opgaver, og "det vil ikke stoppe"

### Hvordan stopper jeg interne systembeskeder fra at vise i chat

De fleste interne beskeder eller værktøjsmeddelelser vises kun, når **verbose** eller **argumentation** er aktiveret
for den pågældende session.

Fix i chaten, hvor du ser det:

```
/verbose off
/ræsonnement off
```

Hvis det stadig er støjende, så tjek sessionsindstillingerne i Control UI og sæt verbose
til **arv**. Bekræft også, at du ikke bruger en bot profil med `verboseDefault` sæt
til `on` i config.

Docs: [Thinking and verbose](/tools/thinking), [Security](/gateway/security#reasoning--verbose-output-in-groups).

### Hvordan stopper jeg en kørende opgave

Send en af disse **som en standalone besked** (ingen skråstreg):

```
stop
abort
esc
vent
exit
interrupt
```

Disse er abort udløsere (ikke skråstreg kommandoer).

For baggrundsprocesser (fra exec værktøjet), kan du bede agenten om at køre:

```
proces handling:kill sessionId:XXX
```

Slash kommandoer overblik: se [Slash kommandoer](/tools/slash-commands).

De fleste kommandoer skal sendes som en **standalone**-besked, der starter med `/`, men nogle få genveje (såsom `/status`) virker også inline for tilladte afsendere.

### Hvordan sender jeg en Discord besked fra Telegram Crosscontext besked nægtet

OpenClaw blokerer **cross-provider** beskeder som standard. Hvis et værktøjsopkald er bundet
til Telegram, vil det ikke sende til Discord medmindre du udtrykkeligt tillader det.

Aktiver meddelelse på tværs af udbydere for agenten:

```json5
{
  agenter: {
    defaults: {
      tools: {
        message: {
          crossContext: {
            allowAcrossProviders: true,
            markør: { aktiveret: true, præfiks: "[from {channel}] " },
          },
        },
      },
    },
  },
}
```

Genstart porten efter redigering af config. Hvis du kun ønsker dette for en enkelt
agent, sæt det under `agents.list[].tools.message` i stedet.

### Hvorfor føles det, som om botten ignorerer hurtige budskaber

Kø tilstand styrer hvordan nye beskeder interagerer med en in-flight kørsel. Brug `/kø` til at ændre tilstande:

- `steer` - nye beskeder omdirigerer den aktuelle opgave
- `opfølgning` - kør beskeder en ad gangen
- `collect` - batchbeskeder og svar en gang (standard)
- `steer-backlog` - styre nu, derefter behandle backlog
- `interrupt` - afbryd nuværende løb og start frisk

Du kan tilføje indstillinger som `debounce:2s cap:25 drop:summarize` for opfølgningstilstande.

## Besvar det nøjagtige spørgsmål fra skærmfotos/chat-loggen

**Q: "Hvad er standardmodellen for antropisk med en API-nøgle?"**

**A:** I OpenClaw, er legitimationsoplysninger og modelvalg adskilt. Indstilling af `ANTHROPIC_API_KEY` (eller lagring af en antropisk API-nøgle i auth profiler) muliggør godkendelse, men den faktiske standardmodel er, hvad du konfigurerer i `agenter. efaults.model.primary` (f.eks. antropic/claude-sonnet-4-5` eller antropic/claude-opus-4-6`). Hvis du ser `Ingen legitimationsoplysninger fundet for profilen "anthropic:default"`, betyder det, at Gateway ikke kunne finde antropiske legitimationsoplysninger i de forventede `auth-profiler. søn` for den agent, der kører.

---

Stadig fast? Spørg i [Discord](https://discord.com/invite/clawd) eller åbn en [GitHub diskussion](https://github.com/openclaw/openclaw/discussions).
