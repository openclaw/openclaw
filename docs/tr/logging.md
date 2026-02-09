---
summary: "Günlükleme genel bakışı: dosya günlükleri, konsol çıktısı, CLI ile izleme ve Control UI"
read_when:
  - You need a beginner-friendly overview of logging
  - Günlük seviyelerini veya biçimlerini yapılandırmak istediğinizde
  - You are troubleshooting and need to find logs quickly
title: "Logging"
---

# Logging

OpenClaw iki yerde günlük tutar:

- **Dosya günlükleri** (JSON satırları) Gateway tarafından yazılır.
- **Konsol çıktısı** terminallerde ve Control UI’da gösterilir.

Bu sayfa, günlüklerin nerede bulunduğunu, nasıl okunacağını ve günlük
seviyeleri ile biçimlerinin nasıl yapılandırılacağını açıklar.

## Where logs live

Varsayılan olarak Gateway, aşağıdaki dizin altında dönen bir günlük dosyası yazar:

`/tmp/openclaw/openclaw-YYYY-MM-DD.log`

Tarih, gateway ana makinesinin yerel saat dilimini kullanır.

Bunu `~/.openclaw/openclaw.json` içinde geçersiz kılabilirsiniz:

```json
{
  "logging": {
    "file": "/path/to/openclaw.log"
  }
}
```

## How to read logs

### CLI: canlı izleme (önerilir)

Gateway günlük dosyasını RPC üzerinden izlemek için CLI’yi kullanın:

```bash
openclaw logs --follow
```

Çıktı modları:

- **TTY oturumları**: düzenli, renkli, yapılandırılmış günlük satırları.
- **TTY olmayan oturumlar**: düz metin.
- `--json`: satır sınırlı JSON (satır başına bir günlük olayı).
- `--plain`: TTY oturumlarında düz metni zorla.
- `--no-color`: ANSI renklerini devre dışı bırak.

JSON modunda, CLI `type` etiketli nesneler üretir:

- `meta`: akış meta verileri (dosya, imleç, boyut)
- `log`: ayrıştırılmış günlük girdisi
- `notice`: kırpma / döndürme ipuçları
- `raw`: ayrıştırılmamış günlük satırı

Gateway’e ulaşılamıyorsa, CLI aşağıdakini çalıştırmanız için kısa bir ipucu yazdırır:

```bash
openclaw doctor
```

### Control UI (web)

Control UI’daki **Logs** sekmesi, aynı dosyayı `logs.tail` kullanarak izler.
Nasıl açılacağını öğrenmek için [/web/control-ui](/web/control-ui) sayfasına bakın.

### Yalnızca kanal günlükleri

Kanal etkinliğini (WhatsApp/Telegram vb.) filtrelemek için şunu kullanın:

```bash
openclaw channels logs --channel whatsapp
```

## Log formats

### Dosya günlükleri (JSONL)

Günlük dosyasındaki her satır bir JSON nesnesidir. CLI ve Control UI bu
girdileri ayrıştırarak yapılandırılmış çıktı (zaman, seviye, alt sistem, mesaj) oluşturur.

### Konsol çıktısı

Konsol günlükleri **TTY farkındadır** ve okunabilirlik için biçimlendirilir:

- Alt sistem önekleri (örn. `gateway/channels/whatsapp`)
- Seviye renklendirme (info/warn/error)
- İsteğe bağlı kompakt veya JSON modu

Konsol biçimlendirmesi `logging.consoleStyle` tarafından kontrol edilir.

## Günlüklemeyi yapılandırma

Tüm günlükleme yapılandırması, `~/.openclaw/openclaw.json` içindeki `logging` altında bulunur.

```json
{
  "logging": {
    "level": "info",
    "file": "/tmp/openclaw/openclaw-YYYY-MM-DD.log",
    "consoleLevel": "info",
    "consoleStyle": "pretty",
    "redactSensitive": "tools",
    "redactPatterns": ["sk-.*"]
  }
}
```

### Günlük seviyeleri

- `logging.level`: **dosya günlükleri** (JSONL) seviyesi.
- `logging.consoleLevel`: **konsol** ayrıntı seviyesi.

`--verbose` yalnızca konsol çıktısını etkiler; dosya günlük seviyelerini değiştirmez.

### Konsol stilleri

`logging.consoleStyle`:

- `pretty`: insan dostu, renkli, zaman damgalı.
- `compact`: daha sıkı çıktı (uzun oturumlar için en iyisi).
- `json`: satır başına JSON (günlük işleyiciler için).

### Redaction

Araç özetleri, konsola ulaşmadan önce hassas belirteçleri sansürleyebilir:

- `logging.redactSensitive`: `off` | `tools` (varsayılan: `tools`)
- `logging.redactPatterns`: varsayılan kümeyi geçersiz kılmak için regex dizgileri listesi

Sansürleme **yalnızca konsol çıktısını** etkiler ve dosya günlüklerini değiştirmez.

## Tanılama + OpenTelemetry

