---
summary: "OpenClaw Gateway CLI (`openclaw gateway`) — gateway’leri çalıştırma, sorgulama ve keşfetme"
read_when:
  - Gateway’i CLI üzerinden çalıştırırken (geliştirme veya sunucular)
  - Gateway kimlik doğrulaması, bağlanma modları ve bağlantıyı hata ayıklarken
  - Bonjour aracılığıyla gateway’leri keşfederken (LAN + tailnet)
title: "gateway"
---

# Gateway CLI

Gateway, OpenClaw’ın WebSocket sunucusudur (kanallar, düğümler, oturumlar, hook’lar).

Bu sayfadaki alt komutlar `openclaw gateway …` altında yer alır.

İlgili dokümanlar:

- [/gateway/bonjour](/gateway/bonjour)
- [/gateway/discovery](/gateway/discovery)
- [/gateway/configuration](/gateway/configuration)

## Gateway’i Çalıştırma

Yerel bir Gateway süreci çalıştırın:

```bash
openclaw gateway
```

Ön plan (foreground) takma adı:

```bash
openclaw gateway run
```

Notlar:

- Varsayılan olarak, Gateway `~/.openclaw/openclaw.json` içinde `gateway.mode=local` ayarlanmadıkça başlatılmayı reddeder. Geçici/geliştirme çalıştırmaları için `--allow-unconfigured` kullanın.
- Kimlik doğrulama olmadan loopback ötesine bağlanma engellenir (güvenlik korkuluğu).
- `SIGUSR1`, yetkilendirildiğinde işlem içi yeniden başlatmayı tetikler (`commands.restart`’i etkinleştirin veya gateway tool/config apply/update kullanın).
- `SIGINT`/`SIGTERM` işleyicileri gateway sürecini durdurur, ancak özel terminal durumlarını geri yüklemez. CLI’yi bir TUI veya raw-mode girdi ile sarıyorsanız, çıkmadan önce terminali geri yükleyin.

### Seçenekler

- `--port <port>`: WebSocket portu (varsayılan yapılandırma/ortamdan gelir; genellikle `18789`).
- `--bind <loopback|lan|tailnet|auto|custom>`: dinleyici bağlanma modu.
- `--auth <token|password>`: kimlik doğrulama modu geçersiz kılma.
- `--token <token>`: belirteç geçersiz kılma (ayrıca süreç için `OPENCLAW_GATEWAY_TOKEN` ayarlar).
- `--password <password>`: parola geçersiz kılma (ayrıca süreç için `OPENCLAW_GATEWAY_PASSWORD` ayarlar).
- `--tailscale <off|serve|funnel>`: Gateway’i Tailscale üzerinden yayınla.
- `--tailscale-reset-on-exit`: kapatmada Tailscale serve/funnel yapılandırmasını sıfırla.
- `--allow-unconfigured`: yapılandırmada `gateway.mode=local` olmadan gateway başlangıcına izin ver.
- `--dev`: eksikse bir geliştirme yapılandırması + çalışma alanı oluştur (BOOTSTRAP.md atlanır).
- `--reset`: geliştirme yapılandırmasını + kimlik bilgilerini + oturumları + çalışma alanını sıfırla (`--dev` gerektirir).
- `--force`: başlatmadan önce seçilen porttaki mevcut dinleyiciyi sonlandır.
- `--verbose`: ayrıntılı günlükler.
- `--claude-cli-logs`: konsolda yalnızca claude-cli günlüklerini göster (ve stdout/stderr’ini etkinleştir).
- `--ws-log <auto|full|compact>`: websocket günlük stili (varsayılan `auto`).
- `--compact`: `--ws-log compact` için takma ad.
- `--raw-stream`: ham model akış olaylarını jsonl olarak günlüğe al.
- `--raw-stream-path <path>`: ham akış jsonl yolu.

## Çalışan bir Gateway’i Sorgulama

Tüm sorgu komutları WebSocket RPC kullanır.

Çıktı modları:

- Varsayılan: insan tarafından okunabilir (TTY’de renklendirilmiş).
- `--json`: makine tarafından okunabilir JSON (stil/spinner yok).
- `--no-color` (veya `NO_COLOR=1`): insan düzenini korurken ANSI’yi devre dışı bırak.

Paylaşılan seçenekler (desteklendiği yerlerde):

- `--url <url>`: Gateway WebSocket URL’si.
- `--token <token>`: Gateway belirteci.
- `--password <password>`: Gateway parolası.
- `--timeout <ms>`: zaman aşımı/bütçe (komuta göre değişir).
- `--expect-final`: “final” yanıtı bekle (ajan çağrıları).

