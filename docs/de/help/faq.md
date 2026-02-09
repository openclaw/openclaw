---
summary: "Häufig gestellte Fragen zur Einrichtung, Konfiguration und Nutzung von OpenClaw"
title: "FAQ"
---

# FAQ

Kurze Antworten plus vertiefte Fehlerbehebung für reale Setups (lokale Entwicklung, VPS, Multi-Agent, OAuth/API-Schlüssel, Modell-Failover). Für Laufzeitdiagnosen siehe [Troubleshooting](/gateway/troubleshooting). Für die vollständige Konfigurationsreferenz siehe [Configuration](/gateway/configuration).

## Inhaltsverzeichnis

- [Schnellstart und Ersteinrichtung]
  - [Ich stecke fest – was ist der schnellste Weg, wieder weiterzukommen?](#im-stuck-whats-the-fastest-way-to-get-unstuck)
  - [Was ist der empfohlene Weg, OpenClaw zu installieren und einzurichten?](#whats-the-recommended-way-to-install-and-set-up-openclaw)
  - [Wie öffne ich das Dashboard nach dem Onboarding?](#how-do-i-open-the-dashboard-after-onboarding)
  - [Wie authentifiziere ich das Dashboard (Token) auf localhost vs. remote?](#how-do-i-authenticate-the-dashboard-token-on-localhost-vs-remote)
  - [Welche Runtime benötige ich?](#what-runtime-do-i-need)
  - [Läuft es auf einem Raspberry Pi?](#does-it-run-on-raspberry-pi)
  - [Gibt es Tipps für Raspberry-Pi-Installationen?](#any-tips-for-raspberry-pi-installs)
  - [Es hängt bei „wake up my friend“ / das Onboarding schlüpft nicht. Was nun?](#it-is-stuck-on-wake-up-my-friend-onboarding-will-not-hatch-what-now)
  - [Kann ich mein Setup auf eine neue Maschine (Mac mini) migrieren, ohne das Onboarding erneut zu machen?](#can-i-migrate-my-setup-to-a-new-machine-mac-mini-without-redoing-onboarding)
  - [Wo sehe ich, was in der neuesten Version neu ist?](#where-do-i-see-what-is-new-in-the-latest-version)
  - [Ich kann docs.openclaw.ai nicht erreichen (SSL-Fehler). Was nun?](#i-cant-access-docsopenclawai-ssl-error-what-now)
  - [Was ist der Unterschied zwischen stable und beta?](#whats-the-difference-between-stable-and-beta)
  - [Wie installiere ich die Beta-Version, und was ist der Unterschied zwischen beta und dev?](#how-do-i-install-the-beta-version-and-whats-the-difference-between-beta-and-dev)
  - [Wie probiere ich die neuesten Bits aus?](#how-do-i-try-the-latest-bits)
  - [Wie lange dauern Installation und Onboarding normalerweise?](#how-long-does-install-and-onboarding-usually-take)
  - [Installer hängt? Wie bekomme ich mehr Feedback?](#installer-stuck-how-do-i-get-more-feedback)
  - [Windows-Installation sagt „git nicht gefunden“ oder „openclaw nicht erkannt“](#windows-install-says-git-not-found-or-openclaw-not-recognized)
  - [Die Doku hat meine Frage nicht beantwortet – wie bekomme ich eine bessere Antwort?](#the-docs-didnt-answer-my-question-how-do-i-get-a-better-answer)
  - [Wie installiere ich OpenClaw unter Linux?](#how-do-i-install-openclaw-on-linux)
  - [Wie installiere ich OpenClaw auf einem VPS?](#how-do-i-install-openclaw-on-a-vps)
  - [Wo sind die Cloud-/VPS-Installationsanleitungen?](#where-are-the-cloudvps-install-guides)
  - [Kann ich OpenClaw bitten, sich selbst zu aktualisieren?](#can-i-ask-openclaw-to-update-itself)
  - [Was macht der Onboarding-Assistent eigentlich?](#what-does-the-onboarding-wizard-actually-do)
  - [Benötige ich ein Claude- oder OpenAI-Abonnement, um das zu betreiben?](#do-i-need-a-claude-or-openai-subscription-to-run-this)
  - [Kann ich ein Claude-Max-Abonnement ohne API-Schlüssel nutzen?](#can-i-use-claude-max-subscription-without-an-api-key)
  - [Wie funktioniert die Anthropic-„setup-token“-Authentifizierung?](#how-does-anthropic-setuptoken-auth-work)
  - [Wo finde ich ein Anthropic setup-token?](#where-do-i-find-an-anthropic-setuptoken)
  - [Unterstützen Sie Claude-Abonnement-Authentifizierung (Claude Pro oder Max)?](#do-you-support-claude-subscription-auth-claude-pro-or-max)
  - [Warum sehe ich `HTTP 429: rate_limit_error` von Anthropic?](#why-am-i-seeing-http-429-ratelimiterror-from-anthropic)
  - [Wird AWS Bedrock unterstützt?](#is-aws-bedrock-supported)
  - [Wie funktioniert die Codex-Authentifizierung?](#how-does-codex-auth-work)
  - [Unterstützen Sie OpenAI-Abonnement-Authentifizierung (Codex OAuth)?](#do-you-support-openai-subscription-auth-codex-oauth)
  - [Wie richte ich Gemini CLI OAuth ein?](#how-do-i-set-up-gemini-cli-oauth)
  - [Ist ein lokales Modell für lockere Chats in Ordnung?](#is-a-local-model-ok-for-casual-chats)
  - [Wie halte ich den Traffic zu gehosteten Modellen in einer bestimmten Region?](#how-do-i-keep-hosted-model-traffic-in-a-specific-region)
  - [Muss ich einen Mac mini kaufen, um das zu installieren?](#do-i-have-to-buy-a-mac-mini-to-install-this)
  - [Benötige ich einen Mac mini für iMessage-Unterstützung?](#do-i-need-a-mac-mini-for-imessage-support)
  - [Wenn ich einen Mac mini kaufe, um OpenClaw auszuführen, kann ich ihn mit meinem MacBook Pro verbinden?](#if-i-buy-a-mac-mini-to-run-openclaw-can-i-connect-it-to-my-macbook-pro)
  - [Kann ich Bun verwenden?](#can-i-use-bun)
  - [Telegram: Was gehört in `allowFrom`?](#telegram-what-goes-in-allowfrom)
  - [Können mehrere Personen eine WhatsApp-Nummer mit verschiedenen OpenClaw-Instanzen nutzen?](#can-multiple-people-use-one-whatsapp-number-with-different-openclaw-instances)
  - [Kann ich einen „Fast-Chat“-Agenten und einen „Opus fürs Coden“-Agenten betreiben?](#can-i-run-a-fast-chat-agent-and-an-opus-for-coding-agent)
  - [Funktioniert Homebrew unter Linux?](#does-homebrew-work-on-linux)
  - [Was ist der Unterschied zwischen der hackbaren (git) Installation und der npm-Installation?](#whats-the-difference-between-the-hackable-git-install-and-npm-install)
  - [Kann ich später zwischen npm- und git-Installationen wechseln?](#can-i-switch-between-npm-and-git-installs-later)
  - [Sollte ich den Gateway auf meinem Laptop oder auf einem VPS betreiben?](#should-i-run-the-gateway-on-my-laptop-or-a-vps)
  - [Wie wichtig ist es, OpenClaw auf einer dedizierten Maschine zu betreiben?](#how-important-is-it-to-run-openclaw-on-a-dedicated-machine)
  - [Was sind die minimalen VPS-Anforderungen und das empfohlene Betriebssystem?](#what-are-the-minimum-vps-requirements-and-recommended-os)
  - [Kann ich OpenClaw in einer VM betreiben, und welche Anforderungen gibt es?](#can-i-run-openclaw-in-a-vm-and-what-are-the-requirements)
- [Was ist OpenClaw?](#what-is-openclaw)
  - [Was ist OpenClaw, in einem Absatz?](#what-is-openclaw-in-one-paragraph)
  - [Was ist der Wert Proposition?](#whats-the-value-proposition)
  - [Ich stelle gerade fest, was ich zuerst tun sollte](#i-just-set-it-up-what-should-i-do-first)
  - [Was sind die fünf besten täglichen Anwendungsfälle für OpenClaw](#what-are-the-top-five-everyday-use-cases-for-openclaw)
  - [Kann OpenClaw mit Lead gen Outtreach Anzeigen und Blogs für eine SaaS](#can-openclaw-help-with-lead-gen-outreach-ads-and-blogs-for-a-saas) helfen
  - [Was sind die Vorteile gegenüber Claude Code für Web-Entwicklung?](#what-are-the-advantages-vs-claude-code-for-web-development)
- [Fertigkeiten und Automatisierung](#skills-and-automation)
  - [Wie kann ich Fähigkeiten anpassen, ohne das Repo schmutzig zu halten?](#how-do-i-customize-skills-without-keeping-the-repo-dirty)
  - [Kann ich Fähigkeiten aus einem benutzerdefinierten Ordner laden?](#can-i-load-skills-from-a-custom-folder)
  - [Wie kann ich verschiedene Modelle für verschiedene Aufgaben verwenden?](#how-can-i-use-different-models-for-different-tasks)
  - [Der Bot friert ein, während er schwere Arbeit macht. Wie lade ich das?](#the-bot-freezes-while-doing-heavy-work-how-do-i-offload-that)
  - [Cron oder Erinnerungen feuern nicht. Was soll ich prüfen?](#cron-or-reminders-do-not-fire-what-should-i-check)
  - [Wie installiere ich Fertigkeiten unter Linux?](#how-do-i-install-skills-on-linux)
  - [Kann OpenClaw Aufgaben nach einem Zeitplan ausführen oder im Hintergrund fortlaufen?](#can-openclaw-run-tasks-on-a-schedule-or-continuously-in-the-background)
  - [Kann ich Apple MacOS-only Fähigkeiten von Linux verwenden?](#can-i-run-apple-macos-only-skills-from-linux)
  - [Hast du eine Idee oder eine HeyGen-Integration?](#do-you-have-a-notion-or-heygen-integration)
  - [Wie installiere ich die Chrome-Erweiterung für Browserübernahme?](#how-do-i-install-the-chrome-extension-for-browser-takeover)
- [Sandboxen und Speicher](#sandboxing-and-memory)
  - [Gibt es eine dedizierte Sandbox-Dokument?](#is-there-a-dedicated-sandboxing-doc)
  - [Wie binde ich einen Hostordner in die Sandbox ein?](#how-do-i-bind-a-host-folder-into-the-sandbox)
  - [Wie funktioniert Speicher?](#how-does-memory-work)
  - [Speicher vergisst die Dinge. Wie setze ich es an?](#memory-keeps-forgetting-things-how-do-i-make-it-stick)
  - [Ist Speicher für immer vorhanden? Was sind die Grenzen?](#does-memory-persist-forever-what-are-the-limits)
  - [Benötigt die semantische Speichersuche einen OpenAI-API-Schlüssel?](#does-semantic-memory-search-require-an-openai-api-key)
- [Wo die Dinge auf der Festplatte leben](#where-things-live-on-disk)
  - [Werden alle Daten mit OpenClaw lokal gespeichert?](#is-all-data-used-with-openclaw-saved-locally)
  - [Wo speichert OpenClaw seine Daten?](#where-does-openclaw-store-its-data)
  - [Wo soll AGENTS.md / SOUL.md / USER.md / MEMORY.md live?](#where-should-agentsmd-soulmd-usermd-memorymd-live)
  - [Was ist die empfohlene Backup-Strategie?](#whats-the-recommended-backup-strategy)
  - [Wie deinstalliere ich OpenClaw?](#how-do-i-completely-uninstall-openclaw)
  - [Können Agenten außerhalb des Arbeitsbereichs arbeiten?](#can-agents-work-outside-the-workspace)
  - [Ich bin im Remote-Modus - wo ist der Session-Store?](#im-in-remote-mode-where-is-the-session-store)
- [Grundlagen konfigurieren](#config-basics)
  - [Welches Format ist die Konfiguration? Wo ist sie?](#what-format-is-the-config-where-is-it)
  - [Ich setze `gateway.bind: "lan"` (oder `"tailnet"`) und jetzt hört nichts auf / das UI sagt unautorisiert](#i-set-gatewaybind-lan-or-tailnet-and-now-nothing-listens-the-ui-says-unauthorized)
  - [Warum brauche ich ein Token auf localhost jetzt?](#why-do-i-need-a-token-on-localhost-now)
  - [Muss ich nach dem Ändern der Konfiguration neu starten?](#do-i-have-to-restart-after-changing-config)
  - [Wie aktiviere ich die Web-Suche (und den Web-Abruf)?](#how-do-i-enable-web-search-and-web-fetch)
  - [config.apply hat meine Konfiguration gelöscht. Wie kann ich das wiederherstellen und vermeiden?](#configapply-wiped-my-config-how-do-i-recover-and-avoid-this)
  - [Wie führe ich ein zentrales Gateway mit spezialisierten Arbeitern über Geräte hinweg aus?](#how-do-i-run-a-central-gateway-with-specialized-workers-across-devices)
  - [Kann der OpenClaw-Browser kopflos laufen?](#can-the-openclaw-browser-run-headless)
  - [Wie verwende ich Brave für die Browser-Steuerung?](#how-do-i-use-brave-for-browser-control)
- [Entfernte Gateways und Knoten](#remote-gateways-and-nodes)
  - [Wie propagieren Befehle zwischen Telegram, Gateway und Knoten?](#how-do-commands-propagate-between-telegram-the-gateway-and-nodes)
  - [Wie kann mein Agent auf meinen Computer zugreifen, wenn das Gateway aus der Ferne gehostet ist?](#how-can-my-agent-access-my-computer-if-the-gateway-is-hosted-remotely)
  - [Maßstabstabstabelle ist verbunden, aber ich bekomme keine Antworten. Was nun?](#tailscale-is-connected-but-i-get-no-replies-what-now)
  - [Können zwei OpenClaw-Instanzen miteinander sprechen (lokal + VPS)?](#can-two-openclaw-instances-talk-to-each-other-local-vps)
  - [Brauche ich separate VPSes für mehrere Agenten](#do-i-need-separate-vpses-for-multiple-agents)
  - [Gibt es einen Vorteil, einen Knoten auf meinem persönlichen Laptop anstelle von SSH von einem VPS zu benutzen?](#is-there-a-benefit-to-using-a-node-on-my-personal-laptop-instead-of-ssh-from-a-vps)
  - [Führen Knoten einen Gateway-Dienst aus?](#do-nodes-run-a-gateway-service)
  - [Gibt es eine API / RPC-Möglichkeit, die Konfiguration anzuwenden?](#is-there-an-api-rpc-way-to-apply-config)
  - [Was ist eine minimale "sane" Konfiguration für eine erste Installation?](#whats-a-minimal-sane-config-for-a-first-install)
  - [Wie erstelle ich eine Maßstabskala auf einem VPS und verbinde mich mit meinem Mac?](#how-do-i-set-up-tailscale-on-a-vps-and-connect-from-my-mac)
  - [Wie verbinde ich einen Mac-Knoten mit einem entfernten Gateway (Tailscale Serve)?](#how-do-i-connect-a-mac-node-to-a-remote-gateway-tailscale-serve)
  - [Soll ich auf einem zweiten Laptop installieren oder einfach einen Knoten hinzufügen?](#should-i-install-on-a-second-laptop-or-just-add-a-node)
- [Env vars and .env loading](#env-vars-and-env-loading)
  - [Wie lädt OpenClaw Umgebungsvariablen?](#how-does-openclaw-load-environment-variables)
  - [Ich habe das Gateway über den Dienst gestartet und meine env vars verschwunden." Was nun?](#i-started-the-gateway-via-the-service-and-my-env-vars-disappeared-what-now)
  - [Ich setze `COPILOT_GITHUB_TOKEN`, aber Modelle Status zeigt "Shell env: aus." Warum?](#i-set-copilotgithubtoken-but-models-status-shows-shell-env-off-why)
- [Sitzungen und mehrere Chats](#sessions-and-multiple-chats)
  - [Wie starte ich eine neue Konversation?](#how-do-i-start-a-fresh-conversation)
  - [Sessions werden automatisch zurückgesetzt, wenn ich `/new`?](#do-sessions-reset-automatically-if-i-never-send-new)
  - [Gibt es eine Möglichkeit, ein Team von OpenClaw Instanzen zu einem CEO und vielen Agenten zu machen](#is-there-a-way-to-make-a-team-of-openclaw-instances-one-ceo-and-many-agents)
  - [Warum wurde Kontext Mitte der Aufgabe abgeschnitten? Wie kann ich es verhindern?](#why-did-context-get-truncated-midtask-how-do-i-prevent-it)
  - [Wie setze ich OpenClaw komplett zurück, aber behalte es installiert?](#how-do-i-completely-reset-openclaw-but-keep-it-installed)
  - [Ich bekomme "Kontext zu groß" Fehler - wie kann ich zurücksetzen oder kompakt?](#im-getting-context-too-large-errors-how-do-i-reset-or-compact)
  - [Warum sehe ich "LLM-Anfrage abgelehnt: messages.N.content.X.tool_use.input: Feld erforderlich"?](#why-am-i-seeing-llm-request-rejected-messagesncontentxtooluseinput-field-required)
  - [Warum erhalte ich alle 30 Minuten herzhafte Nachrichten?](#why-am-i-getting-heartbeat-messages-every-30-minutes)
  - [Muss ich ein "Bot-Konto" zu einer WhatsApp-Gruppe hinzufügen?](#do-i-need-to-add-a-bot-account-to-a-whatsapp-group)
  - [Wie erhalte ich die JID einer WhatsApp-Gruppe?](#how-do-i-get-the-jid-of-a-whatsapp-group)
  - [Warum antwortet OpenClaw nicht in einer Gruppe?](#why-doesnt-openclaw-reply-in-a-group)
  - [Teilen Gruppen/Themen den Kontext mit DMs?](#do-groupsthreads-share-context-with-dms)
  - [Wie viele Arbeitsbereiche und Agenten kann ich erstellen?](#how-many-workspaces-and-agents-can-i-create)
  - [Kann ich mehrere Bots oder Chats gleichzeitig ausführen (Slack), und wie soll ich das einrichten?](#can-i-run-multiple-bots-or-chats-at-the-same-time-slack-and-how-should-i-set-that-up)
- [Modelle: Standardeinstellungen, Auswahl, Aliases, Umschalten](#models-defaults-selection-aliases-switching)
  - [Was ist das "Standardmodell"?](#what-is-the-default-model)
  - [Welches Modell empfehlen Sie?](#what-model-do-you-recommend)
  - [Wie wechsele ich Modelle ohne meine Konfiguration zu löschen?](#how-do-i-switch-models-without-wiping-my-config)
  - [Kann ich selbst gehostete Modelle verwenden (llama.cpp, vLLM, Ollama)?](#can-i-use-selfhosted-models-llamacpp-vllm-ollama)
  - [Was verwendet OpenClaw, Fehler und Krill für Modelle?](#what-do-openclaw-flawd-and-krill-use-for-models)
  - [Wie schalte ich Modelle auf die Fliege ein (ohne Neustart)?](#how-do-i-switch-models-on-the-fly-without-restarting)
  - [Kann ich GPT 5.2 für tägliche Aufgaben und Codex 5.3 für die Codierung verwenden](#can-i-use-gpt-52-for-daily-tasks-and-codex-53-for-coding)
  - [Warum sehe ich "Modell … ist nicht erlaubt" und dann keine Antwort?](#why-do-i-see-model-is-not-allowed-and-then-no-reply)
  - [Warum sehe ich "Unbekanntes Modell: minimax/MiniMax-M2.1"?](#why-do-i-see-unknown-model-minimaxminimaxm21)
  - [Kann ich MiniMax als Standard und OpenAI für komplexe Aufgaben verwenden?](#can-i-use-minimax-as-my-default-and-openai-for-complex-tasks)
  - [Sind opus / sonnet / gpt integrierte Tastenkombinationen?](#are-opus-sonnet-gpt-builtin-shortcuts)
  - [Wie kann ich Model-Verknüpfungen definieren/überschreiben (Alias)?](#how-do-i-defineoverride-model-shortcuts-aliases)
  - [Wie füge ich Modelle von anderen Anbietern wie OpenRouter oder Z.AI hinzu?](#how-do-i-add-models-from-other-providers-like-openrouter-or-zai)
- [Model Failover und "Alle Modelle fehlgeschlagen"](#model-failover-and-all-models-failed)
  - [Wie funktioniert das Failover-System?](#how-does-failover-work)
  - [Was bedeutet dieser Fehler?](#what-does-this-error-mean)
  - [Checkliste für `Keine Anmeldeinformationen für Profil gefunden für "anthropic:default"`](#fix-checklist-for-no-credentials-found-for-profile-anthropicdefault)
  - [Warum hat es auch Google Gemini versucht und scheitert?](#why-did-it-also-try-google-gemini-and-fail)
- [Auth Profile: was sie sind und wie sie sie verwalten](#auth-profiles-what-they-are-and-how-to-manage-them)
  - [Was ist ein auth Profil?](#what-is-an-auth-profile)
  - [Was sind typische Profil-IDs?](#what-are-typical-profile-ids)
  - [Kann ich kontrollieren, welches auth Profil zuerst ausprobiert wurde?](#can-i-control-which-auth-profile-is-tried-first)
  - [OAuth vs API-Schlüssel: Was ist der Unterschied?](#oauth-vs-api-key-whats-the-difference)
- [Gateway: Ports, "bereits läuft", und Remote-Modus](#gateway-ports-already-running-and-remote-mode)
  - [Welchen Port benutzt das Gateway?](#what-port-does-the-gateway-use)
  - [Warum sagt `openclaw gateway status` `Runtime: läuft` aber \`RPC Sonde: fehlgeschlagen?](#why-does-openclaw-gateway-status-say-runtime-running-but-rpc-probe-failed)
  - [Warum zeigt `openclaw gateway status` `Config (cli)` und `Config (service)` unterschiedlich?](#why-does-openclaw-gateway-status-show-config-cli-and-config-service-different)
  - [Was bedeutet "eine andere Gateway-Instanz bereits hört" ?](#what-does-another-gateway-instance-is-already-listening-mean)
  - [Wie führe ich OpenClaw im Remote-Modus aus (Client verbindet sich mit einem Gateway anderswo)?](#how-do-i-run-openclaw-in-remote-mode-client-connects-to-a-gateway-elsewhere)
  - [Das Control UI sagt "nicht autorisiert" (oder erneute Verbindung). Was nun?](#the-control-ui-says-unauthorized-or-keeps-reconnecting-what-now)
  - [Ich setze `gateway.bind: "tailnet"` aber es kann nicht binden / nichts listens](#i-set-gatewaybind-tailnet-but-it-cant-bind-nothing-listens)
  - [Kann ich mehrere Gateways auf dem gleichen Host ausführen?](#can-i-run-multiple-gateways-on-the-same-host)
  - [Was bedeutet "ungültiger Handshake" / Code 1008?](#what-does-invalid-handshake-code-1008-mean)
- [Protokollieren und Debuggen](#logging-and-debugging)
  - [Wo sind Logs?](#where-are-logs)
  - [Wie starte ich den Gateway-Dienst?](#how-do-i-startstoprestart-the-gateway-service)
  - [Ich habe mein Terminal unter Windows geschlossen - wie starte ich OpenClaw?](#i-closed-my-terminal-on-windows-how-do-i-restart-openclaw)
  - [Das Gateway ist offen, aber Antworten kommen nie an. Was soll ich prüfen?](#the-gateway-is-up-but-replies-never-arrive-what-should-i-check)
  - ["Keine Verbindung zum Gateway: kein Grund" - was jetzt?](#disconnected-from-gateway-no-reason-what-now)
  - [Telegram setMyCommands schlägt bei Netzwerkfehlern fehl. Was soll ich prüfen?](#telegram-setmycommands-fails-with-network-errors-what-should-i-check)
  - [TUI zeigt keine Ausgabe. Was soll ich prüfen?](#tui-shows-no-output-what-should-i-check)
  - [Wie höre ich vollständig auf und starte dann das Tor?](#how-do-i-completely-stop-then-start-the-gateway)
  - [ELI5: `openclaw gateway restart` vs `openclaw gateway`](#eli5-openclaw-gateway-restart-vs-openclaw-gateway)
  - [Was ist der schnellste Weg, um mehr Details zu erhalten, wenn etwas fehlschlägt?](#whats-the-fastest-way-to-get-more-details-when-something-fails)
- [Medien und Anhänge](#media-and-attachments)
  - [Meine Fähigkeit generierte ein Bild/PDF, aber nichts wurde gesendet](#my-skill-generated-an-imagepdf-but-nothing-was-sent)
- [Sicherheit und Zugriffskontrolle](#security-and-access-control)
  - [Ist es sicher OpenClaw eingehenden DMs auszusetzen?](#is-it-safe-to-expose-openclaw-to-inbound-dms)
  - [Ist eine Injektion nur eine Sorge für öffentliche Bots?](#is-prompt-injection-only-a-concern-for-public-bots)
  - [Sollte mein Bot eine eigene Github Account oder Telefonnummer haben](#should-my-bot-have-its-own-email-github-account-or-phone-number)
  - [Kann ich ihr Autonomie über meine Textnachrichten geben und ist so sicher](#can-i-give-it-autonomy-over-my-text-messages-and-is-that-safe)
  - [Kann ich billigere Modelle für persönliche Assistentenaufgaben verwenden?](#can-i-use-cheaper-models-for-personal-assistant-tasks)
  - [Ich habe `/start` im Telegram ausgeführt, aber keinen Paarcode](#i-ran-start-in-telegram-but-didnt-get-a-pairing-code)
  - [WhatsApp: Wird es meine Kontakte benachrichtigen? Wie funktioniert das Paaren?](#whatsapp-will-it-message-my-contacts-how-does-pairing-work)
- [Chat Befehle, Abbruch von Aufgaben und "es wird nicht stoppen"](#chat-commands-aborting-tasks-and-it-wont-stop)
  - [Wie kann ich die Anzeige interner Systemnachrichten im Chat verhindern](#how-do-i-stop-internal-system-messages-from-showing-in-chat)
  - [Wie kann ich eine laufende Aufgabe stoppen/abbrechen?](#how-do-i-stopcancel-a-running-task)
  - [Wie sende ich eine Discord Nachricht von Telegram? ("Cross-context Nachricht verweigert")](#how-do-i-send-a-discord-message-from-telegram-crosscontext-messaging-denied)
  - [Warum fühlt es sich wie der Bot "ignoriert?](#why-does-it-feel-like-the-bot-ignores-rapidfire-messages)

## Erste 60 Sekunden, wenn etwas kaputt ist

1. **Schnellstatus (erste Prüfung)**

   ```bash
   openclaw status
   ```

   Schnelle lokale Zusammenfassung: OS + Update, Gateway/Service Erreichbarkeit, Agenten/Sitzungen, Provider-Konfiguration + Laufzeitprobleme (wenn Gateway erreichbar ist).

2. **Einfügbarer Bericht (sicher zum Teilen)**

   ```bash
   openclaw Status --all
   ```

   Nur-Lese-Diagnose mit Log-tail (Token redacted).

3. **Daemon + Port-Status**

   ```bash
   openclaw gateway status
   ```

   Zeigt die Supervisor Laufzeit vs RPC Erreichbarkeit, die Sonde Ziel-URL, und welche Konfiguration der Dienst verwendet werden soll.

4. **Tiefsonden**

   ```bash
   openclaw Status --deep
   ```

   Runs Gateway Gesundheitschecks + Providersonden (benötigt ein erreichbares Gateway). Siehe [Health](/gateway/health).

5. **Nutze das neueste Protokoll**

   ```bash
   openclaw logs --follow
   ```

   Wenn RPC nicht erreichbar ist, fallen Sie zurück auf:

   ```bash
   tail -f "$(ls -t /tmp/openclaw/openclaw-*.log | head -1)"
   ```

   Datei-Protokolle sind getrennt von Service-Logs; siehe [Logging](/logging) und [Troubleshooting](/gateway/troubleshooting).

6. **Führe den Arzt (Reparaturen)**

   ```bash
   openclaw doctor
   ```

   Reparatur/migrate config/state + führt Gesundheitschecks aus. Siehe [Doctor](/gateway/doctor).

7. **Gateway snapshot**

   ```bash
   openclaw health --json
   openclaw health --verbose # zeigt die Ziel-URL + den Konfigurationspfad bei Fehlern an
   ```

   Fragt das laufende Gateway nach einem vollständigen Schnappschuss (nur WS). Siehe [Health](/gateway/health).

## Schnellstart und Ersteinrichtung

### Im Steck, was ist der schnellste Weg, um loszulegen

Benutze einen lokalen KI-Agenten, der deinen Computer **sehen kann** kann. Das ist viel effektiver, als
in Discord, zu fragen weil die meisten "Ich bin fest" Fälle **lokale Konfigurations- oder Umgebungsprobleme** sind, die
entfernte Helfer nicht überprüfen können.

- **Claude Code**: [https://www.anthropic.com/claude-code/](https://www.anthropic.com/claude-code/)
- **OpenAI Codex**: [https://openai.com/codex/](https://openai.com/codex/)

Diese Werkzeuge können das Repo lesen, Befehle ausführen, Protokolle inspizieren und dabei helfen, das Setup Ihrer Maschine
zu korrigieren (PATH, Dienste, Berechtigungen, Authentifizierungsdateien). Gib ihnen die **vollständige Quelle-Checkout** via
die hackbare (git) Installation:

```bash
curl -fsSL https://openclaw.ai/install.sh | bash -s -- --install-method git
```

Dies installiert OpenClaw **von einem Git Checkout**, so dass der Agent den Code + Dokumentation und
Grund für die genaue Version lesen kann, die Sie gerade verwenden. Sie können später immer wieder zu stable
wechseln, indem Sie den Installer ohne `--install-method git` erneut ausführen.

Tipp: Bittet den Agenten, die Fixierung **zu planen und zu überwachen** und dann nur die
notwendigen Befehle auszuführen. Das hält Änderungen klein und leichter zu überprüfen.

Wenn du einen echten Fehler oder Fehler entdeckst, schreibe bitte ein GitHub Problem oder sende eine PR:
[https://github.com/openclaw/openclaw/issues](https://github.com/openclaw/openclaw/issues)
[https://github.com/openclaw/openclaw/pulls](https://github.com/openclaw/pulls)

Beginnen Sie mit diesen Befehlen (Ausgabe teilen, wenn Sie um Hilfe bitten):

```bash
openclaw status
openclaw models status
openclaw doctor
```

Was sie tun:

- `openclaw status`: Schnelles Snapshot von Gateway/agent health + basic config.
- 'openclaw models status': prüft den Provider auth + die Verfügbarkeit des Modells.
- `openclaw doctor`: Validiert und repariert übliche config/state Probleme.

Andere nützliche CLI-Prüfungen: `openclaw status --all`, `openclaw logs --follow`,
`openclaw gateway status`, `openclaw health --verbose`.

Schnell-Debug-Schleife: [Erste 60 Sekunden, wenn etwas kaputt ist](#first-60-seconds-if-somethings-broken).
Installiere docs: [Install](/install), [Installer flags](/install/installer), [Updating](/install/updating).

### Was ist die empfohlene Methode, OpenClaw zu installieren und einzurichten

Das Repo empfiehlt, aus der Quelle zu laufen und den Onboarding-Assistenten zu verwenden:

```bash
curl -fsSL https://openclaw.ai/install.sh | bash
openclaw onboard --install-daemon
```

Der Assistent kann auch automatisch UI-Assets erstellen. Nach dem Einsteigen laufen Sie typischerweise das Gateway auf Port **18789**.

Aus Quelle (Mitwirkende/Entwickl):

```bash
git clone https://github.com/openclaw/openclaw.git
cd openclaw
pnpm install
pnpm build
pnpm ui:build # auto-installalls UI deps on first run
openclaw on board
```

Wenn Sie noch keine globale Installation haben, führen Sie sie über `pnpm openclaw onboard` aus.

### Wie kann ich das Dashboard nach dem Einsteigen öffnen

Der Assistent öffnet Ihren Browser mit einer sauberen (nicht-tokenisierten) Dashboard-URL direkt nach dem Einbinden und gibt auch den Link in der Zusammenfassung aus. Diesen Tab öffnen; wenn er nicht startet, kopieren/einfügen Sie die gedruckte URL auf dem gleichen Rechner.

### Wie authentifiziere ich das Dashboard-Token auf localhost vs remote

**Lokalhost (selbe Maschine):**

- Öffne `http://127.0.0.1:18789/`.
- Wenn es nach auth fragt, fügen Sie das Token aus `gateway.auth.token` (oder `OPENCLAW_GATEWAY_TOKEN`) in die Kontroll-UI-Einstellungen ein.
- Rufe es vom Gateway-Host ab: `openclaw config get gateway.auth.token` (oder generiere eins: `openclaw doctor --generate-gateway-token`).

**Nicht auf localhost:**

- **Maßstabsserve** (empfohlen): bind loopback halten, `openclaw gateway --tailscale serve` ausführen, `https://<magicdns>/`. Wenn `gateway.auth.allowTailscale` `true` ist, erfüllen Identitätsheader auth (kein Token).
- **Tailnet bind**: Führen Sie `openclaw gateway --bind tailnet --token "<token>"`, öffnen Sie `http://<tailscale-ip>:18789/`, fügen Sie Token in die Dashboard-Einstellungen ein.
- **SSH Tunnel**: `ssh -N -L 18789:127.0.0.1:18789 user@host` dann öffnen Sie `http://127.0.0.1:18789/` und fügen Sie das Token in die Kontroll-UI-Einstellungen ein.

Siehe [Dashboard](/web/dashboard) und [Web-Oberflächen](/web) für binde Modi und auth Details.

### Welche Laufzeit benötige ich

Knoten **>= 22** ist erforderlich. `pnpm` wird empfohlen. Bun wird **nicht empfohlen** für das Gateway.

### Lauft es auf Raspberry Pi

Ja. Das Gateway ist leichtgewichtig - docs list **512MB-1GB RAM**, **1 core**, und etwa **500MB**
Scheibe als ausreichend für den persönlichen Gebrauch und beachten Sie, dass ein **Raspberry Pi 4 sie ausführen kann**.

Wenn du einen zusätzlichen Headroom (Logs, Medien, andere Dienste) möchtest, wird **2GB empfohlen**, aber es ist ein
kein hartes Minimum.

Tipp: Eine kleine Pi/VPS kann das Gateway beherbergen und du kannst **Knoten** auf deinem Laptop/Telefon für
lokale Bildschirme/Kamera/Leinwand oder Befehlsausführung paaren. Siehe [Nodes](/nodes).

### Alle Tipps für Raspberry Pi Installationen

Kurze Version: es funktioniert, aber erwarten Sie raue Kanten.

- Benutze ein **64-Bit-** Betriebssystem und behalte Knoten >= 22.
- Bevorzugen Sie die **hackable (git)-Installation** damit Sie Logs sehen und schnell aktualisieren können.
- Beginnen Sie ohne Kanäle/Fähigkeiten und fügen Sie sie einzeln hinzu.
- Wenn Sie auf seltsame Binärprobleme stoßen, ist dies normalerweise ein **ARM-Kompatibilität** Problem.

Docs: [Linux](/platforms/linux), [Install](/install).

### Es steckt beim Wecken fest, mein Freund wird nicht ausbrüten, was jetzt

Dieser Bildschirm hängt davon ab, ob das Gateway erreichbar und authentifiziert ist. Die TUI sendet auch
"Wach auf, mein Freund!" automatisch auf der ersten Luke. Wenn du diese Zeile mit **keine Antwort**
siehst und die Tokens bei 0 bleiben, wird der Agent nie rangiert.

1. Gateway neu starten:

```bash
openclaw gateway restart
```

2. Überprüfe Status + Auth:

```bash
openclaw Status
openclaw modelliert den Status
openclaw log --follow
```

3. Wenn es immer noch hängt, laufen:

```bash
openclaw doctor
```

Wenn das Gateway aus der Ferne ist, stellen Sie sicher, dass die Verbindung zwischen Tunnel/Schneiderei und dem Interface
auf das rechte Tor gezeigt wird. Siehe [Remote access](/gateway/remote).

### Kann ich mein Setup auf eine neue Maschine Mac mini migrieren, ohne erneut zu arbeiten

Ja. Kopieren Sie das **Zustandsverzeichnis** und **Workspace**, dann starten Sie Doctor einmal. Diese
hält deinen Bot "genau dasselbe" (Speicher, Sitzungsverlauf, Auth und Kanal
Zustand) solange du **beide** Standorte kopierst:

1. Installieren Sie OpenClaw auf der neuen Maschine.
2. Kopiere `$OPENCLAW_STATE_DIR` (Standard: `~/.openclaw`) von der alten Maschine.
3. Kopieren Sie Ihren Arbeitsbereich (Standard: `~/.openclaw/workspace`).
4. Führe `openclaw doctor` aus und starte den Gateway-Dienst neu.

Damit werden die Konfiguration, die Authentifizierungsprofile, WhatsApp Creds, Sessions und Speicher beibehalten. Wenn Sie im
Remote-Modus sind, merken Sie sich, dass der Gateway-Host den Session-Shop und den Arbeitsbereich besitzt.

**Wichtig:** Wenn du deinen Arbeitsbereich nur auf GitHub überträgst, unterstützst du
**memory + bootstrap Dateien**, aber **nicht** Sitzungsverlauf oder auth. Diese live
unter `~/.openclaw/` (z.B. `~/.openclaw/agents/<agentId>/sessions/`).

Verwandt: [Migrating](/install/migrating), [Wo die Dinge auf der Festplatte leben](/help/faq#where-does-openclaw-store-its-data),
[Agent-Arbeitsbereich](/concepts/agent-workspace), [Doctor](/gateway/doctor),
[Remote-Modus](/gateway/remote).

### Wo sehe ich, was neu in der neuesten Version ist

Prüfe die GitHub Changelog:
[https://github.com/openclaw/openclaw/blob/main/CHANGELOG.md](https://github.com/openclaw/blob/main/CHANGELOG.md)

Neueste Einträge sind ganz oben. Wenn der obere Bereich **Unreleased** markiert ist, ist der nächste datierte
Abschnitt die neueste verschickte Version. Einträge sind nach **Highlights**, **Changes** und
**Fixes** gruppiert (plus docs/other sections wenn nötig).

### Ich kann auf docs.openclaw.ai SSL-Fehler nicht zugreifen. Was jetzt

Einige Comcast/Xfinity-Verbindungen blockieren `docs.openclaw.ai` über Xfinity
Erweiterte Sicherheit. Deaktivieren oder erlaubte Liste `docs.openclaw.ai`, dann erneut versuchen. Mehr
Detail: [Troubleshooting](/help/troubleshooting#docsopenclawai-shows-an-ssl-error-comcastxfinity).
Bitte hilf uns die Blockierung zu entsperren, indem du sie hier meldest: [https://spa.xfinity.com/check_url_status](https://spa.xfinity.com/check_url_status).

Wenn du die Seite noch nicht erreichen kannst, werden die Dokumentation auf GitHub:
[https://github.com/openclaw/openclaw/tree/main/docs](https://github.com/openclaw/openclaw/tree/main/docs) gespiegelt

### Was ist der Unterschied zwischen Stable und Beta

**Stable** und **beta** sind **npm dist-tags**, keine separaten Codezeilen:

- `latest` = stabil
- `beta` = frühzeitiges Build zum Testen

Wir versenden Builds an **Beta**, testen sie und sobald ein Build solide ist, fördern wir die gleiche Version \*\*
zu `latest`\*\*. Das ist der Grund, warum Beta und stable auf die
**gleiche Version** zeigen können.

Schau, was sich geändert hat:
[https://github.com/openclaw/openclaw/blob/main/CHANGELOG.md](https://github.com/openclaw/openclaw/blob/main/CHANGELOG.md)

### Wie installiere ich die Beta-Version und was ist der Unterschied zwischen Beta und dev

**Beta** ist der npm dist-tag `beta` (entspricht möglicherweise `aktuellst`).
**Dev** ist der bewegte Kopf von `main` (git); wenn er veröffentlicht wird, verwendet er den npm dist-tag `dev`.

One-liners (macOS/Linux):

```bash
curl -fsSL --proto '=https' --tlsv1.2 https://openclaw.ai/install.sh | bash -s -- --beta
```

```bash
curl -fsSL --proto '=https' --tlsv1.2 https://openclaw.ai/install.sh | bash -s -- --install-method git
```

Windows Installer (PowerShell):
[https://openclaw.ai/install.ps1](https://openclaw.ai/install.ps1)

Mehr Detail: [Entwicklungskanäle](/install/development-channels) und [Installer flags](/install/installer).

### Wie lange dauert die Installation und das Onboarding in der Regel

Grobe Leitfaden:

- **Installieren:** 2-5 Minuten
- **Onboarding:** 5-15 Minuten, je nachdem, wie viele Kanäle/Modelle du konfigurierst

Wenn es hängt, verwenden Sie [Installer steck](/help/faq#installer-stuck-how-do-i-get-more-feedback)
und die schnelle Debug-Schleife in [Im stuck](/help/faq#im-stuck--whats-the-fastest-way-to-get-unstuck).

### Wie versuche ich die neuesten Bits

Zwei Optionen:

1. **Dev-Kanal (Git Checkout):**

```bash
openclaw Update --channel dev
```

Dies wechselt zum 'main' Zweig und Updates aus der Quelle.

2. **Hackable Installation (von der Installer-Seite):**

```bash
curl -fsSL https://openclaw.ai/install.sh | bash -s -- --install-method git
```

Das gibt Ihnen ein lokales Repo können Sie bearbeiten, dann aktualisieren via git.

Wenn Sie einen sauberen Klon manuell bevorzugen, benutzen:

```bash
git clone https://github.com/openclaw/openclaw.git
cd openclaw
pnpm installieren
pnpm build
```

Docs: [Update](/cli/update), [Entwicklungskanäle](/install/development-channels),
[Install](/install).

### Installer steckt fest Wie bekomme ich mehr Feedback

Starte den Installer mit **verbose output**:

```bash
curl -fsSL https://openclaw.ai/install.sh | bash -s -- --verbose
```

Beta-Installation mit ausführlichen Folgen:

```bash
curl -fsSL https://openclaw.ai/install.sh | bash -s -- --beta --verbose
```

Für eine hackable (git) Installation:

```bash
curl -fsSL https://openclaw.ai/install.sh | bash -s -- --install-method git --verbose
```

Weitere Optionen: [Installer flags](/install/installer).

### Windows Installation besagt, dass git nicht gefunden wurde oder openclaw nicht erkannt wurde

Zwei häufige Windows-Probleme:

**1) npm Fehler beim Spawn git / git nicht gefunden**

- Installiere **Git for Windows** und stelle sicher, dass `git` auf deinem PATH ist.
- Schließen und öffnen Sie PowerShell und führen Sie den Installer erneut.

**2) openclaw wird nach der Installation nicht erkannt**

- Ihr npm global bin Ordner ist nicht auf PATH.

- Pfad überprüfen:

  ```powershell
  npm config get prefix
  ```

- Stelle sicher, dass `<prefix>\\bin` auf PATH ist (auf den meisten Systemen ist es `%AppData%\\npm`).

- Schließen und öffnen Sie PowerShell nach dem Update von PATH.

Wenn Sie das reibungslose Setup von Windows wünschen, verwenden Sie **WSL2** anstelle von nativen Windows.
Docs: [Windows](/platforms/windows).

### Die Dokumentation hat meine Frage nicht beantwortet, wie ich eine bessere Antwort bekomme

Benutze die \*\*hackable (git) Installation \*\* damit du die vollständige Quelle und die Dokumentation lokal hast dann fragen Sie
Ihren Bot (oder Claude/Codex) _aus diesem Ordner_ damit er das Repo lesen und genau beantworten kann.

```bash
curl -fsSL https://openclaw.ai/install.sh | bash -s -- --install-method git
```

Mehr Detail: [Install](/install) und [Installer flags](/install/installer).

### Wie installiere ich OpenClaw auf Linux

Kurze Antwort: Folgen Sie dem Linux-Leitfaden und führen Sie den Onboarding-Assistenten aus.

- Linux Schnellpfad + Service-Installation: [Linux](/platforms/linux).
- Voller Durchgang: [Erste Schritt](/start/getting-started).
- Installer + Updates: [Installieren & Updates](/install/updating).

### Wie installiere ich OpenClaw auf einem VPS

Jeder Linux VPS funktioniert. Installieren Sie auf dem Server, dann verwenden Sie SSH/Maßstab, um das Gateway zu erreichen.

Anleitungen: [exe.dev](/install/exe-dev), [Hetzner](/install/hetzner), [Fly.io](/install/fly).
Remote-Zugriff: [Gateway entfernt](/gateway/remote).

### Wo sind die CloudVPS Installationsanleitungen

Wir behalten einen **Hosting-Hub** mit den gängigen Anbietern. Wähle eine aus und folge der Anleitung:

- [VPS Hosting](/vps) (alle Anbieter an einem Ort)
- [Fly.io](/install/fly)
- [Hetzner](/install/hetzner)
- [exe.dev](/install/exe-dev)

Wie es in der Cloud funktioniert: Das **Gateway läuft auf dem Server**, und Sie greifen auf
von Ihrem Laptop/Telefon aus über die Steuerungsschnittstelle (oder Schneidermaßstab/SSH) zu. Ihr Status + Arbeitsbereich
live auf dem Server, also behandeln Sie den Host als Quelle der Wahrheit und sichern Sie ihn ab.

Du kannst **Knoten** (Mac/iOS/Android/kopflos) mit diesem Cloud-Gateway paaren, um auf
lokale Bildschirme/Kamera/Leinwand zuzugreifen oder Befehle auf deinem Laptop auszuführen, während du das
Gateway in der Cloud hältst.

Hub: [Platforms](/platforms). Remote-Zugriff: [Gateway entfernt](/gateway/remote).
Nodes: [Nodes](/nodes), [Nodes CLI](/cli/nodes).

### Darf ich OpenClaw bitten, sich selbst zu aktualisieren

Kurze Antwort: **möglich, nicht empfohlen**. Der Update-Fluss kann das
Gateway neu starten (das die aktive Sitzung abläuft), benötigt eine saubere Git Checkout und
kann zur Bestätigung aufgefordert werden. Safer: führen Sie Updates von einer Shell als Operator aus.

CLI verwenden:

```bash
openclaw update
openclaw update status
openclaw update --channel stable|beta|dev
openclaw update --tag <dist-tag|version>
openclaw update --no-restart
```

Wenn Sie von einem Agenten automatisieren müssen:

```bash
openclaw update --yes --no-restart
openclaw gateway neustarten
```

Docs: [Update](/cli/update), [Updating](/install/updating).

### Was macht der Onboarding-Assistent tatsächlich

`openclaw onboard` ist der empfohlene Setup-Pfad. Im **lokalen Modus** geht es durch:

- **Model/auth setup** (Anthropisches **setup-token** empfohlen für Claude Abonnements, OpenAI Codex OAuth unterstützt, API-Schlüssel optional, LM Studio lokale Modelle unterstützt)
- **Workspace** Standort + Bootstrap Dateien
- **Gateway-Einstellungen** (bind/port/auth/tailscale)
- **Provider** (WhatsApp, Telegram, Discord, Mattermost (Plugin), Signal, iMessage)
- **Daemon install** (LaunchAgent unter macOS; systemd user unit unter Linux/WSL2)
- **Gesundheitsprüfung** und **Skills** Auswahl

Es wird auch gewarnt, ob Ihr konfiguriertes Modell unbekannt ist oder ob auth fehlt.

### Benötige ich ein Claude oder OpenAI Abonnement, um dies ausführen zu können

Nein. Du kannst OpenClaw mit **API-Schlüssel** (Anthropic/OpenAI/others) oder mit
**lokal-only Modelle** ausführen, sodass deine Daten auf deinem Gerät bleiben. Abonnements (Claude
Pro/Max oder OpenAI Codex) sind optionale Methoden, um diese Anbieter zu authentifizieren.

Docs: [Anthropic](/providers/anthropic), [OpenAI](/providers/openai),
[Lokale Modelle](/gateway/local-models), [Models](/concepts/models).

### Kann ich Claude Max-Abonnement ohne API-Schlüssel verwenden

Ja. Du kannst dich mit einem **setup-token**
anstelle eines API-Schlüssels authentifizieren. Dies ist der Abonnementpfad.

Claude Pro/Max-Abonnements **enthalten keinen API-Schlüssel**, daher ist dies der
korrekte Ansatz für Abonnementkonten. Wichtig: Sie müssen mit
Anthropic überprüfen, dass diese Nutzung nach ihren Abonnementrichtlinien und Bedingungen erlaubt ist.
Wenn Sie den explizitsten, unterstützten Pfad wollen, verwenden Sie einen Anthropischen API-Schlüssel.

### Wie funktioniert Anthropisches setuptoken auth

`claude setup-token` generiert einen **token string** über das Claude Code CLI (es ist nicht in der Web-Konsole verfügbar). Du kannst es auf **jeder Maschine** ausführen. Wähle **Anthropisches Token (füge setup-token ein)** im Assistenten ein oder füge es mit `openclaw models auth paste-token --provider anthropic` ein. Der Token wird als Auth-Profil für den **anthropic** Provider gespeichert und wird als API-Schlüssel verwendet (kein Auto-Aktualisieren). Mehr Detail: [OAuth](/concepts/oauth).

### Wo finde ich ein anthropisches Setuptoken

Es ist **nicht** in der Anthropischen Konsole. Das Setup-Token wird von dem **Claude Code CLI** auf **jeder Maschine**:

```bash
claude setup-token
```

Kopieren Sie den ausgedruckten Token und wählen Sie dann **Anthropisches Token (Einfügen von setup-token)** im Assistenten. Wenn Sie es auf dem Gateway-Host ausführen möchten, verwenden Sie `openclaw models auth setup-token --provider anthropic`. Wenn du `claude setup-token` woanders ausführst, füge es auf den Gateway-Host mit `openclaw models auth paste-token --provider anthropic` ein. Siehe [Anthropic](/providers/anthropic).

### Unterstützen Sie Claude Abonnement auth (Claude Pro oder Max)

Ja - über **setup-token**. OpenClaw verwendet Claude Code CLI OAuth Token nicht mehr wieder; verwenden Sie einen Setup-Token oder einen Anthropischen API-Schlüssel. Generieren Sie das Token überall und fügen Sie es auf den Gateway-Host ein. Siehe [Anthropic](/providers/anthropic) und [OAuth](/concepts/oauth).

Hinweis: Der Zugang zu Claude Abonnements unterliegt den Bedingungen von Anthropic. Die API-Schlüssel sind für die Produktion oder die Mehrbenutzerbelastung meist die sicherere Wahl.

### Warum sehe ich HTTP 429 ratelimiterror von Anthropic

Das bedeutet, dass dein **Anthropisches Quote/Rate Limit** für das aktuelle Fenster ausgeschöpft ist. Wenn Sie
ein **Claude-Abonnement** verwenden (setup-token oder Claude Code OAuth), warten Sie auf das Fenster
Zurücksetzen oder aktualisieren Sie Ihr Paket. Wenn du einen **Anthropischen API-Schlüssel** verwendest, überprüfe die Anthropische Konsole
für die Nutzung/Abrechnung und setze bei Bedarf Grenzen.

Tipp: Legen Sie ein **Fallback-Modell** fest, so dass OpenClaw weiter antworten kann, während ein Anbieter eine Kursbegrenzung hat.
Siehe [Models](/cli/models) und [OAuth](/concepts/oauth).

### Wird AWS Bedrock unterstützt

Ja - via pi-ai's **Amazon Bedrock (Converse)** Provider mit **Manual-config**. Sie müssen AWS Anmeldeinformationen/Region auf dem Gateway-Host angeben und einen Bedrock Provider Eintrag in Ihrer Model-Konfiguration hinzufügen. Siehe [Amazon Bedrock](/providers/bedrock) und [Model Providers](/providers/models). Wenn Sie einen verwalteten Schlüsselfluss bevorzugen, ist ein OpenAI-kompatibler Proxy vor Bedrock immer noch eine gültige Option.

### Wie funktioniert Codex auth

OpenClaw unterstützt **OpenAI Code (Codex)** über OAuth (ChatGPT anmelden). Der Assistent kann den OAuth-Fluss ausführen und setzt das Standardmodell auf `openai-codex/gpt-5.3-codex`, falls angemessen. Siehe [Modellanbieter](/concepts/model-providers) und [Wizard](/start/wizard).

### Unterstützen Sie OpenAI Abonnement auth Codex OAuth

Ja. OpenClaw unterstützt das **OpenAI Code (Codex) Abonnement von OAuth**. Der Onboarding-Assistent
kann den OAuth-Fluss für Sie ausführen.

Siehe [OAuth](/concepts/oauth), [Modellanbieter](/concepts/model-providers), und [Wizard](/start/wizard).

### Wie kann ich Gemini CLI OAuth einrichten

Gemini CLI verwendet einen **Plugin auth flow**, keine Client-ID oder Geheimnis in `openclaw.json`.

Schritte:

1. Plugin aktivieren: `openclaw Plugins aktivieren Google gemini-cli-auth`
2. Login: `openclaw models auth login --provider google-gemini-cli --set-default`

Dies speichert OAuth Token in Authentifizierungsprofilen auf dem Gateway-Host. Details: [Model Providers](/concepts/model-providers).

### Ist ein lokales Modell OK für Gelegenheitschats

Normalerweise nein. OpenClaw braucht einen großen Kontext + starke Sicherheit; kleine Karten knacken und lecken. Wenn du das **größte** MiniMax M2.1 Build ausführen musst, kannst du lokal (LM Studio) sehen und [/gateway/local-models](/gateway/local-models). Kleinere/quantifizierte Modelle erhöhen das Prompt-Injektionsrisiko - siehe [Security](/gateway/security).

### Wie mache ich gehosteten Modellverkehr in einer bestimmten Region

Wähle regionenangeheftete Endpunkte. OpenRouter stellt die in den USA gehosteten Optionen für MiniMax, Kimi und GLM zur Verfügung. Wählen Sie die in den USA gehostete Variante aus, um Daten in der Region zu behalten. Du kannst noch Anthropic/OpenAI neben diesen auflisten, indem du `models.mode: "merge"` verwendest, so dass Fallbacks verfügbar bleiben, während du den von dir ausgewählten regionalen Provider respektierst.

### Muss ich ein Mac Mini kaufen, um dies zu installieren

Nein. OpenClaw läuft auf macOS oder Linux (Windows via WSL2). Ein Mac Mini ist optional - einige Leute
kaufen einen als immer-On-Host, aber auch ein kleiner VPS, Home-Server oder Raspberry Pi-Class Box funktioniert.

Sie benötigen nur einen Mac **für macOS-only Tools**. Für iMessage, verwende [BlueBubbles](/channels/bluebubbles) (empfohlen) - der BlueBubbles Server läuft auf jedem Mac, und das Gateway kann unter Linux oder anderswo laufen. Wenn Sie andere Werkzeuge nur für macOS benötigen, führen Sie das Gateway auf einem Mac aus oder paaren Sie einen MacOS-Knoten.

Docs: [BlueBubbles](/channels/bluebubbles), [Nodes](/nodes), [Mac Remote-Modus](/platforms/mac/remote).

### Benötige ich einen Mac Mini für iMessage Unterstützung

Du brauchst **ein macOS-Gerät** in Nachrichten angemeldet. Es tut **nicht** muss ein Mac Mini sein -
irgendein Mac funktioniert. **Benutze [BlueBubbles](/channels/bluebubbles)** (empfohlen) für iMessage - der BlueBubbles Server läuft auf macOS, während das Gateway unter Linux oder anderswo laufen kann.

Gemeinsame Setups:

- Führen Sie das Gateway unter Linux/VPS aus und starten Sie den BlueBubbles Server auf jedem Mac, der in Nachrichten angemeldet ist.
- Führen Sie alles auf dem Mac aus, wenn Sie die einfachste Einzeleinstellung wünschen.

Docs: [BlueBubbles](/channels/bluebubbles), [Nodes](/nodes),
[Mac Remote-Modus](/platforms/mac/remote).

### Wenn ich ein Mac Mini kaufe, um OpenClaw zu starten kann ich es mit meinem MacBook Pro verbinden

Ja. Das **Mac Mini kann das Gateway**, und dein MacBook Pro kann sich als
**Knoten** (Begleitgerät) verbinden. Knoten führen das Gateway nicht aus - sie bieten zusätzliche
Fähigkeiten wie Bildschirm/Kamera/Leinwand und `system.run` auf diesem Gerät.

Gewöhnliches Muster:

- Gateway auf dem Mac mini (immer-on).
- MacBook Pro führt die macOS-App oder einen Knotenhost und Paare zum Gateway aus.
- Benutze `openclaw nodes status` / `openclaw nodes list` um es zu sehen.

Dokumentation: [Nodes](/nodes), [Nodes CLI](/cli/nodes).

### Kann ich Bun verwenden

Bun ist **nicht empfohlen**. Wir sehen Laufzeitfehler insbesondere mit WhatsApp und Telegram.
Verwende **Knoten** für stabile Gateways.

Wenn Sie immer noch mit Bun experimentieren wollen, machen Sie es auf einem nicht-produktiven Gateway
ohne WhatsApp/Telegram.

### Telegramm, was in erlaubt ist von

`channels.telegram.allowFrom` ist **die Telegramm-Benutzer-ID** (numerisch, empfohlen) oder `@username`. Es ist nicht der Bot-Benutzername.

Sicherer (kein Drittanbieter-Bot):

- DM deinen Bot, dann führe `openclaw logs --follow` aus und lese `from.id`.

Offizielle Bot API:

- DM deinen Bot, dann rufe `https://api.telegram.org/bot<bot_token>/getUpdates` auf und lese `message.from.id`.

Drittanbieter (weniger privat):

- DM `@userinfobot` oder `@getidsbot`.

Siehe [/channels/telegram](/channels/telegram#access-control-dms--groups).

### Kann mehrere Personen eine WhatsApp-Nummer mit verschiedenen OpenClaw-Instanzen verwenden

Ja, über **Multi-Agent-Routing**. Binden Sie die WhatsApp **DM** des Absenders an (peer `kind: "dm"`, Absender E. 64 wie `+15551234567`) zu einer anderen `agentId`, so dass jeder Mensch seinen eigenen Arbeitsbereich und Session-Shop bekommt. Antworten kommen immer noch vom **gleichen WhatsApp-Konto**, und die DM-Zugriffskontrolle (`channels.whatsapp.dmPolicy` / `channels.whatsapp.allowFrom`) ist global pro WhatsApp-Konto. Siehe [Multi-Agent Routing](/concepts/multi-agent) und [WhatsApp](/channels/whatsapp).

### Kann ich einen schnellen Chat-Agent und ein Opus für Programmierer laufen

Ja. Multi-Agent-Routing: Geben Sie jedem Agent sein eigenes Standardmodell und binden Sie eingehende Routen (Provider-Konto oder bestimmte Peers) an jeden Agenten. Beispiel config lebt in [Multi-Agent Routing](/concepts/multi-agent). Siehe auch [Models](/concepts/models) und [Configuration](/gateway/configuration).

### Funktioniert Homebrew unter Linux

Ja. Homebrew unterstützt Linux (Linuxbrew). Schnellstart:

```bash
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
echo 'eval "$(/home/linuxbrew/.linuxbrew/bin/brew shellenv)"' >> ~/.profile
eval "$(/home/linuxbrew/.linuxbrew/bin/brew shellenv)"
braun Installation <formula>
```

Wenn du OpenClaw über das System ausführst, stelle sicher, dass der Service von PATH `/home/linuxbrew/.linuxbrew/bin` (oder dein Braupräfix) enthält, so dass `brew`-installierte Werkzeuge in nicht-login Shell auflösen.
Jüngste Builds stellen auch häufige User bin dirs auf Linux Systemd-Diensten vor (z.B. `~/.local/bin`, `~/.npm-global/bin`, `~/.local/share/pnpm`, `~/. un/bin`) und ehre `PNPM_HOME`, `NPM_CONFIG_PREFIX`, `BUN_INSTALL`, `VOLTA_HOME`, `ASDF_DATA_DIR`, `NVM_DIR` und `FNM_DIR` wenn gesetzt.

### Was ist der Unterschied zwischen der hackbaren git-Installation und der npm Installation

- **Hackable (git) install:** vollständige Quelltext-Checkout, editierbar, am besten für Mitwirkende geeignet.
  Du ausführst Builds lokal und kannst Code/docs patchen.
- **npm Installation:** globale CLI-Installation, kein Repo, am besten für "nur ausführen".
  Updates kommen von npm dist-tags.

Docs: [Erste Schritte](/start/getting-started), [Updating](/install/updating).

### Kann ich später zwischen npm und git installieren

Ja. Installieren Sie die andere Variante und führen Sie dann Doctor aus, so dass der Gateway-Service am neuen Einstiegspunkt punktet.
**löscht deine Daten nicht** - es ändert nur die OpenClaw-Code-Installation. Ihr Zustand
(`~/.openclaw`) und Arbeitsbereich (`~/.openclaw/workspace`) bleiben unberührt.

Von npm → git:

```bash
git clone https://github.com/openclaw/openclaw.git
cd openclaw
pnpm install
pnpm build
openclaw doctor
openclaw gateway restart
```

Von git → npm:

```bash
npm installieren -g openclaw@latest
openclaw doctor
openclaw gateway neustarten
```

Doctor erkennt ein Einstiegspunktkonflikt eines Gateway-Dienstes und bietet an, die Servicekonfiguration neu zu schreiben, um sie an die aktuelle Installation anzupassen (verwenden Sie `--repair` in der Automatisierung).

Backup-Tipps: siehe [Backup-Strategie](/help/faq#whats-the-recommended-backup-strategy).

### Soll ich das Gateway auf meinem Laptop oder einem VPS laufen

Kurze Antwort: **wenn Sie 24/7 Zuverlässigkeit wollen, verwenden Sie einen VPS**. Wenn du die
niedrigste Reibung haben möchtest und du mit Ruhe/Neustart in Ordnung bist, führe sie lokal aus.

**Laptop (lokale Gateway)**

- **Pros:** keine Serverkosten, direkten Zugriff auf lokale Dateien, Live-Browser-Fenster.
- **Cons:** Sleep/Network Drops = Trennen, OS Updates/reboots unterbrechen, müssen wach bleiben.

**VPS / Cloud**

- **Pros:** immer, stabiles Netzwerk, kein Laptop Schlafstörungen, einfacher zu laufen.
- **Cons:** laufen oft kopflose (verwenden Sie Screenshots), nur Remote-Dateizugriff, Sie müssen SSH für Updates verwenden.

**OpenClaw-spezifische Notiz:** WhatsApp/Telegram/Slack/Mattermost (Plugin)/Discord funktionieren alle gut von einem VPS. Der einzige wirkliche Ausgleich ist der **kopflose Browser** gegen ein sichtbares Fenster. Siehe [Browser](/tools/browser).

**Empfohlen Standard:** VPS, wenn Sie Gateway zuvor getrennt haben. Local ist großartig, wenn Sie aktiv den Mac verwenden und lokale Dateizugriff oder UI-Automatisierung mit einem sichtbaren Browser wollen.

### Wie wichtig es ist, OpenClaw auf einem dedizierten Rechner auszuführen

Nicht erforderlich, aber **empfohlen für Zuverlässigkeit und Isolation**.

- **Dedizierter Host (VPS/Mac mini/Pi):** immer, weniger Schlaf-/Reboot-Unterbrechungen, sauberere Berechtigungen, einfacher zu betreiben.
- **Geteilter Laptop/Desktop:** absolut gut für Testzwecke und aktive Nutzung, aber erwarten Pausen wenn der Rechner schläft oder aktualisiert wird.

Wenn du das Beste aus beiden Welten willst, behalte das Gateway auf einem dedizierten Host und paare deinen Laptop als **Knoten** für lokale Bildschirme/Kamera/Exec-Tools. Siehe [Nodes](/nodes).
Für Sicherheitsanleitung, lesen Sie [Security](/gateway/security).

### Was sind die minimalen VPS-Anforderungen und empfohlenen OS

OpenClaw ist Leichtgewicht. Für ein einfaches Gateway + einen Chatkanal:

- **Absolute Minimum:** 1 vCPU, 1 GB RAM, ~500MB Festplatte.
- **Empfohlen:** 1-2 vCPU, 2 GB RAM oder mehr für Headroom (Logs, Medien, mehrere Kanäle). Knoten-Tools und Browser-Automatisierung können ressourcenhungrig sein.

OS: verwenden Sie **Ubuntu LTS** (oder jedes moderne Debian/Ubuntu). Der Linux-Installationspfad wird am besten dort getestet.

Docs: [Linux](/platforms/linux), [VPS hosting](/vps).

### Kann ich OpenClaw in einer VM laufen und was sind die Anforderungen

Ja. Behandle eine VM gleich wie ein VPS: Sie muss immer eingeschaltet sein, erreichbar und und haben genug
RAM für das Gateway und alle Kanäle, die du aktivierst.

Basisanleitung:

- **Absoluter Minimum:** 1 vCPU, 1 GB RAM.
- **Empfohlen:** 2 GB RAM oder mehr, wenn Sie mehrere Kanäle, Browserautomatisierung oder Medienwerkzeuge verwenden.
- **OS:** Ubuntu LTS oder ein anderes modernes Debian/Ubuntu.

Wenn Sie unter Windows sind, ist **WSL2 das einfachste Setup im VM-Stil** und hat die beste
-Kompatibilität. Siehe [Windows](/platforms/windows), [VPS hosting](/vps).
Wenn Sie macOS in einer VM verwenden, lesen Sie [macOS VM](/install/macos-vm).

## Was ist OpenClaw?

### Was ist OpenClaw in einem Absatz

OpenClaw ist ein persönlicher KI-Assistent, den Sie auf Ihren eigenen Geräten laufen. Es antwortet auf den Messaging-Oberflächen, die du bereits benutzt hast (WhatsApp, Telegram, Slack, Mattermost (Plugin), Discord, Google Chat, Signal, iMessage, WebChat) und kann auch Voice + eine Live-Leinwand auf unterstützten Plattformen tun. Das **Gateway** ist die immerwährende Kontrollebene; der Assistent ist das Produkt.

### Was ist der Wert Proposition

OpenClaw ist nicht "nur ein Claude-Wrapper". Es ist ein **lokal-first control plane**, mit dem du einen
fähigen Assistenten auf **deiner eigenen Hardware** ausführen kannst, erreichbar über die Chat-Apps, die du bereits benutzt hast mit
Stateful Sessions, Speicher und Tools - ohne die Steuerung Ihrer Workflows an eine gehostete
SaaS zu übergeben.

Highlights:

- **Deine Geräte, deine Daten:** Führe das Gateway aus, wo immer du willst (Mac, Linux, VPS) und behalte den Arbeitsbereich* Sitzungsverlauf lokal.
- **Echte Kanäle, keine Web-Sandbox:** WhatsApp/Telegram/Slack/Discord/Signal/iMessage/etc,
  plus mobile Stimme und Leinwand auf unterstützten Plattformen.
- **Model-agnostic:** verwenden Sie Anthropic, OpenAI, MiniMax, OpenRouter, etc., mit per-agent Routing
  und Failover.
- **Lokale Option:** Lokale Modelle ausführen, so dass **alle Daten auf deinem Gerät bleiben können** wenn du möchtest.
- **Multi-Agent-Routing:** trennt Agenten pro Kanal, Konto oder Aufgabe, alle mit eigenem
  Arbeitsbereich und Standardeinstellungen.
- **Open Source und gehackbar:** Inspektion, Erweiterung und Selbst-Host ohne Händler-Slock-In.

Docs: [Gateway](/gateway), [Channels](/channels), [Multi-agent](/concepts/multi-agent),
[Memory](/concepts/memory).

### Ich stelle gerade fest, was ich zuerst machen soll

Gute erste Projekte:

- Erstellen Sie eine Website (WordPress, Shopify, oder eine einfache statische Site).
- Prototyp einer mobilen App (Umriss-, Bildschirme, API-Plan).
- Dateien und Ordner organisieren (bereinigen, benennen, tagging).
- Verbinden Sie Google Mail und automatisieren Sie Zusammenfassungen oder Follow-Ups.

Es kann große Aufgaben bewältigen, aber es funktioniert am besten, wenn Sie sie in Phasen aufteilen und
Sub-Agenten für parallele Arbeit verwenden.

### Was sind die fünf besten täglichen Anwendungsfälle für OpenClaw

Alltagssiege sehen in der Regel so aus:

- **Persönliche Briefings:** Zusammenfassungen von Posteingang, Kalender und Nachrichten, die dir wichtig sind.
- **Forschung und Entwurf:** Schnellforschung, Zusammenfassungen und erste Entwürfe für E-Mails oder Doktoranden.
- **Erinnerungen und Follow-ups:** cron oder Heartbeat getriebene Stupunkte und Checklisten.
- **Browserautomatisierung:** Formulare ausfüllen, Daten sammeln und Web-Aufgaben wiederholen.
- **Geräteübergreifende Koordination:** Senden Sie eine Aufgabe von Ihrem Telefon aus, lassen Sie das Gateway auf einem Server laufen und erhalten Sie das Ergebnis wieder im Chat.

### Kann OpenClaw mit Lead gen Outtreach Anzeigen und Blogs für eine SaaS helfen

Ja für **Forschung, Qualifizierung und Entwurf**. Es kann Websites scannen, Shortlisten bauen,
Perspektiven zusammenfassen und Outtreach oder Ad-Copy Entwürfe schreiben.

Für **Outtreach oder Adruns**, halte einen Menschen in der Schleife. Vermeiden Sie Spam, folgen Sie lokalen Gesetzen und
Plattformrichtlinien, und überprüfen Sie vor dem Versand. Das sicherste Muster ist
OpenClaw zu entwerfen und du bestätigst.

Docs: [Security](/gateway/security).

### Was sind die Vorteile gegenüber Claude Code für die Webentwicklung

OpenClaw ist ein **persönlicher Assistent** und Koordinationsschicht, kein IDE-Ersatz. Verwende
Claude Code oder Codex für die schnellste direkte Programmierung Schleife innerhalb eines Repos. Verwenden Sie OpenClaw wenn Sie
dauerhaften Speicher, Zugriff über Geräte hinweg und Orchestrierung von Werkzeugen.

Vorteile:

- **Dauerhafter Arbeitsspeicher + Arbeitsbereich** über Sitzungen hinweg
- **Zugriff auf mehrere Plattformen** (WhatsApp, Telegram, TUI, WebChat)
- **Werkzeug-Orchestrierung** (Browser, Dateien, Planung, Hooks)
- **Immer Gateway** (auf einem VPS laufen, von überall interagieren)
- **Knoten** für lokalen Browser/Bildschirm-/Kamera/exec

Showcase: [https://openclaw.ai/showcase](https://openclaw.ai/showcase)

## Fertigkeiten und Automatisierung

### Wie kann ich Fähigkeiten anpassen, ohne das Repo schmutzig zu halten

Verwaltete Overrides verwenden, anstatt die Repo-Kopie zu bearbeiten. Lege deine Änderungen in `~/.openclaw/skills/<name>/SKILL.md` fest (oder füge einen Ordner über `skills.load.extraDirs` in `~/.openclaw/openclaw.json` hinzu). Precedence ist `<workspace>/skills` > `~/.openclaw/skills` > gebündelt, so dass verwaltete Überschreibungen ohne git gewinnen. Nur Upstream-würdige Bearbeitungen sollten im Repo leben und als PRs ausgehen.

### Kann ich Fähigkeiten aus einem benutzerdefinierten Ordner laden

Ja. Füge zusätzliche Verzeichnisse über `skills.load.extraDirs` in `~/.openclaw/openclaw.json` (niedrigster Präzedenzfall) hinzu. Standardpriorität bleibt: `<workspace>/skills` → `~/.openclaw/skills` → bundled → `skills.load.extraDirs`. `clawhub` installiert sich standardmäßig in `./skills`, was OpenClaw als `<workspace>/skills` behandelt.

### Wie kann ich verschiedene Modelle für verschiedene Aufgaben verwenden

Die heute unterstützten Muster sind:

- **Cron-Jobs**: Einzelne Jobs können ein `Modell` pro Job überschreiben.
- **Sub-Agenten**: Routen Sie Aufgaben, um Agenten mit unterschiedlichen Standardmodellen zu trennen.
- **On-Demand-Switch**: Benutze `/model`, um das aktuelle Sitzungsmodell jederzeit zu wechseln.

Siehe [Cron jobs](/automation/cron-jobs), [Multi-Agent Routing](/concepts/multi-agent), und [Slash commands](/tools/slash-commands).

### Der Bot friert ein, während schwere Arbeit Wie kann ich abladen, dass

Benutze **Sub-Agenten** für lange oder parallele Aufgaben. Sub-Agenten laufen in ihrer eigenen Sitzung,
geben Sie eine Zusammenfassung zurück und halten Ihren Hauptchat auf dem Laufenden.

Bitten Sie Ihren Bot, "einen Sub-Agent für diese Aufgabe zu spawnen" oder verwenden Sie `/subagents`.
Benutze `/status` im Chat um zu sehen, was das Gateway gerade macht (und ob es beschäftigt ist).

Token-Tipp: Sowohl lange Aufgaben als auch Sub-Agenten konsumieren Token. Wenn die Kosten ein Problem sind, setzen Sie ein
billigeres Modell für Sub-Agenten via `agents.defaults.subagents.model`.

Docs: [Sub-agents](/tools/subagents).

### Cron oder Erinnerungen feuern nicht Was sollte ich überprüfen

Cron läuft innerhalb des Gateway-Prozesses. Wenn das Gateway nicht kontinuierlich läuft, werden
geplante Jobs nicht ausgeführt.

Checkliste:

- Bestätige cron ist aktiviert (`cron.enabled`) und `OPENCLAW_SKIP_CRON` ist nicht gesetzt.
- Überprüfen Sie, ob das Gateway 24/7 läuft (keine Ruhe/Neustarte).
- Überprüfen Sie die Zeitzone Einstellungen für den Job (`--tz` vs Host-Zeitzone).

Debug:

```bash
openclaw cron läuft <jobId> --force
openclaw cron läuft --id <jobId> --limit 50
```

Docs: [Cron jobs](/automation/cron-jobs), [Cron vs Heartbeat](/automation/cron-vs-heartbeat).

### Wie installiere ich Fähigkeiten unter Linux

Benutze **ClawHub** (CLI) oder lege Fähigkeiten in deinen Arbeitsbereich ab. Die macOS Skills UI ist unter Linux nicht verfügbar.
Durchsuche die Fertigkeiten unter [https://clawhub.com](https://clawhub.com).

Installieren Sie ClawHub CLI (wählen Sie einen Paketmanager):

```bash
npm i -g clawhub
```

```bash
pnpm add -g clawhub
```

### Darf OpenClaw Aufgaben nach einem Zeitplan oder im Hintergrund ausführen

Ja. Gateway-Scheduler verwenden:

- **Cron-Jobs** für geplante oder wiederkehrende Aufgaben (beim Neustart bestehen).
- **Heartbeat** für periodische Überprüfungen der Hauptsitzung.
- **Einzelarbeiten** für autonome Agenten, die Zusammenfassungen veröffentlichen oder in Chats liefern.

Docs: [Cron jobs](/automation/cron-jobs), [Cron vs Heartbeat](/automation/cron-vs-heartbeat),
[Heartbeat](/gateway/heartbeat).

### Kann ich Apple-MacOS-Nur-Fähigkeiten von Linux verwenden?

Nicht direkt. macOS-Fertigkeiten werden von `metadata.openclaw.os` plus benötigte Binärdateien angegriffen, und Fähigkeiten werden nur dann im System-Prompt angezeigt, wenn sie auf dem **Gateway-Host** zugelassen sind. Unter Linux werden nur `darwin`-skills (wie `apple-notes`, `apple-reminders`, `things-mac`) nicht geladen, es sei denn, Sie überschreiben das Tor.

Du hast drei unterstützte Muster:

\*\*Option A - führen Sie das Gateway auf einem Mac (einfachste). \*
Führen Sie das Gateway aus, wo die macOS-Binärdateien existieren, dann verbinden Sie sich mit Linux im [Remote-Modus](#how-do-i-run-openclaw-in-remote-mode-client-connects-to-a-gateway-elsewhere) oder über Maßstab. Die Fähigkeiten werden normalerweise geladen, weil der Gateway-Host macOS ist.

\*\*Option B - einen macOS-Knoten verwenden (kein SSH). \*
Führen Sie das Gateway auf Linux aus, paaren Sie einen MacOS-Knoten (Menüleisten-App), und setze **Knoten-Ausführungsbefehle** auf "Always Ask" oder "Always Allow" auf dem Mac. OpenClaw kann Fähigkeiten nur für macOS als förderfähig behandeln, wenn die benötigten Binärdateien auf dem Knoten existieren. Der Agent führt diese Fähigkeiten über das Werkzeug "nodes" aus. Wenn Sie "Always Ask" wählen, fügt die Genehmigung "Always Allow" in der Prompt-Liste diesen Befehl hinzu.

\*\*Option C - proxy macOS-Binaries über SSH (erweitert). \*
Behalten Sie das Gateway auf Linux, aber lassen Sie die benötigten CLI Binärdateien zu SSH Wrapper auflösen, die auf einem Mac laufen. Dann überschreiben Sie die Fähigkeiten, um Linux zu ermöglichen, so dass es berechtigt bleibt.

1. Erstelle einen SSH-Wrapper für die Binärdatei (Beispiel: `memo` für Apple Notes):

   ```bash
   #!/usr/bin/env bash
   setzen -euo pipefail
   exec ssh -T user@mac-host /opt/homebrew/bin/memo "$@"
   ```

2. Setze den Wrapper auf `PATH` auf den Linux-Host (z.B. `~/bin/memo`).

3. Überschreibe die Skill-Metadaten (Arbeitsbereich oder `~/.openclaw/skills`), um Linux zu ermöglichen:

   ```markdown
   ---
   Name: apple-notes
   description: Verwalte Apple Notizen über die Memo CLI auf macOS.
   metadata: { "openclaw": { "os": ["darwin", "linux"], "requires": { "bins": ["memo"] } } } }
   ---
   ```

4. Starten Sie eine neue Sitzung, damit der Skill-Schnappschuss aktualisiert wird.

### Hast du eine Notion oder HeyGen-Integration

Heute nicht eingebaut.

Optionen:

- **Benutzerdefinierte Fertigkeit / Plugin:** am besten für zuverlässigen API-Zugriff (Notion/HeyGen beide haben APIs).
- **Browserautomatisierung:** funktioniert ohne Code, ist aber langsamer und zerbrechlicher.

Wenn Sie den Kontext pro Kunde behalten möchten (Agentur-Workflows), ist ein einfaches Muster folgendes:

- Eine Notion-Seite pro Client (Kontext + Einstellungen + aktive Arbeit).
- Bitten Sie den Agenten, diese Seite am Anfang einer Sitzung zu laden.

Wenn du eine native Integration möchtest, öffne eine Feature-Anfrage oder baue eine Fertigkeit
, die diese APIs zielt.

Fähigkeiten installieren:

```bash
clawhub Installation <skill-slug>
clawhub update --all
```

ClawHub installiert sich in `. skills` unter deinem aktuellen Verzeichnis (oder fällt auf deinen konfigurierten OpenClaw-Arbeitsbereich zurück); OpenClaw behandelt dies als `<workspace>/skills` auf der nächsten Sitzung. Platziere sie in `~/.openclaw/skills/<name>/SKILL.md`. Einige Fähigkeiten erwarten Binärdateien über Homebrew installiert; unter Linux bedeutet das Linuxbrew (siehe obiger Eintrag in der Homebrew Linux FAQ). Siehe [Skills](/tools/skills) und [ClawHub](/tools/clawhub).

### Wie installiere ich die Chrome-Erweiterung für die Übernahme des Browsers

Verwenden Sie den integrierten Installer und laden Sie dann die entpackte Erweiterung in Chrome:

```bash
openclaw browser extension install
openclaw browser extension path
```

Dann Chrome → `chrome://extensions` → "Developer mode" aktivieren → "Load unpacked" → Diesen Ordner auswählen.

Vollständige Anleitung (inklusive Remote-Gateway + Sicherheitshinweise): [Chrome-Erweiterung](/tools/chrome-extension)

Wenn das Gateway auf dem gleichen Rechner läuft wie Chrome (Standard-Setup), brauchst du normalerweise nichts Extras.
Wenn das Gateway anderswo läuft, führen Sie einen Node-Host auf der Browser-Maschine aus, damit das Gateway Browseraktionen weiterleiten kann.
Sie müssen immer noch auf den Erweiterung-Button auf dem Tab klicken, den Sie steuern möchten (es wird nicht automatisch angehängt).

## Sandboxen und Speicher

### Gibt es ein dediziertes Sandbox-Doc

Ja. Siehe [Sandboxing](/gateway/sandboxing). Für Docker-spezifische Einrichtung (vollständiges Gateway in Docker oder Sandbox-Bildern), siehe [Docker](/install/docker).

### Docker fühlt sich begrenzt an, wie ich volle Funktionen aktivieren kann

Das Standard-Image ist sicherheitsorientiert und läuft als Benutzer `node`, daher enthält es keine Systempakete, Homebrew oder gebündelte Browser. Für ein volleres Setup:

- Persisiere `/home/node` mit `OPENCLAW_HOME_VOLUME` damit Caches überleben.
- Das Backsystem taucht mit `OPENCLAW_DOCKER_APT_PACKAGES` in das Bild auf.
- Installieren Sie Playwright Browser über das mitgelieferte CLI:
  `node /app/node_modules/playwright-core/cli.js installieren chromium`
- Legen Sie `PLAYWRIGHT_BROWSERS_PATH` fest und stellen Sie sicher, dass der Pfad erhalten bleibt.

Docs: [Docker](/install/docker), [Browser](/tools/browser).

**Kann ich DMs persönlich halten, aber Gruppen mit einem Agenten öffentlich machen**

Ja - wenn dein privater Datenverkehr **DM** ist und dein öffentlicher Datenverkehr **Gruppen** ist.

Benutze `agents.defaults.sandbox.mode: "non-main"` so dass die Gruppen/Kanalsitzungen (nicht-Hauptschlüssel) in Docker laufen, während die Haupt-DM-Sitzung auf dem Host bleibt. Dann beschränken Sie die Werkzeuge, die in Sandbox-Sessions über `tools.sandbox.tools` verfügbar sind.

Setup walkthrough + Beispiel config: [Gruppen: Persönliche DMs + öffentliche Gruppen](/channels/groups#pattern-personal-dms-public-groups-single-agent)

Schlüsselkonfigurationsreferenz: [Gateway-Konfiguration](/gateway/configuration#agentsdefaultssandbox)

### Wie binde ich einen Hostordner in die Sandbox ein

Setze `agents.defaults.sandbox.docker.binds` auf `["host:path:mode"]` (z.B. `"/home/user/src:/src:ro"`). Global + per-agent binds merge; per-agent binds werden ignoriert, wenn `scope: "shared"`. Benutze `:ro` für alles sensible und erinnere dich an Bindungen, die die Sandbox-Dateisystem-Wände umgehen. Siehe [Sandboxing](/gateway/sandboxing#custom-bind-mounts) und [Sandbox vs Tool Policy vs Elevated](/gateway/sandbox-vs-tool-policy-vs-elevated#bind-mounts-security-quick-check) für Beispiele und Sicherheitshinweise.

### Wie funktioniert Speicher

OpenClaw Speicher ist nur Markdown Dateien im Agent-Arbeitsbereich:

- Tägliche Notizen in `memory/YYY-MM-TTD.md`
- Langfristige Notizen in `MEMORY.md` kuratiert (nur Haupt/Privatsitzungen)

OpenClaw führt auch einen \*\*stillen Vorverdichtungsspeicher aus, um das Modell
daran zu erinnern, haltbare Notizen vor der automatischen Verdichtung zu schreiben. Dies wird nur ausgeführt, wenn der Workspace beschreibbar ist (schreibgeschützte Sandboxes überspringen es). Siehe [Memory](/concepts/memory).

### Speicher vergisst immer wieder, wie mache ich es Stick

Bitten Sie den Bot, die Tatsache in den Speicher **zu schreiben** zu schreiben. Langfristige Notizen gehören in `MEMORY.md`,
kurzfristiger Kontext geht in `memory/YYY-MM-DD.md`.

Dies ist ein Bereich, den wir noch verbessern. Es hilft, das Modell daran zu erinnern, Erinnerungen zu speichern;
wird es wissen, was zu tun ist. Wenn es immer wieder vergisst, stelle sicher, dass das Gateway bei jedem Lauf denselben
Arbeitsbereich verwendet.

Docs: [Memory](/concepts/memory), [Agent-Arbeitsbereich](/concepts/agent-workspace).

### Benötigt semantische Speichersuche einen OpenAI-API-Schlüssel

Nur wenn Sie **OpenAI Einbetten** verwenden. Codex OAuth deckt Chat/Vervollständigung ab und
gewährt **nicht** Einbettungszugriff so **Einloggen mit dem Codex (OAuth oder dem
Codex CLI Login)** hilft nicht bei der semantischen Speichersuche. OpenAI Einbettungen
benötigen noch einen echten API-Schlüssel (`OPENAI_API_KEY` oder `models.providers.openai.apiKey`).

Wenn Sie keinen Provider explizit setzen, wählt OpenClaw einen Provider automatisch aus, wenn er
einen API-Schlüssel auflösen kann (auth Profile, `models.providers.*.apiKey`, oder env vars).
Es bevorzugt OpenAI, wenn ein OpenAI-Schlüssel aufgelöst wird, ansonsten Gemini wenn ein Gemini-Key
aufgelöst wird. Wenn keiner der beiden Schlüssel verfügbar ist, bleibt die Speichersuche deaktiviert, bis Sie sie
konfigurieren. Wenn Sie einen lokalen Modellpfad konfiguriert und vorhanden haben, bevorzugt OpenClaw
`local`.

Wenn Sie lieber lokal bleiben möchten, setzen Sie `memorySearch.provider = "local"` (und optional
`memorySearch.fallback = "keine"`). Wenn Sie Gemini einbetten wollen, setzen Sie
`memorySearch.provider = "gemini"` und stellen `GEMINI_API_KEY` (oder
`memorySearch.remote.apiKey`). Wir unterstützen **OpenAI, Gemini oder lokal** Einbetten von
Modellen - siehe [Memory](/concepts/memory) für die Setup-Details.

### Dauerhafter Speicher Was sind die Grenzen

Speicherdateien leben auf der Festplatte und bleiben solange bestehen, bis Sie sie löschen. Das Limit ist Ihr
Speicher, nicht das Modell. Der **Session-Kontext** ist immer noch durch das Modell
Kontextfenster begrenzt, so dass lange Gespräche kompakt oder abgeschnitten werden können. Aus diesem Grund existiert die
Speichersuche - sie zieht nur die relevanten Teile zurück in den Kontext.

Docs: [Memory](/concepts/memory), [Context](/concepts/context).

## Wo die Dinge auf der Festplatte leben

### Wird alle Daten mit OpenClaw lokal gespeichert

Nein - **OpenClaw's Status ist local**, aber **externe Dienste sehen noch was du ihnen schickst**.

- **Lokal standardmäßig:** Sitzungen, Speicherdateien, Konfiguration und Arbeitsbereich live auf dem Gateway-Host
  (`~/.openclaw` + dein Arbeitsbereichs-Verzeichnis).
- **Entfernt nach Notwendigkeit:** Nachrichten, die du an Modellanbieter gesendet hast (Anthropic/OpenAI/etc.) Gehe zu ihren APIs und Chat-Plattformen (WhatsApp/Telegram/Slack/etc.). Nachrichtendaten auf ihren
  Servern speichern.
- **Du kontrollierst den Fußabdruck:** mit lokalen Modellen hält die Eingabeaufforderungen auf deinem Computer, aber der Verkehr des Kanals
  geht immer noch über die Server des Kanals.

Verwandt: [Agent-Arbeitsbereich](/concepts/agent-workspace), [Memory](/concepts/memory).

### Wo speichert OpenClaw seine Daten

Alles lebt unter `$OPENCLAW_STATE_DIR` (Standard: `~/.openclaw`):

| Pfad                                                            | Zweck                                                                                                       |
| --------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `$OPENCLAW_STATE_DIR/openclaw.json`                             | Hauptkonfiguration (JSON5)                                                               |
| `$OPENCLAW_STATE_DIR/credentials/oauth.json`                    | Legaler OAuth-Import (bei der ersten Verwendung in Auth-Profile kopiert)                 |
| `$OPENCLAW_STATE_DIR/agents/<agentId>/agent/auth-profiles.json` | Auth Profile (OAuth + API-Schlüssel)                                                     |
| `$OPENCLAW_STATE_DIR/agents/<agentId>/agent/auth.json`          | Laufzeitauth-Cache (automatisch verwaltet)                                               |
| `$OPENCLAW_STATE_DIR/credentials/`                              | Provider-Status (z.B. `whatsapp/<accountId>/creds.json`) |
| `$OPENCLAW_STATE_DIR/agents/`                                   | Per-Agenten-Status (agentDir + Sitzungen)                                                |
| `$OPENCLAW_STATE_DIR/agents/<agentId>/sessions/`                | Gesprächsverlauf & -status (pro Agent)                               |
| `$OPENCLAW_STATE_DIR/agents/<agentId>/sessions/sessions.json`   | Session-Metadaten (pro Agent)                                                            |

Legacy single agent path: `~/.openclaw/agent/*` (migriert von `openclaw doctor`).

Dein **Arbeitsbereich** (AGENTS.md, Speicherdateien, Fähigkeiten, etc.) ist separat und konfiguriert über `agents.defaults.workspace` (Standard: `~/.openclaw/workspace`).

### Wo soll AGENTSmd SOULmd USERmd MEMORYmd leben

Diese Dateien leben im **agent workspace**, nicht `~/.openclaw`.

- **Arbeitsbereich (pro Agent)**: `AGENTS.md`, `SOUL.md`, `IDENTITY.md`, `USER.md`,
  `MEMORY.md` (oder `memory.md`), `memory/YYYY-MM-DD.md`, optional `HEARTBEAT.md`.
- **State Verzeichnis (`~/.openclaw`)**: Konfiguration, Anmeldeinformationen, Authentifizierungsprofile, Sitzungen, Protokolle,
  und gemeinsame Fähigkeiten (`~/.openclaw/skills`).

Standard-Arbeitsbereich ist `~/.openclaw/workspace`, konfigurierbar über:

```json5
{
  agents: { defaults: { workspace: "~/.openclaw/workspace" } },
}
```

Wenn der Bot nach einem Neustart "vergisst" bestätigen Sie, dass das Gateway bei jedem Start denselben
Arbeitsbereich verwendet (und denke: Remote-Modus benutzt den **Gateway Host**
Arbeitsbereich nicht Ihr lokaler Laptop).

Tipp: Wenn du ein dauerhaftes Verhalten oder eine dauerhafte Einstellung wünschst, frage den Bot, es in
AGENTS **zu schreiben. d oder MEMORY.md** statt sich auf den Chatverlauf zu verlassen.

Siehe [Agent workspace](/concepts/agent-workspace) und [Memory](/concepts/memory).

### Was ist die empfohlene Backup-Strategie

Lege deinen **Agenten-Arbeitsbereich** in ein **privat** Git Repo und sichere ihn irgendwo
privat (zum Beispiel GitHub privat). Dies erfasst Speicher + AGENTS/SOUL/USER
Dateien und lässt Sie später den "Geist" des Assistenten wiederherstellen.

**nicht** etwas unter `~/.openclaw` übertragen (Anmeldeinformationen, Sitzungen, Tokens).
Wenn Sie eine vollständige Wiederherstellung benötigen, sichern Sie sowohl den Arbeitsbereich als auch das Zustandsverzeichnis
separat (siehe obige Migrationsfrage).

Docs: [Agent Workspace](/concepts/agent-workspace).

### Wie deinstalliere ich OpenClaw komplett

Siehe den dedizierten Führer: [Uninstall](/install/uninstall).

### Darf Agenten außerhalb des Arbeitsbereichs arbeiten

Ja. Der Arbeitsbereich ist der **Standard cwd** und Speicher Anker, nicht ein harter Sandbox.
Relative Pfade lösen sich innerhalb des Arbeitsbereichs, aber absolute Pfade können auf andere
Hostpositionen zugreifen, es sei denn, Sandboxen ist aktiviert. Wenn Sie Isolation benötigen, verwenden Sie
[`agents.defaults.sandbox`](/gateway/sandboxing) oder die Sandbox für jeden Agenten. Wenn Sie
wollen, dass ein Repo das Standard-Arbeitsverzeichnis ist, zeigen Sie den Agenten
`workspace` auf das Repo-Root. Das OpenClaw-Repo ist nur Quellcode; behalte den
-Arbeitsbereich getrennt, es sei denn, du möchtest, dass der Agent in ihm arbeitet.

Beispiel (Repo als Standard cwd):

```json5
{
  Agenten: {
    defaults: {
      workspace: "~/Projects/my-repo",
    },
  },
}
```

### Im Remote-Modus, wo ist der Session-Shop

Session-Status gehört dem **Gateway-Host**. Wenn Sie im Remote-Modus sind, ist der Session-Speicher, um den Sie kümmern, auf dem Remote-Rechner, nicht auf Ihrem lokalen Laptop. Siehe [Sitzungsmanagement](/concepts/session).

## Grundlagen konfigurieren

### Welches Format ist die Konfiguration, wo ist es

OpenClaw liest eine optionale **JSON5** Konfiguration von `$OPENCLAW_CONFIG_PATH` (Standard: `~/.openclaw/openclaw.json`):

```
$OPENCLAW_CONFIG_PATH
```

Wenn die Datei fehlt, verwendet sie Safe-ish Standardwerte (einschließlich eines Standard-Arbeitsbereiches von `~/.openclaw/workspace`).

### Ich setze Gatewaybind Lan oder tailnet und hört jetzt nichts auf die Benutzeroberfläche sagt unbefugt

Nicht-Loopback-Binds **benötigen auth**. Konfiguriere `gateway.auth.mode` + `gateway.auth.token` (oder benutze `OPENCLAW_GATEWAY_TOKEN`).

```json5
{
  Gateway: {
    bind: "lan",
    auth: {
      Modus: "token",
      token: "replace-me",
    },
  },
}
```

Hinweise:

- `gateway.remote.token` ist nur für **entfernte CLI-Aufrufe** und aktiviert keine lokale Gateway-Authentifizierung.
- Die Kontroll-Oberfläche authentifiziert sich über `connect.params.auth.token` (gespeichert in app/UI Einstellungen). Vermeiden Sie die Eingabe von Token in URLs.

### Warum brauche ich jetzt ein Token auf localhost

Der Assistent generiert standardmäßig ein Gateway-Token (auch bei Loopback), so dass **lokale WS-Clients sich authentifizieren müssen**. Dies blockiert andere lokale Prozesse, die Gateway aufzurufen. Fügen Sie das Token in die Kontroll-UI-Einstellungen (oder Ihre Clientkonfiguration) ein, um sich zu verbinden.

Wenn du **wirklich** eine Schleife öffnen möchtest, entferne `gateway.auth` aus deiner Konfiguration. Der Arzt kann jederzeit ein Token generieren: "openclaw doctor --generate-gateway-token".

### Muss ich nach dem Ändern der Konfiguration neu starten

Das Gateway überwacht die Konfiguration und unterstützt Hot-Reload:

- `gateway.reload.mode: "hybrid"` (Standard): Hot-apply sichere Änderungen, Neustart für kritische Änderungen
- `hot`, `restart`, `off` werden ebenfalls unterstützt

### Wie aktiviere ich Web-Suche und Web-Abruf

`web_fetch` funktioniert ohne API-Schlüssel. `web_search` erfordert einen Brave Search API
Schlüssel. **Empfohlen:** Führe `openclaw configure --section web` aus, um es in
`tools.web.search.apiKey` zu speichern. Umgebungsalternative: Setze `BRAVE_API_KEY` für den
Gateway-Prozess.

```json5
{
  Tools: {
    web: {
      search: {
        aktiviert: true
        apiKey: "BRAVE_API_KEY_HIERE",
        maxResults: 5,
      },
      Abruf: {
        enabled: true,
      },
    },
  },
}
```

Hinweise:

- Wenn du erlaubte Listen verwendest, füge `web_search`/`web_fetch` oder `group:web` hinzu.
- `web_fetch` ist standardmäßig aktiviert (sofern nicht ausdrücklich deaktiviert).
- Daemons lesen env vars von `~/.openclaw/.env` (oder der Service-Umgebung).

Doku: [Web tools](/tools/web).

### Wie führe ich ein zentrales Gateway mit spezialisierten Mitarbeitern über Geräte hinweg

Das gemeinsame Muster ist **ein Gateway** (z.B. Raspberry Pi) plus **Knoten** und **Agenten**:

- **Gateway (zentral):** besitzt Kanäle (Signal/WhatsApp), Routing und Sitzungen.
- **Knoten (Geräte):** Macs/iOS/Android verbinden sich als Peripherie und enthüllen lokale Tools (`system.run`, `canvas`, `camera`).
- **Agenten (Arbeiter):** separate Gehirn/Arbeitsbereiche für spezielle Rollen (z.B. "Hetzner ops", "Persönliche Daten").
- **Sub-Agenten:** Spawne Hintergrundarbeit von einem Hauptmakler, wenn du Parallelität möchtest.
- **TUI:** mit dem Gateway verbinden und Agenten/Sitzungen wechseln.

Docs: [Nodes](/nodes), [Remote Access](/gateway/remote), [Multi-Agent Routing](/concepts/multi-agent), [Sub-agents](/tools/subagents), [TUI](/web/tui).

### Darf der OpenClaw-Browser kopflose laufen

Ja. Es ist eine Konfigurations-Option:

```json5
{
  Browser: { headless: true },
  Agenten: {
    defaults: {
      sandbox: { browser: { headless: true } },
    },
  },
}
```

Standard ist `false` (kopfvoll). Kopflos wird eher Anti-Bot-Kontrollen auf einigen Seiten auslösen. Siehe [Browser](/tools/browser).

Headless verwendet die **gleiche Chromium-Engine** und arbeitet für die meisten Automatisierungen (Formulare, Klicks, Scraping, Logins). Die wichtigsten Unterschiede:

- Kein sichtbares Browserfenster (verwenden Sie Screenshots wenn Sie Bilder benötigen).
- Einige Seiten sind strenger über die Automatisierung im kopflosen Modus (CAPTCHAs, Anti-Bot).
  Zum Beispiel blockiert X/Twitter oft kopflose Sitzungen.

### Wie verwende ich Brave zur Browsersteuerung

Setze `browser.executablePath` auf deine Brave Binärdatei (oder jeden Chromium-basierten Browser) und starte das Gateway neu.
Sehen Sie sich die vollständigen Konfigurationsbeispiele in [Browser]an (/tools/browser#use-brave-or-another-chromium-based-browser).

## Entfernte Gateways und Knoten

### Wie die Befehle zwischen Telegram dem Gateway und Knoten übertragen werden

Telegramm-Nachrichten werden vom **Gateway** behandelt. Das Gateway führt den Agent aus und
ruft nur dann Knoten über den **Gateway WebSocket** auf, wenn ein Knotenwerkzeug benötigt wird:

Telegramm → Gateway → Agent → `node.*` → Knoten → Gateway → Telegram

Knoten sehen keinen eingehenden Providerverkehr; sie empfangen nur Node-RPC-Anrufe.

### Wie kann mein Agent auf meinen Computer zugreifen, wenn das Gateway entfernt gehostet wird

Kurze Antwort: **Verbinden Sie Ihren Computer als Knoten**. Das Gateway läuft woanders, aber es kann
`node.*` Werkzeuge (Bildschirm, Kamera, System) auf deinem lokalen Rechner über den Gateway WebSocket aufrufen.

Typisches Setup:

1. Führen Sie das Gateway auf dem immerwährenden Host (VPS/Home-Server) aus.
2. Legen Sie den Gateway-Host + Ihren Computer in das gleiche Hecknetz.
3. Stellen Sie sicher, dass das Gateway WS erreichbar ist (tailnet bind or SSH tunnel).
4. Öffne die macOS-App lokal und verbinde dich im **Remote over SSH** Modus (oder direkt tailnet)
   damit sie sich als Knoten registrieren kann.
5. Den Knoten auf dem Gateway genehmigen:

   ```bash
   openclaw nodes pending
   openclaw nodes approve <requestId>
   ```

Es wird keine separate TCP Bridge benötigt; Knoten verbinden sich über den Gateway WebSocket.

Sicherheits-Erinnerung: Das Kopieren eines macOS-Knotens erlaubt `system.run` auf diesem Rechner. Nur
Geräte denen Sie vertrauen, und überprüfen Sie [Security](/gateway/security).

Docs: [Nodes](/nodes), [Gateway protocol](/gateway/protocol), [macOS remote mode](/platforms/mac/remote), [Security](/gateway/security).

### Skalierung ist verbunden, aber ich bekomme keine Antworten Was jetzt

Überprüfen Sie die Basics:

- Gateway läuft: "openclaw gateway status"
- Gateway-Gesundheit: "openclaw status"
- Kanal-Gesundheit: `openclaw channels status`

Überprüfen Sie dann auth und routing:

- Wenn du den Schablonen-Server verwendest, stelle sicher, dass `gateway.auth.allowTailscale` korrekt eingestellt ist.
- Wenn Sie sich über den SSH-Tunnel verbinden, bestätigen Sie, dass der lokale Tunnel oben ist und Punkte am rechten Hafen.
- Bestätigen Sie Ihre Zulassungslisten (DM oder Gruppe) mit Ihrem Konto.

Docs: [Tailscale](/gateway/tailscale), [Fernzugriff/gateway/remote), [Channels](/channels).

### Können zwei OpenClaw-Instanzen miteinander kommunizieren

Ja. Es gibt keine eingebaute "Bot-to-Bot" Brücke, aber du kannst sie auf einige zuverlässige
verschieben:

**Einfach:** benutze einen normalen Chatkanal, auf den beide Bots zugreifen können (Telegram/Slack/WhatsApp).
Lassen Sie Bot A eine Nachricht an Bot B senden und dann Bot B wie gewohnt antworten.

**CLI Bridge (generisch):** Führen Sie ein Skript aus, das das andere Gateway mit
`openclaw agent --message aufruft... --deliver`, zielt auf einen Chat ab, wo der andere Bot
lauscht. Wenn sich ein Bot auf einem entfernten VPS befindet, verweisen Sie Ihr CLI auf dieses entfernte Gateway
über SSH/Maßstabstabe (siehe [Remote Access](/gateway/remote)).

Beispielmuster (führen Sie von einer Maschine aus, die das Zieltor erreichen kann):

```bash
openclaw agent --message "Hallo vom lokalen Bot" --deliver --channel telegram --reply-to <chat-id>
```

Tipp: Füge einen Wächter hinzu, damit die beiden Bots nicht endlos schleifen (nur erwähnen, Kanal
Erlaubnislisten oder eine "Antworte nicht auf Bot Nachrichten"-Regel).

Docs: [Remote Access](/gateway/remote), [Agent CLI](/cli/agent), [Agent senden](/tools/agent-send).

### Benötige ich separate VPSes für mehrere Agenten

Nein. Ein Gateway kann mehrere Agenten beherbergen, jeder mit eigenem Arbeitsbereich, Standardeinstellungen,
und Routing. Das ist das normale Setup und es ist viel billiger und einfacher als
ein VPS pro Agent auszuführen.

Verwenden Sie separate VPSes nur, wenn Sie harte Isolation (Sicherheitsgrenzen) oder sehr
verschiedene Konfigurationen benötigen, die Sie nicht teilen möchten. Andernfalls sollten ein Gateway und
mehrere Agenten oder Sub-Agenten verwenden.

### Gibt es einen Vorteil, einen Knoten auf meinem persönlichen Laptop anstelle von SSH von einem VPS zu verwenden

Ja - Knoten sind der erstklassige Weg, um Ihren Laptop von einem entfernten Gateway aus zu erreichen, und sie
entsperren mehr als Shell-Zugang. Das Gateway läuft auf macOS/Linux (Windows via WSL2) und ist
leichtgewichtig (eine kleine VPS oder Raspberry Pi-Klasse ist in Ordnung; 4 GB RAM ist reichlich), also ist ein gängiges
Setup ein immerwährender Host plus Ihr Laptop als Knoten.

- **Keine eingehende SSH erforderlich.** Knoten verbinden sich mit dem Gateway WebSocket und verwenden Geräte-Paarung.
- **Sicherere Ausführungskontrollen.** `system.run` wird von node allowlists/approvals auf diesem Laptop bewacht.
- **Weitere Geräte-Tools.** Knoten zeigen zusätzlich zu `system.run` `Canvas`, `camera` und `screen` an.
- \*\*Lokale Browser-Automatisierung. \* Behalte das Gateway auf einem VPS, aber führen Sie Chrome lokal aus und übertragen Sie die Steuerung
  mit der Chrome-Erweiterung + einem Knoten-Host auf dem Laptop.

SSH ist gut für Ad-hoc Shell-Zugriff, aber Knoten sind einfacher für laufende Agenten-Workflows und
Geräteautomatisierung.

Docs: [Nodes](/nodes), [Knoten CLI](/cli/nodes), [Chrome-Erweiterung](/tools/chrome-extension).

### Soll ich auf einem zweiten Laptop installieren oder einfach einen Knoten hinzufügen

Wenn du nur **lokale Werkzeuge** (Bildschirm/Kamera/ausführen) auf dem zweiten Laptop brauchst, füge es als
**Knoten** hinzu. Dies hält ein einzelnes Gateway und vermeidet doppelte Konfiguration. Lokale Knotenwerkzeuge sind
zur Zeit nur macOS, aber wir planen, sie auf andere Betriebssysteme zu erweitern.

Installieren Sie ein zweites Gateway nur, wenn Sie **harte Isolierung** oder zwei vollständig getrennte Bots benötigen.

Docs: [Nodes](/nodes), [Knoten CLI](/cli/nodes), [Mehrere Gateways](/gateway/multiple-gateways).

### Knoten führen einen Gateway-Dienst aus

Nein. Nur ein Gateway\*\* sollte pro Host ausgeführt werden, es sei denn, Sie führen absichtlich isolierte Profile aus (siehe [Mehrere Gateways](/gateway/multiple-gateways)). Knoten sind Peripheriegeräte, die
mit dem Gateway verbinden (iOS/Android Knoten oder macOS "Knotenmodus" in der Menüleiste. Für kopflose Knoten
Hosts und CLI Steuerung, siehe [Knoten Host CLI](/cli/node).

Ein vollständiger Neustart wird für Änderungen von `gateway`, `discovery` und `canvasHost` benötigt.

### Gibt es einen API-RPC-Weg um die Konfiguration zu übernehmen

Ja. `config.apply` validates + schreibt die vollständige Konfiguration und startet das Gateway als Teil der Operation neu.

### configapply wischte meine Config Wie kann ich wiederherstellen und dies vermeiden

`config.apply` ersetzt die **komplette Konfiguration**. Wenn du ein Teilobjekt sendest, wird alles
entfernt.

Wiederherstellen:

- Wiederherstellen aus dem Backup (git oder ein kopiertes `~/.openclaw/openclaw.json`).
- Wenn du kein Backup hast, führe `openclaw doctor` erneut und konfiguriere Channels/Modelle neu.
- Wenn dies nicht erwartet wurde, legen Sie einen Fehler auf und fügen Sie Ihre letzte bekannte Konfiguration oder ein Backup hinzu.
- Ein lokaler Codierer kann oft eine funktionierende Konfiguration aus Logs oder Geschichte rekonstruieren.

Vermeiden Sie:

- Benutze `openclaw config set` für kleine Änderungen.
- Benutze `openclaw configure` für interaktive Bearbeitungen.

Docs: [Config](/cli/config), [Configure](/cli/configure), [Doctor](/gateway/doctor).

### Was ist eine minimale vernünftige Konfiguration für eine erste Installation

```json5
{
  agents: { defaults: { workspace: "~/.openclaw/workspace" } },
  channels: { whatsapp: { allowFrom: ["+15555550123"] } },
}
```

Dies legt Ihren Arbeitsbereich fest und schränkt ein, wer den Bot auslösen kann.

### Wie konfiguriere ich eine Maßstabskala auf einem VPS und verbinde mich mit meinem Mac

Minimale Schritte:

1. **Installiere + melde dich auf dem VPS an**

   ```bash
   curl -fsSL https://tailscale.com/install.sh | sh
   sudo tailscale up
   ```

2. **Installiere + melde dich auf deinem Mac an**
   - Verwenden Sie die Maßstab-App und melden Sie sich im selben tailnet an.

3. \*\*MagicDNS aktivieren (empfohlen) \*\*
   - Aktivieren Sie in der Tailscale Admin-Konsole MagicDNS, so dass der VPS einen stabilen Namen hat.

4. **Benutze den tailnet hostname**
   - SSH: `ssh user@your-vps.tailnet-xxxx.ts.net`
   - Gateway WS: `ws://your-vps.tailnet-xxxx.ts.net:18789`

Wenn Sie die Steuerungsoberfläche ohne SSH wollen, verwenden Sie den Schneidangebot auf dem VPS:

```bash
openclaw gateway --tailscale serve
```

Dies hält das Gateway an Loopback gebunden und zeigt HTTPS über Maßstabskala auf. Siehe [Tailscale](/gateway/tailscale).

### Wie verbinde ich einen Mac-Knoten mit einem Remote-Gateway-Schnittstellen-Server

Serve stellt die **Gateway Control UI + WS** dar. Knoten verbinden sich über den gleichen Gateway WS Endpunkt.

Empfohlene Einrichtung:

1. **Stelle sicher, dass der VPS + Mac im selben tailnet** ist.
2. **Benutze die macOS-App im Remote-Modus** (SSH-Ziel kann der tailnet-Hostname sein).
   Die App wird den Gateway-Port Tunnel machen und sich als Knoten verbinden.
3. **Erlaube den Knoten** im Gateway:

   ```bash
   openclaw nodes pending
   openclaw nodes approve <requestId>
   ```

Docs: [Gateway protocol](/gateway/protocol), [Discovery](/gateway/discovery), [macOS remote mode](/platforms/mac/remote).

## Env vars und .env laden

### Wie lädt OpenClaw Umgebungsvariablen

OpenClaw liest Umgebungsvariablen aus dem übergeordneten Prozess (Shell, launchd/systemd, CI usw.) und zusätzlich laden:

- `.env` aus dem aktuellen Arbeitsverzeichnis
- eine globale Fallback‑Datei `.env` aus `~/.openclaw/.env` (alias `$OPENCLAW_STATE_DIR/.env`)

Keine der `.env`‑Dateien überschreibt bestehende Umgebungsvariablen.

Sie können auch inline env vars in der Konfiguration definieren (nur angewendet, wenn der Prozess env fehlt):

```json5
{
  env: {
    OPENROUTER_API_KEY: "sk-or-...",
    vars: { GROQ_API_KEY: "gsk-..." },
  },
}
```

Siehe [/environment](/help/environment) für vollständige Prioritäten und Quellen.

### Ich begann das Gateway über den Dienst und meine env vars verschwand Was jetzt

Zwei gemeinsame Fixes:

1. Lege die fehlenden Schlüssel in `~/.openclaw/.env` ein, so dass sie abgeholt werden, auch wenn der Dienst deine Shell env nicht ererbt.
2. Shell-Import aktivieren (Opt-in-Bequemlichkeit):

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

Dies führt Ihre Login-Shell aus und importiert nur fehlende erwartete Schlüssel (überschreiben). Env var equivalents:
`OPENCLAW_LOAD_SHELL_ENV=1`, `OPENCLAW_SHELL_ENV_TIMEOUT_MS=15000`.

### Ich habe COPILOTGITHUBTOKEN gesetzt, aber Model-Status zeigt Shell env aus Warum

`openclaw models status` gibt an, ob **shell env import** aktiviert ist. "Shell env: off"
bedeutet **nicht** dass deine env vars fehlen - es bedeutet nur, dass OpenClaw nicht automatisch
deine Login-Shell lädt.

Wenn das Gateway als Dienst (launchd/systemd) läuft, wird es Ihre Shell-
Umgebung nicht erben. Beheben durch eine der folgenden:

1. Füge das Token in `~/.openclaw/.env` ein:

   ```
   COPILOT_GITHUB_TOKEN=...
   ```

2. Oder aktivieren Sie den Shell-Import (`env.shellEnv.enabled: true`).

3. Oder füge es zu deinem Konfigurationsblock hinzu (gilt nur, wenn es fehlt).

Dann starten Sie das Gateway neu und recherchieren:

```bash
openclaw models status
```

Copilot Token werden von `COPILOT_GITHUB_TOKEN` gelesen (auch `GH_TOKEN` / `GITHUB_TOKEN`).
Siehe [/concepts/model-providers](/concepts/model-providers) und [/environment](/help/environment).

## Sitzungen und mehrere Chats

### Wie starte ich eine neue Unterhaltung

Sende `/new` oder `/reset` als eigenständige Nachricht. Siehe [Sitzungsmanagement](/concepts/session).

### Sitzungen automatisch zurücksetzen, wenn ich nie neue sende

Ja. Sitzungen laufen nach `session.idleMinutes` ab (Standard **60**). Die **nächste**
Nachricht startet eine neue Session-ID für diesen Chat-Schlüssel. Dies löscht keine
Transkripte - es startet nur eine neue Sitzung.

```json5
{
  Sitzung: {
    idleMinutes: 240,
  },
}
```

### Gibt es eine Möglichkeit, ein Team von OpenClaw Instanzen zu einem CEO und vielen Agenten zu machen

Ja, über **Multi-Agent-Routing** und **Sub-Agenten**. Sie können einen Coordinator
Agenten und mehrere Arbeiter Agenten mit eigenen Arbeitsbereichen und Modellen erstellen.

Trotzdem wird dies am besten als **lustiges Experiment** angesehen. Es ist token schwer und oft
weniger effizient als mit einem Bot mit separaten Sitzungen. Das typische Modell, mit dem wir uns
vorstellen, ist ein Bot, mit dem Sie sprechen, mit verschiedenen Sitzungen für parallele Arbeit. Dieser
-Bot kann auch Sub-Agenten spawnen wenn nötig.

Docs: [Multi-Agent routing](/concepts/multi-agent), [Sub-agents](/tools/subagents), [Agents CLI](/cli/agents).

### Warum wurde Kontext abgeschnitten Mittelaufgabe Wie kann ich es verhindern

Der Session-Kontext ist durch das Modellfenster begrenzt. Lange Chats, große Werkzeugausgänge oder viele
-Dateien können Verdichtung oder Kürzung auslösen.

Was hilft:

- Bitten Sie den Bot, den aktuellen Zustand zusammenzufassen und ihn in eine Datei zu schreiben.
- Benutze `/compact` vor langen Aufgaben und `/new` beim Ändern von Themen.
- Halten Sie den wichtigen Kontext im Arbeitsbereich und bitten Sie den Bot, ihn wieder zu lesen.
- Verwenden Sie Sub-Agenten für lange oder parallele Arbeit, so dass der Hauptchat kleiner bleibt.
- Wählen Sie ein Modell mit einem größeren Kontextfenster, wenn dies oft passiert.

### Wie setze ich OpenClaw komplett zurück, aber halte es installiert

Den Reset-Befehl verwenden:

```bash
openclaw reset
```

Nicht interaktiv zurücksetzen:

```bash
openclaw Reset --scope full --yes --non-interactive
```

Anschließend an Bord erneut starten:

```bash
openclaw onboard --install-daemon
```

Hinweise:

- Der Onboarding-Assistent bietet auch **Reset** an, wenn er eine vorhandene Konfiguration sieht. Siehe [Wizard](/start/wizard).
- Wenn du Profile benutzt hast (`--profile` / `OPENCLAW_PROFILE`), setze jedes State Verzeichnis zurück (Standardwerte sind `~/.openclaw-<profile>`).
- Dev reset: `openclaw gateway --dev --reset` (dev-only; wipes dev config + credentials + sessions + workspace).

### Im Kontext zu große Fehler wie kann ich zurücksetzen oder kompakt

Verwenden Sie eine der folgenden Optionen:

- **Kompakt** (hält die Unterhaltung, fasst aber ältere Wendungen zusammen):

  ```
  /kompakt
  ```

  oder `/compact <instructions>` um die Zusammenfassung zu leiten.

- **Zurücksetzen** (neue Sitzungs-ID für denselben Chatschlüssel):

  ```
  /new
  /reset
  ```

Wenn es weitergeht:

- Aktiviere oder tune **Session pruning** (`agents.defaults.contextPruning`), um alte Werkzeugausgabe abzuschneiden.
- Verwenden Sie ein Modell mit einem größeren Kontextfenster.

Docs: [Compaction](/concepts/compaction), [Sitzungsschnitt](/concepts/session-pruning), [Sitzungsverwaltung](/concepts/session).

### Warum sehe ich LLM-Anfrage abgelehnt Nachrichten NcontentXtooluseinput Feld erforderlich

Dies ist ein Fehler bei der Anbieterüberprüfung: Das Modell hat einen `tool_use` Block ohne die erforderliche
`input` emittiert. Normalerweise ist die Session-Historie veraltet oder beschädigt (oft nach langen Threads
oder einer Tool/Schema-Änderung).

Korrektur: Starte eine neue Session mit `/new` (Standalone-Nachricht).

### Warum bekomme ich alle 30 Minuten Herzschlag-Nachrichten

Herzbeats laufen standardmäßig alle **30m** ab. Einschalten oder deaktivieren:

```json5
{
  Agenten: {
    defaults: {
      heartbeat: {
        every: "2h", // oder "0m" um
      },
    },
  },
}
```

Wenn `HEARTBEAT.md` existiert, aber faktisch leer ist (nur Leerzeilen und Markdown-
Überschriften wie `# Heading`), überspringt OpenClaw den Heartbeat-Lauf, um API-
Aufrufe zu sparen.
Fehlt die Datei, läuft der Heartbeat trotzdem und das Modell entscheidet, was zu tun ist.

Per-agent überschreibt `agents.list[].heartbeat`. Docs: [Heartbeat](/gateway/heartbeat).

### Muss ich ein Bot-Konto zu einer WhatsApp-Gruppe hinzufügen

Nein. OpenClaw läuft auf **deinem eigenen Konto**, also wenn du in der Gruppe bist, kann OpenClaw es sehen.
Standardmäßig werden Gruppenantworten blockiert, bis Absender erlaubt sind (`groupPolicy: "allowlist"`).

Wenn du nur **du** in der Lage sein möchtest, Gruppenantworten auszulösen:

```json5
{
  Kanäle: {
    whatsapp: {
      groupPolicy: "allowlist",
      groupAllowFrom: ["+15551234567"],
    },
  },
}
```

### Wie bekomme ich die JID einer WhatsApp-Gruppe

Option 1 (schnellste): Track-Logs und Senden einer Testnachricht in der Gruppe:

```bash
openclaw-Protokolle --follow --json
```

Suche nach `chatId` (oder `from`) und endet in `@g.us`, wie:
`1234567890-1234567890@g.us`.

Option 2 (wenn bereits konfiguriert/erlaubt): Listengruppen aus der Konfiguration:

```bash
openclaw Verzeichnisgruppen Liste --channel whatsapp
```

Docs: [WhatsApp](/channels/whatsapp), [Directory](/cli/directory), [Logs](/cli/logs).

### Warum antwortet OpenClaw nicht in einer Gruppe

Zwei gemeinsame Ursachen:

- Erwähnungsgating ist an (Standard). Du musst den Bot @erwähnen (oder Match `mentionPatterns`).
- Du hast `channels.whatsapp.groups` ohne `"*"` konfiguriert und die Gruppe ist nicht erlaubt.

Siehe [Groups](/channels/groups) und [Gruppenmitteilungen](/channels/group-messages).

### Gruppenthesen teilen Kontext mit DMs

Direkte Chats werden standardmäßig in die Hauptsitzung eingeblendet. Gruppen/Kanäle haben ihre eigenen Sitzungsschlüssel und Telegram-Themen / Discord-Threads sind separate Sitzungen. Siehe [Groups](/channels/groups) und [Gruppenmitteilungen](/channels/group-messages).

### Wie viele Arbeitsbereiche und Agenten kann ich erstellen

Keine harten Grenzen. Dutzende (sogar Hunderte) sind in Ordnung, aber hüten Sie sich auf:

- **Festplattenwachstum:** Sitzungen + Transkripte live unter `~/.openclaw/agents/<agentId>/sessions/`.
- **Tokenkost:** mehr Agenten bedeuten mehr gleichzeitige Modellnutzung.
- **Ops Overhead:** pro Agent auth Profile, Arbeitsbereiche und Kanalrouting.

Tipps:

- Behalte einen **aktiven** Arbeitsbereich pro Agent (`agents.defaults.workspace`).
- Lösche alte Sitzungen (lösche JSONL oder speichere Einträge), wenn die Festplatte wächst.
- Verwende `openclaw doctor`, um verirrte Arbeitsbereiche und Missverhältnisse im Profil zu erkennen.

### Kann ich mehrere Bots oder Chats gleichzeitig betreiben, Slack und wie sollte ich das einrichten

Ja. Verwende **Multi-Agent Routing** um mehrere isolierte Agenten auszuführen und eingehende Nachrichten von
Kanal/Account/Peer zu leiten. Slack wird als Kanal unterstützt und kann an bestimmte Agenten gebunden werden.

Browser-Zugriff ist leistungsstark, aber nicht "tun Sie irgendetwas ein menschliches Dosen" - Anti-Bot, CAPTCHAs, und MFA kann
noch die Automatisierung blockieren. Benutzen Sie für die zuverlässigste Browsersteuerung die Chrome-Erweiterungsrelais
auf dem Computer, auf dem der Browser läuft (und halten Sie das Gateway überall).

Best-Practice-Setup:

- Immer auf Gateways-Host (VPS/Mac mini).
- Ein Agent pro Rolle (Bindung).
- Slack Channel(s) an diese Agenten gebunden.
- Lokaler Browser über Extension Relais (oder einen Knoten) bei Bedarf.

Docs: [Multi-Agent Routing](/concepts/multi-agent), [Slack](/channels/slack),
[Browser](/tools/browser), [Chrome Erweiterung](/tools/chrome-extension), [Nodes](/nodes).

## Modelle: Standardeinstellungen, Auswahl, Aliase, Wechseln

### Was ist das Standardmodell

OpenClaw's Standardmodell ist was Sie einstellen als:

```
agents.defaults.model.primary
```

Modelle werden als `provider/model` referenziert (Beispiel: `anthropic/claude-opus-4-6`). Wenn du den Provider weggelassen hast, nimmt OpenClaw derzeit `anthropic` als temporären Deprecation Fallback an - aber du solltest trotzdem **explizit** `provider/model` setzen.

### Welches Modell empfehlen Sie

**Empfohlen Standard:** `anthropic/claude-opus-4-6`.
**Gute Alternative:** `anthropic/claude-sonnet-4-5`.
**Verlässliche (weniger Zeichen):** `openai/gpt-5.2` - fast so gut wie Opus, nur weniger Persönlichkeit.
**Budget:** `zai/glm-4.7`.

MiniMax M2.1 hat eigene Doktor: [MiniMax](/providers/minimax) und
[Lokale Modelle](/gateway/local-models).

Thumbnail-Regel: Benutze das **beste Modell, das du sich leisten kannst** für Arbeit mit hohem Einsatz und ein billigeres
-Modell für Routine-Chat oder Zusammenfassungen. Sie können Modelle pro Agent leiten und Sub-Agenten nach
paraletrieren lange Aufgaben (jeder Sub-Agent verbraucht Tokens). Siehe [Models](/concepts/models) und
[Sub-agents](/tools/subagents).

Starke Warnung: schwächere/überquantifizierte Modelle sind anfälliger für
Injektion und unsicheres Verhalten. Siehe [Security](/gateway/security).

Mehr Kontext: [Models](/concepts/models).

### Kann ich selbst gehostete Modelle llamacpp vLLM Ollama verwenden

Ja. Wenn Ihr lokaler Server eine OpenAI-kompatible API aufdeckt, können Sie einen
benutzerdefinierten Provider darauf zeigen. Ollama wird direkt unterstützt und ist der einfachste Weg.

Sicherheitshinweis: kleinere oder stark quantifizierte Modelle sind anfälliger für eine
Injektion. Wir empfehlen **große Modelle** für jeden Bot, der Werkzeuge verwenden kann.
Wenn Sie immer noch kleine Modelle wollen, aktivieren Sie Sandboxen und strenge Werkzeug-Zulassungslisten.

Docs: [Ollama](/providers/ollama), [Lokale Modelle](/gateway/local-models),
[Modellanbieter](/concepts/model-providers), [Security](/gateway/security),
[Sandboxing](/gateway/sandboxing).

### Wie kann ich Modelle wechseln, ohne meine Konfiguration zu löschen

Benutze **Modellbefehle** oder bearbeite nur die **Modell** Felder. Vermeiden Sie die vollständige Konfiguration zu ersetzen.

Sichere Optionen:

- `/model` im Chat (schnell, pro Sitzung)
- `openclaw models set ...` (aktualisiert nur model config)
- `openclaw configure --section model` (interaktiv)
- editiere `agents.defaults.model` in `~/.openclaw/openclaw.json`

Vermeide `config.apply` mit einem Teilobjekt, es sei denn, du beabsichtigst die gesamte Konfiguration zu ersetzen.
Wenn du die Konfiguration überschrieben hast, stelle sie aus dem Backup her oder führe `openclaw doctor` erneut aus, um sie zu reparieren.

Docs: [Models](/concepts/models), [Configure](/cli/configure), [Config](/cli/config), [Doctor](/gateway/doctor).

### Was verwenden OpenClaw, Fehler und Krill für Modelle

- **OpenClaw + Fehler:** Anthropisches Opus (`anthropic/claude-opus-4-6`) - siehe [Anthropic](/providers/anthropic).
- **Krill:** MiniMax M2.1 (`minimax/MiniMax-M2.1`) - see [MiniMax](/providers/minimax).

### Wie kann ich Modelle ohne Neustart auf die Fliege schalten

Benutze den `/model` Befehl als eigenständige Nachricht:

```
/model sonnet
/model haiku
/model opus
/model gpt
/model gpt-mini
/model gemini
/model gemini-flash
```

Sie können die verfügbaren Modelle mit `/model`, `/model list`, oder `/model status` auflisten.

`/model` (und `/model list`) zeigt einen kompakten, nummerierten Picker. Nach Nummer wählen:

```
/model 3
```

Sie können auch ein bestimmtes Auth-Profil für den Anbieter erzwingen (pro Sitzung):

```
/model opus@anthropic:default
/model opus@anthropic:work
```

Tipp: `/model status` zeigt an, welcher Agent aktiv ist, welche `auth-profiles.json` Datei verwendet wird und welcher auth profile als nächstes ausprobiert wird.
Es zeigt auch den konfigurierten Provider-Endpunkt (`baseUrl`) und den API-Modus (`api`) an, wenn er verfügbar ist.

**Wie löse ich ein Profil, das ich mit Profil gesetzt habe**

Starte `/model` \*\*ohne das `@profile` Suffix:

```
/model anthropic/claude-opus-4-6
```

Wenn du zur Standardeinstellung zurückkehren möchtest, wähle es aus `/model` (oder sende `/model <default provider/model>`).
Benutze `/model status` um zu bestätigen, welches auth Profil aktiv ist.

### Kann GPT 5.2 für tägliche Aufgaben und Codex 5.3 für die Codierung verwenden

Ja. Setze einen als Standard und wechsele wie benötigt:

- **Schneller Schalter (pro Sitzung):** `/model gpt-5.2` für tägliche Aufgaben, `/model gpt-5.3-codex` für die Programmierung.
- **Standard + switch:** setzt `agents.defaults.model.primary` auf `openai/gpt-5.2`, dann wechseln Sie auf `openai-codex/gpt-5.3-codex` wenn die Programmierung (oder umgekehrt).
- **Sub-Agenten:** Route Codierung Aufgaben an Sub-Agenten mit einem anderen Standardmodell.

Siehe [Models](/concepts/models) und [Schrägbefehle](/tools/slash-commands).

### Warum sehe ich Modell nicht erlaubt und dann keine Antwort

Wenn `agents.defaults.models` gesetzt ist, wird es zur **allowlist** für `/model` und jede
Session überschreibt. Wählen Sie ein Modell, das nicht in dieser Liste zurückgegeben wird:

```
Model "provider/model" is not allowed. Use /model to list available models.
```

Dieser Fehler wird **statt einer normalen Antwort** zurückgegeben. Korrektur: Füge das Modell zu
`agents.defaults.models` hinzu, entferne die Erlaubnisliste oder wähle ein Modell aus der `/model list`.

### Warum sehe ich unbekanntes Modell minimaxMiniMaxM21

Dies bedeutet, dass der **Provider nicht konfiguriert ist** (keine MiniMax Providerkonfiguration oder Auth
Profil gefunden), daher kann das Modell nicht gelöst werden. Eine Korrektur für diese Erkennung ist
in **2026.1.12** (zum Zeitpunkt des Schreibens unveröffentlicht).

Checkliste reparieren:

1. Aktualisieren Sie auf **2026.1.12** (oder starten Sie vom Quellcode `main`), dann starten Sie das Gateway neu.
2. Stellen Sie sicher, dass MiniMax konfiguriert ist (Assistent oder JSON), oder dass ein MiniMax API-Schlüssel
   in env/auth Profilen vorhanden ist, damit der Provider injiziert werden kann.
3. Benutze die exakte Model ID (Groß-/Kleinschreibung): `minimax/MiniMax-M2.1` oder
   `minimax/MiniMax-M2.1-lightning`.
4. Run:

   ```bash
   openclaw models list
   ```

   und wählen Sie aus der Liste (oder `/model list` im Chat).

Siehe [MiniMax](/providers/minimax) und [Models](/concepts/models).

### Kann ich MiniMax als Standard und OpenAI für komplexe Aufgaben verwenden

Ja. Verwende **MiniMax als Standard** und wechsele bei Bedarf Modelle **pro Sitzung**.
Fallbacks sind für **errors**, nicht für "hard tasks", also verwende `/model` oder einen separaten Agent.

**Option A: Wechsel pro Sitzung**

```json5
{
  env: { MINIMAX_API_KEY: "sk-...", OPENAI_API_KEY: "sk-... },
  Agenten: {
    defaults: {
      model: { primary: "minimax/MiniMax-M2. },
      Modelle: {
        "minimax/MiniMax-M2. ": { alias: "minimax" },
        "openai/gpt-5. ": { alias: "gpt" },
      },
    },
  },
}
```

Dann:

```
/model gpt
```

**Option B: separate Agenten**

- Agent A default: MiniMax
- Agent B Standard: OpenAI
- Route nach Agenten oder benutze `/agent` um zu wechseln

Docs: [Models](/concepts/models), [Multi-Agent Routing](/concepts/multi-agent), [MiniMax](/providers/minimax), [OpenAI](/providers/openai).

### Sind opus sonnet gpt eingebaute Verknüpfungen

Ja. OpenClaw liefert ein paar Standardshorthands (wird nur angewendet, wenn das Modell in `agents.defaults.models` existiert):

- `opus` → `anthropic/claude-opus-4-6`
- `sonnet` → `anthropic/claude-sonnet-4-5`
- `gpt` → `openai/gpt-5.2`
- `gpt-mini` → `openai/gpt-5-mini`
- `gemini` → `google/gemini-3-Pro-Vorschau`
- `gemini-flash` → `google/gemini-3-flash-preview`

Wenn Sie Ihren eigenen Alias mit dem gleichen Namen setzen, gewinnt Ihr Wert.

### Wie kann ich Model-Verknüpfungen Aliase definieren

Aliase kommen von `agents.defaults.models.<modelId>.alias`. Beispiel:

```json5
{
  Agenten: {
    defaults: {
      model: { primary: "anthropic/claude-opus-4-6" },
      Modelle: {
        "anthropic/claude-opus-4-6": { alias: "opus" },
        "anthropic/claude-sonnet-4-5": { alias: "sonnet" },
        "anthropic/claude-haiku-4-5": { alias: "haiku" },
      },
    },
  },
}
```

Dann löst `/model sonnet` (oder `/<alias>` wenn unterstützt) an diese Model ID.

### Wie füge ich Modelle anderer Anbieter wie OpenRouter oder ZAI hinzu

OpenRouter (pay-per-token; viele Modelle):

```json5
{
  Agenten: {
    defaults: {
      model: { primary: "openrouter/anthropic/claude-sonnet-4-5" },
      Modelle: { "openrouter/anthropic/claude-sonnet-4-5": {} },
    },
  },
  env: { OPENROUTER_API_KEY: "sk-or-. ." },
}
```

Z.AI (GLM-Modelle):

```json5
{
  Agenten: {
    defaults: {
      model: { primary: "zai/glm-4. },
      Modelle: { "zai/glm-4. ": {} },
    },
  },
  env: { ZAI_API_KEY: "..." },
}
```

Wenn Sie einen Provider/Model referenzieren, aber der benötigte Providerschlüssel fehlt, erhalten Sie einen Runtime Autth-Fehler (z. . `Kein API-Schlüssel für Anbieter "zai"`) gefunden.

**Kein API-Schlüssel für Anbieter nach dem Hinzufügen eines neuen Agenten**

Dies bedeutet normalerweise, dass der **neue Agent** einen leeren Auth-Store hat. Auth ist pro Agent und
gespeichert in:

```
~/.openclaw/agents/<agentId>/agent/auth-profiles.json
```

Lösungsoptionen:

- Führe \`openclaw Agents add <id>aus und konfiguriere auth während des Assistenten.
- Oder kopiere `auth-profiles.json` aus der Hauptmappe `agentDir` in die `agentDir` des neuen Agenten.

Verwende **nicht** `agentDir` zwischen Agenten; es verursacht auth/sessions-Kollisionen.

## Model Failover und "Alle Modelle fehlgeschlagen"

### Wie funktioniert Failover

Failover passiert in zwei Stufen:

1. **Auth Profil Rotation** innerhalb des gleichen Providers.
2. **Modell‑Fallback** zum nächsten Modell in `agents.defaults.model.fallbacks`.

Cooldowns gelten für fehlerhafte Profile (exponentieller Backoff), so dass OpenClaw auch dann weiter reagieren kann, wenn ein Anbieter mit einer Rate begrenzt oder vorübergehend versagt.

### Was bedeutet dieser Fehler

```
Keine Anmeldedaten für Profil "anthropic:default" gefunden
```

Es bedeutet, dass das System versucht hat, die Authentifizierungs-Profil-ID `anthropic:default` zu verwenden, aber konnte keine Anmeldeinformationen dafür im erwarteten Auth-Store finden.

### Überprüfungsliste für keine Anmeldeinformationen für das Profil anthropicdefault gefunden

- **Bestätige wo auth Profile leben** (neue vs Legacy Pfade)
  - Aktuell: `~/.openclaw/agents/<agentId>/agent/auth-profiles.json`
  - Legacy: `~/.openclaw/agent/*` (von `openclaw doctor`)
- **Bestätige dass dein env var vom Tor geladen wird**
  - Wenn du `ANTHROPIC_API_KEY` in deiner Shell gesetzt hast, aber das Gateway über system/launchd ausführst, wird es möglicherweise nicht geerbt. Setze es in `~/.openclaw/.env` oder aktiviere `env.shellEnv`.
- **Stelle sicher, dass du den richtigen Agenten bearbeitest**
  - Multi-Agent Setups bedeuten, dass es mehrere `auth-profiles.json` Dateien geben kann.
- **Sanity-Check Modell/Auth Status**
  - Benutze `openclaw models status` um konfigurierte Modelle zu sehen und ob Anbieter authentifiziert sind.

**Fix Checkliste für keine Anmeldeinformationen für Profil anthropic**

Dies bedeutet, dass der Run an ein anthropisches auth Profil gekoppelt ist, aber das Gateway
kann es nicht in seinem auth Store finden.

- **Benutze einen Setup-Token**
  - Führen Sie `claude setup-token` aus und fügen Sie es mit `openclaw models auth setup-token --provider anthropic` ein.
  - Wenn das Token auf einem anderen Rechner erstellt wurde, verwenden Sie `openclaw models auth paste-token --provider anthropic`.

- **Wenn du stattdessen einen API-Schlüssel verwenden möchtest**
  - Lege `ANTHROPIC_API_KEY` in `~/.openclaw/.env` auf den **Gateway-Host** ein.
  - Lösche jede angeheftete Reihenfolge, die ein fehlendes Profil erzwingt:

    ```bash
    openclaw modelliert auth order clear --provider anthropic
    ```

- **Bestätige deine Befehle auf dem Gateway-Host**
  - Im Remote-Modus werden automatisch Profile live auf dem Gateway-Rechner und nicht auf Ihrem Laptop gespeichert.

### Warum hat es auch Google Gemini versucht und scheitert

Wenn Ihre Modellkonfiguration Google Gemini als Fallback enthält (oder Sie zu einem Gemini Shorthand) wechselt, wird OpenClaw es während des Modellfallbacks versuchen. Wenn Sie keine Google-Zugangsdaten konfiguriert haben, sehen Sie "Kein API-Schlüssel für Anbieter "google" gefunden.

Korrektur: entweder bietet Google auth, oder entfernt oder vermeidet Google Modelle in `agents.defaults.model.fallbacks` / Aliasse, so dass Fallback nicht dorthin geleitet wird.

**LLM-Anfrage hat Nachrichten zurückgewiesen, dass Signatur Google Antigravität benötigt**

Grund: Der Session-Verlauf enthält **Denkblöcke ohne Signaturen** (oft von
ein abgebrochen/teilweiser Stream). Google Antigravity erfordert Unterschriften für Denkblöcke.

Korrektur: OpenClaw entfernt nun unsignierte Denkblöcke für Google Antigravity Claude. Wenn es immer noch scheint, starte eine **neue Sitzung** oder setze `/thinking off` für diesen Agenten.

## Auth Profile: was sie sind und wie sie verwaltet werden

Verwandt: [/concepts/oauth](/concepts/oauth) (OAuth fließt, Token Speicher, Multi-Account-Muster)

### Was ist ein auth Profil

Ein Authentifizierungsprofil ist ein an einen Anbieter gebundener Referenzdatensatz (OAuth oder API-Schlüssel). Profile live in:

```
~/.openclaw/agents/<agentId>/agent/auth-profiles.json
```

### Typische Profil-IDs

OpenClaw verwendet Provider-präfixe IDs wie:

- `anthropic:default` (üblich, wenn keine E-Mail-Identität existiert)
- `Anthropic:<email>` für OAuth Identitäten
- benutzerdefinierte IDs, die Sie wählen (z.B. `anthropic:work`)

### Kann ich kontrollieren, welches Autorenprofil zuerst ausprobiert wird

Ja. Konfiguration unterstützt optionale Metadaten für Profile und eine Bestellung pro Anbieter (`auth.order.<provider>`). Dies speichert Geheimnisse **nicht** ; es teilt die IDs dem Provider/Modus und legt die Drehreihenfolge fest.

OpenClaw kann ein Profil vorübergehend überspringen, wenn es in einer kurzen **Cooldown** (Kursbegrenzungen/Zeitüberschreitungen/Ausfallfehler) oder einem längeren **deaktivierten** Status (Abrechnung/unzureichende Credits) liegt. Führen Sie `openclaw modelliert status --json` aus und überprüfen Sie `auth.unusableProfiles`. Tuning: `auth.cooldowns.billingBackoffHours*`.

Du kannst auch eine **per-agent** Bestellung überschreiben (gespeichert in `auth-profiles.json`) über das CLI setzen:

```bash
# Standardwerte des konfigurierten Standardagenten (omit --agent)
openclaw Modelle auth order get --provider anthropic

# Sperrung der Rotation auf ein einzelnes Profil (nur versuchen Sie diese)
openclaw Models auth order set --provider anthropic anthropic:default

# Oder setzen Sie eine explizite Reihenfolge (Fallback innerhalb des Providers)
openclaw Modelle auth order set --provider anthropic:work anthropic:default

# Löschen (fall zurück zum config auth. rder / round-robin)
openclaw modelliert auth order clear --provider anthropic
```

Um einen bestimmten Agenten anzusprechen:

```bash
openclaw modelliert auth order set --provider anthropic --agent main anthropic:default
```

### OAuth vs API-Schlüssel was der Unterschied ist

OpenClaw unterstützt beides:

- **OAuth** nutzt häufig den Zugang zu Abonnements (sofern zutreffend).
- **API-Schlüssel** verwenden Pay-per-Token Abrechnung.

Der Assistent unterstützt explizit Anthropisches Setup-Token und OpenAI Codex OAuth und kann API-Schlüssel für Sie speichern.

## Gateway: Ports, "bereits läuft" und Remote-Modus

### Welcher Port verwendet das Gateway

`gateway.port` steuert den einzelnen Multiplex-Port für WebSocket + HTTP (Kontroll-UI, Haken, etc.).

Priorität:

```
--port > OPENCLAW_GATEWAY_PORT > gateway.port > Standard 18789
```

### Warum heißt openclaw Gateway-Status Laufzeit läuft, aber RPC Sonde fehlgeschlagen

Weil "läuft" die **Supervisor** Ansicht ist (launchd/systemd/schtasks). Die RPC-Sonde ist die CLI Verbindung zum Gateway WebSocket und ruft "status" auf.

Benutze `openclaw Gateway status` und vertraue diesen Zeilen:

- `Probe target:` (die URL, die die Sonde tatsächlich verwendet)
- `Listening:` (was ist eigentlich auf dem Port gebunden)
- `Letzter Gateway-Fehler:` (gemeinsame Root-Ursache wenn der Prozess am Leben ist, aber der Port nicht lauscht)

### Warum zeigt openclaw Gateway-Status Config cli und Config-Dienst unterschiedlich an

Du bearbeitest gerade eine Konfigurationsdatei, während der Dienst eine andere ausführt (oft ein `--profile` / `OPENCLAW_STATE_DIR` Missverhältnis).

Fix:

```bash
openclaw Gateway Installation --force
```

Führen Sie diese aus der gleichen `--profile` / Umgebung aus, die Sie verwenden möchten.

### Was bedeutet eine andere Gateway-Instanz bereits lauscht

OpenClaw erzwingt eine Laufzeitsperre, indem er den WebSocket Listener sofort beim Start bindet (Standard `ws://127.0.0.1:18789`). Wenn die Bind mit `EADDRINUSE` fehlschlägt, wirft sie `GatewayLockError` und zeigt an, dass eine andere Instanz bereits lauscht.

Korrektur: stoppen Sie die andere Instanz, freien Port oder starten Sie mit `openclaw gateway --port <port>`.

### Wie kann ich OpenClaw im Remote-Modus Client mit einem Gateway verbinden

Setze `gateway.mode: "remote"` und verweise auf eine WebSocket-URL, optional mit einem Token/Passwort:

```json5
{
  gateway: {
    Modus: "remote",
    remote: {
      url: "ws://gateway.tailnet:18789",
      token: "your-token",
      Passwort: "your-password",
    },
  },
}
```

Hinweise:

- `openclaw gateway` startet nur, wenn `gateway.mode` `local` ist (oder du das überschreibende Flag) übergeben hast.
- Die macOS-App beobachtet die Konfigurationsdatei und wechselt live wenn sich diese Werte ändern.

### Die Kontroll-Oberfläche sagt nicht autorisiert oder verbindet was jetzt wieder

Dein Gateway läuft mit aktiviertem auth (`gateway.auth.*`), aber die Oberfläche sendet nicht das passende Token/Passwort.

Fakten (von Code):

- Die Kontroll-Oberfläche speichert das Token im Browser localStorage Schlüssel `openclaw.control.settings.v1`.

Fix:

- Schnellste: `openclaw dashboard` (druckt + kopiert die Dashboard-URL, versucht zu öffnen; zeigt SSH Hinweis an, wenn kopflos).
- Wenn du noch kein Token hast: `openclaw doctor --generate-gateway-token`.
- Wenn entfernt, öffnen Sie zuerst `ssh -N -L 18789:127.0.0.1:18789 user@host` und öffnen Sie `http://127.0.0.1:18789/`.
- Setze `gateway.auth.token` (oder `OPENCLAW_GATEWAY_TOKEN`) auf dem Gateway-Host.
- In den Kontroll-UI-Einstellungen fügen Sie den gleichen Token ein.
- Immer noch festgefahren? Führe `openclaw status --all` aus und folge [Troubleshooting](/gateway/troubleshooting). Siehe [Dashboard](/web/dashboard) für auth details.

### Ich setze Gatewaybind tailnet aber es kann nichts binden hört

`tailnet` bind wählt eine angepasste IP aus deinen Netzwerkschnittstellen (100.64.0.0/10). Wenn der Rechner nicht auf der Maßstabstabstabelle ist (oder die Schnittstelle nicht verfügbar ist), gibt es nichts zu binden.

Fix:

- Skalierung auf diesem Host starten (so hat er eine 100.x-Adresse) oder
- Wechseln Sie zu `gateway.bind: "loopback"` / `"lan"`.

Hinweis: `tailnet` ist explizit. `auto` bevorzugt loopback; verwende `gateway.bind: "tailnet"` wenn du eine tailnet-only Bind möchtest.

### Kann ich mehrere Gateways auf dem gleichen Host ausführen

Normalerweise kein - ein Gateway kann mehrere Messaging-Kanäle und -Agenten ausführen. Verwenden Sie nur mehrere Gateways wenn Sie Redundanz (z.B. Rettungsbot) oder harte Isolation benötigen.

Ja, aber Sie müssen isolieren:

- `OPENCLAW_CONFIG_PATH` (pro Instanz config)
- `OPENCLAW_STATE_DIR` (Instanz-Status)
- `agents.defaults.workspace` (Workspace-Isolierung)
- "gateway.port" (eindeutige Ports)

Schnelleinstellung (empfohlen):

- Verwenden Sie `openclaw --profile <name> …` pro Instanz (automatisch erstellt `~/.openclaw-<name>`).
- Setze einen einzigartigen `gateway.port` in jeder Profilkonfiguration (oder passe `--port` für manuelle Ausführungen).
- Install a per-profile service: `openclaw --profile <name> gateway install`.

Profile ergänzen auch Dienstnamen (`bot.molt.<profile>`; legacy `com.openclaw.*`, `openclaw-gateway-<profile>.service`, `OpenClaw Gateway (<profile>)`).
Vollständige Anleitung: [Multiple gateways](/gateway/multiple-gateways).

### Was bedeutet ungültiger Handshake-Code 1008

Das Gateway ist ein **WebSocket-Server**, und es erwartet die allererste Nachricht an
ein `connect` Frame. Wenn es etwas anderes erhält, schließt es die Verbindung
mit **code 1008** (Richtlinienverletzung).

Häufige Ursachen:

- Du hast die **HTTP** URL in einem Browser (`http://...`) anstelle eines WS Clients geöffnet.
- Sie haben den falschen Port oder Pfad verwendet.
- Ein Proxy oder Tunnel entfernte Auth-Header oder schickte eine Nicht-Gateway-Anfrage.

Schnell-Korrekturen:

1. Benutze die WS URL: `ws://<host>:18789` (oder `wss://...` wenn HTTPS).
2. Öffnen Sie den WS Port nicht in einem normalen Browser-Tab.
3. Wenn auth aktiviert ist, füge das Token/Passwort in den `connect` Frame ein.

Wenn Sie den CLI oder TUI verwenden, sollte die URL wie folgt aussehen:

```
openclaw tui --url ws://<host>:18789 --token <token>
```

Protokolldetails: [Gateway protocol](/gateway/protocol).

## Protokollierung und Debugging

### Wo sind Logs

Dateiprotokolle (strukturiert):

```
/tmp/openclaw/openclaw-YYYY-MM-DD.log
```

Sie können einen stabilen Pfad über `logging.file` setzen. File log level wird von `logging.level` gesteuert. Konsole verbosity wird von `--verbose` und `logging.consoleLevel` kontrolliert.

Schnellster Log-Schwanz:

```bash
openclaw logs --follow
```

Dienste/Supervisor Protokolle (wenn das Gateway über Launchd/System läuft):

- macOS: `$OPENCLAW_STATE_DIR/logs/gateway.log` und `gateway.err.log` (Standard: `~/.openclaw/logs/...`; Profile verwenden `~/.openclaw-<profile>/logs/...`)
- Linux: `journalctl --user -u openclaw-gateway[-<profile>].service -n 200 --no-pager`
- Windows: `schtasks /Query /TN "OpenClaw Gateway (<profile>)" /V /FO LIST`

Siehe [Troubleshooting](/gateway/troubleshooting#log-locations) für mehr.

### Wie starte ich den Gateway-Dienst neu

Gateway-Helfer verwenden:

```bash
openclaw Gateway-Status
openclaw Gateway Neustart
```

Wenn du das Gateway manuell ausführst, kann `openclaw gateway --force` den Port wiederherstellen. Siehe [Gateway](/gateway).

### Ich habe mein Terminal unter Windows geschlossen wie ich OpenClaw neu starten kann

Es gibt **zwei Windows-Installationsmodus**:

**1) WSL2 (empfohlen):** das Gateway läuft innerhalb von Linux.

Öffne PowerSell, gib WSL ein und starte neu:

```powershell
wsl
openclaw Gateway Status
openclaw Gateway Neustart
```

Wenn Sie den Dienst nie installiert haben, starten Sie ihn im Vordergrund:

```bash
openclaw gateway run
```

**2) Native Windows (nicht empfohlen):** das Gateway läuft direkt unter Windows.

PowerShell öffnen und ausführen:

```powershell
openclaw Gateway-Status
openclaw Gateway Neustart
```

Wenn Sie es manuell ausführen (kein Dienst), benutzen:

```powershell
openclaw gateway run
```

Docs: [Windows (WSL2)](/platforms/windows), [Gateway Service runbook](/gateway).

### Das Gateway ist offen, aber Antworten kommen nie an, was sollte ich überprüfen

Beginnen Sie mit einer schnellen Gesundheitsreife:

```bash
openclaw Status
openclaw modelliert Status
openclaw Channels Status
openclaw log --follow
```

Häufige Ursachen:

- Model auth nicht geladen auf dem **Gateway host** (überprüfen Sie den `models status`).
- Kanal-Paarung/erlaubte Sperrung von Antworten (überprüfen Sie die Channel-Konfiguration + Logs).
- WebChat/Dashboard ist ohne den richtigen Token geöffnet.

Wenn Sie entfernt sind, bestätigen Sie die Verbindung zwischen Tunnel/Maßstabsstufe, dass der WebSocket des
Gateway erreichbar ist.

Docs: [Channels](/channels), [Troubleshooting](/gateway/troubleshooting), [Fernzugriff/gateway/remote).

### Keine Verbindung zum Gateway

Dies bedeutet in der Regel, dass die Benutzeroberfläche die WebSocket-Verbindung verloren hat. Prüfen Sie:

1. Wird das Gateway ausgeführt? `openclaw gateway status`
2. Ist das Gateway gesund? `openclaw status`
3. Hat die Benutzeroberfläche den richtigen Token? `openclaw dashboard`
4. Ist die Verbindung zwischen Tunnel/Maßstabskala aufgebaut, wenn sie entfernt ist?

Dann tail Logs:

```bash
openclaw logs --follow
```

Docs: [Dashboard](/web/dashboard), [Fernzugriff/gateway/remote), [Troubleshooting](/gateway/troubleshooting).

### Telegram setMyCommands schlägt fehl: Netzwerkfehler Was sollte ich überprüfen

Beginnen Sie mit Logs und Kanalstatus:

```bash
openclaw Channels Status
openclaw Channels protokolliert --channel telegram
```

Wenn Sie auf einem VPS oder hinter einem Proxy sind, bestätigen Sie, dass ausgehende HTTPS erlaubt ist und DNS funktioniert.
Wenn das Gateway Remote ist, überprüfen Sie die Protokolle auf dem Gateway-Host.

Docs: [Telegram](/channels/telegram), [Kanal-Fehlerbehebung](/channels/troubleshooting).

### TUI zeigt keine Ausgabe Was soll ich überprüfen

Bestätigen Sie, dass das Gateway erreichbar ist und der Agent ausgeführt werden kann:

```bash
openclaw Status
openclaw modelliert den Status
openclaw log --follow
```

Benutze in der TUI `/status`, um den aktuellen Status zu sehen. Wenn du Antworten in einem Chat
Kanal erwartet, stelle sicher, dass die Zustellung aktiviert ist (`/deliver on`).

Docs: [TUI](/web/tui), [Schrägbefehle](/tools/slash-commands).

### Wie kann ich komplett stoppen und dann das Gateway starten

Wenn Sie den Dienst installiert haben:

```bash
openclaw Gateway Stop
openclaw Gateway Start
```

Dies stoppt/startet den **überwachten Dienst** (startete auf macOS, System unter Linux).
Benutzen Sie dies, wenn das Gateway im Hintergrund als Daemon läuft.

Wenn Sie im Vordergrund stehen, stoppen Sie mit Strg-C, dann:

```bash
openclaw gateway run
```

Docs: [Gateway service runbook](/gateway).

### ELI5 openclaw gateway Neustart vs openclaw Gateway

- `openclaw gateway restart`: Startet den **Hintergrunddienst** (launchd/system) neu.
- `openclaw gateway`: führt das Gateway **im Vordergrund** für diese Terminalsitzung aus.

Wenn Sie den Dienst installiert haben, verwenden Sie die Gateway-Befehle. Benutze `openclaw gateway` wenn
du einen einmaligen Vordergrundlauf möchtest.

### Was ist der schnellste Weg, um mehr Details zu erhalten, wenn etwas versagt

Starten Sie das Gateway mit `--verbose` um mehr Konsolendetails zu erhalten. Prüfen Sie dann die Protokolldatei auf Channel-Autor, Modellrouting und RPC-Fehler.

## Medien und Anhänge

### Meine Fertigkeit hat ein imagePDF erzeugt, aber nichts wurde gesendet

Ausgehende Anhänge des Agenten müssen eine `MEDIA:<path-or-url>` Zeile (auf der eigenen Zeile) enthalten. Siehe [OpenClaw assistant setup](/start/openclaw) und [Agent send](/tools/agent-send).

CLI senden:

```bash
openclaw Nachricht senden --target +15555550123 --message "Here you go" --media /path/to/file.png
```

Auch überprüfen:

- Der Zielkanal unterstützt ausgehende Medien und wird nicht von Zulassungslisten blockiert.
- Die Datei liegt innerhalb der Größenbeschränkungen des Anbieters (Bilder werden auf max. 2048px vergrößert).

Siehe [Images](/nodes/images).

## Sicherheit und Zugriffskontrolle

### Ist es sicher, OpenClaw eingehenden DMs auszusetzen

Eingehende DMs als nicht vertrauenswürdige Eingabe behandeln. Standardwerte sollen das Risiko verringern:

- Standardverhalten auf DM-fähigen Kanälen ist **Paarung**:
  - Unbekannte Absender erhalten einen Paarcode; der Bot verarbeitet seine Nachricht nicht.
  - Bestätigen mit: `openclaw pairing genehmigen <channel> <code>`
  - Ausstehende Anfragen werden auf **3 pro Kanal begrenzt**; überprüfe `openclaw pairing list <channel>` falls ein Code nicht angekommen ist.
- Das Öffnen von DMs erfordert explizit opt-in (`dmPolicy: "open"` und allowlist `"*"`).

Führen Sie `openclaw doctor` aus, um riskante DM-Richtlinien zu erstellen.

### Ist sofortige Injektion nur ein Anliegen für öffentliche Bots

Nein. Bei der Injektion von Prompt handelt es sich um **nicht vertrauenswürdigen Inhalt**, nicht nur, wer den Bot DM kann.
Wenn dein Assistent externe Inhalte liest (Websuche/-abruf, Browserseiten, E-Mails, Dokumente, Anhänge, eingefügte Logs), können diese Inhalte Anweisungen enthalten, die versuchen, das Modell zu kapern. Dies kann auch passieren, wenn **du der einzige Absender** bist.

Das größte Risiko besteht darin, wenn Werkzeuge aktiviert sind: Das Modell kann in
ausgetrickst werden, um Kontext zu filtern oder in Ihrem Namen aufzurufen. Reduzieren Sie den Blast‑Radius durch:

- unter Verwendung eines schreibgeschützten oder tool-deaktivierten "reader"-Agenten, um nicht vertrauenswürdige Inhalte zusammenzufassen
- hält `web_search` / `web_fetch` / `browser` für tool-fähige Agenten aus
- sandboxing und strenge Werkzeugzulisten

Details: [Security](/gateway/security).

### Sollte mein Bot eine eigene Github Account oder Telefonnummer haben

Ja, für die meisten Setups. Die Isolierung des Bots mit separaten Konten und Telefonnummern
verringert den Strahlradius, wenn etwas schief geht. Dies erleichtert auch das Drehen von Zugangsdaten
oder den Widerruf des Zugriffs, ohne Ihre persönlichen Konten zu beeinträchtigen.

Starte klein. Geben Sie Zugriff nur auf die Werkzeuge und Konten, die Sie tatsächlich benötigen, und erweitern Sie später
falls nötig.

Docs: [Security](/gateway/security), [Pairing](/channels/pairing).

### Darf ich ihr Autonomie über meine Textnachrichten geben und ist so sicher

Wir empfehlen **nicht** die volle Autonomie über deine persönlichen Nachrichten. Das sicherste Muster ist:

- Behalte DMs im **Paarungsmodus** oder einer engen Berechtigungsliste.
- Benutze eine **separate Nummer oder Konto** wenn du möchtest, dass es in deinem Namen angezeigt wird.
- Lass ihn entwerfen, dann **vor dem Senden genehmigen**.

Wenn Sie experimentieren möchten, machen Sie es auf einem dedizierten Konto und halten Sie es isoliert. Siehe
[Security](/gateway/security).

### Kann ich billigere Modelle für persönliche Assistentenaufgaben verwenden

Ja, **if** der Agent ist chat-only und die Eingabe wird vertraut. Kleinere Stufen sind
anfälliger für Instruktionen, also vermeide sie für Tool-fähige Agenten
oder beim Lesen nicht vertrauenswürdiger Inhalte. Wenn Sie ein kleineres Modell verwenden müssen, sperren Sie
Werkzeuge und laufen innerhalb einer Sandbox. Siehe [Security](/gateway/security).

### Ich habe im Telegramm startet, aber keinen Paarcode erhalten

Paarungscodes werden **nur** gesendet, wenn eine unbekannte Absendernachricht des Bots und
`dmPolicy: "Paarung" aktiviert ist. `/start\` generiert keinen Code.

Ausstehende Anfragen überprüfen:

```bash
openclaw pairing list telegram
```

Wenn du sofortigen Zugriff wünschst, kannst du deine Absender-ID erlauben oder setze `dmPolicy: "open"`
für dieses Konto.

### WhatsApp wird meine Kontakte benachrichtigen, wie das Paaren funktioniert

Nein. Standard WhatsApp DM Richtlinie ist **Paarung**. Unbekannte Absender erhalten nur einen Paarcode und ihre Nachricht ist **nicht verarbeitet**. OpenClaw antwortet nur auf Chats, die es erhält, oder auf explizit sendet Sie Trigger.

Paarung genehmigen mit:

```bash
openclaw Paarung genehmigen Whatsapp <code>
```

Liste ausstehender Anfragen:

```bash
openclaw pairing list whatsapp
```

Eingabeaufforderung: Es wird benutzt um deine **Erlaubnisliste/Eigentümer** zu setzen, sodass deine eigenen DMs erlaubt sind. Es wird nicht für den automatischen Versand verwendet. Wenn du auf deiner persönlichen WhatsApp-Nummer startest, benutze diese Nummer und aktiviere `channels.whatsapp.selfChatMode`.

## Chat-Befehle, Abbrechen von Aufgaben und "es wird nicht aufhören"

### Wie verhindere ich, dass interne Systemmeldungen im Chat angezeigt werden

Die meisten internen oder Tool-Nachrichten erscheinen nur, wenn **verbose** oder **reasoning** für diese Sitzung aktiviert ist.

Fix im Chat, wo du ihn siehst:

```
/ausführlicher aus
/argumentieren aus
```

Wenn es immer noch laut ist, überprüfen Sie die Session-Einstellungen im Kontroll-UI und setzen Sie das Wort
auf **inherit**. Bestätige auch, dass du kein Bot-Profil verwendest, wenn `verboseDefault` in der Konfiguration
auf `on` gesetzt wurde.

Docs: [Thinking and verbose](/tools/thinking), [Security](/gateway/security#reasoning--verbose-output-in-groups).

### Wie kann ich eine laufende Aufgabe abbrechen

Sende eine dieser **als Standalone-Nachricht** (kein Schräg):

```

abbrechen
esc
warten
beenden
Unterbrechung
```

Dies sind Trigger (keine Schrägstrich Befehle).

Für Hintergrundprozesse (vom exec Tool) können Sie den Agent bitten zu starten:

```
prozessaktion:kill sessionId:XXX
```

Slash Befehle Übersicht: siehe [Slash commands](/tools/slash-commands).

Die meisten Befehle müssen als **standalone** Nachricht gesendet werden, die mit `/` beginnt, aber ein paar Verknüpfungen (wie `/status`) funktionieren auch inline für erlaubte Absender.

### Wie schicke ich eine Discord Nachricht von Telegram Crosscontext Nachrichten abgelehnt

OpenClaw blockiert standardmäßig **Cross-Provider** Messaging. Wenn ein Werkzeugaufruf mit
an Telegramm gebunden ist, wird er nicht an Discord gesendet.

Anbieterübergreifende Nachrichten für den Agenten aktivieren:

```json5
{
  Agenten: {
    defaults: {
      tools: {
        message: {
          crossContext: {
            allowAcrossProviders: true,
            Marker: { enabled: true Präfix: "[von {channel}] " },
          },
        },
      },
    },
  },
}
```

Starten Sie das Gateway nach dem Bearbeiten der Konfiguration neu. Wenn du dies nur für einen einzigen
Agent möchtest, setze ihn stattdessen unter `agents.list[].tools.message` ein.

### Warum fühlt es sich so an, als ob der Bot Nachrichten ignoriert

Warteschlangen-Modus steuert die Interaktion neuer Nachrichten mit einem Bordrun. Benutze `/queue` um Modi zu ändern:

- `steer` - neue Nachrichten redirect die aktuelle Aufgabe
- `followup` - Nachrichten ausführen eine zur Zeit
- `collect` - batch messages and reply once (default)
- `steer-backlog` - Lenkung jetzt, verarbeite dann Backlog
- `interrupt` - Abbruch des aktuellen Auslaufs und Neustart

Du kannst Optionen wie `debounce:2s cap:25 drop:summarize` für Follow-up-Modi hinzufügen.

## Beantworte die genaue Frage aus dem Screenshot/Chat-Log

**F: "Was ist das Standardmodell für Anthropic mit einem API-Schlüssel?"**

**A:** In OpenClaw sind Anmeldedaten und Modellauswahl getrennt. Das Setzen von `ANTHROPIC_API_KEY` (oder das Speichern eines Anthropischen API-Schlüssels in Authentifizierungsprofilen) aktiviert Authentifizierung, aber das eigentliche Standardmodell ist was du in `agents konfigurierst. efaults.model.primary` (z.B. `anthropic/claude-sonnet-4-5` oder `anthropic/claude-opus-4-6`). Wenn Sie `Keine Zugangsdaten für das Profil "anthropic:default" sehen, bedeutet dies, dass das Gateway keine Anthropischen Zugangsdaten in den erwarteten `auth-Profilen finden konnte. son\` für den Agenten, der läuft.

---

Immer noch festgefahren? Fragen Sie in [Discord](https://discord.com/invite/clawd) oder eröffnen Sie eine [GitHub-Diskussion](https://github.com/openclaw/openclaw/discussions).
