---
summary: "`openclaw` komutları, alt komutları ve seçenekleri için OpenClaw CLI başvuru belgesi"
read_when:
  - CLI komutları veya seçenekleri eklerken ya da değiştirirken
  - Yeni komut yüzeylerini belgelendirirken
title: "CLI Başvurusu"
---

# CLI başvurusu

Bu sayfa mevcut CLI davranışını açıklar. Komutlar değişirse bu belgeyi güncelleyin.

## Komut sayfaları

- [`setup`](/cli/setup)
- [`onboard`](/cli/onboard)
- [`configure`](/cli/configure)
- [`config`](/cli/config)
- [`doctor`](/cli/doctor)
- [`dashboard`](/cli/dashboard)
- [`reset`](/cli/reset)
- [`uninstall`](/cli/uninstall)
- [`update`](/cli/update)
- [`message`](/cli/message)
- [`agent`](/cli/agent)
- [`agents`](/cli/agents)
- [`acp`](/cli/acp)
- [`status`](/cli/status)
- [`health`](/cli/health)
- [`sessions`](/cli/sessions)
- [`gateway`](/cli/gateway)
- [`logs`](/cli/logs)
- [`system`](/cli/system)
- [`models`](/cli/models)
- [`memory`](/cli/memory)
- [`nodes`](/cli/nodes)
- [`devices`](/cli/devices)
- [`node`](/cli/node)
- [`approvals`](/cli/approvals)
- [`sandbox`](/cli/sandbox)
- [`tui`](/cli/tui)
- [`browser`](/cli/browser)
- [`cron`](/cli/cron)
- [`dns`](/cli/dns)
- [`docs`](/cli/docs)
- [`hooks`](/cli/hooks)
- [`webhooks`](/cli/webhooks)
- [`pairing`](/cli/pairing)
- [`plugins`](/cli/plugins) (eklenti komutları)
- [`channels`](/cli/channels)
- [`security`](/cli/security)
- [`skills`](/cli/skills)
- [`voicecall`](/cli/voicecall) (eklenti; yüklüyse)

## Global bayraklar

- `--dev`: durumu `~/.openclaw-dev` altında izole eder ve varsayılan portları kaydırır.
- `--profile <name>`: durumu `~/.openclaw-<name>` altında izole eder.
- `--no-color`: ANSI renklerini devre dışı bırakır.
- `--update`: `openclaw update` için kısaltma (yalnızca kaynak kurulumlar).
- `-V`, `--version`, `-v`: sürümü yazdırır ve çıkar.

## Çıktı biçimlendirme

- ANSI renkleri ve ilerleme göstergeleri yalnızca TTY oturumlarında oluşturulur.
- OSC-8 bağlantıları desteklenen terminallerde tıklanabilir bağlantılar olarak oluşturulur; aksi halde düz URL’lere geri dönülür.
- `--json` (ve desteklenen yerlerde `--plain`) temiz çıktı için biçimlendirmeyi devre dışı bırakır.
- `--no-color` ANSI biçimlendirmeyi devre dışı bırakır; `NO_COLOR=1` da dikkate alınır.
- Uzun süren komutlar bir ilerleme göstergesi gösterir (desteklendiğinde OSC 9;4).

## Renk paleti

OpenClaw, CLI çıktısı için bir lobster paleti kullanır.