Tanılamalar, model çalıştırmaları **ve** mesaj akışı telemetrisi (webhook’lar,
kuyruklama, oturum durumu) için yapılandırılmış, makine tarafından okunabilir
olaylardır. Günlüklerin yerini **almazlar**; metrikleri, izleri ve diğer
dışa aktarıcıları beslemek için vardırlar.

Tanılama olayları süreç içinde üretilir, ancak dışa aktarıcılar yalnızca
tanılamalar + dışa aktarıcı eklentisi etkinleştirildiğinde bağlanır.

### OpenTelemetry ve OTLP karşılaştırması

- **OpenTelemetry (OTel)**: izler, metrikler ve günlükler için veri modeli + SDK’lar.
- **OTLP**: OTel verilerini bir toplayıcıya/arka uca dışa aktarmak için kullanılan tel protokolü.
- OpenClaw bugün **OTLP/HTTP (protobuf)** üzerinden dışa aktarır.

### Dışa aktarılan sinyaller

- **Metrikler**: sayaçlar + histogramlar (belirteç kullanımı, mesaj akışı, kuyruklama).
- **İzler**: model kullanımı + webhook/mesaj işleme için span’ler.
- **Günlükler**: `diagnostics.otel.logs` etkinleştirildiğinde OTLP üzerinden dışa aktarılır. Günlük
  hacmi yüksek olabilir; `logging.level` ve dışa aktarıcı filtrelerini göz önünde bulundurun.

### Diagnostic event catalog

Model kullanımı:

- `model.usage`: belirteçler, maliyet, süre, bağlam, sağlayıcı/model/kanal, oturum kimlikleri.

Mesaj akışı:

- `webhook.received`: kanal başına webhook girişi.
- `webhook.processed`: webhook işlendi + süre.
- `webhook.error`: webhook işleyici hataları.
- `message.queued`: işleme için kuyruğa alınan mesaj.
- `message.processed`: sonuç + süre + isteğe bağlı hata.

Kuyruk + oturum:

- `queue.lane.enqueue`: komut kuyruğu şeridi kuyruğa alma + derinlik.
- `queue.lane.dequeue`: komut kuyruğu şeridi kuyruktan çıkarma + bekleme süresi.
- `session.state`: oturum durumu geçişi + neden.
- `session.stuck`: oturum takılı kaldı uyarısı + yaş.
- `run.attempt`: çalıştırma yeniden deneme/deneme meta verileri.
- `diagnostic.heartbeat`: toplu sayaçlar (webhook’lar/kuyruk/oturum).

### Tanılamaları etkinleştirme (dışa aktarıcı yok)

Tanılama olaylarının eklentiler veya özel hedefler için kullanılabilir olmasını istiyorsanız bunu kullanın:

```json
{
  "diagnostics": {
    "enabled": true
  }
}
```

### Tanılama bayrakları (hedefli günlükler)

`logging.level` yükseltmeden, ek ve hedefli hata ayıklama günlüklerini açmak için bayrakları kullanın.
Bayraklar büyük/küçük harfe duyarsızdır ve joker karakterleri destekler (örn. `telegram.*` veya `*`).

```json
{
  "diagnostics": {
    "flags": ["telegram.http"]
  }
}
```

Env override (one-off):

```
OPENCLAW_DIAGNOSTICS=telegram.http,telegram.payload
```

Notlar:

- Bayrak günlükleri standart günlük dosyasına gider (`logging.file` ile aynı).
- Çıktı, `logging.redactSensitive`’e göre hâlâ sansürlenir.
- Tam kılavuz: [/diagnostics/flags](/diagnostics/flags).

### OpenTelemetry’ye dışa aktarma

Tanılamalar, `diagnostics-otel` eklentisi (OTLP/HTTP) üzerinden dışa aktarılabilir. Bu,
OTLP/HTTP kabul eden herhangi bir OpenTelemetry toplayıcı/arka uç ile çalışır.

```json
{
  "plugins": {
    "allow": ["diagnostics-otel"],
    "entries": {
      "diagnostics-otel": {
        "enabled": true
      }
    }
  },
  "diagnostics": {
    "enabled": true,
    "otel": {
      "enabled": true,
      "endpoint": "http://otel-collector:4318",
      "protocol": "http/protobuf",
      "serviceName": "openclaw-gateway",
      "traces": true,
      "metrics": true,
      "logs": true,
      "sampleRate": 0.2,
      "flushIntervalMs": 60000
    }
  }
}
```

Notlar:

- Eklentiyi `openclaw plugins enable diagnostics-otel` ile de etkinleştirebilirsiniz.
- `protocol` şu anda yalnızca `http/protobuf`’i destekler. `grpc` yok sayılır.
- Metrikler; belirteç kullanımı, maliyet, bağlam boyutu, çalıştırma süresi ve mesaj akışı
  sayaçları/histogramlarını (webhook’lar, kuyruklama, oturum durumu, kuyruk derinliği/bekleme) içerir.
- İzler/metrikler `traces` / `metrics` ile açılıp kapatılabilir (varsayılan: açık). İzler,
  etkinleştirildiğinde model kullanım span’leri ile webhook/mesaj işleme span’lerini içerir.
