---
summary: "Gateway hizmeti, yaşam döngüsü ve operasyonları için çalıştırma kılavuzu"
read_when:
  - Gateway sürecini çalıştırırken veya hata ayıklarken
title: "Gateway Çalıştırma Kılavuzu"
---

# Gateway hizmeti çalıştırma kılavuzu

Son güncelleme: 2025-12-09

## Nedir

- Tek Baileys/Telegram bağlantısına ve kontrol/olay düzlemine sahip, her zaman açık süreç.
- Eski `gateway` komutunun yerini alır. CLI giriş noktası: `openclaw gateway`.
- Durdurulana kadar çalışır; ölümcül hatalarda sıfırdan farklı bir kodla çıkar, böylece denetleyici yeniden başlatır.

## Nasıl çalıştırılır (yerel)

```bash
openclaw gateway --port 18789
# for full debug/trace logs in stdio:
openclaw gateway --port 18789 --verbose
# if the port is busy, terminate listeners then start:
openclaw gateway --force
# dev loop (auto-reload on TS changes):
pnpm gateway:watch
```

- Yapılandırma sıcak yeniden yükleme, `~/.openclaw/openclaw.json` (veya `OPENCLAW_CONFIG_PATH`) dosyasını izler.
  - Varsayılan mod: `gateway.reload.mode="hybrid"` (güvenli değişiklikleri anında uygular, kritiklerde yeniden başlatır).
  - Sıcak yeniden yükleme, gerektiğinde **SIGUSR1** ile süreç içi yeniden başlatma kullanır.
  - `gateway.reload.mode="off"` ile devre dışı bırakın.
- WebSocket kontrol düzlemini `127.0.0.1:<port>`’ya bağlar (varsayılan 18789).
- Aynı port HTTP’yi de sunar (kontrol UI, kancalar, A2UI). Tek port çoklama.
  - OpenAI Chat Completions (HTTP): [`/v1/chat/completions`](/gateway/openai-http-api).
  - OpenResponses (HTTP): [`/v1/responses`](/gateway/openresponses-http-api).
  - Tools Invoke (HTTP): [`/tools/invoke`](/gateway/tools-invoke-http-api).
- Varsayılan olarak `canvasHost.port` üzerinde (varsayılan `18793`) bir Canvas dosya sunucusu başlatır; `~/.openclaw/workspace/canvas`’ten `http://<gateway-host>:18793/__openclaw__/canvas/` sunar. `canvasHost.enabled=false` veya `OPENCLAW_SKIP_CANVAS_HOST=1` ile devre dışı bırakın.
- stdout’a günlükler; canlı tutmak ve günlükleri döndürmek için launchd/systemd kullanın.
- Sorun giderirken günlük dosyasındaki hata ayıklama günlüklerini (el sıkışmalar, istek/yanıt, olaylar) stdio’ya yansıtmak için `--verbose` geçin.
- `--force`, seçilen porttaki dinleyicileri bulmak için `lsof` kullanır, SIGTERM gönderir, öldürdüklerini günlüğe yazar, ardından gateway’i başlatır (`lsof` yoksa hızlıca başarısız olur).
- Bir denetleyici altında çalıştırırsanız (launchd/systemd/mac uygulaması alt süreç modu), durdur/yeniden başlat genellikle **SIGTERM** gönderir; eski derlemelerde bu `pnpm` `ELIFECYCLE` çıkış kodu **143** (SIGTERM) olarak görünebilir; bu normal bir kapanıştır, çökme değildir.
- **SIGUSR1**, yetkili olduğunda süreç içi yeniden başlatmayı tetikler (gateway araç/yapılandırma uygulama/güncelleme veya manuel yeniden başlatmalar için `commands.restart`’yi etkinleştirin).
- Gateway kimlik doğrulaması varsayılan olarak gereklidir: `gateway.auth.token` (veya `OPENCLAW_GATEWAY_TOKEN`) ya da `gateway.auth.password` ayarlayın. İstemciler, Tailscale Serve kimliği kullanılmıyorsa `connect.params.auth.token/password` göndermelidir.
- Sihirbaz artık loopback’te bile varsayılan olarak bir belirteç üretir.
- Port önceliği: `--port` > `OPENCLAW_GATEWAY_PORT` > `gateway.port` > varsayılan `18789`.

## Uzaktan erişim

- Tailscale/VPN tercih edilir; aksi halde SSH tüneli:

  ```bash
  ssh -N -L 18789:127.0.0.1:18789 user@host
  ```

- İstemciler daha sonra tünel üzerinden `ws://127.0.0.1:18789`’e bağlanır.

