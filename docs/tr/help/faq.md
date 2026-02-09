---
summary: "OpenClaw kurulumu, yapılandırması ve kullanımı hakkında sık sorulan sorular"
title: "SSS"
---

# help/faq.md

Gerçek dünyadaki kurulumlar için hızlı yanıtlar ve daha derin sorun giderme (yerel geliştirme, VPS, çoklu ajan, OAuth/API anahtarları, model devre dışı bırakma). Çalışma zamanı tanılamaları için [Sorun Giderme](/gateway/troubleshooting) sayfasına bakın. Tam yapılandırma referansı için [Yapılandırma](/gateway/configuration) sayfasını inceleyin.

## İçindekiler

- [Hızlı başlangıç ve ilk çalıştırma kurulumu]
  - [Takıldım, takılmaktan kurtulmanın en hızlı yolu nedir?](#im-stuck-whats-the-fastest-way-to-get-unstuck)
  - [OpenClaw’ı kurmak ve ayarlamak için önerilen yol nedir?](#whats-the-recommended-way-to-install-and-set-up-openclaw)
  - [Onboarding sonrası panoyu nasıl açarım?](#how-do-i-open-the-dashboard-after-onboarding)
  - [Panoyu localhost’ta ve uzaktan nasıl doğrularım (belirteç)?](#how-do-i-authenticate-the-dashboard-token-on-localhost-vs-remote)
  - [Hangi çalışma zamanına ihtiyacım var?](#what-runtime-do-i-need)
  - [Raspberry Pi üzerinde çalışır mı?](#does-it-run-on-raspberry-pi)
  - [Raspberry Pi kurulumları için ipuçları var mı?](#any-tips-for-raspberry-pi-installs)
  - ["wake up my friend" ekranında takılı kaldı / onboarding çıkmıyor. Ne yapmalıyım?](#it-is-stuck-on-wake-up-my-friend-onboarding-will-not-hatch-what-now)
  - [Kurulumumu yeniden onboarding yapmadan yeni bir makineye (Mac mini) taşıyabilir miyim?](#can-i-migrate-my-setup-to-a-new-machine-mac-mini-without-redoing-onboarding)
  - [En son sürümde nelerin yeni olduğunu nerede görebilirim?](#where-do-i-see-what-is-new-in-the-latest-version)
  - [docs.openclaw.ai’ye erişemiyorum (SSL hatası). Ne yapmalıyım?](#i-cant-access-docsopenclawai-ssl-error-what-now)
  - [Stable ile beta arasındaki fark nedir?](#whats-the-difference-between-stable-and-beta)
  - [Beta sürümü nasıl kurarım ve beta ile dev arasındaki fark nedir?](#how-do-i-install-the-beta-version-and-whats-the-difference-between-beta-and-dev)
  - [En güncel sürümü nasıl denerim?](#how-do-i-try-the-latest-bits)
  - [Kurulum ve onboarding genellikle ne kadar sürer?](#how-long-does-install-and-onboarding-usually-take)
  - [Kurucu takıldı mı? Daha fazla geri bildirim nasıl alırım?](#installer-stuck-how-do-i-get-more-feedback)
  - [Windows kurulumu git bulunamadı veya openclaw tanınmıyor diyor](#windows-install-says-git-not-found-or-openclaw-not-recognized)
  - [Dokümanlar sorumu yanıtlamadı - daha iyi bir yanıtı nasıl alırım?](#the-docs-didnt-answer-my-question-how-do-i-get-a-better-answer)
  - [OpenClaw’ı Linux’ta nasıl kurarım?](#how-do-i-install-openclaw-on-linux)
  - [OpenClaw’ı bir VPS’e nasıl kurarım?](#how-do-i-install-openclaw-on-a-vps)
  - [Bulut/VPS kurulum kılavuzları nerede?](#where-are-the-cloudvps-install-guides)
  - [OpenClaw’dan kendini güncellemesini isteyebilir miyim?](#can-i-ask-openclaw-to-update-itself)
  - [Onboarding sihirbazı aslında ne yapar?](#what-does-the-onboarding-wizard-actually-do)
  - [Bunu çalıştırmak için Claude veya OpenAI aboneliğine ihtiyacım var mı?](#do-i-need-a-claude-or-openai-subscription-to-run-this)
  - [API anahtarı olmadan Claude Max aboneliğini kullanabilir miyim](#can-i-use-claude-max-subscription-without-an-api-key)
  - [Anthropic "setup-token" kimlik doğrulaması nasıl çalışır?](#how-does-anthropic-setuptoken-auth-work)
  - [Anthropic setup-token’ı nereden bulurum?](#where-do-i-find-an-anthropic-setuptoken)
  - [Claude abonelik kimlik doğrulamasını (Claude Pro veya Max) destekliyor musunuz?](#do-you-support-claude-subscription-auth-claude-pro-or-max)
  - [Neden Anthropic’ten `HTTP 429: rate_limit_error` görüyorum?](#why-am-i-seeing-http-429-ratelimiterror-from-anthropic)
  - [AWS Bedrock destekleniyor mu?](#is-aws-bedrock-supported)
  - [Codex kimlik doğrulaması nasıl çalışır?](#how-does-codex-auth-work)
  - [OpenAI abonelik kimlik doğrulamasını (Codex OAuth) destekliyor musunuz?](#do-you-support-openai-subscription-auth-codex-oauth)
  - [Gemini CLI OAuth’u nasıl kurarım](#how-do-i-set-up-gemini-cli-oauth)
  - [Gündelik sohbetler için yerel bir model uygun mu?](#is-a-local-model-ok-for-casual-chats)
  - [Barındırılan model trafiğini belirli bir bölgede nasıl tutarım?](#how-do-i-keep-hosted-model-traffic-in-a-specific-region)
  - [Bunu kurmak için Mac Mini satın almam gerekiyor mu?](#do-i-have-to-buy-a-mac-mini-to-install-this)
  - [iMessage desteği için Mac mini gerekli mi?](#do-i-need-a-mac-mini-for-imessage-support)
  - [OpenClaw’ı çalıştırmak için bir Mac mini alırsam, MacBook Pro’ma bağlayabilir miyim?](#if-i-buy-a-mac-mini-to-run-openclaw-can-i-connect-it-to-my-macbook-pro)
  - [Bun kullanabilir miyim?](#can-i-use-bun)
  - [Telegram: `allowFrom` alanına ne girilir?](#telegram-what-goes-in-allowfrom)
  - [Birden fazla kişi, farklı OpenClaw örnekleriyle tek bir WhatsApp numarasını kullanabilir mi?](#can-multiple-people-use-one-whatsapp-number-with-different-openclaw-instances)
  - ["Hızlı sohbet" ajanı ve "kodlama için Opus" ajanı çalıştırabilir miyim?](#can-i-run-a-fast-chat-agent-and-an-opus-for-coding-agent)
  - [Homebrew Linux’ta çalışır mı?](#does-homebrew-work-on-linux)
  - [Hacklenebilir (git) kurulum ile npm kurulumu arasındaki fark nedir?](#whats-the-difference-between-the-hackable-git-install-and-npm-install)
  - [Daha sonra npm ve git kurulumları arasında geçiş yapabilir miyim?](#can-i-switch-between-npm-and-git-installs-later)
  - [Gateway’i dizüstü bilgisayarımda mı yoksa bir VPS’te mi çalıştırmalıyım?](#should-i-run-the-gateway-on-my-laptop-or-a-vps)
  - [OpenClaw’ı adanmış bir makinede çalıştırmak ne kadar önemli?](#how-important-is-it-to-run-openclaw-on-a-dedicated-machine)
  - [Minimum VPS gereksinimleri ve önerilen işletim sistemi nedir?](#what-are-the-minimum-vps-requirements-and-recommended-os)
  - [OpenClaw’ı bir VM içinde çalıştırabilir miyim ve gereksinimler nelerdir](#can-i-run-openclaw-in-a-vm-and-what-are-the-requirements)
- [OpenClaw nedir?](#what-is-openclaw)
  - [Tek paragrafta OpenClaw nedir?](#what-is-openclaw-in-one-paragraph)
  - [Değer önerisi nedir?](#whats-the-value-proposition)
  - [Yeni kurdum, önce ne yapmalıyım](#i-just-set-it-up-what-should-i-do-first)
  - [OpenClaw için en iyi beş günlük kullanım senaryosu nelerdir](#what-are-the-top-five-everyday-use-cases-for-openclaw)
  - [Can OpenClaw help with lead gen outreach ads and blogs for a SaaS](#can-openclaw-help-with-lead-gen-outreach-ads-and-blogs-for-a-saas)
  - [Web geliştirme için Claude Code'a kıyasla avantajları nelerdir?](#what-are-the-advantages-vs-claude-code-for-web-development)
- [Beceriler ve otomasyon](#skills-and-automation)
  - [Depoyu kirletmeden becerileri nasıl özelleştiririm?](#how-do-i-customize-skills-without-keeping-the-repo-dirty)
  - [Becerileri özel bir klasörden yükleyebilir miyim?](#can-i-load-skills-from-a-custom-folder)
  - [Farklı görevler için farklı modelleri nasıl kullanabilirim?](#how-can-i-use-different-models-for-different-tasks)
  - [Bot ağır işler yaparken donuyor. [Bunu nasıl dışarıya aktarırım?](#the-bot-freezes-while-doing-heavy-work-how-do-i-offload-that)
  - [Cron veya hatırlatıcılar tetiklenmiyor. [Neyi kontrol etmeliyim?](#cron-or-reminders-do-not-fire-what-should-i-check)
  - [Linux'ta becerileri nasıl kurarım?](#how-do-i-install-skills-on-linux)
  - [OpenClaw görevleri zamanlanmış olarak veya arka planda sürekli çalıştırabilir mi?](#can-openclaw-run-tasks-on-a-schedule-or-continuously-in-the-background)
  - [Apple macOS'a özel becerileri Linux'tan çalıştırabilir miyim?](#can-i-run-apple-macos-only-skills-from-linux)
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
  - [OpenClaw verilerini nerede saklar?](#where-does-openclaw-store-its-data)
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
  - [Tailscale is connected but I get no replies. Ne yapmalıyım?](#tailscale-is-connected-but-i-get-no-replies-what-now)
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
  - ["I started the Gateway via the service and my env vars disappeared." Ne yapmalıyım?](#i-started-the-gateway-via-the-service-and-my-env-vars-disappeared-what-now)
  - [I set `COPILOT_GITHUB_TOKEN`, but models status shows "Shell env: off." Why?](#i-set-copilotgithubtoken-but-models-status-shows-shell-env-off-why)
- [Sessions and multiple chats](#sessions-and-multiple-chats)
  - [How do I start a fresh conversation?](#how-do-i-start-a-fresh-conversation)
  - [`/new` hiç göndermesem oturumlar otomatik olarak sıfırlanır mı?](#do-sessions-reset-automatically-if-i-never-send-new)
  - [OpenClaw örneklerinden oluşan bir ekipte bir CEO ve birçok ajan olacak şekilde yapılandırmanın bir yolu var mı?](#is-there-a-way-to-make-a-team-of-openclaw-instances-one-ceo-and-many-agents)
  - Bağlam neden görev ortasında kesildi?
    4. Bunu nasıl önlerim? How do I prevent it?](#why-did-context-get-truncated-midtask-how-do-i-prevent-it)
  - [How do I completely reset OpenClaw but keep it installed?](#how-do-i-completely-reset-openclaw-but-keep-it-installed)
  - [I'm getting "context too large" errors - how do I reset or compact?](#im-getting-context-too-large-errors-how-do-i-reset-or-compact)
  - [Neden her 30 dakikada bir heartbeat mesajları alıyorum?](#why-am-i-getting-heartbeat-messages-every-30-minutes)
  - [Why am I getting heartbeat messages every 30 minutes?](#why-am-i-getting-heartbeat-messages-every-30-minutes)
  - [Bir WhatsApp grubunun JID’sini nasıl alırım?](#how-do-i-get-the-jid-of-a-whatsapp-group)
  - [OpenClaw neden bir grupta yanıt vermiyor?](#why-doesnt-openclaw-reply-in-a-group)
  - [Gruplar/iş parçacıkları DM’lerle bağlam paylaşır mı?](#do-groupsthreads-share-context-with-dms)
  - [Kaç çalışma alanı ve ajan oluşturabilirim?](#how-many-workspaces-and-agents-can-i-create)
  - [Aynı anda birden fazla bot veya sohbet (Slack) çalıştırabilir miyim ve bunu nasıl kurmalıyım?](#can-i-run-multiple-bots-or-chats-at-the-same-time-slack-and-how-should-i-set-that-up)
  - [Modeller: varsayılanlar, seçim, takma adlar, değiştirme](#models-defaults-selection-aliases-switching)
- [Models: defaults, selection, aliases, switching](#models-defaults-selection-aliases-switching)
  - [What is the "default model"?](#what-is-the-default-model)
  - [Yapılandırmamı silmeden modelleri nasıl değiştiririm?](#how-do-i-switch-models-without-wiping-my-config)
  - [Kendi barındırdığım modelleri kullanabilir miyim (llama.cpp, vLLM, Ollama)?](#can-i-use-selfhosted-models-llamacpp-vllm-ollama)
  - [OpenClaw, Flawd ve Krill hangi modelleri kullanıyor?](#what-do-openclaw-flawd-and-krill-use-for-models)
  - [Yeniden başlatmadan, anında modelleri nasıl değiştiririm?](#how-do-i-switch-models-on-the-fly-without-restarting)
  - [Günlük işler için GPT 5.2’yi, kodlama için Codex 5.3’ü kullanabilir miyim?](#can-i-use-gpt-52-for-daily-tasks-and-codex-53-for-coding)
  - Neden "Model …
    24. is not allowed" görüyorum ve ardından yanıt gelmiyor?
  - [Neden "Unknown model: minimax/MiniMax-M2.1" görüyorum?](#why-do-i-see-unknown-model-minimaxminimaxm21) [MiniMax’i varsayılan olarak, karmaşık görevler için OpenAI’yi kullanabilir miyim?](#can-i-use-minimax-as-my-default-and-openai-for-complex-tasks)
  - [opus / sonnet / gpt yerleşik kısayollar mı?](#are-opus-sonnet-gpt-builtin-shortcuts)
  - [Model kısayollarını (takma adları) nasıl tanımlarım/geçersiz kılarım?](#how-do-i-defineoverride-model-shortcuts-aliases)
  - [OpenRouter veya Z.AI gibi diğer sağlayıcılardan modelleri nasıl eklerim?](#how-do-i-add-models-from-other-providers-like-openrouter-or-zai)
  - [Model devretme (failover) ve "All models failed"](#model-failover-and-all-models-failed)
  - [Failover nasıl çalışır?](#how-does-failover-work)
- [Bu hata ne anlama geliyor?](#what-does-this-error-mean)
  - [`No credentials found for profile "anthropic:default"` için düzeltme kontrol listesi](#fix-checklist-for-no-credentials-found-for-profile-anthropicdefault)
  - [Neden Google Gemini’yi de denedi ve başarısız oldu?](#why-did-it-also-try-google-gemini-and-fail)
  - [Fix checklist for `No credentials found for profile "anthropic:default"`](#fix-checklist-for-no-credentials-found-for-profile-anthropicdefault)
  - [Bir auth profili nedir?](#what-is-an-auth-profile)
- [Tipik profil kimlikleri nelerdir?](#what-are-typical-profile-ids)
  - [Hangi auth profilinin önce deneneceğini kontrol edebilir miyim?](#can-i-control-which-auth-profile-is-tried-first)
  - [OAuth ve API anahtarı: farkları nelerdir?](#oauth-vs-api-key-whats-the-difference)
  - [Gateway: portlar, "already running" ve uzak mod](#gateway-ports-already-running-and-remote-mode)
  - [Gateway hangi portu kullanır?](#what-port-does-the-gateway-use)
- [Neden `openclaw gateway status` çıktısı `Runtime: running` ama `RPC probe: failed` diyor?](#why-does-openclaw-gateway-status-say-runtime-running-but-rpc-probe-failed)
  - [Neden `openclaw gateway status` içinde `Config (cli)` ve `Config (service)` farklı görünüyor?](#why-does-openclaw-gateway-status-show-config-cli-and-config-service-different)
  - [Why does `openclaw gateway status` say `Runtime: running` but `RPC probe: failed`?](#why-does-openclaw-gateway-status-say-runtime-running-but-rpc-probe-failed)
  - [OpenClaw’ı uzak modda nasıl çalıştırırım (istemci başka bir yerdeki Gateway’e bağlanır)?](#how-do-i-run-openclaw-in-remote-mode-client-connects-to-a-gateway-elsewhere)
  - Control UI "unauthorized" diyor (ya da sürekli yeniden bağlanıyor).
    47.&#x20;
  - [Aynı ana bilgisayarda birden fazla Gateway çalıştırabilir miyim?](#can-i-run-multiple-gateways-on-the-same-host)
  - ["invalid handshake" / 1008 kodu ne anlama geliyor?](#what-does-invalid-handshake-code-1008-mean) Ne yapmalıyım?](#the-control-ui-says-unauthorized-or-keeps-reconnecting-what-now)
  - [Günlükleme ve hata ayıklama](#logging-and-debugging)
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

## Hızlı başlangıç ve ilk çalıştırma kurulumu

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

Node **>= 22** is required. `pnpm` is recommended. 1. Bun, Gateway için **önerilmez**.

### 2. Raspberry Pi üzerinde çalışır mı

Evet. 3. Gateway hafiftir – dokümanlar kişisel kullanım için **512MB-1GB RAM**, **1 çekirdek** ve yaklaşık **500MB** disk alanının yeterli olduğunu ve **Raspberry Pi 4’ün çalıştırabildiğini** belirtir.

4. Ek pay istiyorsanız (loglar, medya, diğer servisler), **2GB önerilir**, ancak bu katı bir alt sınır değildir.

5. İpucu: küçük bir Pi/VPS Gateway’i barındırabilir ve yerel ekran/kamera/tuval veya komut çalıştırma için dizüstü bilgisayarınızda/telefonunuzda **node**’ları eşleştirebilirsiniz. 6. Bkz. [Nodes](/nodes).

### 7. Raspberry Pi kurulumları için ipuçları var mı

8. Kısa cevap: çalışır, ancak pürüzler bekleyin.

- 9. **64-bit** bir işletim sistemi kullanın ve Node >= 22 tutun.
- 10. Logları görebilmek ve hızlı güncellemek için **hacklenebilir (git) kurulumu** tercih edin.
- 11. Kanallar/beceriler olmadan başlayın, sonra onları tek tek ekleyin.
- 12. Garip binary sorunlarına denk gelirseniz, bu genellikle bir **ARM uyumluluğu** problemidir.

13. Dokümanlar: [Linux](/platforms/linux), [Install](/install).

### 14. Wake up my friend onboarding ekranında takılı kaldı, hatch olmuyor. Şimdi ne yapmalıyım

15. Bu ekran, Gateway’nin erişilebilir ve doğrulanmış olmasına bağlıdır. 16. TUI ayrıca ilk hatch’te otomatik olarak
    "Wake up, my friend!" gönderir. 17. Bu satırı **yanıt olmadan** görüyorsanız
    ve token’lar 0’da kalıyorsa, ajan hiç çalışmadı demektir.

1. Gateway’i yeniden başlatın:

```bash
openclaw gateway restart
```

2. 18. Durum + doğrulamayı kontrol edin:

```bash
19. openclaw status
openclaw models status
openclaw logs --follow
```

3. 20. Hâlâ takılı kalıyorsa, şunu çalıştırın:

```bash
openclaw doctor
```

21. Gateway uzaktaysa, tünel/Tailscale bağlantısının açık olduğundan ve UI’ın doğru Gateway’i işaret ettiğinden emin olun. [Uzak erişim](/gateway/remote).

### 22. Onboarding’i yeniden yapmadan kurulumumu yeni bir makineye (Mac mini) taşıyabilir miyim

Evet. 23. **State dizinini** ve **workspace**’i kopyalayın, sonra Doctor’ı bir kez çalıştırın. 24. Bu,
**her iki** konumu da kopyaladığınız sürece botunuzu "**birebir aynı**" (hafıza, oturum geçmişi, doğrulama ve kanal durumu) tutar:

1. 25. Yeni makineye OpenClaw kurun.
2. 26. Eski makineden `$OPENCLAW_STATE_DIR`’i (varsayılan: `~/.openclaw`) kopyalayın.
3. 27. Workspace’inizi kopyalayın (varsayılan: `~/.openclaw/workspace`).
4. 28. `openclaw doctor` çalıştırın ve Gateway servisini yeniden başlatın.

29) Bu, yapılandırmayı, auth profillerini, WhatsApp kimlik bilgilerini, oturumları ve hafızayı korur. 30. Uzaktan moddaysanız,
    oturum deposu ve workspace’in Gateway ana makinesine ait olduğunu unutmayın.

31. **Önemli:** Yalnızca workspace’inizi GitHub’a commit/push ederseniz, **hafıza + bootstrap dosyalarını** yedeklemiş olursunuz, ancak oturum geçmişini veya doğrulamayı **yedeklemiş olmazsınız**. 32. Bunlar
    `~/.openclaw/` altında bulunur (örneğin `~/.openclaw/agents/<agentId>/sessions/`).

33. İlgili: [Migrating](/install/migrating), [Where things live on disk](/help/faq#where-does-openclaw-store-its-data),
    [Agent workspace](/concepts/agent-workspace), [Doctor](/gateway/doctor),
    [Remote mode](/gateway/remote).

### 34. En son sürümde nelerin yeni olduğunu nereden görebilirim

35. GitHub değişiklik günlüğünü kontrol edin:
    [https://github.com/openclaw/openclaw/blob/main/CHANGELOG.md](https://github.com/openclaw/openclaw/blob/main/CHANGELOG.md)

36. En yeni girdiler en üsttedir. 37. En üst bölüm **Unreleased** olarak işaretliyse, bir sonraki tarihli bölüm en son yayınlanan sürümdür. 38. Girdiler **Highlights**, **Changes** ve **Fixes** başlıkları altında gruplanır (gerektiğinde doküman/diğer bölümlerle).

### 39. docs.openclaw.ai’ye erişemiyorum, SSL hatası alıyorum. Ne yapmalıyım

40. Bazı Comcast/Xfinity bağlantıları, Xfinity Advanced Security üzerinden `docs.openclaw.ai`’yi yanlışlıkla engeller. 41. Bunu devre dışı bırakın veya `docs.openclaw.ai`’yi allowlist’e ekleyin, sonra tekrar deneyin. 42. Daha fazla
    detay: [Troubleshooting](/help/troubleshooting#docsopenclawai-shows-an-ssl-error-comcastxfinity).
41. Engeli kaldırmamıza yardımcı olmak için lütfen buradan bildirin: [https://spa.xfinity.com/check_url_status](https://spa.xfinity.com/check_url_status).

44. Siteye hâlâ erişemiyorsanız, dokümanlar GitHub’da yansılanmıştır:
    [https://github.com/openclaw/openclaw/tree/main/docs](https://github.com/openclaw/openclaw/tree/main/docs)

### 45. Stable ile beta arasındaki fark nedir

46. **Stable** ve **beta**, ayrı kod hatları değil, **npm dist-tag**’leridir:

- 47. `latest` = stable
- 48. `beta` = test için erken derleme

49. Derlemeleri **beta**’ya gönderir, test ederiz ve bir derleme sağlam olduğunda **aynı sürümü `latest`’e terfi ettiririz**. 50. Bu yüzden beta ve stable **aynı sürümü** işaret edebilir.

See what changed:
[https://github.com/openclaw/openclaw/blob/main/CHANGELOG.md](https://github.com/openclaw/openclaw/blob/main/CHANGELOG.md)

### How do I install the beta version and whats the difference between beta and dev

**Beta** is the npm dist-tag `beta` (may match `latest`).
**Dev** is the moving head of `main` (git); when published, it uses the npm dist-tag `dev`.

One-liners (macOS/Linux):

```bash
curl -fsSL --proto '=https' --tlsv1.2 https://openclaw.ai/install.sh | bash -s -- --beta
```

```bash
curl -fsSL --proto '=https' --tlsv1.2 https://openclaw.ai/install.sh | bash -s -- --install-method git
```

Windows installer (PowerShell):
[https://openclaw.ai/install.ps1](https://openclaw.ai/install.ps1)

More detail: [Development channels](/install/development-channels) and [Installer flags](/install/installer).

### How long does install and onboarding usually take

Rough guide:

- **Install:** 2-5 minutes
- **Onboarding:** 5-15 minutes depending on how many channels/models you configure

If it hangs, use [Installer stuck](/help/faq#installer-stuck-how-do-i-get-more-feedback)
and the fast debug loop in [Im stuck](/help/faq#im-stuck--whats-the-fastest-way-to-get-unstuck).

### How do I try the latest bits

Two options:

1. **Dev channel (git checkout):**

```bash
openclaw update --channel dev
```

This switches to the `main` branch and updates from source.

2. **Hackable install (from the installer site):**

```bash
curl -fsSL https://openclaw.ai/install.sh | bash -s -- --install-method git
```

That gives you a local repo you can edit, then update via git.

If you prefer a clean clone manually, use:

```bash
git clone https://github.com/openclaw/openclaw.git
cd openclaw
pnpm install
pnpm build
```

Docs: [Update](/cli/update), [Development channels](/install/development-channels),
[Install](/install).

### Installer stuck How do I get more feedback

Re-run the installer with **verbose output**:

```bash
curl -fsSL https://openclaw.ai/install.sh | bash -s -- --verbose
```

Beta install with verbose:

```bash
curl -fsSL https://openclaw.ai/install.sh | bash -s -- --beta --verbose
```

For a hackable (git) install:

```bash
curl -fsSL https://openclaw.ai/install.sh | bash -s -- --install-method git --verbose
```

More options: [Installer flags](/install/installer).

### Windows install says git not found or openclaw not recognized

Two common Windows issues:

**1) npm error spawn git / git not found**

- Install **Git for Windows** and make sure `git` is on your PATH.
- Close and reopen PowerShell, then re-run the installer.

**2) openclaw is not recognized after install**

- Your npm global bin folder is not on PATH.

- Check the path:

  ```powershell
  npm config get prefix
  ```

- Ensure `<prefix>\\bin` is on PATH (on most systems it is `%AppData%\\npm`).

- Close and reopen PowerShell after updating PATH.

If you want the smoothest Windows setup, use **WSL2** instead of native Windows.
Docs: [Windows](/platforms/windows).

### The docs didnt answer my question how do I get a better answer

Use the **hackable (git) install** so you have the full source and docs locally, then ask
your bot (or Claude/Codex) _from that folder_ so it can read the repo and answer precisely.

```bash
curl -fsSL https://openclaw.ai/install.sh | bash -s -- --install-method git
```

More detail: [Install](/install) and [Installer flags](/install/installer).

### Linux üzerinde OpenClaw’ı nasıl kurarım

Kısa cevap: Linux kılavuzunu takip edin, ardından onboarding sihirbazını çalıştırın.

- Linux hızlı yol + servis kurulumu: [Linux](/platforms/linux).
- Tam anlatım: [Getting Started](/start/getting-started).
- Kurulum + güncellemeler: [Install & updates](/install/updating).

### OpenClaw’ı bir VPS üzerine nasıl kurarım

Herhangi bir Linux VPS çalışır. Sunucuya kurun, ardından Gateway’e erişmek için SSH/Tailscale kullanın.

Kılavuzlar: [exe.dev](/install/exe-dev), [Hetzner](/install/hetzner), [Fly.io](/install/fly).
Uzaktan erişim: [Gateway remote](/gateway/remote).

### CloudVPS kurulum kılavuzları nerede

Yaygın sağlayıcılar için bir **hosting hub** tutuyoruz. Birini seçin ve kılavuzu takip edin:

- [VPS hosting](/vps) (tüm sağlayıcılar tek yerde)
- [Fly.io](/install/fly)
- [Hetzner](/install/hetzner)
- [exe.dev](/install/exe-dev)

Bulutta nasıl çalışır: **Gateway sunucuda çalışır** ve siz ona dizüstü bilgisayarınızdan/telefonunuzdan Control UI (veya Tailscale/SSH) üzerinden erişirsiniz. Durumunuz + çalışma alanınız sunucuda yaşar, bu yüzden ana kaynağın sunucu olduğunu varsayın ve yedekleyin.

Buluttaki bu Gateway’e **node**’lar (Mac/iOS/Android/headless) eşleştirerek yerel ekran/kamera/tuval erişimi sağlayabilir veya Gateway bulutta kalırken dizüstü bilgisayarınızda komutlar çalıştırabilirsiniz.

Merkez: [Platforms](/platforms). Uzaktan erişim: [Gateway remote](/gateway/remote).
Node’lar: [Nodes](/nodes), [Nodes CLI](/cli/nodes).

### OpenClaw’dan kendini güncellemesini isteyebilir miyim

Kısa cevap: **mümkün, ancak önerilmez**. Güncelleme akışı Gateway’i yeniden başlatabilir (aktif oturumu düşürür), temiz bir git checkout gerekebilir ve onay isteyebilir. Daha güvenlisi: güncellemeleri operatör olarak bir kabuktan çalıştırmaktır.

CLI’yi kullanın:

```bash
openclaw update
openclaw update status
openclaw update --channel stable|beta|dev
openclaw update --tag <dist-tag|version>
openclaw update --no-restart
```

Bir agent üzerinden otomatikleştirmeniz gerekiyorsa:

```bash
openclaw update --yes --no-restart
openclaw gateway restart
```

Dokümanlar: [Update](/cli/update), [Updating](/install/updating).

### Onboarding sihirbazı aslında ne yapar

`openclaw onboard` önerilen kurulum yoludur. **Yerel modda** sizi şu adımlardan geçirir:

- **Model/kimlik doğrulama kurulumu** (Claude abonelikleri için Anthropic **setup-token** önerilir, OpenAI Codex OAuth desteklenir, API anahtarları isteğe bağlıdır, LM Studio yerel modelleri desteklenir)
- **Çalışma alanı** konumu + bootstrap dosyaları
- **Gateway ayarları** (bind/port/auth/tailscale)
- **Sağlayıcılar** (WhatsApp, Telegram, Discord, Mattermost (eklenti), Signal, iMessage)
- **Daemon kurulumu** (macOS’ta LaunchAgent; Linux/WSL2’de systemd user unit)
- **Sağlık kontrolleri** ve **beceri** seçimi

Ayrıca yapılandırılmış modeliniz bilinmiyorsa veya kimlik doğrulaması eksikse uyarır.

### Bunu çalıştırmak için Claude veya OpenAI aboneliğine ihtiyacım var mı

Hayır. OpenClaw’ı **API anahtarları** (Anthropic/OpenAI/diğerleri) ile veya verileriniz cihazınızda kalsın diye **yalnızca yerel modellerle** çalıştırabilirsiniz. Abonelikler (Claude Pro/Max veya OpenAI Codex), bu sağlayıcılarda kimlik doğrulamak için isteğe bağlı yollardır.

Dokümanlar: [Anthropic](/providers/anthropic), [OpenAI](/providers/openai),
[Local models](/gateway/local-models), [Models](/concepts/models).

### API anahtarı olmadan Claude Max aboneliğini kullanabilir miyim

Evet. Bir API anahtarı yerine **setup-token** ile kimlik doğrulayabilirsiniz. Bu, abonelik yoludur.

Claude Pro/Max abonelikleri **bir API anahtarı içermez**, bu yüzden abonelik hesapları için doğru yaklaşım budur. Önemli: Bu kullanımın abonelik politikaları ve şartları kapsamında izinli olduğunu Anthropic ile doğrulamanız gerekir.
En açık ve desteklenen yolu istiyorsanız, bir Anthropic API anahtarı kullanın.

### Anthropic setuptoken kimlik doğrulaması nasıl çalışır

`claude setup-token`, Claude Code CLI aracılığıyla bir **token string** üretir (web konsolunda mevcut değildir). **Herhangi bir makinede** çalıştırabilirsiniz. Sihirbazda **Anthropic token (setup-token yapıştır)** seçin veya `openclaw models auth paste-token --provider anthropic` ile yapıştırın. Token, **anthropic** sağlayıcısı için bir kimlik doğrulama profili olarak saklanır ve bir API anahtarı gibi kullanılır (otomatik yenileme yoktur). Daha fazla ayrıntı: [OAuth](/concepts/oauth).

### Anthropic setuptoken’ı nerede bulurum

Anthropic Console’da **değildir**. Setup-token, **Claude Code CLI** tarafından **herhangi bir makinede** üretilir:

```bash
claude setup-token
```

Yazdırdığı token’ı kopyalayın, ardından sihirbazda **Anthropic token (setup-token yapıştır)** seçin. Gateway host üzerinde çalıştırmak istiyorsanız, `openclaw models auth setup-token --provider anthropic` kullanın. `claude setup-token`’ı başka bir yerde çalıştırdıysanız, gateway host üzerinde `openclaw models auth paste-token --provider anthropic` ile yapıştırın. [Anthropic](/providers/anthropic)’e bakın.

### Claude abonelik kimlik doğrulamasını (Claude Pro veya Max) destekliyor musunuz

Evet – **setup-token** aracılığıyla. OpenClaw artık Claude Code CLI OAuth token’larını yeniden kullanmaz; bir setup-token veya Anthropic API anahtarı kullanın. Token’ı herhangi bir yerde üretin ve gateway host üzerine yapıştırın. [Anthropic](/providers/anthropic) ve [OAuth](/concepts/oauth)’a bakın.

Not: Claude abonelik erişimi Anthropic’in şartlarına tabidir. Üretim veya çok kullanıcılı iş yükleri için API anahtarları genellikle daha güvenli bir tercihtir.

### Anthropic’ten neden HTTP 429 ratelimiterror görüyorum

Bu, mevcut zaman penceresi için **Anthropic kota/hız limitinizin** tükendiği anlamına gelir. Bir **Claude aboneliği** (setup-token veya Claude Code OAuth) kullanıyorsanız, pencerenin sıfırlanmasını bekleyin veya planınızı yükseltin. **Anthropic API anahtarı** kullanıyorsanız, kullanım/faturalandırma için Anthropic Console’u kontrol edin ve gerekirse limitleri artırın.

İpucu: Bir sağlayıcı hız sınırlamasına girdiğinde OpenClaw’ın yanıt vermeye devam edebilmesi için bir **yedek model** ayarlayın.
[Models](/cli/models) ve [OAuth](/concepts/oauth)’a bakın.

### AWS Bedrock destekleniyor mu

Evet – pi-ai’nin **Amazon Bedrock (Converse)** sağlayıcısı üzerinden **manuel yapılandırma** ile. Gateway host üzerinde AWS kimlik bilgilerini/bölgesini sağlamanız ve modeller yapılandırmanıza bir Bedrock sağlayıcı girdisi eklemeniz gerekir. [Amazon Bedrock](/providers/bedrock) ve [Model providers](/providers/models)’a bakın. Yönetilen bir anahtar akışı tercih ederseniz, Bedrock’un önünde OpenAI uyumlu bir proxy hâlâ geçerli bir seçenektir.

### Codex kimlik doğrulaması nasıl çalışır

OpenClaw, OAuth (ChatGPT oturum açma) üzerinden **OpenAI Code (Codex)** destekler. Sihirbaz OAuth akışını çalıştırabilir ve uygun olduğunda varsayılan modeli `openai-codex/gpt-5.3-codex` olarak ayarlar. [Model providers](/concepts/model-providers) ve [Wizard](/start/wizard)’a bakın.

### OpenAI abonelik kimlik doğrulaması Codex OAuth’u destekliyor musunuz

Evet. OpenClaw, **OpenAI Code (Codex) abonelik OAuth**’unu tamamen destekler. Onboarding sihirbazı OAuth akışını sizin için çalıştırabilir.

[OAuth](/concepts/oauth), [Model providers](/concepts/model-providers) ve [Wizard](/start/wizard)’a bakın.

### Gemini CLI OAuth’u nasıl kurarım

Gemini CLI, `openclaw.json` içinde bir istemci kimliği veya gizli anahtar değil, **eklenti kimlik doğrulama akışı** kullanır.

Adımlar:

1. Eklentiyi etkinleştirin: `openclaw plugins enable google-gemini-cli-auth`
2. Giriş: `openclaw models auth login --provider google-gemini-cli --set-default`

Bu, OAuth token’larını gateway host üzerindeki kimlik doğrulama profillerinde saklar. Ayrıntılar: [Model providers](/concepts/model-providers).

### Gündelik sohbetler için yerel bir model uygun mu

Genellikle hayır. OpenClaw büyük bağlam + güçlü güvenlik gerektirir; küçük kartlar keser ve sızıntı yapar. Mecbur kalırsanız, yerel olarak çalıştırabileceğiniz **en büyük** MiniMax M2.1 derlemesini (LM Studio) kullanın ve [/gateway/local-models](/gateway/local-models)’e bakın. Smaller/quantized models increase prompt-injection risk - see [Security](/gateway/security).

### How do I keep hosted model traffic in a specific region

Pick region-pinned endpoints. OpenRouter exposes US-hosted options for MiniMax, Kimi, and GLM; choose the US-hosted variant to keep data in-region. You can still list Anthropic/OpenAI alongside these by using `models.mode: "merge"` so fallbacks stay available while respecting the regioned provider you select.

### Do I have to buy a Mac Mini to install this

Hayır. OpenClaw runs on macOS or Linux (Windows via WSL2). A Mac mini is optional - some people
buy one as an always-on host, but a small VPS, home server, or Raspberry Pi-class box works too.

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

Evet. The **Mac mini can run the Gateway**, and your MacBook Pro can connect as a
**node** (companion device). Nodes don't run the Gateway - they provide extra
capabilities like screen/camera/canvas and `system.run` on that device.

Common pattern:

- Gateway on the Mac mini (always-on).
- MacBook Pro runs the macOS app or a node host and pairs to the Gateway.
- Use `openclaw nodes status` / `openclaw nodes list` to see it.

Dokümanlar: [Nodes](/nodes), [Nodes CLI](/cli/nodes).

### Can I use Bun

Bun **önerilmez**. We see runtime bugs, especially with WhatsApp and Telegram.
Use **Node** for stable gateways.

If you still want to experiment with Bun, do it on a non-production gateway
without WhatsApp/Telegram.

### Telegram what goes in allowFrom

`channels.telegram.allowFrom` is **the human sender's Telegram user ID** (numeric, recommended) or `@username`. It is not the bot username.

Daha güvenli (üçüncü taraf bot yok):

- DM your bot, then run `openclaw logs --follow` and read `from.id`.

Official Bot API:

- DM your bot, then call `https://api.telegram.org/bot<bot_token>/getUpdates` and read `message.from.id`.

Üçüncü taraf (daha az gizli):

- DM `@userinfobot` or `@getidsbot`.

See [/channels/telegram](/channels/telegram#access-control-dms--groups).

### Can multiple people use one WhatsApp number with different OpenClaw instances

Yes, via **multi-agent routing**. Bind each sender's WhatsApp **DM** (peer `kind: "dm"`, sender E.164 like `+15551234567`) to a different `agentId`, so each person gets their own workspace and session store. Replies still come from the **same WhatsApp account**, and DM access control (`channels.whatsapp.dmPolicy` / `channels.whatsapp.allowFrom`) is global per WhatsApp account. See [Multi-Agent Routing](/concepts/multi-agent) and [WhatsApp](/channels/whatsapp).

### Can I run a fast chat agent and an Opus for coding agent

Evet. Use multi-agent routing: give each agent its own default model, then bind inbound routes (provider account or specific peers) to each agent. Example config lives in [Multi-Agent Routing](/concepts/multi-agent). See also [Models](/concepts/models) and [Configuration](/gateway/configuration).

### Does Homebrew work on Linux

Evet. Homebrew supports Linux (Linuxbrew). Hızlı kurulum:

```bash
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
echo 'eval "$(/home/linuxbrew/.linuxbrew/bin/brew shellenv)"' >> ~/.profile
eval "$(/home/linuxbrew/.linuxbrew/bin/brew shellenv)"
brew install <formula>
```

OpenClaw’ı systemd üzerinden çalıştırıyorsanız, `brew` ile kurulmuş araçların non-login shell’lerde çözümlenebilmesi için servis PATH’inin `/home/linuxbrew/.linuxbrew/bin`’i (veya brew prefix’inizi) içerdiğinden emin olun.
Son derlemeler ayrıca Linux systemd servislerinde yaygın kullanıcı bin dizinlerini başa ekler (örneğin `~/.local/bin`, `~/.npm-global/bin`, `~/.local/share/pnpm`, `~/.bun/bin`) ve ayarlıysa `PNPM_HOME`, `NPM_CONFIG_PREFIX`, `BUN_INSTALL`, `VOLTA_HOME`, `ASDF_DATA_DIR`, `NVM_DIR` ve `FNM_DIR` değişkenlerini dikkate alır.

### Hackable git kurulumu ile npm kurulumu arasındaki fark nedir

- **Hackable (git) kurulumu:** tam kaynak kodu checkout’u, düzenlenebilir, katkıda bulunanlar için en iyisi.
  Derlemeleri yerel olarak çalıştırırsınız ve kod/doküman yamalayabilirsiniz.
- **npm kurulumu:** global CLI kurulumu, repo yok, “sadece çalıştırmak” isteyenler için en iyisi.
  Güncellemeler npm dist-tag’lerinden gelir.

Dokümanlar: [Başlarken](/start/getting-started), [Güncelleme](/install/updating).

### Daha sonra npm ve git kurulumları arasında geçiş yapabilir miyim

Evet. Diğer türü kurun, ardından Doctor’ı çalıştırın; böylece gateway servisi yeni giriş noktasını işaret eder.
Bu **verilerinizi silmez** – yalnızca OpenClaw kod kurulumunu değiştirir. Durumunuz
(`~/.openclaw`) ve çalışma alanınız (`~/.openclaw/workspace`) olduğu gibi kalır.

npm → git:

```bash
git clone https://github.com/openclaw/openclaw.git
cd openclaw
pnpm install
pnpm build
openclaw doctor
openclaw gateway restart
```

git → npm:

```bash
npm install -g openclaw@latest
openclaw doctor
openclaw gateway restart
```

Doctor, gateway servis giriş noktası uyuşmazlığını tespit eder ve servis yapılandırmasını mevcut kurulumla eşleştirmek için yeniden yazmayı teklif eder (otomasyonda `--repair` kullanın).

Yedekleme ipuçları: bkz. [Yedekleme stratejisi](/help/faq#whats-the-recommended-backup-strategy).

### Gateway’i dizüstü bilgisayarımda mı yoksa bir VPS’te mi çalıştırmalıyım

Kısa cevap: **24/7 güvenilirlik istiyorsanız, bir VPS kullanın**. En az sürtünme istiyorsanız ve uyku/yeniden başlatmalar sorun değilse, yerelde çalıştırın.

**Dizüstü (yerel Gateway)**

- **Artılar:** sunucu maliyeti yok, yerel dosyalara doğrudan erişim, canlı tarayıcı penceresi.
- **Eksiler:** uyku/ağ kopmaları = bağlantı kesilmeleri, OS güncellemeleri/yeniden başlatmalar kesintiye uğratır, uyanık kalması gerekir.

**VPS / bulut**

- **Artılar:** her zaman açık, stabil ağ, dizüstü uyku sorunları yok, çalışır durumda tutmak daha kolay.
- **Eksiler:** genellikle headless çalışır (ekran görüntüleri kullanılır), yalnızca uzaktan dosya erişimi, güncellemeler için SSH gerekir.

**OpenClaw’a özgü not:** WhatsApp/Telegram/Slack/Mattermost (eklenti)/Discord’un hepsi VPS’ten sorunsuz çalışır. Tek gerçek ödünleşim **headless tarayıcı** ile görünür pencere arasındadır. Bkz. [Tarayıcı](/tools/browser).

**Önerilen varsayılan:** Daha önce gateway bağlantı kopmaları yaşadıysanız VPS. Mac’i aktif olarak kullandığınızda ve yerel dosya erişimi veya görünür tarayıcıyla UI otomasyonu istediğinizde yerel kullanım harikadır.

### OpenClaw’ı adanmış bir makinede çalıştırmak ne kadar önemli

Zorunlu değil, ancak **güvenilirlik ve izolasyon için önerilir**.

- **Adanmış host (VPS/Mac mini/Pi):** her zaman açık, daha az uyku/yeniden başlatma kesintisi, daha temiz izinler, çalışır durumda tutmak daha kolay.
- **Paylaşılan dizüstü/masaüstü:** test ve aktif kullanım için tamamen uygun, ancak makine uyuduğunda veya güncellendiğinde duraklamalar bekleyin.

Her iki dünyanın en iyisi için Gateway’i adanmış bir host’ta tutun ve dizüstünüzü yerel ekran/kamera/exec araçları için bir **node** olarak eşleyin. Bkz. [Node’lar](/nodes).
Güvenlik rehberliği için [Güvenlik](/gateway/security) bölümünü okuyun.

### Minimum VPS gereksinimleri ve önerilen OS nedir

OpenClaw hafiftir. Temel bir Gateway + bir sohbet kanalı için:

- **Mutlak minimum:** 1 vCPU, 1GB RAM, ~500MB disk.
- **Önerilen:** 1–2 vCPU, 2GB RAM veya daha fazlası (loglar, medya, birden fazla kanal için pay bırakır). Node araçları ve tarayıcı otomasyonu kaynak tüketebilir.

OS: **Ubuntu LTS** (veya herhangi bir modern Debian/Ubuntu) kullanın. Linux kurulum yolu burada en iyi şekilde test edilmiştir.

Dokümanlar: [Linux](/platforms/linux), [VPS barındırma](/vps).

### OpenClaw’ı bir VM’de çalıştırabilir miyim ve gereksinimler nelerdir

Evet. Treat a VM the same as a VPS: it needs to be always on, reachable, and have enough
RAM for the Gateway and any channels you enable.

Baseline guidance:

- **Absolute minimum:** 1 vCPU, 1GB RAM.
- **Recommended:** 2GB RAM or more if you run multiple channels, browser automation, or media tools.
- **OS:** Ubuntu LTS or another modern Debian/Ubuntu.

If you are on Windows, **WSL2 is the easiest VM style setup** and has the best tooling
compatibility. See [Windows](/platforms/windows), [VPS hosting](/vps).
If you are running macOS in a VM, see [macOS VM](/install/macos-vm).

## OpenClaw nedir?

### What is OpenClaw in one paragraph

OpenClaw is a personal AI assistant you run on your own devices. It replies on the messaging surfaces you already use (WhatsApp, Telegram, Slack, Mattermost (plugin), Discord, Google Chat, Signal, iMessage, WebChat) and can also do voice + a live Canvas on supported platforms. The **Gateway** is the always-on control plane; the assistant is the product.

### What's the value proposition

OpenClaw is not "just a Claude wrapper." It's a **local-first control plane** that lets you run a
capable assistant on **your own hardware**, reachable from the chat apps you already use, with
stateful sessions, memory, and tools - without handing control of your workflows to a hosted
SaaS.

Öne çıkanlar:

- **Your devices, your data:** run the Gateway wherever you want (Mac, Linux, VPS) and keep the
  workspace + session history local.
- **Real channels, not a web sandbox:** WhatsApp/Telegram/Slack/Discord/Signal/iMessage/etc,
  plus mobile voice and Canvas on supported platforms.
- **Model-agnostic:** use Anthropic, OpenAI, MiniMax, OpenRouter, etc., with per-agent routing
  and failover.
- **Local-only option:** run local models so **all data can stay on your device** if you want.
- **Multi-agent routing:** separate agents per channel, account, or task, each with its own
  workspace and defaults.
- **Open source and hackable:** inspect, extend, and self-host without vendor lock-in.

Docs: [Gateway](/gateway), [Channels](/channels), [Multi-agent](/concepts/multi-agent),
[Memory](/concepts/memory).

### I just set it up what should I do first

Good first projects:

- Build a website (WordPress, Shopify, or a simple static site).
- Prototype a mobile app (outline, screens, API plan).
- Organize files and folders (cleanup, naming, tagging).
- Connect Gmail and automate summaries or follow ups.

It can handle large tasks, but it works best when you split them into phases and
use sub agents for parallel work.

### What are the top five everyday use cases for OpenClaw

Everyday wins usually look like:

- **Personal briefings:** summaries of inbox, calendar, and news you care about.
- **Research and drafting:** quick research, summaries, and first drafts for emails or docs.
- **Reminders and follow ups:** cron or heartbeat driven nudges and checklists.
- **Browser automation:** filling forms, collecting data, and repeating web tasks.
- **Cross device coordination:** send a task from your phone, let the Gateway run it on a server, and get the result back in chat.

### Can OpenClaw help with lead gen outreach ads and blogs for a SaaS

Yes for **research, qualification, and drafting**. It can scan sites, build shortlists,
summarize prospects, and write outreach or ad copy drafts.

For **outreach or ad runs**, keep a human in the loop. Avoid spam, follow local laws and
platform policies, and review anything before it is sent. The safest pattern is to let
OpenClaw draft and you approve.

Docs: [Security](/gateway/security).

### What are the advantages vs Claude Code for web development

OpenClaw is a **personal assistant** and coordination layer, not an IDE replacement. Use
Claude Code or Codex for the fastest direct coding loop inside a repo. Use OpenClaw when you
want durable memory, cross-device access, and tool orchestration.

Advantages:

- **Persistent memory + workspace** across sessions
- **Multi-platform access** (WhatsApp, Telegram, TUI, WebChat)
- **Araç orkestrasyonu** (tarayıcı, dosyalar, zamanlama, kancalar)
- **Her zaman açık Ağ Geçidi** (bir VPS üzerinde çalışır, her yerden etkileşim kurulur)
- Yerel tarayıcı/ekran/kamera/çalıştırma için **Düğümler**

Vitrin: [https://openclaw.ai/showcase](https://openclaw.ai/showcase)

## Yetenekler ve otomasyon

### Depoyu kirletmeden yetenekleri nasıl özelleştiririm

Depo kopyasını düzenlemek yerine yönetilen geçersiz kılmaları kullanın. Değişikliklerinizi `~/.openclaw/skills/<name>/SKILL.md` içine koyun (veya `~/.openclaw/openclaw.json` içinde `skills.load.extraDirs` ile bir klasör ekleyin). Öncelik sırası `<workspace>/skills` > `~/.openclaw/skills` > paketlenmiş şeklindedir; böylece git’e dokunmadan yönetilen geçersiz kılmalar kazanır. Yalnızca upstream’e uygun düzenlemeler depoda yer almalı ve PR olarak gönderilmelidir.

### Yetenekleri özel bir klasörden yükleyebilir miyim

Evet. `~/.openclaw/openclaw.json` içinde `skills.load.extraDirs` ile ek dizinler ekleyin (en düşük öncelik). Varsayılan öncelik sırası şöyle kalır: `<workspace>/skills` → `~/.openclaw/skills` → paketlenmiş → `skills.load.extraDirs`. `clawhub` varsayılan olarak `./skills` içine kurar; OpenClaw bunu `<workspace>/skills` olarak değerlendirir.

### Farklı görevler için farklı modelleri nasıl kullanabilirim

Bugün desteklenen kalıplar şunlardır:

- **Cron işleri**: izole işler, iş başına bir `model` geçersiz kılması ayarlayabilir.
- **Alt ajanlar**: görevleri farklı varsayılan modellere sahip ayrı ajanlara yönlendirin.
- **İsteğe bağlı geçiş**: geçerli oturum modelini istediğiniz zaman değiştirmek için `/model` kullanın.

[Cron işleri](/automation/cron-jobs), [Çoklu Ajan Yönlendirme](/concepts/multi-agent) ve [Slash komutları](/tools/slash-commands) sayfalarına bakın.

### Bot ağır işler yaparken donuyor Bunu nasıl dışarı alırım

Uzun veya paralel görevler için **alt ajanlar** kullanın. Alt ajanlar kendi oturumlarında çalışır,
bir özet döndürür ve ana sohbetinizi duyarlı tutar.

Botunuza "bu görev için bir alt ajan oluştur" demesini isteyin veya `/subagents` kullanın.
Ağ Geçidi’nin şu anda ne yaptığını (ve meşgul olup olmadığını) görmek için sohbette `/status` kullanın.

Token ipucu: uzun görevler ve alt ajanlar her ikisi de token tüketir. Maliyet önemliyse, `agents.defaults.subagents.model` üzerinden
alt ajanlar için daha ucuz bir model ayarlayın.

Dokümanlar: [Alt ajanlar](/tools/subagents).

### Cron veya hatırlatıcılar tetiklenmiyor Ne kontrol etmeliyim

Cron, Ağ Geçidi süreci içinde çalışır. Ağ Geçidi sürekli çalışmıyorsa,
zamanlanmış işler çalışmaz.

Kontrol listesi:

- Cron’un etkin olduğunu (`cron.enabled`) ve `OPENCLAW_SKIP_CRON`’un ayarlı olmadığını doğrulayın.
- Ağ Geçidi’nin 7/24 çalıştığını kontrol edin (uyku/yeniden başlatma yok).
- İş için saat dilimi ayarlarını doğrulayın (`--tz` vs ana makine saat dilimi).

Hata ayıklama:

```bash
openclaw cron run <jobId> --force
openclaw cron runs --id <jobId> --limit 50
```

Dokümanlar: [Cron işleri](/automation/cron-jobs), [Cron vs Heartbeat](/automation/cron-vs-heartbeat).

### Linux’ta yetenekleri nasıl kurarım

**ClawHub** (CLI) kullanın veya yetenekleri çalışma alanınıza bırakın. macOS Yetenekler UI’si Linux’ta mevcut değildir.
[https://clawhub.com](https://clawhub.com) adresinden yeteneklere göz atın.

ClawHub CLI’yi kurun (bir paket yöneticisi seçin):

```bash
npm i -g clawhub
```

```bash
pnpm add -g clawhub
```

### Can OpenClaw run tasks on a schedule or continuously in the background

Evet. Ağ Geçidi zamanlayıcısını kullanın:

- **Cron işleri** zamanlanmış veya yinelenen görevler için (yeniden başlatmalar arasında kalıcıdır).
- **Heartbeat**, "ana oturum" için periyodik kontroller içindir.
- **İzole işler**, özetler gönderen veya sohbetlere teslim eden otonom ajanlar içindir.

Docs: [Cron jobs](/automation/cron-jobs), [Cron vs Heartbeat](/automation/cron-vs-heartbeat),
[Heartbeat](/gateway/heartbeat).

### Apple macOS’a özel yetenekleri Linux’tan çalıştırabilir miyim?

Doğrudan hayır. macOS skills are gated by `metadata.openclaw.os` plus required binaries, and skills only appear in the system prompt when they are eligible on the **Gateway host**. On Linux, `darwin`-only skills (like `apple-notes`, `apple-reminders`, `things-mac`) will not load unless you override the gating.

3. Desteklenen üç deseniniz var:

4. **Seçenek A - Gateway’i bir Mac üzerinde çalıştırın (en basiti).**
   Gateway’i macOS ikili dosyalarının bulunduğu yerde çalıştırın, ardından Linux’tan [uzak modda](#how-do-i-run-openclaw-in-remote-mode-client-connects-to-a-gateway-elsewhere) veya Tailscale üzerinden bağlanın. 5. Gateway ana bilgisayarı macOS olduğu için beceriler normal şekilde yüklenir.

6. **Seçenek B - bir macOS düğümü kullanın (SSH yok).**
   Gateway’i Linux’ta çalıştırın, bir macOS düğümüyle (menü çubuğu uygulaması) eşleştirin ve Mac’te **Node Run Commands** ayarını "Always Ask" veya "Always Allow" olarak ayarlayın. 7. OpenClaw, gerekli ikili dosyalar düğümde mevcut olduğunda macOS-yalnız becerileri uygun kabul edebilir. 8. Ajan bu becerileri `nodes` aracı üzerinden çalıştırır. 9. "Always Ask" seçerseniz, istemde "Always Allow"u onaylamak o komutu izin listesine ekler.

10. **Seçenek C - macOS ikili dosyalarını SSH üzerinden proxy’leyin (ileri seviye).**
    Gateway’i Linux’ta tutun, ancak gerekli CLI ikili dosyalarının bir Mac’te çalışan SSH sarmalayıcılarına çözülmesini sağlayın. 11. Ardından, uygun kalması için beceriyi Linux’a izin verecek şekilde geçersiz kılın.

1. 12. İkili dosya için bir SSH sarmalayıcı oluşturun (örnek: Apple Notes için `memo`):

   ````bash
   13. ```bash
   #!/usr/bin/env bash
   set -euo pipefail
   exec ssh -T user@mac-host /opt/homebrew/bin/memo "$@"
   ```
   ````

2. Put the wrapper on `PATH` on the Linux host (for example `~/bin/memo`).

3. Override the skill metadata (workspace or `~/.openclaw/skills`) to allow Linux:

   ````markdown
   16. ```yaml
   ---
   name: apple-notes
   description: Manage Apple Notes via the memo CLI on macOS.
   metadata: { "openclaw": { "os": ["darwin", "linux"], "requires": { "bins": ["memo"] } } }
   ---
   ```
   ````

4. Start a new session so the skills snapshot refreshes.

### 18) Bir Notion veya HeyGen entegrasyonunuz var mı

19. Şu anda yerleşik değil.

Seçenekler:

- **Custom skill / plugin:** best for reliable API access (Notion/HeyGen both have APIs).
- 21. **Tarayıcı otomasyonu:** kod yazmadan çalışır ancak daha yavaştır ve daha kırılgandır.

22. İstemci başına bağlamı korumak istiyorsanız (ajans iş akışları), basit bir desen şudur:

- 23. İstemci başına bir Notion sayfası (bağlam + tercihler + aktif işler).
- 24. Ajanın oturumun başında o sayfayı getirmesini isteyin.

25. Yerel bir entegrasyon istiyorsanız, bir özellik talebi açın veya bu API’leri hedefleyen bir beceri oluşturun.

26. Becerileri yükleyin:

````bash
27. ```bash
clawhub install <skill-slug>
clawhub update --all
```
````

28. ClawHub, mevcut dizininiz altında `./skills` içine kurar (veya yapılandırılmış OpenClaw çalışma alanınıza geri döner); OpenClaw bunu bir sonraki oturumda `<workspace>/skills` olarak ele alır. 29. Ajanlar arasında paylaşılan beceriler için bunları `~/.openclaw/skills/<name>/SKILL.md` altına yerleştirin. 30. Bazı beceriler Homebrew ile kurulan ikili dosyaları bekler; Linux’ta bu Linuxbrew anlamına gelir (yukarıdaki Homebrew Linux SSS girdisine bakın). 31. [Skills](/tools/skills) ve [ClawHub](/tools/clawhub) sayfalarına bakın.

### 32. Tarayıcı devralma için Chrome uzantısını nasıl kurarım

33. Yerleşik yükleyiciyi kullanın, ardından paketlenmemiş uzantıyı Chrome’da yükleyin:

```bash
openclaw browser extension install
openclaw browser extension path
```

34. Ardından Chrome → `chrome://extensions` → "Developer mode"u etkinleştir → "Load unpacked" → o klasörü seç.

35. Tam kılavuz (uzak Gateway + güvenlik notları dahil): [Chrome extension](/tools/chrome-extension)

36. Gateway, Chrome ile aynı makinede çalışıyorsa (varsayılan kurulum), genellikle **ekstra hiçbir şeye** ihtiyacınız olmaz.
    Gateway başka bir yerde çalışıyorsa, Gateway’in tarayıcı eylemlerini proxy’leyebilmesi için
    tarayıcı makinesinde bir node host çalıştırın.
37. Yine de kontrol etmek istediğiniz sekmede uzantı düğmesine tıklamanız gerekir (otomatik bağlanmaz).

## 38. Sandboxing ve bellek

### 39. Özel bir sandboxing dokümanı var mı

Evet. [Sandboxing](/gateway/sandboxing) bölümüne bakın. 40. Docker’a özgü kurulum için (Docker’da tam gateway veya sandbox imajları), [Docker](/install/docker) sayfasına bakın.

### 41. Docker sınırlı hissettiriyor Tam özellikleri nasıl etkinleştiririm

42. Varsayılan imaj güvenlik önceliklidir ve `node` kullanıcısı olarak çalışır; bu nedenle sistem paketleri, Homebrew veya paketlenmiş tarayıcılar içermez. 43. Daha kapsamlı bir kurulum için:

- 44. Önbelleklerin kalıcı olması için `/home/node` dizinini `OPENCLAW_HOME_VOLUME` ile kalıcı hale getirin.
- 45. Sistem bağımlılıklarını `OPENCLAW_DOCKER_APT_PACKAGES` ile imaja ekleyin.
- 46. Paketlenmiş CLI ile Playwright tarayıcılarını yükleyin:
      `node /app/node_modules/playwright-core/cli.js install chromium`
- 47. `PLAYWRIGHT_BROWSERS_PATH` ayarlayın ve yolun kalıcı olduğundan emin olun.

48. Dokümanlar: [Docker](/install/docker), [Browser](/tools/browser).

49. **DM’leri kişisel tutup grupları tek bir ajanla herkese açık sandbox’lı yapabilir miyim**

50. Evet - özel trafiğiniz **DM’ler** ve herkese açık trafiğiniz **gruplar** ise.

Use `agents.defaults.sandbox.mode: "non-main"` so group/channel sessions (non-main keys) run in Docker, while the main DM session stays on-host. Then restrict what tools are available in sandboxed sessions via `tools.sandbox.tools`.

Setup walkthrough + example config: [Groups: personal DMs + public groups](/channels/groups#pattern-personal-dms-public-groups-single-agent)

Key config reference: [Gateway configuration](/gateway/configuration#agentsdefaultssandbox)

### How do I bind a host folder into the sandbox

Set `agents.defaults.sandbox.docker.binds` to `["host:path:mode"]` (e.g., `"/home/user/src:/src:ro"`). Global + per-agent binds merge; per-agent binds are ignored when `scope: "shared"`. Use `:ro` for anything sensitive and remember binds bypass the sandbox filesystem walls. See [Sandboxing](/gateway/sandboxing#custom-bind-mounts) and [Sandbox vs Tool Policy vs Elevated](/gateway/sandbox-vs-tool-policy-vs-elevated#bind-mounts-security-quick-check) for examples and safety notes.

### How does memory work

OpenClaw memory is just Markdown files in the agent workspace:

- Daily notes in `memory/YYYY-MM-DD.md`
- Curated long-term notes in `MEMORY.md` (main/private sessions only)

OpenClaw also runs a **silent pre-compaction memory flush** to remind the model
to write durable notes before auto-compaction. This only runs when the workspace
is writable (read-only sandboxes skip it). [Bellek](/concepts/memory).

### Memory keeps forgetting things How do I make it stick

Ask the bot to **write the fact to memory**. Long-term notes belong in `MEMORY.md`,
short-term context goes into `memory/YYYY-MM-DD.md`.

This is still an area we are improving. It helps to remind the model to store memories;
it will know what to do. If it keeps forgetting, verify the Gateway is using the same
workspace on every run.

Docs: [Memory](/concepts/memory), [Agent workspace](/concepts/agent-workspace).

### Does semantic memory search require an OpenAI API key

Only if you use **OpenAI embeddings**. Codex OAuth covers chat/completions and
does **not** grant embeddings access, so **signing in with Codex (OAuth or the
Codex CLI login)** does not help for semantic memory search. OpenAI embeddings
still need a real API key (`OPENAI_API_KEY` or `models.providers.openai.apiKey`).

If you don't set a provider explicitly, OpenClaw auto-selects a provider when it
can resolve an API key (auth profiles, `models.providers.*.apiKey`, or env vars).
It prefers OpenAI if an OpenAI key resolves, otherwise Gemini if a Gemini key
resolves. If neither key is available, memory search stays disabled until you
configure it. If you have a local model path configured and present, OpenClaw
prefers `local`.

If you'd rather stay local, set `memorySearch.provider = "local"` (and optionally
`memorySearch.fallback = "none"`). If you want Gemini embeddings, set
`memorySearch.provider = "gemini"` and provide `GEMINI_API_KEY` (or
`memorySearch.remote.apiKey`). We support **OpenAI, Gemini, or local** embedding
models - see [Memory](/concepts/memory) for the setup details.

### Does memory persist forever What are the limits

Memory files live on disk and persist until you delete them. The limit is your
storage, not the model. The **session context** is still limited by the model
context window, so long conversations can compact or truncate. That is why
memory search exists - it pulls only the relevant parts back into context.

Docs: [Memory](/concepts/memory), [Context](/concepts/context).

## Where things live on disk

### Is all data used with OpenClaw saved locally

No - **OpenClaw's state is local**, but **external services still see what you send them**.

- **Local by default:** sessions, memory files, config, and workspace live on the Gateway host
  (`~/.openclaw` + your workspace directory).
- **Remote by necessity:** messages you send to model providers (Anthropic/OpenAI/etc.) go to
  their APIs, and chat platforms (WhatsApp/Telegram/Slack/etc.) store message data on their
  servers.
- **You control the footprint:** using local models keeps prompts on your machine, but channel
  traffic still goes through the channel's servers.

Related: [Agent workspace](/concepts/agent-workspace), [Memory](/concepts/memory).

### Where does OpenClaw store its data

Everything lives under `$OPENCLAW_STATE_DIR` (default: `~/.openclaw`):

| Yol                                                             | Amaç                                                                                                |
| --------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `$OPENCLAW_STATE_DIR/openclaw.json`                             | Ana yapılandırma (JSON5)                                                         |
| `$OPENCLAW_STATE_DIR/credentials/oauth.json`                    | Eski OAuth içe aktarma (ilk kullanımda kimlik doğrulama profillerine kopyalanır) |
| `$OPENCLAW_STATE_DIR/agents/<agentId>/agent/auth-profiles.json` | Kimlik doğrulama profilleri (OAuth + API anahtarları)                            |
| `$OPENCLAW_STATE_DIR/agents/<agentId>/agent/auth.json`          | Çalışma zamanı kimlik doğrulama önbelleği (otomatik olarak yönetilir)            |
| `$OPENCLAW_STATE_DIR/credentials/`                              | Sağlayıcı durumu (örn. `whatsapp/<accountId>/creds.json`)        |
| `$OPENCLAW_STATE_DIR/agents/`                                   | Ajan başına durum (agentDir + oturumlar)                                         |
| `$OPENCLAW_STATE_DIR/agents/<agentId>/sessions/`                | Konuşma geçmişi ve durum (ajan başına)                                           |
| `$OPENCLAW_STATE_DIR/agents/<agentId>/sessions/sessions.json`   | Oturum meta verileri (ajan başına)                                               |

Eski tek ajan yolu: `~/.openclaw/agent/*` (`openclaw doctor` tarafından taşınır).

**Çalışma alanınız** (AGENTS.md, bellek dosyaları, beceriler vb.) ayrıdır ve `agents.defaults.workspace` üzerinden yapılandırılır (varsayılan: `~/.openclaw/workspace`).

### AGENTSmd SOULmd USERmd MEMORYmd nerede olmalı

Bu dosyalar `~/.openclaw` altında değil, **ajan çalışma alanında** bulunur.

- **Çalışma alanı (ajan başına)**: `AGENTS.md`, `SOUL.md`, `IDENTITY.md`, `USER.md`,
  `MEMORY.md` (veya `memory.md`), `memory/YYYY-MM-DD.md`, isteğe bağlı `HEARTBEAT.md`.
- **Durum dizini (`~/.openclaw`)**: yapılandırma, kimlik bilgileri, kimlik doğrulama profilleri, oturumlar, günlükler
  ve paylaşılan beceriler (`~/.openclaw/skills`).

Default workspace is `~/.openclaw/workspace`, configurable via:

```json5
{
  agents: { defaults: { workspace: "~/.openclaw/workspace" } },
}
```

Bot yeniden başlatıldıktan sonra "unutuyorsa", Gateway'in her başlatmada aynı
çalışma alanını kullandığını doğrulayın (ve unutmayın: uzak mod **yerel dizüstü bilgisayarınızı değil**, **gateway ana makinesinin** çalışma alanını kullanır).

İpucu: Kalıcı bir davranış veya tercih istiyorsanız, sohbet geçmişine güvenmek yerine bottan **AGENTS.md veya MEMORY.md içine yazmasını** isteyin.

[Agent workspace](/concepts/agent-workspace) ve [Memory](/concepts/memory) sayfalarına bakın.

### Önerilen yedekleme stratejisi nedir

**Ajan çalışma alanınızı** **özel** bir git deposuna koyun ve bunu özel bir yerde yedekleyin
(örneğin GitHub private). Bu, bellek ile AGENTS/SOUL/USER
dosyalarını kapsar ve daha sonra asistanın "zihnini" geri yüklemenizi sağlar.

`~/.openclaw` altındaki hiçbir şeyi **commit etmeyin** (kimlik bilgileri, oturumlar, tokenlar).
Tam bir geri yükleme gerekiyorsa, hem çalışma alanını hem de durum dizinini ayrı ayrı yedekleyin (yukarıdaki taşıma sorusuna bakın).

Belgeler: [Agent workspace](/concepts/agent-workspace).

### OpenClaw'ı tamamen nasıl kaldırırım

Özel kılavuza bakın: [Uninstall](/install/uninstall).

### Ajanlar çalışma alanı dışında çalışabilir mi

Evet. Çalışma alanı **varsayılan cwd** ve bellek çıpasıdır, katı bir sandbox değildir.
Göreli yollar çalışma alanı içinde çözülür, ancak sandboxing etkin değilse mutlak yollar ana makinedeki diğer konumlara erişebilir. Yalıtım gerekiyorsa,
[`agents.defaults.sandbox`](/gateway/sandboxing) veya ajan başına sandbox ayarlarını kullanın. Bir deponun varsayılan çalışma dizini olmasını istiyorsanız, o ajanın
`workspace` ayarını depo köküne yönlendirin. The OpenClaw repo is just source code; keep the
workspace separate unless you intentionally want the agent to work inside it.

Örnek (depo varsayılan cwd olarak):

```json5
{
  agents: {
    defaults: {
      workspace: "~/Projects/my-repo",
    },
  },
}
```

### Uzak moddayım, oturum deposu nerede

Oturum durumu **gateway ana makinesine** aittir. Uzak moddaysanız, önem verdiğiniz oturum deposu yerel dizüstü bilgisayarınızda değil, uzak makinededir. [Session management](/concepts/session) sayfasına bakın.

## Yapılandırma temelleri

### Yapılandırma hangi formatta Nerede

OpenClaw, `$OPENCLAW_CONFIG_PATH` konumundan isteğe bağlı bir **JSON5** yapılandırması okur (varsayılan: `~/.openclaw/openclaw.json`):

```
$OPENCLAW_CONFIG_PATH
```

Dosya eksikse, güvenli sayılabilecek varsayılanları kullanır (varsayılan çalışma alanı olarak `~/.openclaw/workspace` dahil).

### gatewaybind lan veya tailnet ayarladım ve şimdi hiçbir şey dinlemiyor; UI yetkisiz diyor

Loopback olmayan bind'ler **kimlik doğrulama gerektirir**. `gateway.auth.mode` + `gateway.auth.token` yapılandırın (veya `OPENCLAW_GATEWAY_TOKEN` kullanın).

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

Notlar:

- `gateway.remote.token` **yalnızca uzak CLI çağrıları** içindir; yerel gateway kimlik doğrulamasını etkinleştirmez.
- Control UI, `connect.params.auth.token` üzerinden kimlik doğrular (uygulama/UI ayarlarında saklanır). Token'ları URL'lere koymaktan kaçının.

### Neden artık localhost'ta bir token'a ihtiyacım var

Sihirbaz varsayılan olarak (loopback'te bile) bir gateway token'ı üretir, bu yüzden **yerel WS istemcileri kimlik doğrulamalıdır**. Bu, diğer yerel süreçlerin Gateway'i çağırmasını engeller. Bağlanmak için token'ı Control UI ayarlarına (veya istemci yapılandırmanıza) yapıştırın.

**Gerçekten** açık loopback istiyorsanız, yapılandırmanızdan `gateway.auth` bölümünü kaldırın. Doctor istediğiniz zaman sizin için bir token üretebilir: `openclaw doctor --generate-gateway-token`.

### Yapılandırmayı değiştirdikten sonra yeniden başlatmam gerekiyor mu

Gateway yapılandırmayı izler ve sıcak yeniden yüklemeyi destekler:

- `gateway.reload.mode: "hybrid"` (varsayılan): güvenli değişiklikleri anında uygular, kritik olanlar için yeniden başlatır
- `hot`, `restart`, `off` da desteklenir

### Web arama ve web fetch'i nasıl etkinleştiririm

`web_fetch` bir API anahtarı olmadan çalışır. `web_search` bir Brave Search API anahtarı gerektirir. **Önerilen:** `tools.web.search.apiKey` altında saklamak için `openclaw configure --section web` çalıştırın. Ortam değişkeni alternatifi: Gateway süreci için `BRAVE_API_KEY` ayarlayın.

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

Notlar:

- Allowlist kullanıyorsanız, `web_search`/`web_fetch` veya `group:web` ekleyin.
- `web_fetch` varsayılan olarak etkindir (açıkça devre dışı bırakılmadıkça).
- Daemon'lar ortam değişkenlerini `~/.openclaw/.env` dosyasından (veya servis ortamından) okur.

Belgeler: [Web tools](/tools/web).

### Cihazlar arasında uzmanlaşmış worker'larla merkezi bir Gateway'i nasıl çalıştırırım

Yaygın model **tek bir Gateway** (örn. Raspberry Pi) + **node'lar** ve **agent'lar** şeklindedir:

- **Gateway (merkezi):** kanallara (Signal/WhatsApp), yönlendirmeye ve oturumlara sahiptir.
- **Node'lar (cihazlar):** Mac/iOS/Android çevre birimleri olarak bağlanır ve yerel araçları (`system.run`, `canvas`, `camera`) açığa çıkarır.
- **Agent'lar (worker'lar):** özel roller için ayrı beyinler/çalışma alanları (örn. "Hetzner ops", "Personal data").
- **Alt agent'lar:** paralellik istediğinizde ana bir agent'tan arka plan işleri başlatır.
- **TUI:** Gateway'e bağlanın ve agent/oturum değiştirin.

Dokümanlar: [Nodes](/nodes), [Remote access](/gateway/remote), [Multi-Agent Routing](/concepts/multi-agent), [Sub-agents](/tools/subagents), [TUI](/web/tui).

### OpenClaw tarayıcısı headless çalışabilir mi

Evet. Bu bir yapılandırma seçeneğidir:

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

Varsayılan `false` (headful). Headless, bazı sitelerde anti-bot kontrollerini tetikleme olasılığı daha yüksektir. [Browser](/tools/browser) bölümüne bakın.

Headless, **aynı Chromium motorunu** kullanır ve çoğu otomasyon için çalışır (formlar, tıklamalar, scraping, girişler). Başlıca farklar:

- Görünür bir tarayıcı penceresi yoktur (görsellere ihtiyacınız varsa ekran görüntülerini kullanın).
- Bazı siteler headless modda otomasyona karşı daha katıdır (CAPTCHA'lar, anti-bot).
  Örneğin, X/Twitter genellikle headless oturumları engeller.

### Tarayıcı kontrolü için Brave'i nasıl kullanırım

`browser.executablePath` değerini Brave binary'nize (veya Chromium tabanlı herhangi bir tarayıcıya) ayarlayın ve Gateway'i yeniden başlatın.
Tam yapılandırma örneklerini [Browser](/tools/browser#use-brave-or-another-chromium-based-browser) bölümünde görün.

## Uzak gateway'ler ve node'lar

### Komutlar Telegram, gateway ve node'lar arasında nasıl iletilir

1. Telegram mesajları **gateway** tarafından işlenir. 2. Gateway ajanı çalıştırır ve
   ancak bir node aracı gerektiğinde **Gateway WebSocket** üzerinden nodeları çağırır:

3. Telegram → Gateway → Agent → `node.*` → Node → Gateway → Telegram

4. Nodelar gelen sağlayıcı trafiğini görmez; yalnızca node RPC çağrılarını alırlar.

### 5. Gateway uzakta barındırılıyorsa ajanım bilgisayarıma nasıl erişebilir

Short answer: **pair your computer as a node**. 7. Gateway başka bir yerde çalışır, ancak Gateway WebSocket üzerinden yerel makinenizdeki `node.*` araçlarını (ekran, kamera, sistem) çağırabilir.

8. Tipik kurulum:

1. 9. Gateway’i her zaman açık olan bir ana makinede (VPS/ev sunucusu) çalıştırın.
2. 10. Gateway ana makinesi ile bilgisayarınızı aynı tailnet içine alın.
3. Ensure the Gateway WS is reachable (tailnet bind or SSH tunnel).
4. Open the macOS app locally and connect in **Remote over SSH** mode (or direct tailnet)
   so it can register as a node.
5. 13. Gateway üzerinde node’u onaylayın:

   ```bash
   openclaw nodes pending
   openclaw nodes approve <requestId>
   ```

14) Ayrı bir TCP köprüsü gerekmez; nodelar Gateway WebSocket üzerinden bağlanır.

15. Güvenlik hatırlatması: bir macOS node’u eşlemek o makinede `system.run` çalıştırılmasına izin verir. 16. Yalnızca güvendiğiniz cihazları
    eşleştirin ve [Security](/gateway/security) bölümünü inceleyin.

17. Dokümanlar: [Nodes](/nodes), [Gateway protocol](/gateway/protocol), [macOS remote mode](/platforms/mac/remote), [Security](/gateway/security).

### Tailscale is connected but I get no replies What now

19. Temel kontrolleri yapın:

- Gateway is running: `openclaw gateway status`
- 21. Gateway sağlık durumu: `openclaw status`
- 22. Kanal sağlık durumu: `openclaw channels status`

23. Ardından kimlik doğrulama ve yönlendirmeyi doğrulayın:

- 24. Tailscale Serve kullanıyorsanız `gateway.auth.allowTailscale` ayarının doğru olduğundan emin olun.
- 25. SSH tüneli ile bağlanıyorsanız, yerel tünelin çalıştığını ve doğru porta işaret ettiğini doğrulayın.
- 26. İzin listelerinizin (DM veya grup) hesabınızı içerdiğini doğrulayın.

27. Dokümanlar: [Tailscale](/gateway/tailscale), [Remote access](/gateway/remote), [Channels](/channels).

### 28. İki OpenClaw örneği yerel VPS’te birbirleriyle konuşabilir mi

Evet. 29. Yerleşik bir "bot-to-bot" köprüsü yoktur, ancak birkaç
güvenilir şekilde bunu bağlayabilirsiniz:

30. **En basiti:** her iki botun da erişebildiği normal bir sohbet kanalı kullanın (Telegram/Slack/WhatsApp).
31. Bot A, Bot B’ye bir mesaj gönderir, ardından Bot B her zamanki gibi yanıt verir.

32. **CLI köprüsü (genel):** diğer Gateway’i çağıran bir betik çalıştırın
    `openclaw agent --message ... 33. --deliver`, diğer botun
    dinlediği bir sohbeti hedefleyerek. 34. Botlardan biri uzak bir VPS üzerindeyse, CLI’nızı SSH/Tailscale üzerinden o uzak Gateway’e yönlendirin
    ([Remote access](/gateway/remote) bölümüne bakın).

35. Örnek desen (hedef Gateway’e erişebilen bir makineden çalıştırın):

```bash
36. openclaw agent --message "Hello from local bot" --deliver --channel telegram --reply-to <chat-id>
```

37. İpucu: iki botun sonsuz döngüye girmemesi için bir koruma ekleyin (yalnızca-mention, kanal
    izin listeleri veya "bot mesajlarına yanıt verme" kuralı).

38. Dokümanlar: [Remote access](/gateway/remote), [Agent CLI](/cli/agent), [Agent send](/tools/agent-send).

### 39. Birden fazla ajan için ayrı VPS’lere ihtiyacım var mı

Hayır. 40. Tek bir Gateway birden fazla ajan barındırabilir; her birinin kendi çalışma alanı, model varsayılanları
ve yönlendirmesi olur. 41. Bu normal kurulumdur ve
her ajan için ayrı bir VPS çalıştırmaktan çok daha ucuz ve basittir.

42. Ayrı VPS’leri yalnızca sert izolasyon (güvenlik sınırları) gerektiğinde veya
    paylaşmak istemediğiniz çok farklı yapılandırmalar olduğunda kullanın. 43. Aksi halde tek bir Gateway kullanın ve
    birden fazla ajan veya alt ajan kullanın.

### 44. Bir VPS’ten SSH kullanmak yerine kişisel dizüstü bilgisayarımda bir node kullanmanın faydası var mı

45. Evet - nodelar, uzak bir Gateway’den dizüstü bilgisayarınıza erişmenin birinci sınıf yoludur ve
    kabuk erişiminden daha fazlasını sağlar. 46. Gateway macOS/Linux’ta (Windows’ta WSL2 üzerinden) çalışır ve
    hafiftir (küçük bir VPS veya Raspberry Pi sınıfı bir cihaz yeterlidir; 4 GB RAM fazlasıyla yeterli), bu nedenle yaygın bir
    kurulum her zaman açık bir ana makine artı node olarak dizüstü bilgisayarınızdır.

- 47. **Gelen SSH gerekmez.** Nodelar Gateway WebSocket’e dışarı doğru bağlanır ve cihaz eşleştirme kullanır.
- 48. **Daha güvenli çalıştırma kontrolleri.** `system.run`, o dizüstü bilgisayardaki node izin listeleri/onayları ile sınırlandırılır.
- 49. **Daha fazla cihaz aracı.** Nodelar `system.run`’a ek olarak `canvas`, `camera` ve `screen` sunar.
- 50. **Yerel tarayıcı otomasyonu.** Gateway’i bir VPS’te tutun, ancak Chrome’u yerelde çalıştırın ve Chrome eklentisi + dizüstü bilgisayardaki bir node ana makinesi ile
      kontrolü aktarın.

SSH is fine for ad-hoc shell access, but nodes are simpler for ongoing agent workflows and
device automation.

Docs: [Nodes](/nodes), [Nodes CLI](/cli/nodes), [Chrome extension](/tools/chrome-extension).

### Should I install on a second laptop or just add a node

If you only need **local tools** (screen/camera/exec) on the second laptop, add it as a
**node**. That keeps a single Gateway and avoids duplicated config. Local node tools are
currently macOS-only, but we plan to extend them to other OSes.

Install a second Gateway only when you need **hard isolation** or two fully separate bots.

Docs: [Nodes](/nodes), [Nodes CLI](/cli/nodes), [Multiple gateways](/gateway/multiple-gateways).

### Do nodes run a gateway service

Hayır. Only **one gateway** should run per host unless you intentionally run isolated profiles (see [Multiple gateways](/gateway/multiple-gateways)). Nodes are peripherals that connect
to the gateway (iOS/Android nodes, or macOS "node mode" in the menubar app). For headless node
hosts and CLI control, see [Node host CLI](/cli/node).

A full restart is required for `gateway`, `discovery`, and `canvasHost` changes.

### Is there an API RPC way to apply config

Evet. `config.apply` validates + writes the full config and restarts the Gateway as part of the operation.

### configapply wiped my config How do I recover and avoid this

`config.apply` replaces the **entire config**. If you send a partial object, everything
else is removed.

Recover:

- Restore from backup (git or a copied `~/.openclaw/openclaw.json`).
- If you have no backup, re-run `openclaw doctor` and reconfigure channels/models.
- If this was unexpected, file a bug and include your last known config or any backup.
- A local coding agent can often reconstruct a working config from logs or history.

Avoid it:

- Use `openclaw config set` for small changes.
- Use `openclaw configure` for interactive edits.

Docs: [Config](/cli/config), [Configure](/cli/configure), [Doctor](/gateway/doctor).

### What's a minimal sane config for a first install

```json5
{
  agents: { defaults: { workspace: "~/.openclaw/workspace" } },
  channels: { whatsapp: { allowFrom: ["+15555550123"] } },
}
```

This sets your workspace and restricts who can trigger the bot.

### How do I set up Tailscale on a VPS and connect from my Mac

Minimal steps:

1. **Install + login on the VPS**

   ```bash
   curl -fsSL https://tailscale.com/install.sh | sh
   sudo tailscale up
   ```

2. **Install + login on your Mac**
   - Use the Tailscale app and sign in to the same tailnet.

3. **Enable MagicDNS (recommended)**
   - In the Tailscale admin console, enable MagicDNS so the VPS has a stable name.

4. **Use the tailnet hostname**
   - SSH: `ssh user@your-vps.tailnet-xxxx.ts.net`
   - Gateway WS: `ws://your-vps.tailnet-xxxx.ts.net:18789`

If you want the Control UI without SSH, use Tailscale Serve on the VPS:

```bash
openclaw gateway --tailscale serve
```

This keeps the gateway bound to loopback and exposes HTTPS via Tailscale. See [Tailscale](/gateway/tailscale).

### How do I connect a Mac node to a remote Gateway Tailscale Serve

Serve exposes the **Gateway Control UI + WS**. Nodes connect over the same Gateway WS endpoint.

Recommended setup:

1. **Make sure the VPS + Mac are on the same tailnet**.
2. **Use the macOS app in Remote mode** (SSH target can be the tailnet hostname).
   The app will tunnel the Gateway port and connect as a node.
3. **Approve the node** on the gateway:

   ```bash
   openclaw nodes pending
   openclaw nodes approve <requestId>
   ```

Docs: [Gateway protocol](/gateway/protocol), [Discovery](/gateway/discovery), [macOS remote mode](/platforms/mac/remote).

## Env vars and .env loading

### How does OpenClaw load environment variables

OpenClaw reads env vars from the parent process (shell, launchd/systemd, CI, etc.) and additionally loads:

- `.env` from the current working directory
- `~/.openclaw/.env`’den küresel bir yedek `.env` (diğer adıyla `$OPENCLAW_STATE_DIR/.env`)

Bu `.env` dosyalarının hiçbiri mevcut ortam değişkenlerini geçersiz kılmaz.

You can also define inline env vars in config (applied only if missing from the process env):

```json5
{
  env: {
    OPENROUTER_API_KEY: "sk-or-...",
    vars: { GROQ_API_KEY: "gsk-..." },
  },
}
```

Tam öncelik ve kaynaklar için [/environment](/help/environment) sayfasına bakın.

### I started the Gateway via the service and my env vars disappeared What now

Two common fixes:

1. Put the missing keys in `~/.openclaw/.env` so they're picked up even when the service doesn't inherit your shell env.
2. Enable shell import (opt-in convenience):

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

This runs your login shell and imports only missing expected keys (never overrides). Env var equivalents:
`OPENCLAW_LOAD_SHELL_ENV=1`, `OPENCLAW_SHELL_ENV_TIMEOUT_MS=15000`.

### I set COPILOTGITHUBTOKEN but models status shows Shell env off Why

`openclaw models status` reports whether **shell env import** is enabled. "Shell env: off"
does **not** mean your env vars are missing - it just means OpenClaw won't load
your login shell automatically.

If the Gateway runs as a service (launchd/systemd), it won't inherit your shell
environment. Fix by doing one of these:

1. Put the token in `~/.openclaw/.env`:

   ```
   COPILOT_GITHUB_TOKEN=...
   ```

2. Or enable shell import (`env.shellEnv.enabled: true`).

3. Or add it to your config `env` block (applies only if missing).

Then restart the gateway and recheck:

```bash
openclaw models status
```

Copilot tokens are read from `COPILOT_GITHUB_TOKEN` (also `GH_TOKEN` / `GITHUB_TOKEN`).
See [/concepts/model-providers](/concepts/model-providers) and [/environment](/help/environment).

## Sessions and multiple chats

### How do I start a fresh conversation

Send `/new` or `/reset` as a standalone message. See [Session management](/concepts/session).

### Do sessions reset automatically if I never send new

Evet. Sessions expire after `session.idleMinutes` (default **60**). The **next**
message starts a fresh session id for that chat key. This does not delete
transcripts - it just starts a new session.

```json5
{
  session: {
    idleMinutes: 240,
  },
}
```

### Is there a way to make a team of OpenClaw instances one CEO and many agents

Yes, via **multi-agent routing** and **sub-agents**. You can create one coordinator
agent and several worker agents with their own workspaces and models.

That said, this is best seen as a **fun experiment**. It is token heavy and often
less efficient than using one bot with separate sessions. The typical model we
envision is one bot you talk to, with different sessions for parallel work. That
bot can also spawn sub-agents when needed.

Docs: [Multi-agent routing](/concepts/multi-agent), [Sub-agents](/tools/subagents), [Agents CLI](/cli/agents).

### Why did context get truncated midtask How do I prevent it

Session context is limited by the model window. Long chats, large tool outputs, or many
files can trigger compaction or truncation.

What helps:

- Ask the bot to summarize the current state and write it to a file.
- Use `/compact` before long tasks, and `/new` when switching topics.
- Keep important context in the workspace and ask the bot to read it back.
- Use sub-agents for long or parallel work so the main chat stays smaller.
- Pick a model with a larger context window if this happens often.

### How do I completely reset OpenClaw but keep it installed

Use the reset command:

```bash
openclaw reset
```

Non-interactive full reset:

```bash
openclaw reset --scope full --yes --non-interactive
```

Then re-run onboarding:

```bash
openclaw onboard --install-daemon
```

Notlar:

- The onboarding wizard also offers **Reset** if it sees an existing config. See [Wizard](/start/wizard).
- If you used profiles (`--profile` / `OPENCLAW_PROFILE`), reset each state dir (defaults are `~/.openclaw-<profile>`).
- Dev reset: `openclaw gateway --dev --reset` (dev-only; wipes dev config + credentials + sessions + workspace).

### Im getting context too large errors how do I reset or compact

Bunlardan birini kullanın:

- **Compact** (keeps the conversation but summarizes older turns):

  ```
  /compact
  ```

  or `/compact <instructions>` to guide the summary.

- **Reset** (fresh session ID for the same chat key):

  ```
  /new
  /reset
  ```

If it keeps happening:

- Enable or tune **session pruning** (`agents.defaults.contextPruning`) to trim old tool output.
- Use a model with a larger context window.

Docs: [Compaction](/concepts/compaction), [Session pruning](/concepts/session-pruning), [Session management](/concepts/session).

### Why am I seeing LLM request rejected messagesNcontentXtooluseinput Field required

This is a provider validation error: the model emitted a `tool_use` block without the required
`input`. It usually means the session history is stale or corrupted (often after long threads
or a tool/schema change).

Fix: start a fresh session with `/new` (standalone message).

### Why am I getting heartbeat messages every 30 minutes

Heartbeats run every **30m** by default. Tune or disable them:

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

`HEARTBEAT.md` varsa ancak fiilen boşsa (yalnızca boş satırlar ve
`# Heading` gibi markdown başlıkları içeriyorsa), OpenClaw API çağrılarını
kurtarmak için heartbeat çalıştırmasını atlar.
Dosya yoksa, heartbeat yine çalışır ve model ne yapacağına karar verir.

Per-agent overrides use `agents.list[].heartbeat`. Docs: [Heartbeat](/gateway/heartbeat).

### Do I need to add a bot account to a WhatsApp group

Hayır. OpenClaw runs on **your own account**, so if you're in the group, OpenClaw can see it.
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

### How do I get the JID of a WhatsApp group

Option 1 (fastest): tail logs and send a test message in the group:

```bash
openclaw logs --follow --json
```

Look for `chatId` (or `from`) ending in `@g.us`, like:
`1234567890-1234567890@g.us`.

Option 2 (if already configured/allowlisted): list groups from config:

```bash
openclaw directory groups list --channel whatsapp
```

Docs: [WhatsApp](/channels/whatsapp), [Directory](/cli/directory), [Logs](/cli/logs).

### Why doesnt OpenClaw reply in a group

Two common causes:

- Mention gating is on (default). You must @mention the bot (or match `mentionPatterns`).
- You configured `channels.whatsapp.groups` without `"*"` and the group isn't allowlisted.

See [Groups](/channels/groups) and [Group messages](/channels/group-messages).

### 1. Grup iş parçacıkları DM’lerle bağlam paylaşır mı

2. Doğrudan sohbetler varsayılan olarak ana oturuma daraltılır. 3. Gruplar/kanalların kendi oturum anahtarları vardır ve Telegram konuları / Discord iş parçacıkları ayrı oturumlardır. 4. [Gruplar](/channels/groups) ve [Grup mesajları](/channels/group-messages) bölümlerine bakın.

### 5. Kaç tane çalışma alanı ve ajan oluşturabilirim

6. Katı sınırlar yok. 7. Onlarca (hatta yüzlercesi) sorun olmaz, ancak şunlara dikkat edin:

- 8. **Disk büyümesi:** oturumlar + dökümler `~/.openclaw/agents/<agentId>/sessions/` altında tutulur.
- 9. **Token maliyeti:** daha fazla ajan, daha fazla eşzamanlı model kullanımı demektir.
- 10. **Operasyonel yük:** ajan başına kimlik doğrulama profilleri, çalışma alanları ve kanal yönlendirmesi.

İpuçları:

- 11. Ajan başına bir **aktif** çalışma alanı tutun (`agents.defaults.workspace`).
- 12. Disk büyürse eski oturumları budayın (JSONL veya store girdilerini silin).
- 13. Dağınık çalışma alanlarını ve profil uyumsuzluklarını tespit etmek için `openclaw doctor` kullanın.

### 14. Aynı anda birden fazla bot veya sohbeti Slack’te çalıştırabilir miyim ve bunu nasıl kurmalıyım

Evet. 15. Birden fazla izole ajan çalıştırmak ve gelen mesajları kanal/hesap/akran bazında yönlendirmek için **Çoklu Ajan Yönlendirme** kullanın. 16. Slack bir kanal olarak desteklenir ve belirli ajanlara bağlanabilir.

17. Tarayıcı erişimi güçlüdür ancak “bir insanın yapabildiği her şeyi yapar” değildir — anti-botlar, CAPTCHA’lar ve MFA otomasyonu yine de engelleyebilir. 18. En güvenilir tarayıcı kontrolü için, tarayıcının çalıştığı makinede Chrome uzantısı rölesini kullanın (Gateway’i ise herhangi bir yerde tutabilirsiniz).

19. En iyi uygulama kurulumu:

- 20. Her zaman açık bir Gateway sunucusu (VPS/Mac mini).
- 21. Rol başına bir ajan (bağlamalar).
- 22. Bu ajanlara bağlanmış Slack kanalı/kanalları.
- 23. Gerektiğinde uzantı rölesi (veya bir düğüm) üzerinden yerel tarayıcı.

24. Dokümanlar: [Çoklu Ajan Yönlendirme](/concepts/multi-agent), [Slack](/channels/slack),
    [Tarayıcı](/tools/browser), [Chrome uzantısı](/tools/chrome-extension), [Düğümler](/nodes).

## 25. Modeller: varsayılanlar, seçim, takma adlar, geçiş

### 26. Varsayılan model nedir

27. OpenClaw’ın varsayılan modeli, aşağıdaki şekilde ayarladığınız modeldir:

```
agents.defaults.model.primary
```

28. Modeller `provider/model` olarak referanslanır (örnek: `anthropic/claude-opus-4-6`). 29. Sağlayıcıyı atladığınızda OpenClaw şu anda geçici bir kullanım dışı bırakma geri dönüşü olarak `anthropic` varsayar — ancak yine de `provider/model`i **açıkça** ayarlamalısınız.

### 30. Hangi modeli önerirsiniz

31. **Önerilen varsayılan:** `anthropic/claude-opus-4-6`.
32. **İyi alternatif:** `anthropic/claude-sonnet-4-5`.
33. **Güvenilir (daha az karakter):** `openai/gpt-5.2` — Opus’a neredeyse eşdeğer, sadece kişiliği daha az.
34. **Bütçe:** `zai/glm-4.7`.

35. MiniMax M2.1’in kendi dokümanları vardır: [MiniMax](/providers/minimax) ve
    [Yerel modeller](/gateway/local-models).

36. Pratik kural: yüksek riskli işler için **karşılayabildiğiniz en iyi modeli**, rutin sohbet veya özetler için daha ucuz bir modeli kullanın. 37. Modelleri ajan bazında yönlendirebilir ve uzun görevleri paralelleştirmek için alt ajanlar kullanabilirsiniz (her alt ajan token tüketir). 38. [Modeller](/concepts/models) ve
    [Alt ajanlar](/tools/subagents) bölümlerine bakın.

39. Güçlü uyarı: daha zayıf/aşırı kuantize edilmiş modeller, prompt enjeksiyonu ve güvensiz davranışlara daha açıktır. 40. [Güvenlik](/gateway/security) bölümüne bakın.

41. Daha fazla bağlam: [Modeller](/concepts/models).

### 42. Kendi barındırdığım modelleri llamacpp vLLM Ollama ile kullanabilir miyim

Evet. 43. Yerel sunucunuz OpenAI uyumlu bir API sunuyorsa, ona özel bir sağlayıcı yönlendirebilirsiniz. 44. Ollama doğrudan desteklenir ve en kolay yoldur.

45. Güvenlik notu: daha küçük veya yoğun şekilde kuantize edilmiş modeller, prompt enjeksiyonuna daha açıktır. 46. Araç kullanabilen herhangi bir bot için **büyük modelleri** şiddetle öneririz.
46. Yine de küçük modeller istiyorsanız, sandboxing’i ve katı araç izin listelerini etkinleştirin.

48. Dokümanlar: [Ollama](/providers/ollama), [Yerel modeller](/gateway/local-models),
    [Model sağlayıcıları](/concepts/model-providers), [Güvenlik](/gateway/security),
    [Sandboxing](/gateway/sandboxing).

### 49. Yapılandırmamı silmeden modelleri nasıl değiştiririm

50. **Model komutlarını** kullanın veya yalnızca **model** alanlarını düzenleyin. 1. Tam yapılandırma değişimlerinden kaçının.

2. Güvenli seçenekler:

- 3. Sohbette `/model` (hızlı, oturum bazlı)
- 4. `openclaw models set ...` (yalnızca model yapılandırmasını günceller)
- 5. `openclaw configure --section model` (etkileşimli)
- 6. `~/.openclaw/openclaw.json` içindeki `agents.defaults.model` değerini düzenleyin

7. Tüm yapılandırmayı değiştirmeyi özellikle istemiyorsanız, kısmi bir nesneyle `config.apply` kullanmaktan kaçının.
8. Yapılandırmayı yanlışlıkla üzerine yazdıysanız, yedekten geri yükleyin veya onarmak için `openclaw doctor` komutunu yeniden çalıştırın.

9. Dokümanlar: [Models](/concepts/models), [Configure](/cli/configure), [Config](/cli/config), [Doctor](/gateway/doctor).

### 10. OpenClaw, Flawd ve Krill modeller için ne kullanıyor

- 11. **OpenClaw + Flawd:** Anthropic Opus (`anthropic/claude-opus-4-6`) - bkz. [Anthropic](/providers/anthropic).
- 12. **Krill:** MiniMax M2.1 (`minimax/MiniMax-M2.1`) - bkz. [MiniMax](/providers/minimax).

### 13. Yeniden başlatmadan anında model nasıl değiştiririm

14. `/model` komutunu tek başına bir mesaj olarak kullanın:

```
15. /model sonnet
/model haiku
/model opus
/model gpt
/model gpt-mini
/model gemini
/model gemini-flash
```

16. Kullanılabilir modelleri `/model`, `/model list` veya `/model status` ile listeleyebilirsiniz.

17. `/model` (ve `/model list`) kompakt, numaralı bir seçici gösterir. 18. Numara ile seçin:

```
19. /model 3
```

You can also force a specific auth profile for the provider (per session):

```
21. /model opus@anthropic:default
/model opus@anthropic:work
```

Tip: `/model status` shows which agent is active, which `auth-profiles.json` file is being used, and which auth profile will be tried next.
23. Ayrıca yapılandırılmış sağlayıcı uç noktasını (`baseUrl`) ve mevcutsa API modunu (`api`) da gösterir.

24. **Profil ile ayarladığım bir profili nasıl sabitlikten çıkarırım**

25. `@profile` soneki **olmadan** `/model` komutunu yeniden çalıştırın:

```
26. /model anthropic/claude-opus-4-6
```

27. Varsayılan ayara dönmek istiyorsanız, `/model` içinden varsayılanı seçin (veya `/model <varsayılan sağlayıcı/model>` gönderin).
28. Hangi kimlik doğrulama profilinin aktif olduğunu doğrulamak için `/model status` kullanın.

### 29. Günlük işler için GPT 5.2’yi ve kodlama için Codex 5.3’ü kullanabilir miyim

Evet. 30. Birini varsayılan yapın ve gerektiğinde değiştirin:

- 31. **Hızlı geçiş (oturum bazında):** günlük işler için `/model gpt-5.2`, kodlama için `/model gpt-5.3-codex`.
- 32. **Varsayılan + geçiş:** `agents.defaults.model.primary` değerini `openai/gpt-5.2` olarak ayarlayın, ardından kodlama yaparken `openai-codex/gpt-5.3-codex` modeline geçin (veya tam tersi).
- 33. **Alt ajanlar:** kodlama görevlerini farklı bir varsayılan modele sahip alt ajanlara yönlendirin.

34. Bkz. [Models](/concepts/models) ve [Slash commands](/tools/slash-commands).

### 35. Neden “Model is not allowed” görüyorum ve ardından yanıt gelmiyor

36. `agents.defaults.models` ayarlıysa, `/model` ve tüm oturum geçersiz kılmaları için **izin listesi** haline gelir. 37. Bu listede olmayan bir model seçmek şu yanıtı döndürür:

```
Model "provider/model" is not allowed. Use /model to list available models.
```

38. Bu hata, normal bir yanıt **yerine** döndürülür. 39. Düzeltme: modeli `agents.defaults.models` listesine ekleyin, izin listesini kaldırın veya `/model list` içinden bir model seçin.

### 40. Neden “Unknown model minimaxMiniMaxM21” görüyorum

41. Bu, **sağlayıcının yapılandırılmadığı** (MiniMax sağlayıcı yapılandırması veya kimlik doğrulama profili bulunamadığı) anlamına gelir; dolayısıyla model çözümlenemiyor. 42. Bu algılama için bir düzeltme **2026.1.12** sürümünde (yazım sırasında yayımlanmamış) bulunmaktadır.

43. Düzeltme kontrol listesi:

1. 44. **2026.1.12** sürümüne yükseltin (veya kaynaktan `main` çalıştırın), ardından ağ geçidini yeniden başlatın.
2. 45. MiniMax’in yapılandırıldığından (sihirbaz veya JSON) emin olun ya da sağlayıcının enjekte edilebilmesi için ortam/kimlik doğrulama profillerinde bir MiniMax API anahtarı bulunduğunu doğrulayın.
3. 46. Tam model kimliğini kullanın (büyük/küçük harfe duyarlı): `minimax/MiniMax-M2.1` veya
       `minimax/MiniMax-M2.1-lightning`.
4. Run:

   ```bash
   openclaw models list
   ```

   47. ve listeden seçin (veya sohbette `/model list`).

48) Bkz. [MiniMax](/providers/minimax) ve [Models](/concepts/models).

### 49. MiniMax’i varsayılan olarak kullanıp karmaşık görevler için OpenAI’ye geçebilir miyim

Evet. 50. **MiniMax’i varsayılan** olarak kullanın ve gerektiğinde modelleri **oturum bazında** değiştirin.1) Fallback’ler **hatalar** içindir, "zor görevler" için değil; bu yüzden `/model` kullanın veya ayrı bir ajan kullanın.

2. **Seçenek A: oturum başına geçiş**

```json5
3. {
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

Ardından:

```
4. /model gpt
```

5. **Seçenek B: ayrı ajanlar**

- 6. Ajan A varsayılanı: MiniMax
- 7. Ajan B varsayılanı: OpenAI
- Route by agent or use `/agent` to switch

9. Dokümanlar: [Models](/concepts/models), [Multi-Agent Routing](/concepts/multi-agent), [MiniMax](/providers/minimax), [OpenAI](/providers/openai).

### 10. opus sonnet gpt yerleşik kısayollar mı

Evet. 11. OpenClaw birkaç varsayılan kısaltma ile gelir (yalnızca model `agents.defaults.models` içinde mevcutsa uygulanır):

- 12. `opus` → `anthropic/claude-opus-4-6`
- 13. `sonnet` → `anthropic/claude-sonnet-4-5`
- 14. `gpt` → `openai/gpt-5.2`
- 15. `gpt-mini` → `openai/gpt-5-mini`
- 16. `gemini` → `google/gemini-3-pro-preview`
- 17. `gemini-flash` → `google/gemini-3-flash-preview`

18. Aynı adla kendi takma adınızı ayarlarsanız, sizin değeriniz geçerli olur.

### 19. Model kısayol takma adlarını nasıl tanımlarım/geçersiz kılarım

20. Takma adlar `agents.defaults.models.<modelId>` yolundan gelir21. `.alias`. Örnek:

```json5
22. {
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

23. Ardından `/model sonnet` (veya desteklendiğinde `/<alias>`) o model kimliğine çözülür.

### 24. OpenRouter veya ZAI gibi diğer sağlayıcılardan modelleri nasıl eklerim

25. OpenRouter (token başına ödeme; birçok model):

```json5
26. {
  agents: {
    defaults: {
      model: { primary: "openrouter/anthropic/claude-sonnet-4-5" },
      models: { "openrouter/anthropic/claude-sonnet-4-5": {} },
    },
  },
  env: { OPENROUTER_API_KEY: "sk-or-..." },
}
```

27. Z.AI (GLM modelleri):

```json5
28. {
  agents: {
    defaults: {
      model: { primary: "zai/glm-4.7" },
      models: { "zai/glm-4.7": {} },
    },
  },
  env: { ZAI_API_KEY: "..." },
}
```

29. Bir sağlayıcı/model referansı verirseniz ancak gerekli sağlayıcı anahtarı eksikse, çalışma zamanı kimlik doğrulama hatası alırsınız (örn. `No API key found for provider "zai"`).

30. **Yeni bir ajan ekledikten sonra sağlayıcı için API anahtarı bulunamadı**

31. Bu genellikle **yeni ajanın** boş bir kimlik doğrulama deposuna sahip olduğu anlamına gelir. 32. Kimlik doğrulama ajan başınadır ve
    şurada saklanır:

```
~/.openclaw/agents/<agentId>/agent/auth-profiles.json
```

Düzeltme seçenekleri:

- 33. `openclaw agents add <id>` komutunu çalıştırın ve sihirbaz sırasında kimlik doğrulamayı yapılandırın.
- 34. Veya ana ajanın `agentDir` dizinindeki `auth-profiles.json` dosyasını yeni ajanın `agentDir` dizinine kopyalayın.

35. Ajanlar arasında `agentDir`’i **yeniden kullanmayın**; kimlik doğrulama/oturum çakışmalarına yol açar.

## 36. Model devretme (failover) ve "Tüm modeller başarısız oldu"

### 37. Failover nasıl çalışır

38. Failover iki aşamada gerçekleşir:

1. 39. Aynı sağlayıcı içinde **kimlik doğrulama profili rotasyonu**.
2. `agents.defaults.model.fallbacks` içindeki bir sonraki modele **model geri dönüşü**.

40) Başarısız olan profillere bekleme süreleri uygulanır (üstel geri çekilme), böylece OpenClaw bir sağlayıcı hız sınırına takıldığında veya geçici olarak arızalıyken bile yanıt vermeye devam edebilir.

### 41. Bu hata ne anlama geliyor

```
42. Profil için kimlik bilgisi bulunamadı: "anthropic:default"
```

43. Bu, sistemin `anthropic:default` kimlik doğrulama profili kimliğini kullanmaya çalıştığı ancak beklenen kimlik doğrulama deposunda bunun için kimlik bilgisi bulamadığı anlamına gelir.

### 44. anthropicdefault profili için kimlik bilgisi bulunamadı hatası için düzeltme kontrol listesi

- 45. **Kimlik doğrulama profillerinin nerede bulunduğunu doğrulayın** (yeni ve eski yollar)
  - 46. Güncel: `~/.openclaw/agents/<agentId>/agent/auth-profiles.json`
  - 47. Eski: `~/.openclaw/agent/*` (`openclaw doctor` tarafından taşınır)
- 48. **Ortam değişkeninizin Gateway tarafından yüklendiğini doğrulayın**
  - 49. `ANTHROPIC_API_KEY`’i kabuğunuzda ayarladıysanız ancak Gateway’i systemd/launchd üzerinden çalıştırıyorsanız, bunu devralmayabilir. 50. `~/.openclaw/.env` dosyasına koyun veya `env.shellEnv`’i etkinleştirin.
- **Make sure you're editing the correct agent**
  - Multi-agent setups mean there can be multiple `auth-profiles.json` files.
- **Sanity-check model/auth status**
  - Use `openclaw models status` to see configured models and whether providers are authenticated.

**Fix checklist for No credentials found for profile anthropic**

This means the run is pinned to an Anthropic auth profile, but the Gateway
can't find it in its auth store.

- **Use a setup-token**
  - Run `claude setup-token`, then paste it with `openclaw models auth setup-token --provider anthropic`.
  - If the token was created on another machine, use `openclaw models auth paste-token --provider anthropic`.

- **If you want to use an API key instead**
  - Put `ANTHROPIC_API_KEY` in `~/.openclaw/.env` on the **gateway host**.
  - Clear any pinned order that forces a missing profile:

    ```bash
    openclaw models auth order clear --provider anthropic
    ```

- **Confirm you're running commands on the gateway host**
  - In remote mode, auth profiles live on the gateway machine, not your laptop.

### Why did it also try Google Gemini and fail

If your model config includes Google Gemini as a fallback (or you switched to a Gemini shorthand), OpenClaw will try it during model fallback. If you haven't configured Google credentials, you'll see `No API key found for provider "google"`.

Fix: either provide Google auth, or remove/avoid Google models in `agents.defaults.model.fallbacks` / aliases so fallback doesn't route there.

**LLM request rejected message thinking signature required google antigravity**

Cause: the session history contains **thinking blocks without signatures** (often from
an aborted/partial stream). Google Antigravity requires signatures for thinking blocks.

Fix: OpenClaw now strips unsigned thinking blocks for Google Antigravity Claude. If it still appears, start a **new session** or set `/thinking off` for that agent.

## Auth profiles: what they are and how to manage them

Related: [/concepts/oauth](/concepts/oauth) (OAuth flows, token storage, multi-account patterns)

### What is an auth profile

An auth profile is a named credential record (OAuth or API key) tied to a provider. Profiles live in:

```
~/.openclaw/agents/<agentId>/agent/auth-profiles.json
```

### What are typical profile IDs

OpenClaw uses provider-prefixed IDs like:

- `anthropic:default` (common when no email identity exists)
- `anthropic:<email>` for OAuth identities
- custom IDs you choose (e.g. `anthropic:work`)

### Can I control which auth profile is tried first

Evet. Config supports optional metadata for profiles and an ordering per provider (`auth.order.<provider>`). This does **not** store secrets; it maps IDs to provider/mode and sets rotation order.

OpenClaw may temporarily skip a profile if it's in a short **cooldown** (rate limits/timeouts/auth failures) or a longer **disabled** state (billing/insufficient credits). To inspect this, run `openclaw models status --json` and check `auth.unusableProfiles`. Tuning: `auth.cooldowns.billingBackoffHours*`.

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

To target a specific agent:

```bash
openclaw models auth order set --provider anthropic --agent main anthropic:default
```

### OAuth vs API key whats the difference

OpenClaw supports both:

- **OAuth** often leverages subscription access (where applicable).
- **API keys** use pay-per-token billing.

The wizard explicitly supports Anthropic setup-token and OpenAI Codex OAuth and can store API keys for you.

## 1. Gateway: portlar, "zaten çalışıyor" ve uzak mod

### 2. Gateway hangi portu kullanır

`gateway.port`, WebSocket + HTTP (Kontrol UI, hook'lar vb.) için tek, çoklanmış portu kontrol eder.

Öncelik sırası:

```
--port > OPENCLAW_GATEWAY_PORT > gateway.port > varsayılan 18789
```

### 5. openclaw gateway status neden Runtime running diyor ama RPC probe failed

6. Çünkü "running", **denetleyicinin** (launchd/systemd/schtasks) bakış açısıdır. 7. RPC probe, CLI'nin gerçekten gateway WebSocket'ine bağlanıp `status` çağırmasıdır.

8. `openclaw gateway status` kullanın ve şu satırlara güvenin:

- 9. `Probe target:` (probe'un gerçekten kullandığı URL)
- 10. `Listening:` (portta gerçekte neyin dinlediği)
- 11. `Last gateway error:` (işlem hayattayken ama port dinlemediğinde yaygın kök neden)

### 12. openclaw gateway status neden Config cli ve Config service farklı gösteriyor

13. Servis başka bir yapılandırmayı çalıştırırken siz başka bir config dosyasını düzenliyorsunuz (çoğunlukla `--profile` / `OPENCLAW_STATE_DIR` uyumsuzluğu).

Fix:

```bash
14. openclaw gateway install --force
```

15. Bunu, servisin kullanmasını istediğiniz aynı `--profile` / ortamdan çalıştırın.

### 16. başka bir gateway örneği zaten dinliyor ne demek

17. OpenClaw, başlatılır başlatılmaz WebSocket dinleyicisini bağlayarak bir çalışma kilidi uygular (varsayılan `ws://127.0.0.1:18789`). 18. Bağlama işlemi `EADDRINUSE` ile başarısız olursa, başka bir örneğin zaten dinlediğini belirten `GatewayLockError` fırlatır.

19. Çözüm: diğer örneği durdurun, portu boşaltın veya `openclaw gateway --port <port>` ile çalıştırın.

### 20. OpenClaw'ı uzak modda nasıl çalıştırırım, istemci başka bir yerdeki Gateway'e bağlansın

21. `gateway.mode: "remote"` ayarlayın ve isteğe bağlı token/şifre ile uzak bir WebSocket URL'si belirtin:

```json5
22. {
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

Notlar:

- 23. `openclaw gateway` yalnızca `gateway.mode` `local` olduğunda (veya geçersiz kılma bayrağı verdiğinizde) başlar.
- 24. macOS uygulaması yapılandırma dosyasını izler ve bu değerler değiştiğinde canlı olarak mod değiştirir.

### 25. Kontrol UI yetkisiz diyor veya sürekli yeniden bağlanıyor Şimdi ne olacak

26. Gateway'iniz kimlik doğrulama etkin (`gateway.auth.*`) şekilde çalışıyor, ancak UI eşleşen token/şifreyi göndermiyor.

27. Gerçekler (koddan):

- 28. Kontrol UI token'ı tarayıcı localStorage anahtarı `openclaw.control.settings.v1` içinde saklar.

Fix:

- 29. En hızlısı: `openclaw dashboard` (dashboard URL'sini yazdırır + kopyalar, açmayı dener; headless ise SSH ipucu gösterir).
- 30. Henüz token'ınız yoksa: `openclaw doctor --generate-gateway-token`.
- 31. Uzaktaysa, önce tünel açın: `ssh -N -L 18789:127.0.0.1:18789 user@host` sonra `http://127.0.0.1:18789/` açın.
- 32. Gateway ana makinesinde `gateway.auth.token` (veya `OPENCLAW_GATEWAY_TOKEN`) ayarlayın.
- 33. Kontrol UI ayarlarında aynı token'ı yapıştırın.
- Hâlâ takıldınız mı? 34. `openclaw status --all` çalıştırın ve [Troubleshooting](/gateway/troubleshooting) bölümünü izleyin. 35. Kimlik doğrulama ayrıntıları için [Dashboard](/web/dashboard) sayfasına bakın.

### 36. gatewaybind tailnet ayarladım ama bağlanamıyor, hiçbir şey dinlemiyor

37. `tailnet` bind, ağ arayüzlerinizden bir Tailscale IP'si seçer (100.64.0.0/10). 38. Makine Tailscale'de değilse (veya arayüz kapalıysa), bağlanacak bir şey yoktur.

Fix:

- 39. O ana makinede Tailscale'i başlatın (böylece bir 100.x adresi olsun) veya
- 40. `gateway.bind: "loopback"` / `"lan"` kullanın.

41. Not: `tailnet` açıkça belirtilmelidir. 42. `auto` loopback'i tercih eder; yalnızca tailnet'e bağlanmak istediğinizde `gateway.bind: "tailnet"` kullanın.

### 43. Aynı ana makinede birden fazla Gateway çalıştırabilir miyim

44. Genellikle hayır - tek bir Gateway birden fazla mesajlaşma kanalı ve ajan çalıştırabilir. 45. Birden fazla Gateway'i yalnızca yedeklilik (ör: kurtarma botu) veya katı izolasyon gerektiğinde kullanın.

46. Evet, ama izole etmelisiniz:

- 47. `OPENCLAW_CONFIG_PATH` (örnek başına config)
- 48. `OPENCLAW_STATE_DIR` (örnek başına durum)
- 49. `agents.defaults.workspace` (çalışma alanı izolasyonu)
- 50. `gateway.port` (benzersiz portlar)

Her örnek için `openclaw --profile <name> …` kullanın (`~/.openclaw-<name>` otomatik oluşturulur).

- Use `openclaw --profile <name> …` per instance (auto-creates `~/.openclaw-<name>`).
- Profil başına bir servis kurun: `openclaw --profile <name> gateway install`.
- Profiller ayrıca servis adlarına sonek ekler (\`bot.molt.<profile>

; eski `com.openclaw.*`, `openclaw-gateway-<profile>.service`, `OpenClaw Gateway (<profile>)`).Geçersiz el sıkışma kodu 1008 ne anlama gelir
Tam kılavuz: [Birden fazla gateway](/gateway/multiple-gateways).

### Gateway bir **WebSocket sunucusudur** ve ilk mesajın mutlaka bir `connect` çerçevesi olmasını bekler.

Başka bir şey alırsa, bağlantıyı **1008 kodu** (ilke ihlali) ile kapatır. **HTTP** URL’sini bir tarayıcıda açtınız (`http://...`), bir WS istemcisi yerine.

Yaygın nedenler:

- Yanlış portu veya yolu kullandınız.
- Bir proxy veya tünel kimlik doğrulama başlıklarını kaldırdı ya da Gateway olmayan bir istek gönderdi.
- Hızlı çözümler:

WS URL’sini kullanın: `ws://<host>:18789` (veya HTTPS ise `wss://...`).

1. WS portunu normal bir tarayıcı sekmesinde açmayın.
2. Kimlik doğrulama açıksa, `connect` çerçevesine token/parolayı ekleyin.
3. CLI veya TUI kullanıyorsanız, URL şöyle görünmelidir:

openclaw tui --url ws://<host>:18789 --token <token>

```
Günlükleme ve hata ayıklama
```

Protokol ayrıntıları: [Gateway protocol](/gateway/protocol).

## Günlükler nerede

### Dosya günlükleri (yapılandırılmış):

`logging.file` ile sabit bir yol ayarlayabilirsiniz.

```
/tmp/openclaw/openclaw-YYYY-MM-DD.log
```

Dosya günlük seviyesi `logging.level` ile kontrol edilir. Konsol ayrıntı düzeyi `--verbose` ve `logging.consoleLevel` ile kontrol edilir. En hızlı günlük takibi:

Servis/denetleyici günlükleri (gateway launchd/systemd ile çalıştığında):

```bash
openclaw logs --follow
```

macOS: `$OPENCLAW_STATE_DIR/logs/gateway.log` ve `gateway.err.log` (varsayılan: `~/.openclaw/logs/...`; profiller `~/.openclaw-<profile>/logs/...` kullanır)

- Linux: `journalctl --user -u openclaw-gateway[-<profile>].service -n 200 --no-pager`
- Windows: `schtasks /Query /TN "OpenClaw Gateway (<profile>)" /V /FO LIST`
- Daha fazlası için [Sorun Giderme](/gateway/troubleshooting#log-locations) bölümüne bakın.

Gateway servisini nasıl başlatırım/durdururum/yeniden başlatırım

### Gateway yardımcılarını kullanın:

openclaw gateway status
openclaw gateway restart

```bash
Gateway’i manuel çalıştırıyorsanız, `openclaw gateway --force` portu geri alabilir.
```

Windows’ta terminalimi kapattım, OpenClaw’ı nasıl yeniden başlatırım [Gateway](/gateway) bölümüne bakın.

### **İki Windows kurulum modu** vardır:

**1) WSL2 (önerilen):** Gateway Linux içinde çalışır.

PowerShell’i açın, WSL’e girin, sonra yeniden başlatın:

wsl
openclaw gateway status
openclaw gateway restart

```powershell
Servisi hiç kurmadıysanız, ön planda başlatın:
```

**2) Yerel Windows (önerilmez):** Gateway doğrudan Windows’ta çalışır.

```bash
openclaw gateway run
```

PowerShell’i açın ve çalıştırın:

openclaw gateway status
openclaw gateway restart

```powershell
Manuel çalıştırıyorsanız (servis yoksa), şunu kullanın:
```

Belgeler: [Windows (WSL2)](/platforms/windows), [Gateway servis çalışma kılavuzu](/gateway).

```powershell
openclaw gateway run
```

Gateway çalışıyor ama yanıtlar hiç gelmiyor. Neyi kontrol etmeliyim

### Hızlı bir sağlık taramasıyla başlayın:

openclaw status
openclaw models status
openclaw channels status
openclaw logs --follow

```bash
Model kimlik doğrulaması **gateway ana makinesinde** yüklenmemiş ( `models status` kontrol edin).
```

Yaygın nedenler:

- Kanal eşleştirme/izin listesi yanıtları engelliyor (kanal yapılandırması + günlükleri kontrol edin).
- Channel pairing/allowlist blocking replies (check channel config + logs).
- WebChat/Dashboard doğru belirteç olmadan açık.

Uzaktaysanız, tünel/Tailscale bağlantısının aktif olduğunu ve Gateway WebSocket’in erişilebilir olduğunu doğrulayın.

Belgeler: [Channels](/channels), [Troubleshooting](/gateway/troubleshooting), [Remote access](/gateway/remote).

### Gateway’den bağlantı koptu, sebep yok, şimdi ne olacak

Bu genellikle UI’nin WebSocket bağlantısını kaybettiği anlamına gelir. Şunları kontrol edin:

1. Gateway çalışıyor mu? `openclaw gateway status`
2. Gateway sağlıklı mı? `openclaw status`
3. UI doğru belirtece sahip mi? `openclaw dashboard`
4. Uzaktaysa, tünel/Tailscale bağlantısı aktif mi?

Ardından logları izle:

```bash
openclaw logs --follow
```

Belgeler: [Dashboard](/web/dashboard), [Remote access](/gateway/remote), [Troubleshooting](/gateway/troubleshooting).

### Telegram setMyCommands ağ hatalarıyla başarısız oluyor. Neyi kontrol etmeliyim

Loglar ve kanal durumu ile başlayın:

```bash
openclaw channels status
openclaw channels logs --channel telegram
```

Bir VPS üzerindeyseniz veya bir proxy arkasındaysanız, giden HTTPS’in izinli olduğunu ve DNS’in çalıştığını doğrulayın.
Gateway uzaktaysa, Gateway ana bilgisayarındaki loglara baktığınızdan emin olun.

Belgeler: [Telegram](/channels/telegram), [Channel troubleshooting](/channels/troubleshooting).

### TUI hiçbir çıktı göstermiyor. Neyi kontrol etmeliyim

Önce Gateway’in erişilebilir olduğunu ve ajanı çalıştırabildiğinizi doğrulayın:

```bash
openclaw status
openclaw models status
openclaw logs --follow
```

TUI içinde, mevcut durumu görmek için `/status` kullanın. Bir sohbet kanalında yanıt bekliyorsanız, teslimatın etkin olduğundan emin olun (`/deliver on`).

Belgeler: [TUI](/web/tui), [Slash commands](/tools/slash-commands).

### Gateway’i tamamen nasıl durdurup yeniden başlatırım

Servisi kurduysanız:

```bash
openclaw gateway stop
openclaw gateway start
```

Bu, **denetlenen servisi** durdurur/başlatır (macOS’ta launchd, Linux’ta systemd).
Gateway bir daemon olarak arka planda çalışıyorsa bunu kullanın.

Ön planda çalıştırıyorsanız, Ctrl-C ile durdurun, ardından:

```bash
openclaw gateway run
```

Belgeler: [Gateway service runbook](/gateway).

### ELI5 openclaw gateway restart vs openclaw gateway

- `openclaw gateway restart`: **arka plan servisini** (launchd/systemd) yeniden başlatır.
- `openclaw gateway`: bu terminal oturumu için gateway’i **ön planda** çalıştırır.

Servisi kurduysanız, gateway komutlarını kullanın. Tek seferlik, ön planda bir çalıştırma istediğinizde `openclaw gateway` kullanın.

### Bir şey başarısız olduğunda daha fazla ayrıntıyı almanın en hızlı yolu nedir

Daha fazla konsol ayrıntısı almak için Gateway’i `--verbose` ile başlatın. Ardından kanal kimlik doğrulaması, model yönlendirme ve RPC hataları için log dosyasını inceleyin.

## Medya ve ekler

### Yeteneğim bir imagePDF üretti ama hiçbir şey gönderilmedi

Ajandanın giden ekleri, kendi satırında olacak şekilde bir `MEDIA:<path-or-url>` satırı içermelidir. [OpenClaw assistant setup](/start/openclaw) ve [Agent send](/tools/agent-send) sayfalarına bakın.

CLI ile gönderme:

```bash
openclaw message send --target +15555550123 --message "Here you go" --media /path/to/file.png
```

Ayrıca şunları kontrol edin:

- Hedef kanal giden medyayı destekliyor ve izin listeleri tarafından engellenmiyor.
- Dosya, sağlayıcının boyut sınırları içinde (görseller en fazla 2048px’e yeniden boyutlandırılır).

[Images](/nodes/images) sayfasına bakın.

## Güvenlik ve erişim kontrolü

### OpenClaw’u gelen DM’lere açmak güvenli mi

Gelen DM’leri güvenilmeyen girdi olarak ele alın. Varsayılanlar riski azaltmak için tasarlanmıştır:

- DM destekli kanallardaki varsayılan davranış **eşleştirme**dir:
  - Bilinmeyen gönderenler bir eşleştirme kodu alır; bot mesajlarını işlemez.
  - Şu komutla onaylayın: `openclaw pairing approve <channel> <code>`
  - Bekleyen istekler **kanal başına 3** ile sınırlandırılır; bir kod gelmediyse `openclaw pairing list <channel>` komutunu kontrol edin.
- DM’leri herkese açık şekilde açmak açık bir opt-in gerektirir (`dmPolicy: "open"` ve allowlist `"*"`).

Riskli DM politikalarını ortaya çıkarmak için `openclaw doctor` çalıştırın.

### Prompt enjeksiyonu yalnızca herkese açık botlar için mi bir endişedir

Hayır. Prompt enjeksiyonu, yalnızca kimin bota DM atabildiğiyle değil, **güvenilmeyen içerikle** ilgilidir.
Asistanınız harici içerik okuyorsa (web arama/getirme, tarayıcı sayfaları, e-postalar,
belgeler, ekler, yapıştırılmış loglar), bu içerik modelin kontrolünü ele geçirmeye çalışan talimatlar içerebilir. Bu, **tek gönderen siz olsanız bile** gerçekleşebilir.

En büyük risk, araçlar etkin olduğunda ortaya çıkar: model bağlamı dışarı sızdırmaya veya sizin adınıza araç çağırmaya kandırılabilir. Etki alanını azaltmak için:

- güvenilmeyen içeriği özetlemek için salt-okunur veya araçları devre dışı bir "okuyucu" ajan kullanmak
- araçları etkin ajanlar için `web_search` / `web_fetch` / `browser`’ı kapalı tutmak
- sandboxlama ve sıkı araç allowlist’leri

Ayrıntılar: [Security](/gateway/security).

### Botumun kendine ait bir e-posta, GitHub hesabı veya telefon numarası olmalı mı

Evet, çoğu kurulum için. Botu ayrı hesaplar ve telefon numaralarıyla izole etmek,
bir şeyler ters giderse etki alanını küçültür. Bu ayrıca kimlik bilgilerini döndürmeyi
veya kişisel hesaplarınızı etkilemeden erişimi iptal etmeyi kolaylaştırır.

Küçük başlayın. Yalnızca gerçekten ihtiyaç duyduğunuz araçlara ve hesaplara erişim verin, gerekirse
daha sonra genişletin.

Dokümanlar: [Security](/gateway/security), [Pairing](/channels/pairing).

### Metin mesajlarım üzerinde ona özerklik verebilir miyim ve bu güvenli mi

Kişisel mesajlarınız üzerinde tam özerklik **önermiyoruz**. En güvenli desen:

- DM’leri **eşleştirme modunda** veya sıkı bir allowlist ile tutun.
- Sizin adınıza mesaj atmasını istiyorsanız **ayrı bir numara veya hesap** kullanın.
- Taslak oluşturmasına izin verin, ardından **göndermeden önce onaylayın**.

Denemek istiyorsanız, bunu özel bir hesapta yapın ve izole tutun. Bkz.
[Security](/gateway/security).

### Kişisel asistan görevleri için daha ucuz modelleri kullanabilir miyim

Evet, **ancak** ajan yalnızca sohbet amaçlıysa ve girdi güveniliyorsa. Daha küçük katmanlar talimat ele geçirmeye
daha yatkındır; bu nedenle araçları etkin ajanlar için veya güvenilmeyen içerik okunurken bunlardan kaçının. Daha küçük bir model kullanmak zorundaysanız, araçları kilitleyin
ve bir sandbox içinde çalıştırın. Bkz. [Security](/gateway/security).

### Telegram’da start çalıştırdım ama bir eşleştirme kodu almadım

Eşleştirme kodları **yalnızca** bilinmeyen bir gönderen botla mesajlaştığında ve
`dmPolicy: "pairing"` etkin olduğunda gönderilir. `/start` tek başına bir kod üretmez.

Bekleyen istekleri kontrol edin:

```bash
openclaw pairing list telegram
```

Anında erişim istiyorsanız, gönderen kimliğinizi allowlist’e ekleyin veya
bu hesap için `dmPolicy: "open"` ayarlayın.

### WhatsApp’ta kişilerime mesaj atacak mı Eşleştirme nasıl çalışır

Hayır. Varsayılan WhatsApp DM politikası **eşleştirme**dir. Bilinmeyen gönderenler yalnızca bir eşleştirme kodu alır ve mesajları **işlenmez**. OpenClaw yalnızca aldığı sohbetlere veya sizin tetiklediğiniz açık gönderimlere yanıt verir.

Eşleştirmeyi şu komutla onaylayın:

```bash
openclaw pairing approve whatsapp <code>
```

Bekleyen istekleri listeleyin:

```bash
openclaw pairing list whatsapp
```

Sihirbaz telefon numarası istemi: kendi DM’lerinizin izinli olması için **allowlist/sahip** ayarını yapmakta kullanılır. Otomatik gönderim için kullanılmaz. 1. Kişisel WhatsApp numaranızda çalıştırıyorsanız, o numarayı kullanın ve `channels.whatsapp.selfChatMode` ayarını etkinleştirin.

## 2. Sohbet komutları, görevleri iptal etme ve "durmuyor" durumu

### 3. Dahili sistem mesajlarının sohbette görünmesini nasıl engellerim

4. Çoğu dahili veya araç mesajı yalnızca o oturum için **verbose** veya **reasoning** etkin olduğunda görünür.

5. Gördüğünüz yerde sohbette düzeltin:

```
6. /verbose off
/reasoning off
```

7. Hâlâ gürültülüyse, Control UI içindeki oturum ayarlarını kontrol edin ve verbose değerini **inherit** olarak ayarlayın. 8. Ayrıca config içinde `verboseDefault` değeri `on` olarak ayarlanmış bir bot profili kullanmadığınızı doğrulayın.

9. Dokümanlar: [Thinking and verbose](/tools/thinking), [Security](/gateway/security#reasoning--verbose-output-in-groups).

### 10. Çalışan bir görevi nasıl durdurur/iptal ederim

11. Bunlardan herhangi birini **tek başına bir mesaj olarak** gönderin (slash olmadan):

```
12. stop
abort
esc
wait
exit
interrupt
```

13. Bunlar iptal tetikleyicileridir (slash komutları değildir).

14. Arka plan süreçleri için (exec aracından), ajandan şunu çalıştırmasını isteyebilirsiniz:

```
15. process action:kill sessionId:XXX
```

16. Slash komutlarına genel bakış: [Slash commands](/tools/slash-commands) bölümüne bakın.

17. Çoğu komut `/` ile başlayan **tek başına** bir mesaj olarak gönderilmelidir, ancak birkaç kısayol (ör. `/status`) izin verilen göndericiler için satır içinde de çalışır.

### 18. Telegram'dan Discord mesajı nasıl gönderirim — Crosscontext messaging denied

19. OpenClaw, varsayılan olarak **sağlayıcılar arası** mesajlaşmayı engeller. 20. Bir araç çağrısı Telegram'a bağlıysa, açıkça izin vermedikçe Discord'a göndermez.

21. Ajan için sağlayıcılar arası mesajlaşmayı etkinleştirin:

```json5
22. {
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

23. Yapılandırmayı düzenledikten sonra gateway'i yeniden başlatın. 24. Bunu yalnızca tek bir ajan için istiyorsanız,
    `agents.list[].tools.message` altında ayarlayın.

### 25. Botun hızlı ardışık mesajları görmezden geliyormuş gibi hissettirmesinin nedeni nedir

26. Kuyruk modu, yeni mesajların devam eden bir çalışmayla nasıl etkileşime girdiğini kontrol eder. 27. Modları değiştirmek için `/queue` kullanın:

- 28. `steer` - yeni mesajlar mevcut görevi yeniden yönlendirir
- 29. `followup` - mesajları teker teker çalıştırır
- 30. `collect` - mesajları toplu işler ve bir kez yanıtlar (varsayılan)
- 31. `steer-backlog` - şimdi yönlendirir, sonra birikmişleri işler
- 32. `interrupt` - mevcut çalışmayı iptal eder ve sıfırdan başlar

33. Followup modları için `debounce:2s cap:25 drop:summarize` gibi seçenekler ekleyebilirsiniz.

## 34. Ekran görüntüsündeki/sohbet kaydındaki soruya birebir yanıt verin

35. **S: "Anthropic için bir API anahtarıyla varsayılan model nedir?"**

36. **C:** OpenClaw'da kimlik bilgileri ve model seçimi ayrıdır. 37. `ANTHROPIC_API_KEY` ayarlamak (veya auth profillerinde bir Anthropic API anahtarı saklamak) kimlik doğrulamayı etkinleştirir, ancak gerçek varsayılan model `agents.defaults.model.primary` içinde yapılandırdığınız değerdir (örneğin, `anthropic/claude-sonnet-4-5` veya `anthropic/claude-opus-4-6`). 38. `No credentials found for profile "anthropic:default"` görüyorsanız, bu Gateway'in çalışan ajan için beklenen `auth-profiles.json` içinde Anthropic kimlik bilgilerini bulamadığı anlamına gelir.

---

Hâlâ takıldınız mı? [Discord](https://discord.com/invite/clawd) üzerinden sorun veya bir [GitHub tartışması](https://github.com/openclaw/openclaw/discussions) açın.
