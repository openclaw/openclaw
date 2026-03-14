---
summary: "Günlüğe kaydetmeye genel bakış: dosya günlükleri, konsol çıktısı, CLI izleme ve Kontrol UI"
read_when:
  - Günlüğe kaydetmeye başlangıç düzeyinde genel bakışa ihtiyacınız var
  - Günlük düzeylerini veya formatlarını yapılandırmak istiyorsunuz
  - Sorun gendiriyorsunuz ve günlükleri hızlıca bulmanız gerekiyor
title: "Günlüğe Kaydetme"
---

# Günlüğe Kaydetme

OpenClaw iki yerde günlük kaydeder:

- Gateway tarafından yazılan **Dosya günlükleri** (JSON satırları).
- Terminallerde ve Kontrol UI'de gösterilen **Konsol çıktısı**.

Bu sayfa, günlüklerin nerede olduğunu, nasıl okunacağını ve günlük düzeylerinin ve formatlarının nasıl yapılandırılacağını açıklar.

## Günlüklerin konumu

Varsayılan olarak, Gateway aşağıdaki dönerü günlük dosyasını yazar:

`/tmp/openclaw/openclaw-YYYY-MM-DD.log`

Tarih, gateway ana bilgisayarının yerel saat dilimini kullanır.

 Bunu `~/.openclaw/openclaw.json` içinde geçersiz kılabilirsiniz:

```json
{
  "logging": {
    "file": "/path/to/openclaw.log"
  }
}
```

## Günlükleri okuma

### CLI: canlı izleme (önerilen)

Gateway günlük dosyasını RPC üzerinden izlemek için CLI'yi kullanın:

```bash
openclaw logs --follow
```

Çıktı modları:

- **TTY oturumları**: güzel, renklendirilmiş, yapılandırılmış günlük satırları.
- **TTY olmayan oturumlar**: düz metin.
- `--json`: satır sınırlı JSON (satır başına bir günlük olayı).
- `--plain`: TTY oturumlarında düz metin zorla.
- `--no-color`: ANSI renklerini devre dışı bırakır.

JSON modunda, CLI `type` etiketli nesneler yayar:

- `meta`: akış meta verileri (dosya, imleç, boyut)
- `log`: ayrıştırılmış günlük girişi
- `notice`: kısaltma / döndürme ipuçları
- `raw`: ayrıştırılmamış günlük satırı

Gateway'e ulaşılamıyorsa, CLI çalıştırmak için kısa bir ipucu yazdırır:

```bash
openclaw doctor
```

### Kontrol UI (web)

Kontrol UI'nin **Günlükler** sekmesi, `logs.tail` kullanarak aynı dosyayı izler.
Nasıl açılacağı için bkz. [/web/control-ui](/web/control-ui).

### Yalnızca kanal günlükleri

Kanal etkinliğini filtrelemek için (WhatsApp/Telegram/vb.):

```bash
openclaw channels logs --channel whatsapp
```

## Günlük formatları

### Dosya günlükleri (JSONL)

Günlük dosyasındaki her satır bir JSON nesnesidir. CLI ve Kontrol UI, yapılandırılmış çıktı oluşturmak için bu girişleri ayrıştırır (zaman, düzey, alt sistem, mesaj).

### Konsol çıktısı

Konsol günlükleri **TTY farkındalıklı** ve okunabilirlik için biçimlendirilmiştir:

- Alt sistem önekleri (örn. `gateway/channels/whatsapp`)
- Düzey renklendirmesi (info/warn/error)
- İsteğe bağlı kompakt veya JSON modu

Konsol biçimlendirmesi `logging.consoleStyle` tarafından kontrol edilir.

## Günlüğe kaydetmeyi yapılandırma

Tüm günlük yapılandırması `~/.openclaw/openclaw.json` içindeki `logging` altında bulunur.

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

### Günlük düzeyleri

- `logging.level`: **dosya günlükleri** (JSONL) düzeyi.
- `logging.consoleLevel`: **konsol** ayrıntı düzeyi.

Her ikisini de **`OPENCLAW_LOG_LEVEL`** ortam değişkeniyle geçersiz kılabilirsiniz (örn. `OPENCLAW_LOG_LEVEL=debug`). Ortam değişkeni, yapılandırma dosyasının önüne geçer, böylece tek bir çalıştırmada `openclaw.json` dosyasını düzenlemeden ayrıntı düzeyini artırabilirsiniz. Ayrıca **`--log-level <level>`** global CLI seçeneğini de geçirebilirsiniz (örneğin, `openclaw --log-level debug gateway run`), bu da o komut için ortam değişkenini geçersiz kılar.

`--verbose` yalnızca konsol çıktısını etkiler; dosya günlük düzeylerini değiştirmez.

### Konsol stilleri

`logging.consoleStyle`:

- `pretty`: insan dostu, renkli, zaman damgalı.
- `kompakt`: daha sıkı çıktı (uzun oturumlar için en iyisi).
- `json`: satır başına JSON (günlük işlemciler için).

### Yeniden düzenleme

Araç özetleri, konsola ulaşmadan önce hassas jetonları yeniden düzenleyebilir:

- `logging.redactSensitive`: `off` | `tools` (varsayılan: `tools`)
- `logging.redactPatterns`: varsayılan seti geçersiz kılmak için regex dizeleri listesi

Yeniden düzenleme **yalnızca konsol çıktısını** etkiler ve dosya günlüklerini değiştirmez.

## Tanılama + OpenTelemetry

Tanılama, model çalıştırmaları **ve** mesaj akışı telemetresi (webhook'lar, kuyrulama, oturum durumu) için yapılandırılmış, makine tarafından okunabilir olaylardır. Günlüklerin **yerine geçmezler**; metrikler, izlemeler ve diğer dışa aktarıcıları beslemek için mevcutturlar.

Tanılama olayları işlem içinde yayılır, ancak dışa aktarıcılar yalnızca tanılama + dışa aktarıcı eklentisi etkinleştirildiğinde bağlanır.

### OpenTelemetry vs OTLP

- **OpenTelemetry (OTel)**: İzleme, metrikler ve günlükler için veri modeli + SDK'ları.
- **OTLP**: OTel verilerini bir toplayıcıye/yedekleme aktarmak için kullanılan kablo protokolü.
- OpenClaw bugün **OTLP/HTTP (protobuf)** üzerinden dışa aktarır.

### Dışa aktarılan sinyaller

- **Metrikler**: Sayaçlar + histogramlar (token kullanımı, mesaj akışı, kuyrulama).
- **İzlemeler**: Model kullanımı + webhook/mesaj işleme için spanlar.
- **Günlükler**: `diagnostics.otel.logs` etkinleştirildiğinde OTLP üzerinden dışa aktarılır. Günlük hacmi yüksek olabilir; `logging.level` ve dışa aktarıcı filtrelerini göz önünde bulundurun.

### Tanılama olay kataloğu

Model kullanımı:

- `model.usage`: token, maliyet, süre, bağlam, sağlayıcı/model/kanal, oturum kimlikleri.

Mesaj akışı:

- `webhook.received`: kanal başına webhook girişi.
- `webhook.processed`: webhook işlendi + süre.
- `webhook.error`: webhook işleyici hataları.
- `message.queued`: işlenmek üzere kuyruğa alınan mesaj.
- `message.processed`: sonuç + süre + isteğe bağlı hata.

Kuyruk + oturum:

- `queue.lane.enqueue`: komut kuyruğu şeridi kuyruğa alma + derinlik.
- `queue.lane.dequeue`: komut kuyruğu şeridi kuyruktan çıkarma + bekleme süresi.
- `session.state`: oturum durumu geçişi + neden.
- `session.stuck`: oturum takılma uyarısı + yaş.
- `run.attempt`: çalıştırma yeniden deneme/deneme meta verileri.
- `diagnostic.heartbeat`: toplu sayaçlar (webhook/kuyruk/oturum).

### Tanılamayı etkinleştirme (dışa aktarıcı yok)

Tanılama olaylarının eklentilerde veya özel havuzlarda kullanılabilir olmasını istiyorsanız bunu kullanın:

```json
{
  "diagnostics": {
    "enabled": true
  }
}
```

### Tanılama bayrakları (hedefli günlükler)

`logging.level` yükseltmeden ekstra, hedefli hata ayıklama günlüklerini açmak için bayrakları kullanın.
Bayraklar büyük/küçük harfe duyarsızdır ve joker karakterleri destekler (örn. `telegram.*` veya `*`).

```json
{
  "diagnostics": {
    "flags": ["telegram.http"]
  }
}
```

Env geçersiz kılma (tek seferlik):

```
OPENCLAW_DIAGNOSTICS=telegram.http,telegram.payload
```

Notlar:

- Bayrak günlükleri standart günlük dosyasına gider (`logging.file` ile aynı).
- Çıktı yine de `logging.redactSensitive` uyarınca yeniden düzenlenir.
- Tam kılavuz: [/diagnostics/flags](/diagnostics/flags).

### OpenTelemetry'e Dışa Aktarma

Tanılama, `diagnostics-otel` eklentisi (OTLP/HTTP) aracılığıyla dışa aktarılabilir. Bu, OTLP/HTTP kabul eden herhangi bir OpenTelemetry toplayıcısı/yedekleme ile çalışır.

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
- `protocol` şu anda yalnızca `http/protobuf` destekliyor. `grpc` yok sayılır.
- Metrikler token kullanımı, maliyet, bağlam boyutu, çalıştırma süresi ve mesaj akışı sayaçlarını/histogramlarını (webhook, kuyrulama, oturum durumu, kuyruk derinliği/bekleme) içerir.
- İzleme/metrikler `traces` / `metrics` ile değiştirilebilir (varsayılan: açık). İzlemeler, etkinleştirildiğinde model kullanımı spanlarını ve webhook/mesaj işleme spanlarını içerir.
- Toplayıcınız kimlik doğrulama gerektirdiğinde `headers` ayarlayın.
- Desteklenen ortam değişkenleri: `OTEL_EXPORTER_OTLP_ENDPOINT`, `OTEL_SERVICE_NAME`, `OTEL_EXPORTER_OTLP_PROTOCOL`.

### Dışa Aktarılan Metrikler (ad + türler)

Model kullanımı:

- `openclaw.tokens` (sayaç, öznitelikler: `openclaw.token`, `openclaw.channel`, `openclaw.provider`, `openclaw.model`)
- `openclaw.cost.usd` (sayaç, öznitelikler: `openclaw.channel`, `openclaw.provider`, `openclaw.model`)
- `openclaw.run.duration_ms` (histogram, öznitelikler: `openclaw.channel`, `openclaw.provider`, `openclaw.model`)
- `openclaw.context.tokens` (histogram, öznitelikler: `openclaw.context`, `openclaw.channel`, `openclaw.provider`, `openclaw.model`)

Mesaj akışı:

- `openclaw.webhook.received` (sayaç, öznitelikler: `openclaw.channel`, `openclaw.webhook`)
- `openclaw.webhook.error` (sayaç, öznitelikler: `openclaw.channel`, `openclaw.webhook`)
- `openclaw.webhook.duration_ms` (histogram, öznitelikler: `openclaw.channel`, `openclaw.webhook`)
- `openclaw.message.queued` (sayaç, öznitelikler: `openclaw.channel`, `openclaw.source`)
- `openclaw.message.processed` (sayaç, öznitelikler: `openclaw.channel`, `openclaw.outcome`)
- `openclaw.message.duration_ms` (histogram, öznitelikler: `openclaw.channel`, `openclaw.outcome`)

Kuyruklar + oturumlar:

- `openclaw.queue.lane.enqueue` (sayaç, öznitelikler: `openclaw.lane`)
- `openclaw.queue.lane.dequeue` (sayaç, öznitelikler: `openclaw.lane`)
- `openclaw.queue.depth` (histogram, öznitelikler: `openclaw.lane` veya `openclaw.channel=heartbeat`)
- `openclaw.queue.wait_ms` (histogram, öznitelikler: `openclaw.lane`)
- `openclaw.session.state` (sayaç, öznitelikler: `openclaw.state`, `openclaw.reason`)
- `openclaw.session.stuck` (sayaç, öznitelikler: `openclaw.state`)
- `openclaw.session.stuck_age_ms` (histogram, öznitelikler: `openclaw.state`)
- `openclaw.run.attempt` (sayaç, öznitelikler: `openclaw.attempt`)

### Dışa Aktarılan Spanlar (ad + ana öznitelikler)

- `openclaw.model.usage`
  - `openclaw.channel`, `openclaw.provider`, `openclaw.model`
  - `openclaw.sessionKey`, `openclaw.sessionId`
  - `openclaw.tokens.*` (input/output/cache_read/cache_write/total)
- `openclaw.webhook.processed`
  - `openclaw.channel`, `openclaw.webhook`, `openclaw.chatId`
- `openclaw.webhook.error`
  - `openclaw.channel`, `openclaw.webhook`, `openclaw.chatId`, `openclaw.error`
- `openclaw.message.processed`
  - `openclaw.channel`, `openclaw.outcome`, `openclaw.chatId`, `openclaw.messageId`, `openclaw.sessionKey`, `openclaw.sessionId`, `openclaw.reason`
- `openclaw.session.stuck`
  - `openclaw.state`, `openclaw.ageMs`, `openclaw.queueDepth`, `openclaw.sessionKey`, `openclaw.sessionKey`

### Örnekleme + temizleme

- İzleme örnekleme: `diagnostics.otel.sampleRate` (0.0–1.0, yalnızca kök spanlar).
- Metrik dışa aktarma aralığı: `diagnostics.otel.flushIntervalMs` (en az 1000ms).

### Protokol notları

- OTLP/HTTP uç noktaları `diagnostics.otel.endpoint` veya `OTEL_EXPORTER_OTLP_ENDPOINT` aracılığıyla ayarlanabilir.
- Uç nokta zaten `/v1/traces` veya `/v1/metrics` içeriyorsa olduğu gibi kullanılır.
- Uç nokta zaten `/v1/logs` içeriyorsa günlükler için olduğu gibi kullanılır.
- `diagnostics.otel.logs`, ana günlük çıktısı için OTLP günlük dışa aktarmayı etkinleştirir.

### Günlük dışa aktarma davranışı

- OTLP günlükleri `logging.file` içine yazılan aynı yapılandırılmış kayıtları kullanır.
- `logging.level` (dosya günlük düzeyi) saygı gösterir. Konsol yeniden düzenlemesi OTLP günlüklerine **uygulanmaz**.
- Yüksek hacimli kurulumlar OTLP toplayıcı örnekleme/filtreleme tercih etmelidir.

## Sorun giderme ipuçları

- **Gateway'e ulaşılamıyor mu?** Önce `openclaw doctor` çalıştırın.
- **Günlükler boş mu?** Gateway'in çalıştığını ve `logging.file` içindeki dosya yoluna yazdığını kontrol edin.
- **Daha fazla ayrıntıya mı ihtiyacınız var?** `logging.level` değerini `debug` veya `trace` olarak ayarlayın ve yeniden deneyin.