- Toplayıcınız kimlik doğrulama gerektiriyorsa `headers` ayarlayın.
- Desteklenen ortam değişkenleri: `OTEL_EXPORTER_OTLP_ENDPOINT`,
  `OTEL_SERVICE_NAME`, `OTEL_EXPORTER_OTLP_PROTOCOL`.

### Dışa aktarılan metrikler (adlar + türler)

Model kullanımı:

- `openclaw.tokens` (counter, attrs: `openclaw.token`, `openclaw.channel`,
  `openclaw.provider`, `openclaw.model`)
- `openclaw.cost.usd` (counter, attrs: `openclaw.channel`, `openclaw.provider`,
  `openclaw.model`)
- `openclaw.run.duration_ms` (histogram, attrs: `openclaw.channel`,
  `openclaw.provider`, `openclaw.model`)
- `openclaw.context.tokens` (histogram, attrs: `openclaw.context`,
  `openclaw.channel`, `openclaw.provider`, `openclaw.model`)

Mesaj akışı:

- `openclaw.webhook.received` (counter, attrs: `openclaw.channel`,
  `openclaw.webhook`)
- `openclaw.webhook.error` (counter, attrs: `openclaw.channel`,
  `openclaw.webhook`)
- `openclaw.webhook.duration_ms` (histogram, attrs: `openclaw.channel`,
  `openclaw.webhook`)
- `openclaw.message.queued` (counter, attrs: `openclaw.channel`,
  `openclaw.source`)
- `openclaw.message.processed` (counter, attrs: `openclaw.channel`,
  `openclaw.outcome`)
- `openclaw.message.duration_ms` (histogram, attrs: `openclaw.channel`,
  `openclaw.outcome`)

Kuyruklar + oturumlar:

- `openclaw.queue.lane.enqueue` (counter, attrs: `openclaw.lane`)
- `openclaw.queue.lane.dequeue` (counter, attrs: `openclaw.lane`)
- `openclaw.queue.depth` (histogram, attrs: `openclaw.lane` veya
  `openclaw.channel=heartbeat`)
- `openclaw.queue.wait_ms` (histogram, attrs: `openclaw.lane`)
- `openclaw.session.state` (counter, attrs: `openclaw.state`, `openclaw.reason`)
- `openclaw.session.stuck` (counter, attrs: `openclaw.state`)
- `openclaw.session.stuck_age_ms` (histogram, attrs: `openclaw.state`)
- `openclaw.run.attempt` (counter, attrs: `openclaw.attempt`)

### Dışa aktarılan span’ler (adlar + temel öznitelikler)

- `openclaw.model.usage`
  - `openclaw.channel`, `openclaw.provider`, `openclaw.model`
  - `openclaw.sessionKey`, `openclaw.sessionId`
  - `openclaw.tokens.*` (input/output/cache_read/cache_write/total)
- `openclaw.webhook.processed`
  - `openclaw.channel`, `openclaw.webhook`, `openclaw.chatId`
- `openclaw.webhook.error`
  - `openclaw.channel`, `openclaw.webhook`, `openclaw.chatId`,
    `openclaw.error`
- `openclaw.message.processed`
  - `openclaw.channel`, `openclaw.outcome`, `openclaw.chatId`,
    `openclaw.messageId`, `openclaw.sessionKey`, `openclaw.sessionId`,
    `openclaw.reason`
- `openclaw.session.stuck`
  - `openclaw.state`, `openclaw.ageMs`, `openclaw.queueDepth`,
    `openclaw.sessionKey`, `openclaw.sessionId`

### Örnekleme + boşaltma

- İz örnekleme: `diagnostics.otel.sampleRate` (0.0–1.0, yalnızca kök span’ler).
- Metrik dışa aktarma aralığı: `diagnostics.otel.flushIntervalMs` (en az 1000ms).

### Protokol notları

- OTLP/HTTP uç noktaları `diagnostics.otel.endpoint` veya
  `OTEL_EXPORTER_OTLP_ENDPOINT` üzerinden ayarlanabilir.
- Uç nokta zaten `/v1/traces` veya `/v1/metrics` içeriyorsa, olduğu gibi kullanılır.
- Uç nokta zaten `/v1/logs` içeriyorsa, günlükler için olduğu gibi kullanılır.
- `diagnostics.otel.logs`, ana günlükleyici çıktısı için OTLP günlük dışa aktarmayı etkinleştirir.

### Log export behavior

- OTLP günlükleri, `logging.file`’e yazılan aynı yapılandırılmış kayıtları kullanır.
- `logging.level`’a (dosya günlük seviyesi) uyar. Konsol sansürlemesi OTLP günlüklerine **uygulanmaz**.
- Yüksek hacimli kurulumlar, OTLP toplayıcı örnekleme/filtrelemeyi tercih etmelidir.

## Sorun giderme ipuçları

- **Gateway’e ulaşılamıyor mu?** Önce `openclaw doctor` çalıştırın.
- **Günlükler boş mu?** Gateway’in çalıştığını ve `logging.file` içindeki dosya yoluna yazdığını kontrol edin.
- **Daha fazla ayrıntı mı gerekli?** `logging.level`’yi `debug` veya `trace` olarak ayarlayın ve yeniden deneyin.