- Bir belirteç yapılandırılmışsa, istemciler tünel üzerinden bile `connect.params.auth.token` içinde bunu eklemelidir.

## Birden fazla gateway (aynı ana makine)

Genellikle gereksizdir: tek bir Gateway birden fazla mesajlaşma kanalını ve ajanı sunabilir. Birden fazla Gateway’i yalnızca yedeklilik veya katı yalıtım için kullanın (örn: kurtarma botu).

Durum + yapılandırmayı yalıtırsanız ve benzersiz portlar kullanırsanız desteklenir. Tam kılavuz: [Birden fazla gateway](/gateway/multiple-gateways).

Hizmet adları profile duyarlıdır:

- macOS: `bot.molt.<profile>` (eski `com.openclaw.*` hâlâ mevcut olabilir)
- Linux: `openclaw-gateway-<profile>.service`
- Windows: `OpenClaw Gateway (<profile>)`

Kurulum meta verileri hizmet yapılandırmasına gömülüdür:

- `OPENCLAW_SERVICE_MARKER=openclaw`
- `OPENCLAW_SERVICE_KIND=gateway`
- `OPENCLAW_SERVICE_VERSION=<version>`

Kurtarma Botu Deseni: kendi profili, durum dizini, çalışma alanı ve temel port aralığına sahip ikinci bir Gateway’i yalıtılmış tutun. Tam kılavuz: [Kurtarma botu kılavuzu](/gateway/multiple-gateways#rescue-bot-guide).

### Geliştirici profili (`--dev`)

Hızlı yol: birincil kurulumunuza dokunmadan, tamamen yalıtılmış bir geliştirme örneği (yapılandırma/durum/çalışma alanı) çalıştırın.

```bash
openclaw --dev setup
openclaw --dev gateway --allow-unconfigured
# then target the dev instance:
openclaw --dev status
openclaw --dev health
```

Varsayılanlar (env/flag/yapılandırma ile geçersiz kılınabilir):

- `OPENCLAW_STATE_DIR=~/.openclaw-dev`
- `OPENCLAW_CONFIG_PATH=~/.openclaw-dev/openclaw.json`
- `OPENCLAW_GATEWAY_PORT=19001` (Gateway WS + HTTP)
- tarayıcı kontrol hizmeti portu = `19003` (türetilmiş: `gateway.port+2`, yalnızca loopback)
- `canvasHost.port=19005` (türetilmiş: `gateway.port+4`)
- `agents.defaults.workspace` varsayılanı, `--dev` altında `setup`/`onboard` çalıştırdığınızda `~/.openclaw/workspace-dev` olur.

Türetilmiş portlar (başparmak kuralları):

- Temel port = `gateway.port` (veya `OPENCLAW_GATEWAY_PORT` / `--port`)
- tarayıcı kontrol hizmeti portu = temel + 2 (yalnızca loopback)
- `canvasHost.port = base + 4` (veya `OPENCLAW_CANVAS_HOST_PORT` / yapılandırma geçersiz kılma)
- Tarayıcı profili CDP portları `browser.controlPort + 9 .. + 108`’den otomatik ayrılır (profil başına kalıcı).

Örnek başına kontrol listesi:

- benzersiz `gateway.port`
- benzersiz `OPENCLAW_CONFIG_PATH`
- benzersiz `OPENCLAW_STATE_DIR`
- benzersiz `agents.defaults.workspace`
- ayrı WhatsApp numaraları (WA kullanılıyorsa)

Profil başına hizmet kurulumu:

```bash
openclaw --profile main gateway install
openclaw --profile rescue gateway install
```

Örnek:

```bash
OPENCLAW_CONFIG_PATH=~/.openclaw/a.json OPENCLAW_STATE_DIR=~/.openclaw-a openclaw gateway --port 19001
OPENCLAW_CONFIG_PATH=~/.openclaw/b.json OPENCLAW_STATE_DIR=~/.openclaw-b openclaw gateway --port 19002
```

## Protokol (operatör görünümü)

- Tam belgeler: [Gateway protokolü](/gateway/protocol) ve [Köprü protokolü (eski)](/gateway/bridge-protocol).
- İstemciden zorunlu ilk çerçeve: `req {type:"req", id, method:"connect", params:{minProtocol,maxProtocol,client:{id,displayName?,version,platform,deviceFamily?,modelIdentifier?,mode,instanceId?}, caps, auth?, locale?, userAgent? } }`.
- Gateway, `res {type:"res", id, ok:true, payload:hello-ok }` ile yanıtlar (veya hata ile `ok:false`, ardından kapatır).
- El sıkışmadan sonra:
  - İstekler: `{type:"req", id, method, params}` → `{type:"res", id, ok, payload|error}`
  - Olaylar: `{type:"event", event, payload, seq?, stateVersion?}`
- Yapılandırılmış presence girdileri: `{host, ip, version, platform?, deviceFamily?, modelIdentifier?, mode, lastInputSeconds?, ts, reason?, tags?[], instanceId? }` (WS istemcileri için `instanceId`, `connect.client.instanceId`’den gelir).
- `agent` yanıtları iki aşamalıdır: önce `res` onayı `{runId,status:"accepted"}`, ardından çalışma bittikten sonra nihai `res` `{runId,status:"ok"|"error",summary}`; akışlanan çıktı `event:"agent"` olarak gelir.

## Yöntemler (ilk set)

- `health` — tam sağlık anlık görüntüsü (`openclaw health --json` ile aynı şekil).
- `status` — kısa özet.
- `system-presence` — mevcut presence listesi.
- `system-event` — bir presence/sistem notu gönder (yapılandırılmış).
- `send` — etkin kanal(lar) üzerinden mesaj gönder.
- `agent` — bir ajan turu çalıştır (olayları aynı bağlantıda akışlar).
- `node.list` — eşleştirilmiş + şu anda bağlı düğümleri listele (`caps`, `deviceFamily`, `modelIdentifier`, `paired`, `connected` ve ilan edilen `commands` dâhil).
- `node.describe` — bir düğümü tanımla (yetenekler + desteklenen `node.invoke` komutları; eşleştirilmiş düğümler ve şu anda bağlı, eşleştirilmemiş düğümler için çalışır).
- `node.invoke` — bir düğümde komut çağır (örn. `canvas.*`, `camera.*`).
- `node.pair.*` — eşleştirme yaşam döngüsü (`request`, `list`, `approve`, `reject`, `verify`).

Ayrıca bkz: presence’in nasıl üretildiği/tekilleştirildiği ve neden kararlı bir `client.instanceId`’ün önemli olduğu için [Presence](/concepts/presence).

## Olaylar

- `agent` — ajan çalıştırmasından akışlanan araç/çıktı olayları (sıra etiketli).
- `presence` — tüm bağlı istemcilere itilen presence güncellemeleri (stateVersion ile deltalar).
- `tick` — canlılığı doğrulamak için periyodik keepalive/no-op.
- `shutdown` — Gateway çıkıyor; yük, `reason` ve isteğe bağlı `restartExpectedMs` içerir. İstemciler yeniden bağlanmalıdır.

## WebChat entegrasyonu

- WebChat, geçmiş, gönderimler, iptal ve olaylar için doğrudan Gateway WebSocket’i ile konuşan yerel bir SwiftUI UI’dır.
- Uzaktan kullanım aynı SSH/Tailscale tünelinden geçer; bir gateway belirteci yapılandırılmışsa, istemci bunu `connect` sırasında ekler.
- macOS uygulaması tek bir WS üzerinden bağlanır (paylaşılan bağlantı); başlangıç anlık görüntüsünden presence’i doldurur ve UI’yi güncellemek için `presence` olaylarını dinler.

## Yazım ve doğrulama

- Sunucu, her gelen çerçeveyi protokol tanımlarından üretilen JSON Schema’ya karşı AJV ile doğrular.
- İstemciler (TS/Swift) üretilmiş türleri tüketir (TS doğrudan; Swift depo jeneratörü üzerinden).
- Protokol tanımları tek doğruluk kaynağıdır; şema/modelleri yeniden üretmek için:
  - `pnpm protocol:gen`
  - `pnpm protocol:gen:swift`

## Bağlantı anlık görüntüsü

- `hello-ok`, `presence`, `health`, `stateVersion` ve `uptimeMs` ile birlikte `snapshot` içerir; ayrıca istemcilerin ek istekler olmadan hemen render edebilmesi için `policy {maxPayload,maxBufferedBytes,tickIntervalMs}` bulunur.
- `health`/`system-presence` manuel yenileme için kullanılabilir olmaya devam eder, ancak bağlanma anında gerekli değildir.

## Hata kodları (res.error şekli)

- Hatalar `{ code, message, details?, retryable?, retryAfterMs? }` kullanır.
- Standart kodlar:
  - `NOT_LINKED` — WhatsApp doğrulanmamış.
  - `AGENT_TIMEOUT` — ajan, yapılandırılan süre içinde yanıt vermedi.
  - `INVALID_REQUEST` — şema/parametre doğrulaması başarısız.
  - `UNAVAILABLE` — Gateway kapanıyor veya bir bağımlılık kullanılamıyor.

## Keepalive davranışı

- Trafik olmasa bile Gateway’in canlı olduğunu istemcilere bildirmek için periyodik olarak `tick` olayları (veya WS ping/pong) yayımlanır.
- Gönderim/ajan onayları ayrı yanıtlardır; gönderimler için tick’leri aşırı yüklemeyin.

## Tekrar oynatma / boşluklar

- Olaylar tekrar oynatılmaz. İstemciler sıra boşluklarını algılar ve devam etmeden önce yenilemelidir (`health` + `system-presence`). WebChat ve macOS istemcileri artık boşlukta otomatik yeniler.

## Denetim (macOS örneği)

- Hizmeti canlı tutmak için launchd kullanın:
  - Program: `openclaw` yolu
  - Arguments: `gateway`
  - KeepAlive: true
  - StandardOut/Err: dosya yolları veya `syslog`
- Hata durumunda launchd yeniden başlatır; ölümcül yanlış yapılandırma, operatörün fark etmesi için çıkmaya devam etmelidir.
- LaunchAgent’lar kullanıcı başınadır ve oturum açılmış bir oturum gerektirir; başsız kurulumlar için özel bir LaunchDaemon kullanın (paketle gelmez).
  - `openclaw gateway install`, `~/Library/LaunchAgents/bot.molt.gateway.plist` yazar
    (veya `bot.molt.<profile>.plist`; eski `com.openclaw.*` temizlenir).
  - `openclaw doctor`, LaunchAgent yapılandırmasını denetler ve güncel varsayılanlara güncelleyebilir.

## Gateway hizmeti yönetimi (CLI)

Kurulum/başlat/durdur/yeniden başlat/durum için Gateway CLI’yi kullanın:

```bash
openclaw gateway status
openclaw gateway install
openclaw gateway stop
openclaw gateway restart
openclaw logs --follow
```

Notlar:

- `gateway status`, varsayılan olarak hizmetin çözümlenmiş port/yapılandırmasını kullanarak Gateway RPC’yi yoklar (`--url` ile geçersiz kılın).
- `gateway status --deep`, sistem düzeyi taramaları ekler (LaunchDaemon’lar/system unit’leri).
- `gateway status --no-probe`, RPC yoklamasını atlar (ağ kapalıyken faydalı).
- `gateway status --json`, betikler için stabildir.
- `gateway status`, **denetleyici çalışma zamanı**nı (launchd/systemd çalışıyor) **RPC erişilebilirliği**nden (WS bağlanma + durum RPC) ayrı raporlar.
- `gateway status`, “localhost vs LAN bind” karışıklığını ve profil uyuşmazlıklarını önlemek için yapılandırma yolunu + yoklama hedefini yazdırır.
- `gateway status`, hizmet çalışıyor görünürken port kapalıysa son gateway hata satırını içerir.
- `logs`, Gateway dosya günlüğünü RPC üzerinden kuyruklar (manuel `tail`/`grep` gerekmez).
- Başka gateway benzeri hizmetler algılanırsa, OpenClaw profili hizmetleri değilse CLI uyarır.
  Çoğu kurulum için hâlâ **makine başına bir gateway** öneriyoruz; yedeklilik veya kurtarma botu için yalıtılmış profiller/portlar kullanın. [Birden fazla gateway](/gateway/multiple-gateways).
  - Temizlik: `openclaw gateway uninstall` (mevcut hizmet) ve `openclaw doctor` (eski geçişler).
- `gateway install`, zaten kuruluysa no-op’tur; yeniden kurmak için `openclaw gateway install --force` kullanın (profil/env/yol değişiklikleri).

Paketlenmiş mac uygulaması:

- OpenClaw.app, Node tabanlı bir gateway rölesi paketleyebilir ve kullanıcı başına bir LaunchAgent kurar; etiketi
  `bot.molt.gateway` (veya `bot.molt.<profile>`; eski `com.openclaw.*` etiketleri de temiz şekilde kaldırılır).
- Temiz durdurmak için `openclaw gateway stop` (veya `launchctl bootout gui/$UID/bot.molt.gateway`) kullanın.
- Yeniden başlatmak için `openclaw gateway restart` (veya `launchctl kickstart -k gui/$UID/bot.molt.gateway`) kullanın.
  - `launchctl`, yalnızca LaunchAgent kuruluysa çalışır; aksi halde önce `openclaw gateway install` kullanın.
  - Adlandırılmış bir profil çalıştırırken etiketi `bot.molt.<profile>` ile değiştirin.

## Denetim (systemd kullanıcı birimi)

OpenClaw, Linux/WSL2’de varsayılan olarak bir **systemd kullanıcı hizmeti** kurar. Tek kullanıcılı makineler için kullanıcı hizmetlerini öneriyoruz (daha basit env, kullanıcı başına yapılandırma).
Çok kullanıcılı veya her zaman açık sunucular için **sistem hizmeti** kullanın (linger gerekmez, paylaşılan denetim).

`openclaw gateway install`, kullanıcı birimini yazar. `openclaw doctor`, birimi denetler
ve mevcut önerilen varsayılanlarla eşleştirecek şekilde güncelleyebilir.

`~/.config/systemd/user/openclaw-gateway[-<profile>].service` oluşturun:

```
[Unit]
Description=OpenClaw Gateway (profile: <profile>, v<version>)
After=network-online.target
Wants=network-online.target

[Service]
ExecStart=/usr/local/bin/openclaw gateway --port 18789
Restart=always
RestartSec=5
Environment=OPENCLAW_GATEWAY_TOKEN=
WorkingDirectory=/home/youruser

[Install]
WantedBy=default.target
```

Linger’ı etkinleştirin (kullanıcı hizmetinin çıkış/boşta kalmadan sağ kalması için gereklidir):

```
sudo loginctl enable-linger youruser
```

Onboarding bunu Linux/WSL2’de çalıştırır (sudo isteyebilir; `/var/lib/systemd/linger` yazar).
Ardından hizmeti etkinleştirin:

```
systemctl --user enable --now openclaw-gateway[-<profile>].service
```

**Alternatif (sistem hizmeti)** — her zaman açık veya çok kullanıcılı sunucular için,
kullanıcı birimi yerine bir systemd **sistem** birimi kurabilirsiniz (linger gerekmez).
`/etc/systemd/system/openclaw-gateway[-<profile>].service` oluşturun (yukarıdaki birimi kopyalayın,
`WantedBy=multi-user.target`’u değiştirin, `User=` + `WorkingDirectory=` ayarlayın), ardından:

```
sudo systemctl daemon-reload
sudo systemctl enable --now openclaw-gateway[-<profile>].service
```

## Windows (WSL2)

Windows kurulumları **WSL2** kullanmalı ve yukarıdaki Linux systemd bölümünü izlemelidir.

## Operasyonel kontroller

- Canlılık: WS açın ve `req:connect` gönderin → `res` ve `payload.type="hello-ok"` (anlık görüntü ile) bekleyin.
- Hazırlık: `health` çağırın → `ok: true` ve `linkChannel`’de bağlantılı bir kanal (uygunsa) bekleyin.
- Hata ayıklama: `tick` ve `presence` olaylarına abone olun; `status`’ın bağlantılı/kimlik doğrulama yaşını gösterdiğinden; presence girdilerinin Gateway ana makinesini ve bağlı istemcileri gösterdiğinden emin olun.

## Güvenlik garantileri

- Varsayılan olarak ana makine başına bir Gateway varsayın; birden fazla profil çalıştırırsanız portları/durumu yalıtın ve doğru örneği hedefleyin.
- Doğrudan Baileys bağlantılarına geri dönüş yoktur; Gateway kapalıysa gönderimler hızlıca başarısız olur.
- Bağlanma dışı ilk çerçeveler veya hatalı JSON reddedilir ve soket kapatılır.
- Zarif kapanış: kapatmadan önce `shutdown` olayı yayılır; istemciler kapanış + yeniden bağlanmayı ele almalıdır.

## CLI yardımcıları

- `openclaw gateway health|status` — Gateway WS üzerinden sağlık/durum iste.
- `openclaw message send --target <num> --message "hi" [--media ...]` — Gateway üzerinden gönder (WhatsApp için idempotent).
- `openclaw agent --message "hi" --to <num>` — bir ajan turu çalıştır (varsayılan olarak nihaiyi bekler).
- `openclaw gateway call <method> --params '{"k":"v"}'` — hata ayıklama için ham yöntem çağırıcı.
- `openclaw gateway stop|restart` — denetlenen gateway hizmetini durdur/yeniden başlat (launchd/systemd).
- Gateway yardımcı alt komutları, `--url` üzerinde çalışan bir gateway varsayar; artık otomatik olarak bir tane başlatmazlar.

## Migration guidance

- `openclaw gateway` ve eski TCP kontrol portu kullanımını bırakın.
- İstemcileri, zorunlu bağlanma ve yapılandırılmış presence ile WS protokolünü konuşacak şekilde güncelleyin.