- `accent` (#FF5A2D): başlıklar, etiketler, birincil vurgular.
- `accentBright` (#FF7A3D): komut adları, vurgu.
- `accentDim` (#D14A22): ikincil vurgu metni.
- `info` (#FF8A5B): bilgilendirici değerler.
- `success` (#2FBF71): başarı durumları.
- `warn` (#FFB020): uyarılar, geri dönüşler, dikkat.
- `error` (#E23D2D): hatalar, başarısızlıklar.
- `muted` (#8B7F77): vurgu azaltma, meta veriler.

Paletin tek doğruluk kaynağı: `src/terminal/palette.ts` (diğer adıyla “lobster seam”).

## Komut ağacı

```
openclaw [--dev] [--profile <name>] <command>
  setup
  onboard
  configure
  config
    get
    set
    unset
  doctor
  security
    audit
  reset
  uninstall
  update
  channels
    list
    status
    logs
    add
    remove
    login
    logout
  skills
    list
    info
    check
  plugins
    list
    info
    install
    enable
    disable
    doctor
  memory
    status
    index
    search
  message
  agent
  agents
    list
    add
    delete
  acp
  status
  health
  sessions
  gateway
    call
    health
    status
    probe
    discover
    install
    uninstall
    start
    stop
    restart
    run
  logs
  system
    event
    heartbeat last|enable|disable
    presence
  models
    list
    status
    set
    set-image
    aliases list|add|remove
    fallbacks list|add|remove|clear
    image-fallbacks list|add|remove|clear
    scan
    auth add|setup-token|paste-token
    auth order get|set|clear
  sandbox
    list
    recreate
    explain
  cron
    status
    list
    add
    edit
    rm
    enable
    disable
    runs
    run
  nodes
  devices
  node
    run
    status
    install
    uninstall
    start
    stop
    restart
  approvals
    get
    set
    allowlist add|remove
  browser
    status
    start
    stop
    reset-profile
    tabs
    open
    focus
    close
    profiles
    create-profile
    delete-profile
    screenshot
    snapshot
    navigate
    resize
    click
    type
    press
    hover
    drag
    select
    upload
    fill
    dialog
    wait
    evaluate
    console
    pdf
  hooks
    list
    info
    check
    enable
    disable
    install
    update
  webhooks
    gmail setup|run
  pairing
    list
    approve
  docs
  dns
    setup
  tui
```

Not: eklentiler ek üst seviye komutlar ekleyebilir (örneğin `openclaw voicecall`).

## Güvenlik

- `openclaw security audit` — yapılandırma ve yerel durumu yaygın güvenlik hatalarına karşı denetler.
- `openclaw security audit --deep` — en iyi çaba ile canlı Gateway yoklaması.
- `openclaw security audit --fix` — güvenli varsayılanları sıkılaştırır ve durum/yapılandırma için chmod uygular.

## Eklentiler

Uzantıları ve yapılandırmalarını yönetin:

- `openclaw plugins list` — eklentileri keşfeder (makine çıktısı için `--json` kullanın).
- `openclaw plugins info <id>` — bir eklenti için ayrıntıları gösterir.
- `openclaw plugins install <path|.tgz|npm-spec>` — bir eklenti yükler (veya `plugins.load.paths`’e bir eklenti yolu ekler).
- `openclaw plugins enable <id>` / `disable <id>` — `plugins.entries.<id>.enabled`’yi aç/kapatır.
- `openclaw plugins doctor` — eklenti yükleme hatalarını raporlar.

Çoğu eklenti değişikliği bir gateway yeniden başlatması gerektirir. [/plugin](/tools/plugin).

## Bellek

`MEMORY.md` + `memory/*.md` üzerinde vektör arama:

- `openclaw memory status` — dizin istatistiklerini gösterir.
- `openclaw memory index` — bellek dosyalarını yeniden dizinler.
- `openclaw memory search "<query>"` — bellek üzerinde anlamsal arama.

## Sohbet slash komutları

Sohbet mesajları `/...` komutlarını (metin ve yerel) destekler. [/tools/slash-commands](/tools/slash-commands).

Öne çıkanlar:

- Hızlı tanılama için `/status`.
- Kalıcı yapılandırma değişiklikleri için `/config`.
- Yalnızca çalışma zamanı yapılandırma geçersiz kılmaları için `/debug` (bellek, disk değil; `commands.debug: true` gerektirir).

## Kurulum + onboarding

### `setup`

Initialize config + workspace.

Seçenekler:

- `--workspace <dir>`: ajan çalışma alanı yolu (varsayılan `~/.openclaw/workspace`).
- `--wizard`: onboarding sihirbazını çalıştırır.
- `--non-interactive`: istemler olmadan sihirbazı çalıştırır.
- `--mode <local|remote>`: sihirbaz modu.
- `--remote-url <url>`: uzak Gateway URL’si.
- `--remote-token <token>`: uzak Gateway belirteci.

Herhangi bir sihirbaz bayrağı mevcut olduğunda sihirbaz otomatik çalışır (`--non-interactive`, `--mode`, `--remote-url`, `--remote-token`).

### `onboard`

Gateway, çalışma alanı ve skills kurmak için etkileşimli sihirbaz.

Seçenekler:

- `--workspace <dir>`
- `--reset` (sihirbazdan önce yapılandırma + kimlik bilgileri + oturumlar + çalışma alanını sıfırlar)
- `--non-interactive`
- `--mode <local|remote>`
- `--flow <quickstart|advanced|manual>` (manual, advanced için takma addır)
- `--auth-choice <setup-token|token|chutes|openai-codex|openai-api-key|openrouter-api-key|ai-gateway-api-key|moonshot-api-key|moonshot-api-key-cn|kimi-code-api-key|synthetic-api-key|venice-api-key|gemini-api-key|zai-api-key|apiKey|minimax-api|minimax-api-lightning|opencode-zen|skip>`
- `--token-provider <id>` (etkileşimsiz; `--auth-choice token` ile kullanılır)
- `--token <token>` (etkileşimsiz; `--auth-choice token` ile kullanılır)
- `--token-profile-id <id>` (etkileşimsiz; varsayılan: `<provider>:manual`)
- `--token-expires-in <duration>` (etkileşimsiz; örn. `365d`, `12h`)
- `--anthropic-api-key <key>`
- `--openai-api-key <key>`
- `--openrouter-api-key <key>`
- `--ai-gateway-api-key <key>`
- `--moonshot-api-key <key>`
- `--kimi-code-api-key <key>`
- `--gemini-api-key <key>`
- `--zai-api-key <key>`
- `--minimax-api-key <key>`
- `--opencode-zen-api-key <key>`
- `--gateway-port <port>`
- `--gateway-bind <loopback|lan|tailnet|auto|custom>`
- `--gateway-auth <token|password>`
- `--gateway-token <token>`
- `--gateway-password <password>`
- `--remote-url <url>`
- `--remote-token <token>`
- `--tailscale <off|serve|funnel>`
- `--tailscale-reset-on-exit`
- `--install-daemon`
- `--no-install-daemon` (takma ad: `--skip-daemon`)
- `--daemon-runtime <node|bun>`
- `--skip-channels`
- `--skip-skills`
- `--skip-health`
- `--skip-ui`
- `--node-manager <npm|pnpm|bun>` (pnpm önerilir; Gateway çalışma zamanı için bun önerilmez)
- `--json`

### `configure`

Etkileşimli yapılandırma sihirbazı (modeller, kanallar, skills, gateway).

### `config`

Etkileşimsiz yapılandırma yardımcıları (get/set/unset). Alt komut olmadan
`openclaw config` çalıştırmak sihirbazı başlatır.

Alt komutlar:

- `config get <path>`: bir yapılandırma değerini yazdırır (nokta/köşeli parantez yolu).
- `config set <path> <value>`: bir değer ayarlar (JSON5 veya ham dize).
- `config unset <path>`: bir değeri kaldırır.

### `doctor`

Sağlık kontrolleri + hızlı düzeltmeler (yapılandırma + gateway + eski hizmetler).

Seçenekler:

- `--no-workspace-suggestions`: çalışma alanı bellek ipuçlarını devre dışı bırakır.
- `--yes`: istemler olmadan varsayılanları kabul eder (headless).
- `--non-interactive`: istemleri atlar; yalnızca güvenli geçişleri uygular.
- `--deep`: ek gateway kurulumları için sistem hizmetlerini tarar.

## Kanal yardımcıları

### `channels`

Sohbet kanalı hesaplarını yönetin (WhatsApp/Telegram/Discord/Google Chat/Slack/Mattermost (eklenti)/Signal/iMessage/MS Teams).

Alt komutlar:

- `channels list`: yapılandırılmış kanalları ve kimlik doğrulama profillerini gösterir.
- `channels status`: gateway erişilebilirliğini ve kanal sağlığını kontrol eder (`--probe` ek kontroller çalıştırır; gateway sağlık yoklamaları için `openclaw health` veya `openclaw status --deep` kullanın).
- İpucu: `channels status`, yaygın yanlış yapılandırmaları algılayabildiğinde önerilen düzeltmelerle uyarılar yazdırır (ardından sizi `openclaw doctor`’e yönlendirir).
- `channels logs`: gateway günlük dosyasından son kanal günlüklerini gösterir.
- `channels add`: bayrak verilmediğinde sihirbaz tarzı kurulum; bayraklar etkileşimsiz moda geçirir.
- `channels remove`: varsayılan olarak devre dışıdır; istemler olmadan yapılandırma girdilerini kaldırmak için `--delete` geçin.
- `channels login`: etkileşimli kanal girişi (yalnızca WhatsApp Web).
- `channels logout`: bir kanal oturumundan çıkış yapar (destekleniyorsa).

Yaygın seçenekler:

- `--channel <name>`: `whatsapp|telegram|discord|googlechat|slack|mattermost|signal|imessage|msteams`
- `--account <id>`: kanal hesap kimliği (varsayılan `default`)
- `--name <label>`: hesap için görünen ad

`channels login` seçenekleri:

- `--channel <channel>` (varsayılan `whatsapp`; `whatsapp`/`web` destekler)
- `--account <id>`
- `--verbose`

`channels logout` seçenekleri:

- `--channel <channel>` (varsayılan `whatsapp`)
- `--account <id>`

`channels list` seçenekleri:

- `--no-usage`: model sağlayıcı kullanım/kota anlık görüntülerini atlar (yalnızca OAuth/API destekli).
- `--json`: JSON çıktısı ( `--no-usage` ayarlı değilse kullanımı içerir).

`channels logs` seçenekleri:

- `--channel <name|all>` (varsayılan `all`)
- `--lines <n>` (varsayılan `200`)
- `--json`

Daha fazla ayrıntı: [/concepts/oauth](/concepts/oauth)

Örnekler:

```bash
openclaw channels add --channel telegram --account alerts --name "Alerts Bot" --token $TELEGRAM_BOT_TOKEN
openclaw channels add --channel discord --account work --name "Work Bot" --token $DISCORD_BOT_TOKEN
openclaw channels remove --channel discord --account work --delete
openclaw channels status --probe
openclaw status --deep
```

### `skills`

Kullanılabilir skills’leri ve hazır olma bilgilerini listeler ve inceler.

Alt komutlar:

- `skills list`: skills’leri listeler (alt komut yoksa varsayılan).
- `skills info <name>`: tek bir skill için ayrıntıları gösterir.
- `skills check`: hazır olanlar ile eksik gereksinimlerin özeti.

Seçenekler:

- `--eligible`: yalnızca hazır skills’leri gösterir.
- `--json`: JSON çıktısı (biçimlendirme yok).
- `-v`, `--verbose`: eksik gereksinim ayrıntılarını dahil eder.

İpucu: skills’leri aramak, yüklemek ve eşitlemek için `npx clawhub` kullanın.

### `pairing`

Kanallar arasında DM eşleştirme isteklerini onaylar.

Alt komutlar:

- `pairing list <channel> [--json]`
- `pairing approve <channel> <code> [--notify]`

### `webhooks gmail`

Gmail Pub/Sub kanca kurulumu + çalıştırıcı. Bkz. [/automation/gmail-pubsub](/automation/gmail-pubsub).

Alt komutlar:

- `webhooks gmail setup` (`--account <email>` gerektirir; `--project`, `--topic`, `--subscription`, `--label`, `--hook-url`, `--hook-token`, `--push-token`, `--bind`, `--port`, `--path`, `--include-body`, `--max-bytes`, `--renew-minutes`, `--tailscale`, `--tailscale-path`, `--tailscale-target`, `--push-endpoint`, `--json` destekler)
- `webhooks gmail run` (aynı bayraklar için çalışma zamanı geçersiz kılmaları)

### `dns setup`

Geniş alan keşfi DNS yardımcısı (CoreDNS + Tailscale). [/gateway/discovery](/gateway/discovery).

Seçenekler:

- `--apply`: CoreDNS yapılandırmasını yükler/günceller (sudo gerektirir; yalnızca macOS).

## Mesajlaşma + ajan

### `message`

Birleşik giden mesajlaşma + kanal eylemleri.

Bkz.: [/cli/message](/cli/message)

Alt komutlar:

- `message send|poll|react|reactions|read|edit|delete|pin|unpin|pins|permissions|search|timeout|kick|ban`
- `message thread <create|list|reply>`
- `message emoji <list|upload>`
- `message sticker <send|upload>`
- `message role <info|add|remove>`
- `message channel <info|list>`
- `message member info`
- `message voice status`
- `message event <list|create>`

Örnekler:

- `openclaw message send --target +15555550123 --message "Hi"`
- `openclaw message poll --channel discord --target channel:123 --poll-question "Snack?" --poll-option Pizza --poll-option Sushi`

### `agent`

Gateway (veya gömülü `--local`) üzerinden tek bir ajan turu çalıştırır.

Gerekli:

- `--message <text>`

Seçenekler:

- `--to <dest>` (oturum anahtarı ve isteğe bağlı teslimat için)
- `--session-id <id>`
- `--thinking <off|minimal|low|medium|high|xhigh>` (yalnızca GPT-5.2 + Codex modelleri)
- `--verbose <on|full|off>`
- `--channel <whatsapp|telegram|discord|slack|mattermost|signal|imessage|msteams>`
- `--local`
- `--deliver`
- `--json`
- `--timeout <seconds>`

### `agents`

İzole ajanları yönetir (çalışma alanları + kimlik doğrulama + yönlendirme).

#### `agents list`

Yapılandırılmış ajanları listeler.

Seçenekler:

- `--json`
- `--bindings`

#### `agents add [name]`

Yeni bir izole ajan ekler. Bayraklar (veya `--non-interactive`) geçilmediği sürece kılavuzlu sihirbazı çalıştırır; etkileşimsiz modda `--workspace` gereklidir.

Seçenekler:

- `--workspace <dir>`
- `--model <id>`
- `--agent-dir <dir>`
- `--bind <channel[:accountId]>` (tekrarlanabilir)
- `--non-interactive`
- `--json`

Bağlama tanımları `channel[:accountId]` kullanır. WhatsApp için `accountId` atlandığında varsayılan hesap kimliği kullanılır.

#### `agents delete <id>`

Bir ajanı siler ve çalışma alanı + durumunu budar.

Seçenekler:

- `--force`
- `--json`

### `acp`

IDE’leri Gateway’e bağlayan ACP köprüsünü çalıştırır.

Tüm seçenekler ve örnekler için [`acp`](/cli/acp) bölümüne bakın.

### `status`

Bağlı oturum sağlığını ve son alıcıları gösterir.

Seçenekler:

- `--json`
- `--all` (tam tanılama; salt-okunur, yapıştırılabilir)
- `--deep` (kanalları yoklar)
- `--usage` (model sağlayıcı kullanım/kotasını gösterir)
- `--timeout <ms>`
- `--verbose`
- `--debug` (`--verbose` için takma ad)

Notlar:

- Genel bakış, mevcut olduğunda Gateway + node ana makinesi hizmet durumunu içerir.

### Kullanım takibi

OpenClaw, OAuth/API kimlik bilgileri mevcut olduğunda sağlayıcı kullanım/kota bilgilerini gösterebilir.

Yüzeyler:

- `/status` (mevcut olduğunda kısa bir sağlayıcı kullanım satırı ekler)
- `openclaw status --usage` (tam sağlayıcı dökümünü yazdırır)
- macOS menü çubuğu (Bağlam altında Kullanım bölümü)

Notlar:

- Veriler doğrudan sağlayıcı kullanım uç noktalarından gelir (tahmin yoktur).
- Sağlayıcılar: Anthropic, GitHub Copilot, OpenAI Codex OAuth; ayrıca bu sağlayıcı eklentileri etkinleştirildiğinde Gemini CLI/Antigravity.
- Eşleşen kimlik bilgileri yoksa kullanım gizlenir.
- Ayrıntılar: [Kullanım takibi](/concepts/usage-tracking).

### `health`

Çalışan Gateway’den sağlık bilgisini getirir.

Seçenekler:

- `--json`
- `--timeout <ms>`
- `--verbose`

### `sessions`

Depolanmış konuşma oturumlarını listeler.

Seçenekler:

- `--json`
- `--verbose`
- `--store <path>`
- `--active <minutes>`

## Sıfırla / Kaldır

### `reset`

Yerel yapılandırmayı/durumu sıfırlar (CLI yüklü kalır).

Seçenekler:

- `--scope <config|config+creds+sessions|full>`
- `--yes`
- `--non-interactive`
- `--dry-run`

Notlar:

- `--non-interactive`, `--scope` ve `--yes` gerektirir.

### `uninstall`

Gateway hizmetini + yerel verileri kaldırır (CLI kalır).

Seçenekler:

- `--service`
- `--state`
- `--workspace`
- `--app`
- `--all`
- `--yes`
- `--non-interactive`
- `--dry-run`

Notlar:

- `--non-interactive`, `--yes` ve açık kapsamlar (veya `--all`) gerektirir.

## Gateway

### `gateway`

WebSocket Gateway’i çalıştırır.

Seçenekler:

- `--port <port>`
- `--bind <loopback|tailnet|lan|auto|custom>`
- `--token <token>`
- `--auth <token|password>`
- `--password <password>`
- `--tailscale <off|serve|funnel>`
- `--tailscale-reset-on-exit`
- `--allow-unconfigured`
- `--dev`
- `--reset` (geliştirici yapılandırması + kimlik bilgileri + oturumlar + çalışma alanını sıfırlar)
- `--force` (porttaki mevcut dinleyiciyi sonlandırır)
- `--verbose`
- `--claude-cli-logs`
- `--ws-log <auto|full|compact>`
- `--compact` (`--ws-log compact` için takma ad)
- `--raw-stream`
- `--raw-stream-path <path>`

### `gateway service`

Gateway hizmetini yönetir (launchd/systemd/schtasks).

Alt komutlar:

- `gateway status` (varsayılan olarak Gateway RPC’yi yoklar)
- `gateway install` (hizmet kurulumu)
- `gateway uninstall`
- `gateway start`
- `gateway stop`
- `gateway restart`

Notlar:

- `gateway status`, hizmetin çözümlenen port/yapılandırmasını kullanarak varsayılan olarak Gateway RPC’yi yoklar (`--url/--token/--password` ile geçersiz kılın).
- `gateway status`, betikleme için `--no-probe`, `--deep` ve `--json`’i destekler.
- `gateway status`, algılayabildiğinde eski veya ek gateway hizmetlerini de gösterir (`--deep` sistem düzeyi taramalar ekler). Profil adlandırılmış OpenClaw hizmetleri birinci sınıf kabul edilir ve “ekstra” olarak işaretlenmez.
- `gateway status`, CLI’nin hangi yapılandırma yolunu kullandığını ve hizmetin muhtemelen hangi yapılandırmayı kullandığını (hizmet ortamı) ve ayrıca çözümlenen yoklama hedef URL’sini yazdırır.
- `gateway install|uninstall|start|stop|restart`, betikleme için `--json`’ü destekler (varsayılan çıktı insan dostu kalır).
- `gateway install`, Node çalışma zamanını varsayılan alır; bun **önerilmez** (WhatsApp/Telegram hataları).
- `gateway install` seçenekleri: `--port`, `--runtime`, `--token`, `--force`, `--json`.

### `logs`

RPC üzerinden Gateway dosya günlüklerini takip eder.

Notlar:

- TTY oturumları renkli, yapılandırılmış bir görünüm oluşturur; TTY olmayanlarda düz metne geri dönülür.
- `--json`, satır ayrımlı JSON üretir (satır başına bir günlük olayı).

Örnekler:

```bash
openclaw logs --follow
openclaw logs --limit 200
openclaw logs --plain
openclaw logs --json
openclaw logs --no-color
```

### `gateway <subcommand>`

Gateway CLI yardımcıları (RPC alt komutları için `--url`, `--token`, `--password`, `--timeout`, `--expect-final` kullanın).
`--url` geçildiğinde CLI, yapılandırmayı veya ortam kimlik bilgilerini otomatik uygulamaz.
`--token` veya `--password`’i açıkça ekleyin. Açık kimlik bilgileri olmaması bir hatadır.

Alt komutlar:

- `gateway call <method> [--params <json>]`
- `gateway health`
- `gateway status`
- `gateway probe`
- `gateway discover`
- `gateway install|uninstall|start|stop|restart`
- `gateway run`

Yaygın RPC’ler:

- `config.apply` (doğrula + yapılandırmayı yaz + yeniden başlat + uyandır)
- `config.patch` (kısmi bir güncellemeyi birleştir + yeniden başlat + uyandır)
- `update.run` (güncellemeyi çalıştır + yeniden başlat + uyandır)

İpucu: `config.set`/`config.apply`/`config.patch`’ü doğrudan çağırırken, zaten bir yapılandırma varsa
`config.get`’dan `baseHash`’i geçin.

## Modeller

Geri dönüş davranışı ve tarama stratejisi için [/concepts/models](/concepts/models) bölümüne bakın.

Tercih edilen Anthropic kimlik doğrulaması (setup-token):

```bash
claude setup-token
openclaw models auth setup-token --provider anthropic
openclaw models status
```

### `models` (kök)

`openclaw models`, `models status` için bir takma addır.

Kök seçenekler:

- `--status-json` (`models status --json` için takma ad)
- `--status-plain` (`models status --plain` için takma ad)

### `models list`

Seçenekler:

- `--all`
- `--local`
- `--provider <name>`
- `--json`
- `--plain`

### `models status`

Seçenekler:

- `--json`
- `--plain`
- `--check` (çıkış 1=süresi dolmuş/eksik, 2=süresi dolmak üzere)
- `--probe` (yapılandırılmış kimlik doğrulama profillerinin canlı yoklaması)
- `--probe-provider <name>`
- `--probe-profile <id>` (tekrarlı veya virgülle ayrılmış)
- `--probe-timeout <ms>`
- `--probe-concurrency <n>`
- `--probe-max-tokens <n>`

Her zaman kimlik doğrulama genel bakışını ve kimlik deposundaki profiller için OAuth süre dolumu durumunu içerir.
`--probe`, canlı istekler çalıştırır (belirteç tüketebilir ve oran sınırlarını tetikleyebilir).

### `models set <model>`

`agents.defaults.model.primary`’yi ayarlar.

### `models set-image <model>`

`agents.defaults.imageModel.primary`’yi ayarlar.

### `models aliases list|add|remove`

Seçenekler:

- `list`: `--json`, `--plain`
- `add <alias> <model>`
- `remove <alias>`

### `models fallbacks list|add|remove|clear`

Seçenekler:

- `list`: `--json`, `--plain`
- `add <model>`
- `remove <model>`
- `clear`

### `models image-fallbacks list|add|remove|clear`

Seçenekler:

- `list`: `--json`, `--plain`
- `add <model>`
- `remove <model>`
- `clear`

### `models scan`

Seçenekler:

- `--min-params <b>`
- `--max-age-days <days>`
- `--provider <name>`
- `--max-candidates <n>`
- `--timeout <ms>`
- `--concurrency <n>`
- `--no-probe`
- `--yes`
- `--no-input`
- `--set-default`
- `--set-image`
- `--json`

### `models auth add|setup-token|paste-token`

Seçenekler:

- `add`: etkileşimli kimlik doğrulama yardımcısı
- `setup-token`: `--provider <name>` (varsayılan `anthropic`), `--yes`
- `paste-token`: `--provider <name>`, `--profile-id <id>`, `--expires-in <duration>`

### `models auth order get|set|clear`

Seçenekler:

- `get`: `--provider <name>`, `--agent <id>`, `--json`
- `set`: `--provider <name>`, `--agent <id>`, `<profileIds...>`
- `clear`: `--provider <name>`, `--agent <id>`

## Sistem

### `system event`

Bir sistem olayını kuyruğa alır ve isteğe bağlı olarak bir heartbeat tetikler (Gateway RPC).

Gerekli:

- `--text <text>`

Seçenekler:

- `--mode <now|next-heartbeat>`
- `--json`
- `--url`, `--token`, `--timeout`, `--expect-final`

### `system heartbeat last|enable|disable`

Heartbeat denetimleri (Gateway RPC).

Seçenekler:

- `--json`
- `--url`, `--token`, `--timeout`, `--expect-final`

### `system presence`

Sistem varlık girdilerini listeler (Gateway RPC).

Seçenekler:

- `--json`
- `--url`, `--token`, `--timeout`, `--expect-final`

## Cron

Zamanlanmış işleri yönetin (Gateway RPC). [/automation/cron-jobs](/automation/cron-jobs).

Alt komutlar:

- `cron status [--json]`
- `cron list [--all] [--json]` (varsayılan olarak tablo çıktısı; ham çıktı için `--json` kullanın)
- `cron add` (takma ad: `create`; `--name` ve tam olarak bir `--at` | `--every` | `--cron`, ayrıca tam olarak bir yük `--system-event` | `--message` gerektirir)
- `cron edit <id>` (alanları yamalar)
- `cron rm <id>` (takma adlar: `remove`, `delete`)
- `cron enable <id>`
- `cron disable <id>`
- `cron runs --id <id> [--limit <n>]`
- `cron run <id> [--force]`

Tüm `cron` komutları `--url`, `--token`, `--timeout`, `--expect-final` kabul eder.

## Node host

`node`, **headless node ana makinesi** çalıştırır veya arka plan hizmeti olarak yönetir. [`openclaw node`](/cli/node).

Alt komutlar:

- `node run --host <gateway-host> --port 18789`
- `node status`
- `node install [--host <gateway-host>] [--port <port>] [--tls] [--tls-fingerprint <sha256>] [--node-id <id>] [--display-name <name>] [--runtime <node|bun>] [--force]`
- `node uninstall`
- `node stop`
- `node restart`

## Node’lar

`nodes`, Gateway ile konuşur ve eşleştirilmiş node’ları hedefler. [/nodes](/nodes).

Yaygın seçenekler:

- `--url`, `--token`, `--timeout`, `--json`

Alt komutlar:

- `nodes status [--connected] [--last-connected <duration>]`
- `nodes describe --node <id|name|ip>`
- `nodes list [--connected] [--last-connected <duration>]`
- `nodes pending`
- `nodes approve <requestId>`
- `nodes reject <requestId>`
- `nodes rename --node <id|name|ip> --name <displayName>`
- `nodes invoke --node <id|name|ip> --command <command> [--params <json>] [--invoke-timeout <ms>] [--idempotency-key <key>]`
- `nodes run --node <id|name|ip> [--cwd <path>] [--env KEY=VAL] [--command-timeout <ms>] [--needs-screen-recording] [--invoke-timeout <ms>] <command...>` (mac node veya headless node ana makinesi)
- `nodes notify --node <id|name|ip> [--title <text>] [--body <text>] [--sound <name>] [--priority <passive|active|timeSensitive>] [--delivery <system|overlay|auto>] [--invoke-timeout <ms>]` (yalnızca mac)

Kamera:

- `nodes camera list --node <id|name|ip>`
- `nodes camera snap --node <id|name|ip> [--facing front|back|both] [--device-id <id>] [--max-width <px>] [--quality <0-1>] [--delay-ms <ms>] [--invoke-timeout <ms>]`
- `nodes camera clip --node <id|name|ip> [--facing front|back] [--device-id <id>] [--duration <ms|10s|1m>] [--no-audio] [--invoke-timeout <ms>]`

Tuval + ekran:

- `nodes canvas snapshot --node <id|name|ip> [--format png|jpg|jpeg] [--max-width <px>] [--quality <0-1>] [--invoke-timeout <ms>]`
- `nodes canvas present --node <id|name|ip> [--target <urlOrPath>] [--x <px>] [--y <px>] [--width <px>] [--height <px>] [--invoke-timeout <ms>]`
- `nodes canvas hide --node <id|name|ip> [--invoke-timeout <ms>]`
- `nodes canvas navigate <url> --node <id|name|ip> [--invoke-timeout <ms>]`
- `nodes canvas eval [<js>] --node <id|name|ip> [--js <code>] [--invoke-timeout <ms>]`
- `nodes canvas a2ui push --node <id|name|ip> (--jsonl <path> | --text <text>) [--invoke-timeout <ms>]`
- `nodes canvas a2ui reset --node <id|name|ip> [--invoke-timeout <ms>]`
- `nodes screen record --node <id|name|ip> [--screen <index>] [--duration <ms|10s>] [--fps <n>] [--no-audio] [--out <path>] [--invoke-timeout <ms>]`

Konum:

- `nodes location get --node <id|name|ip> [--max-age <ms>] [--accuracy <coarse|balanced|precise>] [--location-timeout <ms>] [--invoke-timeout <ms>]`

## Tarayıcı

Tarayıcı denetim CLI’si (özel Chrome/Brave/Edge/Chromium). Bkz. [`openclaw browser`](/cli/browser) ve [Tarayıcı aracı](/tools/browser).

Yaygın seçenekler:

- `--url`, `--token`, `--timeout`, `--json`
- `--browser-profile <name>`

Yönetim:

- `browser status`
- `browser start`
- `browser stop`
- `browser reset-profile`
- `browser tabs`
- `browser open <url>`
- `browser focus <targetId>`
- `browser close [targetId]`
- `browser profiles`
- `browser create-profile --name <name> [--color <hex>] [--cdp-url <url>]`
- `browser delete-profile --name <name>`

İnceleme:

- `browser screenshot [targetId] [--full-page] [--ref <ref>] [--element <selector>] [--type png|jpeg]`
- `browser snapshot [--format aria|ai] [--target-id <id>] [--limit <n>] [--interactive] [--compact] [--depth <n>] [--selector <sel>] [--out <path>]`

Eylemler:

- `browser navigate <url> [--target-id <id>]`
- `browser resize <width> <height> [--target-id <id>]`
- `browser click <ref> [--double] [--button <left|right|middle>] [--modifiers <csv>] [--target-id <id>]`
- `browser type <ref> <text> [--submit] [--slowly] [--target-id <id>]`
- `browser press <key> [--target-id <id>]`
- `browser hover <ref> [--target-id <id>]`
- `browser drag <startRef> <endRef> [--target-id <id>]`
- `browser select <ref> <values...> [--target-id <id>]`
- `browser upload <paths...> [--ref <ref>] [--input-ref <ref>] [--element <selector>] [--target-id <id>] [--timeout-ms <ms>]`
- `browser fill [--fields <json>] [--fields-file <path>] [--target-id <id>]`
- `browser dialog --accept|--dismiss [--prompt <text>] [--target-id <id>] [--timeout-ms <ms>]`
- `browser wait [--time <ms>] [--text <value>] [--text-gone <value>] [--target-id <id>]`
- `browser evaluate --fn <code> [--ref <ref>] [--target-id <id>]`
- `browser console [--level <error|warn|info>] [--target-id <id>]`
- `browser pdf [--target-id <id>]`

## Docs search

### `docs [query...]`

Canlı doküman dizininde arama yapın.

## TUI

### `tui`

Gateway’e bağlı terminal UI’yi açar.

Seçenekler:

- `--url <url>`
- `--token <token>`
- `--password <password>`
- `--session <key>`
- `--deliver`
- `--thinking <level>`
- `--message <text>`
- `--timeout-ms <ms>` (varsayılan `agents.defaults.timeoutSeconds`)
- `--history-limit <n>`