Not: `--url` ayarladığınızda, CLI yapılandırma veya ortam kimlik bilgilerine geri dönmez.
`--token` veya `--password`’yi açıkça iletin. Açık kimlik bilgileri eksikse hata oluşur.

### `gateway health`

```bash
openclaw gateway health --url ws://127.0.0.1:18789
```

### `gateway status`

`gateway status`, Gateway hizmetini (launchd/systemd/schtasks) ve isteğe bağlı bir RPC yoklamasını gösterir.

```bash
openclaw gateway status
openclaw gateway status --json
```

Seçenekler:

- `--url <url>`: yoklama URL’sini geçersiz kıl.
- `--token <token>`: yoklama için belirteçle kimlik doğrulama.
- `--password <password>`: yoklama için parola ile kimlik doğrulama.
- `--timeout <ms>`: yoklama zaman aşımı (varsayılan `10000`).
- `--no-probe`: RPC yoklamasını atla (yalnızca hizmet görünümü).
- `--deep`: sistem düzeyi hizmetleri de tara.

### `gateway probe`

`gateway probe` “her şeyi hata ayıkla” komutudur. Her zaman yoklar:

- yapılandırılmış uzak gateway’inizi (ayarlıysa) ve
- localhost’u (loopback) **uzak ayarlı olsa bile**.

Birden fazla gateway erişilebilir durumdaysa hepsini yazdırır. İzole profiller/portlar kullandığınızda (ör. bir kurtarma botu) birden fazla gateway desteklenir, ancak çoğu kurulum hâlâ tek bir gateway çalıştırır.

```bash
openclaw gateway probe
openclaw gateway probe --json
```

#### SSH üzerinden uzaktan (Mac uygulaması ile eşdeğer)

macOS uygulamasındaki “Remote over SSH” modu, uzak gateway’in (yalnızca loopback’e bağlı olabilir) `ws://127.0.0.1:<port>` adresinde erişilebilir hâle gelmesi için yerel bir port yönlendirme kullanır.

CLI eşdeğeri:

```bash
openclaw gateway probe --ssh user@gateway-host
```

Seçenekler:

- `--ssh <target>`: `user@host` veya `user@host:port` (port varsayılanı `22`).
- `--ssh-identity <path>`: kimlik dosyası.
- `--ssh-auto`: keşfedilen ilk gateway ana makinesini SSH hedefi olarak seç (yalnızca LAN/WAB).

Yapılandırma (isteğe bağlı, varsayılanlar olarak kullanılır):

- `gateway.remote.sshTarget`
- `gateway.remote.sshIdentity`

### `gateway call <method>`

Düşük seviyeli RPC yardımcısı.

```bash
openclaw gateway call status
openclaw gateway call logs.tail --params '{"sinceMs": 60000}'
```

## Gateway hizmetini yönetme

```bash
openclaw gateway install
openclaw gateway start
openclaw gateway stop
openclaw gateway restart
openclaw gateway uninstall
```

Notlar:

- `gateway install`, `--port`, `--runtime`, `--token`, `--force`, `--json`’i destekler.
- Yaşam döngüsü komutları betikleme için `--json` kabul eder.

## Gateway’leri keşfetme (Bonjour)

`gateway discover`, Gateway işaretlerini (`_openclaw-gw._tcp`) tarar.

- Multicast DNS-SD: `local.`
- Unicast DNS-SD (Wide-Area Bonjour): bir alan adı seçin (örnek: `openclaw.internal.`) ve split DNS + bir DNS sunucusu kurun; bkz. [/gateway/bonjour](/gateway/bonjour)

Yalnızca Bonjour keşfi etkin (varsayılan) gateway’ler işareti yayınlar.

Wide-Area keşif kayıtları (TXT) şunları içerir:

- `role` (gateway rol ipucu)
- `transport` (taşıma ipucu, ör. `gateway`)
- `gatewayPort` (WebSocket portu, genellikle `18789`)
- `sshPort` (SSH portu; yoksa varsayılan `22`)
- `tailnetDns` (MagicDNS ana makine adı, mevcutsa)
- `gatewayTls` / `gatewayTlsSha256` (TLS etkin + sertifika parmak izi)
- `cliPath` (uzak kurulumlar için isteğe bağlı ipucu)

### `gateway discover`

```bash
openclaw gateway discover
```

Seçenekler:

- `--timeout <ms>`: komut başına zaman aşımı (browse/resolve); varsayılan `2000`.
- `--json`: makine tarafından okunabilir çıktı (ayrıca stil/spinner’ı devre dışı bırakır).

Örnekler:

```bash
openclaw gateway discover --timeout 4000
openclaw gateway discover --json | jq '.beacons[].wsUrl'
```
