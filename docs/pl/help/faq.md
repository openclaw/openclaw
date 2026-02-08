---
summary: "Najczęściej zadawane pytania dotyczące konfiguracji, ustawień i użytkowania OpenClaw"
title: "FAQ"
x-i18n:
  source_path: help/faq.md
  source_hash: b7c0c9766461f6e7
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:52:00Z
---

# FAQ

Szybkie odpowiedzi oraz pogłębione rozwiązywanie problemów dla rzeczywistych konfiguracji (lokalne środowisko deweloperskie, VPS, wiele agentów, OAuth/klucze API, przełączanie modeli). W przypadku diagnostyki czasu działania zobacz [Rozwiązywanie problemów](/gateway/troubleshooting). Pełne odniesienie do konfiguracji znajdziesz w [Konfiguracja](/gateway/configuration).

## Spis treści

- [Szybki start i konfiguracja przy pierwszym uruchomieniu]
  - [Utknąłem — jaki jest najszybszy sposób, aby ruszyć dalej?](#im-stuck-whats-the-fastest-way-to-get-unstuck)
  - [Jaki jest zalecany sposób instalacji i konfiguracji OpenClaw?](#whats-the-recommended-way-to-install-and-set-up-openclaw)
  - [Jak otworzyć pulpit po onboardingu?](#how-do-i-open-the-dashboard-after-onboarding)
  - [Jak uwierzytelnić pulpit (token) na localhost vs zdalnie?](#how-do-i-authenticate-the-dashboard-token-on-localhost-vs-remote)
  - [Jakiego środowiska uruchomieniowego potrzebuję?](#what-runtime-do-i-need)
  - [Czy działa na Raspberry Pi?](#does-it-run-on-raspberry-pi)
  - [Czy są jakieś wskazówki dla instalacji na Raspberry Pi?](#any-tips-for-raspberry-pi-installs)
  - [Zatrzymało się na „wake up my friend” / onboarding się nie uruchamia. Co teraz?](#it-is-stuck-on-wake-up-my-friend-onboarding-will-not-hatch-what-now)
  - [Czy mogę przenieść konfigurację na nową maszynę (Mac mini) bez ponownego onboardingu?](#can-i-migrate-my-setup-to-a-new-machine-mac-mini-without-redoing-onboarding)
  - [Gdzie zobaczę nowości w najnowszej wersji?](#where-do-i-see-what-is-new-in-the-latest-version)
  - [Nie mogę uzyskać dostępu do docs.openclaw.ai (błąd SSL). Co teraz?](#i-cant-access-docsopenclawai-ssl-error-what-now)
  - [Jaka jest różnica między stable a beta?](#whats-the-difference-between-stable-and-beta)
  - [Jak zainstalować wersję beta i czym różni się beta od dev?](#how-do-i-install-the-beta-version-and-whats-the-difference-between-beta-and-dev)
  - [Jak wypróbować najnowsze zmiany?](#how-do-i-try-the-latest-bits)
  - [Ile zwykle trwa instalacja i onboarding?](#how-long-does-install-and-onboarding-usually-take)
  - [Instalator się zawiesił? Jak uzyskać więcej informacji?](#installer-stuck-how-do-i-get-more-feedback)
  - [Instalacja na Windows zgłasza „git not found” lub „openclaw not recognized”](#windows-install-says-git-not-found-or-openclaw-not-recognized)
  - [Dokumentacja nie odpowiedziała na moje pytanie — jak uzyskać lepszą odpowiedź?](#the-docs-didnt-answer-my-question-how-do-i-get-a-better-answer)
  - [Jak zainstalować OpenClaw na Linuxie?](#how-do-i-install-openclaw-on-linux)
  - [Jak zainstalować OpenClaw na VPS?](#how-do-i-install-openclaw-on-a-vps)
  - [Gdzie są poradniki instalacji w chmurze/VPS?](#where-are-the-cloudvps-install-guides)
  - [Czy mogę poprosić OpenClaw, aby sam się zaktualizował?](#can-i-ask-openclaw-to-update-itself)
  - [Co faktycznie robi kreator onboardingu?](#what-does-the-onboarding-wizard-actually-do)
  - [Czy potrzebuję subskrypcji Claude lub OpenAI, aby to uruchomić?](#do-i-need-a-claude-or-openai-subscription-to-run-this)
  - [Czy mogę używać subskrypcji Claude Max bez klucza API](#can-i-use-claude-max-subscription-without-an-api-key)
  - [Jak działa uwierzytelnianie Anthropic „setup-token”?](#how-does-anthropic-setuptoken-auth-work)
  - [Gdzie znaleźć setup-token Anthropic?](#where-do-i-find-an-anthropic-setuptoken)
  - [Czy obsługujecie uwierzytelnianie subskrypcji Claude (Claude Pro lub Max)?](#do-you-support-claude-subscription-auth-claude-pro-or-max)
  - [Dlaczego widzę `HTTP 429: rate_limit_error` z Anthropic?](#why-am-i-seeing-http-429-ratelimiterror-from-anthropic)
  - [Czy AWS Bedrock jest obsługiwany?](#is-aws-bedrock-supported)
  - [Jak działa uwierzytelnianie Codex?](#how-does-codex-auth-work)
  - [Czy obsługujecie uwierzytelnianie subskrypcji OpenAI (Codex OAuth)?](#do-you-support-openai-subscription-auth-codex-oauth)
  - [Jak skonfigurować OAuth Gemini CLI](#how-do-i-set-up-gemini-cli-oauth)
  - [Czy lokalny model nadaje się do luźnych rozmów?](#is-a-local-model-ok-for-casual-chats)
  - [Jak utrzymać ruch do modeli hostowanych w określonym regionie?](#how-do-i-keep-hosted-model-traffic-in-a-specific-region)
  - [Czy muszę kupić Mac mini, aby to zainstalować?](#do-i-have-to-buy-a-mac-mini-to-install-this)
  - [Czy potrzebuję Mac mini do obsługi iMessage?](#do-i-need-a-mac-mini-for-imessage-support)
  - [Jeśli kupię Mac mini do uruchamiania OpenClaw, czy mogę połączyć go z MacBook Pro?](#if-i-buy-a-mac-mini-to-run-openclaw-can-i-connect-it-to-my-macbook-pro)
  - [Czy mogę używać Bun?](#can-i-use-bun)
  - [Telegram: co wpisuje się w `allowFrom`?](#telegram-what-goes-in-allowfrom)
  - [Czy wiele osób może używać jednego numeru WhatsApp z różnymi instancjami OpenClaw?](#can-multiple-people-use-one-whatsapp-number-with-different-openclaw-instances)
  - [Czy mogę uruchomić agenta „szybkiej rozmowy” oraz agenta „Opus do kodowania”?](#can-i-run-a-fast-chat-agent-and-an-opus-for-coding-agent)
  - [Czy Homebrew działa na Linuxie?](#does-homebrew-work-on-linux)
  - [Jaka jest różnica między instalacją „hackowalną” (git) a instalacją npm?](#whats-the-difference-between-the-hackable-git-install-and-npm-install)
  - [Czy mogę później przełączać się między instalacją npm a git?](#can-i-switch-between-npm-and-git-installs-later)
  - [Czy powinienem uruchamiać Gateway na laptopie czy na VPS?](#should-i-run-the-gateway-on-my-laptop-or-a-vps)
  - [Jak ważne jest uruchamianie OpenClaw na dedykowanej maszynie?](#how-important-is-it-to-run-openclaw-on-a-dedicated-machine)
  - [Jakie są minimalne wymagania VPS i zalecany system operacyjny?](#what-are-the-minimum-vps-requirements-and-recommended-os)
  - [Czy mogę uruchomić OpenClaw w maszynie wirtualnej i jakie są wymagania](#can-i-run-openclaw-in-a-vm-and-what-are-the-requirements)
- [Czym jest OpenClaw?](#what-is-openclaw)
  - [Czym jest OpenClaw w jednym akapicie?](#what-is-openclaw-in-one-paragraph)
  - [Jaka jest propozycja wartości?](#whats-the-value-proposition)
  - [Właśnie to skonfigurowałem — co powinienem zrobić najpierw](#i-just-set-it-up-what-should-i-do-first)
  - [Jakie są pięć najczęstszych codziennych zastosowań OpenClaw](#what-are-the-top-five-everyday-use-cases-for-openclaw)
  - [Czy OpenClaw może pomóc w lead gen, outreach, reklamach i blogach dla SaaS](#can-openclaw-help-with-lead-gen-outreach-ads-and-blogs-for-a-saas)
  - [Jakie są zalety w porównaniu z Claude Code przy tworzeniu stron internetowych?](#what-are-the-advantages-vs-claude-code-for-web-development)
- [Skills i automatyzacja](#skills-and-automation)
  - [Jak dostosować skills bez brudzenia repozytorium?](#how-do-i-customize-skills-without-keeping-the-repo-dirty)
  - [Czy mogę ładować skills z niestandardowego folderu?](#can-i-load-skills-from-a-custom-folder)
  - [Jak mogę używać różnych modeli do różnych zadań?](#how-can-i-use-different-models-for-different-tasks)
  - [Bot zawiesza się podczas ciężkiej pracy. Jak to odciążyć?](#the-bot-freezes-while-doing-heavy-work-how-do-i-offload-that)
  - [Cron lub przypomnienia nie uruchamiają się. Co sprawdzić?](#cron-or-reminders-do-not-fire-what-should-i-check)
  - [Jak zainstalować skills na Linuxie?](#how-do-i-install-skills-on-linux)
  - [Czy OpenClaw może uruchamiać zadania według harmonogramu lub ciągle w tle?](#can-openclaw-run-tasks-on-a-schedule-or-continuously-in-the-background)
  - [Czy mogę uruchamiać skills tylko dla macOS z Linuxa?](#can-i-run-apple-macos-only-skills-from-linux)
  - [Czy macie integrację z Notion lub HeyGen?](#do-you-have-a-notion-or-heygen-integration)
  - [Jak zainstalować rozszerzenie Chrome do przejmowania przeglądarki?](#how-do-i-install-the-chrome-extension-for-browser-takeover)
- [Sandboxing i pamięć](#sandboxing-and-memory)
  - [Czy istnieje dedykowana dokumentacja sandboxing?](#is-there-a-dedicated-sandboxing-doc)
  - [Jak powiązać folder hosta z sandboxem?](#how-do-i-bind-a-host-folder-into-the-sandbox)
  - [Jak działa pamięć?](#how-does-memory-work)
  - [Pamięć ciągle zapomina. Jak sprawić, by zapamiętywała?](#memory-keeps-forgetting-things-how-do-i-make-it-stick)
  - [Czy pamięć utrzymuje się na zawsze? Jakie są limity?](#does-memory-persist-forever-what-are-the-limits)
  - [Czy semantyczne wyszukiwanie pamięci wymaga klucza API OpenAI?](#does-semantic-memory-search-require-an-openai-api-key)
- [Gdzie dane są zapisywane na dysku](#where-things-live-on-disk)
  - [Czy wszystkie dane używane przez OpenClaw są zapisywane lokalnie?](#is-all-data-used-with-openclaw-saved-locally)
  - [Gdzie OpenClaw przechowuje swoje dane?](#where-does-openclaw-store-its-data)
  - [Gdzie powinny znajdować się AGENTS.md / SOUL.md / USER.md / MEMORY.md?](#where-should-agentsmd-soulmd-usermd-memorymd-live)
  - [Jaka jest zalecana strategia kopii zapasowych?](#whats-the-recommended-backup-strategy)
  - [Jak całkowicie odinstalować OpenClaw?](#how-do-i-completely-uninstall-openclaw)
  - [Czy agenci mogą pracować poza obszarem roboczym?](#can-agents-work-outside-the-workspace)
  - [Jestem w trybie zdalnym — gdzie jest magazyn sesji?](#im-in-remote-mode-where-is-the-session-store)
- [Podstawy konfiguracji](#config-basics)
  - [Jaki format ma konfiguracja? Gdzie się znajduje?](#what-format-is-the-config-where-is-it)
  - [Ustawiłem `gateway.bind: "lan"` (lub `"tailnet"`) i teraz nic nie nasłuchuje / UI mówi „unauthorized”](#i-set-gatewaybind-lan-or-tailnet-and-now-nothing-listens-the-ui-says-unauthorized)
  - [Dlaczego teraz potrzebuję tokenu na localhost?](#why-do-i-need-a-token-on-localhost-now)
  - [Czy muszę restartować po zmianie konfiguracji?](#do-i-have-to-restart-after-changing-config)
  - [Jak włączyć wyszukiwanie w sieci (i web fetch)?](#how-do-i-enable-web-search-and-web-fetch)
  - [config.apply wyczyścił moją konfigurację. Jak odzyskać i uniknąć tego?](#configapply-wiped-my-config-how-do-i-recover-and-avoid-this)
  - [Jak uruchomić centralny Gateway z wyspecjalizowanymi workerami na różnych urządzeniach?](#how-do-i-run-a-central-gateway-with-specialized-workers-across-devices)
  - [Czy przeglądarka OpenClaw może działać w trybie headless?](#can-the-openclaw-browser-run-headless)
  - [Jak używać Brave do sterowania przeglądarką?](#how-do-i-use-brave-for-browser-control)
- [Zdalne gatewaye i węzły](#remote-gateways-and-nodes)
  - [Jak polecenia propagują się między Telegramem, gatewayem i węzłami?](#how-do-commands-propagate-between-telegram-the-gateway-and-nodes)
  - [Jak agent może uzyskać dostęp do mojego komputera, jeśli Gateway jest hostowany zdalnie?](#how-can-my-agent-access-my-computer-if-the-gateway-is-hosted-remotely)
  - [Tailscale jest połączony, ale nie otrzymuję odpowiedzi. Co teraz?](#tailscale-is-connected-but-i-get-no-replies-what-now)
  - [Czy dwie instancje OpenClaw mogą ze sobą rozmawiać (lokalnie + VPS)?](#can-two-openclaw-instances-talk-to-each-other-local-vps)
  - [Czy potrzebuję osobnych VPS dla wielu agentów](#do-i-need-separate-vpses-for-multiple-agents)
  - [Czy jest korzyść z używania węzła na moim laptopie zamiast SSH z VPS?](#is-there-a-benefit-to-using-a-node-on-my-personal-laptop-instead-of-ssh-from-a-vps)
  - [Czy węzły uruchamiają usługę gateway?](#do-nodes-run-a-gateway-service)
  - [Czy istnieje sposób API / RPC na zastosowanie konfiguracji?](#is-there-an-api-rpc-way-to-apply-config)
  - [Jaka jest minimalna „rozsądna” konfiguracja dla pierwszej instalacji?](#whats-a-minimal-sane-config-for-a-first-install)
  - [Jak skonfigurować Tailscale na VPS i połączyć się z Maca?](#how-do-i-set-up-tailscale-on-a-vps-and-connect-from-my-mac)
  - [Jak podłączyć węzeł Mac do zdalnego Gateway (Tailscale Serve)?](#how-do-i-connect-a-mac-node-to-a-remote-gateway-tailscale-serve)
  - [Czy powinienem instalować na drugim laptopie czy po prostu dodać węzeł?](#should-i-install-on-a-second-laptop-or-just-add-a-node)
- [Zmienne środowiskowe i ładowanie .env](#env-vars-and-env-loading)
  - [Jak OpenClaw ładuje zmienne środowiskowe?](#how-does-openclaw-load-environment-variables)
  - [„Uruchomiłem Gateway jako usługę i moje zmienne środowiskowe zniknęły.” Co teraz?](#i-started-the-gateway-via-the-service-and-my-env-vars-disappeared-what-now)
  - [Ustawiłem `COPILOT_GITHUB_TOKEN`, ale status modeli pokazuje „Shell env: off.” Dlaczego?](#i-set-copilotgithubtoken-but-models-status-shows-shell-env-off-why)
- [Sesje i wiele czatów](#sessions-and-multiple-chats)
  - [Jak rozpocząć nową rozmowę?](#how-do-i-start-a-fresh-conversation)
  - [Czy sesje resetują się automatycznie, jeśli nigdy nie wyślę `/new`?](#do-sessions-reset-automatically-if-i-never-send-new)
  - [Czy da się stworzyć zespół instancji OpenClaw: jeden CEO i wielu agentów](#is-there-a-way-to-make-a-team-of-openclaw-instances-one-ceo-and-many-agents)
  - [Dlaczego kontekst został ucięty w trakcie zadania? Jak temu zapobiec?](#why-did-context-get-truncated-midtask-how-do-i-prevent-it)
  - [Jak całkowicie zresetować OpenClaw, zachowując instalację?](#how-do-i-completely-reset-openclaw-but-keep-it-installed)
  - [Otrzymuję błędy „context too large” — jak zresetować lub skompaktować?](#im-getting-context-too-large-errors-how-do-i-reset-or-compact)
  - [Dlaczego widzę „LLM request rejected: messages.N.content.X.tool_use.input: Field required”?](#why-am-i-seeing-llm-request-rejected-messagesncontentxtooluseinput-field-required)
  - [Dlaczego otrzymuję komunikaty heartbeat co 30 minut?](#why-am-i-getting-heartbeat-messages-every-30-minutes)
  - [Czy muszę dodać „konto bota” do grupy WhatsApp?](#do-i-need-to-add-a-bot-account-to-a-whatsapp-group)
  - [Jak uzyskać JID grupy WhatsApp?](#how-do-i-get-the-jid-of-a-whatsapp-group)
  - [Dlaczego OpenClaw nie odpowiada w grupie?](#why-doesnt-openclaw-reply-in-a-group)
  - [Czy grupy/wątki współdzielą kontekst z DM-ami?](#do-groupsthreads-share-context-with-dms)
  - [Ile obszarów roboczych i agentów mogę utworzyć?](#how-many-workspaces-and-agents-can-i-create)
  - [Czy mogę uruchamiać wiele botów lub czatów jednocześnie (Slack) i jak to skonfigurować?](#can-i-run-multiple-bots-or-chats-at-the-same-time-slack-and-how-should-i-set-that-up)
- [Modele: domyślne, wybór, aliasy, przełączanie](#models-defaults-selection-aliases-switching)
  - [Czym jest „domyślny model”?](#what-is-the-default-model)
  - [Jaki model polecacie?](#what-model-do-you-recommend)
  - [Jak przełączyć modele bez czyszczenia konfiguracji?](#how-do-i-switch-models-without-wiping-my-config)
  - [Czy mogę używać modeli hostowanych samodzielnie (llama.cpp, vLLM, Ollama)?](#can-i-use-selfhosted-models-llamacpp-vllm-ollama)
  - [Jakich modeli używają OpenClaw, Flawd i Krill?](#what-do-openclaw-flawd-and-krill-use-for-models)
  - [Jak przełączyć modele w locie (bez restartu)?](#how-do-i-switch-models-on-the-fly-without-restarting)
  - [Czy mogę używać GPT 5.2 do codziennych zadań i Codex 5.3 do kodowania](#can-i-use-gpt-52-for-daily-tasks-and-codex-53-for-coding)
  - [Dlaczego widzę „Model … is not allowed”, a potem brak odpowiedzi?](#why-do-i-see-model-is-not-allowed-and-then-no-reply)
  - [Dlaczego widzę „Unknown model: minimax/MiniMax-M2.1”?](#why-do-i-see-unknown-model-minimaxminimaxm21)
  - [Czy mogę używać MiniMax jako domyślnego i OpenAI do złożonych zadań?](#can-i-use-minimax-as-my-default-and-openai-for-complex-tasks)
  - [Czy opus / sonnet / gpt to wbudowane skróty?](#are-opus-sonnet-gpt-builtin-shortcuts)
  - [Jak zdefiniować/nadpisać skróty modeli (aliasy)?](#how-do-i-defineoverride-model-shortcuts-aliases)
  - [Jak dodać modele od innych dostawców, takich jak OpenRouter lub Z.AI?](#how-do-i-add-models-from-other-providers-like-openrouter-or-zai)
- [Failover modeli i „All models failed”](#model-failover-and-all-models-failed)
  - [Jak działa failover?](#how-does-failover-work)
  - [Co oznacza ten błąd?](#what-does-this-error-mean)
  - [Lista naprawcza dla `No credentials found for profile "anthropic:default"`](#fix-checklist-for-no-credentials-found-for-profile-anthropicdefault)
  - [Dlaczego próbował także Google Gemini i zawiódł?](#why-did-it-also-try-google-gemini-and-fail)
- [Profile uwierzytelniania: czym są i jak nimi zarządzać](#auth-profiles-what-they-are-and-how-to-manage-them)
  - [Czym jest profil uwierzytelniania?](#what-is-an-auth-profile)
  - [Jakie są typowe identyfikatory profili?](#what-are-typical-profile-ids)
  - [Czy mogę kontrolować, który profil uwierzytelniania jest próbowany jako pierwszy?](#can-i-control-which-auth-profile-is-tried-first)
  - [OAuth vs klucz API: jaka jest różnica?](#oauth-vs-api-key-whats-the-difference)
- [Gateway: porty, „already running” i tryb zdalny](#gateway-ports-already-running-and-remote-mode)
  - [Jakiego portu używa Gateway?](#what-port-does-the-gateway-use)
  - [Dlaczego `openclaw gateway status` pokazuje `Runtime: running`, ale `RPC probe: failed`?](#why-does-openclaw-gateway-status-say-runtime-running-but-rpc-probe-failed)
  - [Dlaczego `openclaw gateway status` pokazuje `Config (cli)` i `Config (service)` jako różne?](#why-does-openclaw-gateway-status-show-config-cli-and-config-service-different)
  - [Co oznacza „another gateway instance is already listening”?](#what-does-another-gateway-instance-is-already-listening-mean)
  - [Jak uruchomić OpenClaw w trybie zdalnym (klient łączy się z Gateway gdzie indziej)?](#how-do-i-run-openclaw-in-remote-mode-client-connects-to-a-gateway-elsewhere)
  - [UI sterowania mówi „unauthorized” (lub ciągle się łączy ponownie). Co teraz?](#the-control-ui-says-unauthorized-or-keeps-reconnecting-what-now)
  - [Ustawiłem `gateway.bind: "tailnet"`, ale nie może zbindować / nic nie nasłuchuje](#i-set-gatewaybind-tailnet-but-it-cant-bind-nothing-listens)
  - [Czy mogę uruchamiać wiele Gateway na tym samym hoście?](#can-i-run-multiple-gateways-on-the-same-host)
  - [Co oznacza „invalid handshake” / kod 1008?](#what-does-invalid-handshake-code-1008-mean)
- [Logowanie i debugowanie](#logging-and-debugging)
  - [Gdzie są logi?](#where-are-logs)
  - [Jak uruchomić/zatrzymać/zrestartować usługę Gateway?](#how-do-i-startstoprestart-the-gateway-service)
  - [Zamknąłem terminal na Windows — jak zrestartować OpenClaw?](#i-closed-my-terminal-on-windows-how-do-i-restart-openclaw)
  - [Gateway działa, ale odpowiedzi nigdy nie docierają. Co sprawdzić?](#the-gateway-is-up-but-replies-never-arrive-what-should-i-check)
  - [„Disconnected from gateway: no reason” — co teraz?](#disconnected-from-gateway-no-reason-what-now)
  - [Telegram setMyCommands kończy się błędami sieci. Co sprawdzić?](#telegram-setmycommands-fails-with-network-errors-what-should-i-check)
  - [TUI nie pokazuje wyjścia. Co sprawdzić?](#tui-shows-no-output-what-should-i-check)
  - [Jak całkowicie zatrzymać, a następnie uruchomić Gateway?](#how-do-i-completely-stop-then-start-the-gateway)
  - [ELI5: `openclaw gateway restart` vs `openclaw gateway`](#eli5-openclaw-gateway-restart-vs-openclaw-gateway)
  - [Jaki jest najszybszy sposób uzyskania większej liczby szczegółów, gdy coś zawiedzie?](#whats-the-fastest-way-to-get-more-details-when-something-fails)
- [Media i załączniki](#media-and-attachments)
  - [Skill wygenerował obraz/PDF, ale nic nie zostało wysłane](#my-skill-generated-an-imagepdf-but-nothing-was-sent)
- [Bezpieczeństwo i kontrola dostępu](#security-and-access-control)
  - [Czy bezpieczne jest wystawienie OpenClaw na przychodzące DM-y?](#is-it-safe-to-expose-openclaw-to-inbound-dms)
  - [Czy prompt injection dotyczy tylko botów publicznych?](#is-prompt-injection-only-a-concern-for-public-bots)
  - [Czy mój bot powinien mieć własny e‑mail, konto GitHub lub numer telefonu](#should-my-bot-have-its-own-email-github-account-or-phone-number)
  - [Czy mogę dać mu autonomię nad moimi wiadomościami tekstowymi i czy to jest bezpieczne](#can-i-give-it-autonomy-over-my-text-messages-and-is-that-safe)
  - [Czy mogę używać tańszych modeli do zadań asystenta osobistego?](#can-i-use-cheaper-models-for-personal-assistant-tasks)
  - [Uruchomiłem `/start` w Telegramie, ale nie dostałem kodu parowania](#i-ran-start-in-telegram-but-didnt-get-a-pairing-code)
  - [WhatsApp: czy będzie wysyłać wiadomości do moich kontaktów? Jak działa parowanie?](#whatsapp-will-it-message-my-contacts-how-does-pairing-work)
- [Polecenia czatu, przerywanie zadań i „nie chce się zatrzymać”](#chat-commands-aborting-tasks-and-it-wont-stop)
  - [Jak zatrzymać wyświetlanie wewnętrznych komunikatów systemowych w czacie](#how-do-i-stop-internal-system-messages-from-showing-in-chat)
  - [Jak zatrzymać/anulować uruchomione zadanie?](#how-do-i-stopcancel-a-running-task)
  - [Jak wysłać wiadomość Discord z Telegrama? („Cross-context messaging denied”)](#how-do-i-send-a-discord-message-from-telegram-crosscontext-messaging-denied)
  - [Dlaczego wygląda to tak, jakby bot „ignorował” serię szybkich wiadomości?](#why-does-it-feel-like-the-bot-ignores-rapidfire-messages)

## Pierwsze 60 sekund, gdy coś nie działa

1. **Szybki status (pierwsze sprawdzenie)**

   ```bash
   openclaw status
   ```

   Szybkie lokalne podsumowanie: system operacyjny + aktualizacja, dostępność gateway/usługi, agenci/sesje, konfiguracja dostawców + problemy środowiska uruchomieniowego (gdy gateway jest osiągalny).

2. **Raport do wklejenia (bezpieczny do udostępnienia)**

   ```bash
   openclaw status --all
   ```

   Diagnostyka tylko do odczytu z końcówką logów (tokeny zanonimizowane).

3. **Stan demona i portów**

   ```bash
   openclaw gateway status
   ```

   Pokazuje środowisko uruchomieniowe nadzorcy vs dostępność RPC, docelowy URL sondy oraz którą konfigurację usługa prawdopodobnie użyła.

4. **Głębokie sondy**

   ```bash
   openclaw status --deep
   ```

   Uruchamia kontrole zdrowia gateway + sondy dostawców (wymaga osiągalnego gateway). Zobacz [Health](/gateway/health).

5. **Podgląd najnowszego logu**

   ```bash
   openclaw logs --follow
   ```

   Jeśli RPC nie działa, użyj zapasowo:

   ```bash
   tail -f "$(ls -t /tmp/openclaw/openclaw-*.log | head -1)"
   ```

   Logi plikowe są oddzielne od logów usługi; zobacz [Logging](/logging) oraz [Rozwiązywanie problemów](/gateway/troubleshooting).

6. **Uruchom lekarza (naprawy)**

   ```bash
   openclaw doctor
   ```

   Naprawia/migruje konfigurację i stan + uruchamia kontrole zdrowia. Zobacz [Doctor](/gateway/doctor).

7. **Migawka Gateway**

   ```bash
   openclaw health --json
   openclaw health --verbose   # shows the target URL + config path on errors
   ```

   Pyta działający gateway o pełną migawkę (tylko WS). Zobacz [Health](/gateway/health).

---

Wciąż utknąłeś? Zapytaj na [Discord](https://discord.com/invite/clawd) lub otwórz [dyskusję GitHub](https://github.com/openclaw/openclaw/discussions).
