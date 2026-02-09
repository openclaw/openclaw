---
summary: "Gateway zamanlayıcısı için cron işleri + uyandırmalar"
read_when:
  - Arka plan işleri veya uyandırmalar zamanlanırken
  - Kalp atışlarıyla birlikte ya da onların yanında çalışması gereken otomasyon bağlanırken
  - Zamanlanmış görevler için heartbeat ile cron arasında karar verilirken
title: "Cron İşleri"
---

# Cron işleri (Gateway zamanlayıcısı)

> **Cron mu Heartbeat mi?** Her birinin ne zaman kullanılacağına dair rehber için [Cron vs Heartbeat](/automation/cron-vs-heartbeat) bölümüne bakın.

Cron, Gateway’in yerleşik zamanlayıcısıdır. İşleri kalıcı olarak saklar, ajanı
doğru zamanda uyandırır ve isteğe bağlı olarak çıktıyı bir sohbete iletebilir.

_“Bunu her sabah çalıştır”_ veya _“ajanı 20 dakika sonra dürt”_ istiyorsanız,
mekanizma cron’dur.

Sorun giderme: [/automation/troubleshooting](/automation/troubleshooting)

## TL;DR

- Cron **Gateway içinde** çalışır (modelin içinde değil).
- Yeniden başlatmalarda programların kaybolmaması için işler `~/.openclaw/cron/` altında kalıcıdır.
- İki yürütme biçimi:
  - **Ana oturum**: bir sistem olayı kuyruğa alınır, ardından bir sonraki heartbeat’te çalışır.
  - **İzole**: `cron:<jobId>` içinde adanmış bir ajan dönüşü çalıştırır; iletim (varsayılan olarak duyur veya hiçbiri).
- Uyandırmalar birinci sınıftır: bir iş “şimdi uyandır” ile “bir sonraki heartbeat” arasında seçim yapabilir.

## Hızlı başlangıç (uygulanabilir)

Tek seferlik bir hatırlatıcı oluşturun, varlığını doğrulayın ve hemen çalıştırın:

```bash
openclaw cron add \
  --name "Reminder" \
  --at "2026-02-01T16:00:00Z" \
  --session main \
  --system-event "Reminder: check the cron docs draft" \
  --wake now \
  --delete-after-run

openclaw cron list
openclaw cron run <job-id>
openclaw cron runs --id <job-id>
```

İletimli, yinelenen izole bir iş zamanlayın:

```bash
openclaw cron add \
  --name "Morning brief" \
  --cron "0 7 * * *" \
  --tz "America/Los_Angeles" \
  --session isolated \
  --message "Summarize overnight updates." \
  --announce \
  --channel slack \
  --to "channel:C1234567890"
```

## Araç çağrısı eşdeğerleri (Gateway cron aracı)

Kanonik JSON şekilleri ve örnekler için [Araç çağrıları için JSON şeması](/automation/cron-jobs#json-schema-for-tool-calls) bölümüne bakın.

## Cron işlerinin saklandığı yer

Cron işleri varsayılan olarak Gateway ana makinesinde `~/.openclaw/cron/jobs.json` konumunda saklanır.
Gateway dosyayı belleğe yükler ve değişikliklerde geri yazar; bu nedenle manuel düzenlemeler
yalnızca Gateway durdurulduğunda güvenlidir. Değişiklikler için `openclaw cron add/edit` veya cron
araç çağrısı API’sini tercih edin.

## Yeni başlayanlar için genel bakış

Bir cron işini şöyle düşünün: **ne zaman** çalışacağı + **ne** yapacağı.

1. **Bir zamanlama seçin**
   - Tek seferlik hatırlatıcı → `schedule.kind = "at"` (CLI: `--at`)
   - Yinelenen iş → `schedule.kind = "every"` veya `schedule.kind = "cron"`
   - ISO zaman damganızda saat dilimi yoksa **UTC** olarak değerlendirilir.

2. **Nerede çalışacağını seçin**
   - `sessionTarget: "main"` → ana bağlamla bir sonraki heartbeat sırasında çalışır.
   - `sessionTarget: "isolated"` → `cron:<jobId>` içinde adanmış bir ajan dönüşü çalıştırır.

3. **Yükü seçin**
   - Ana oturum → `payload.kind = "systemEvent"`
   - İzole oturum → `payload.kind = "agentTurn"`

İsteğe bağlı: tek seferlik işler (`schedule.kind = "at"`) varsayılan olarak başarıdan sonra silinir. Saklamak için
`deleteAfterRun: false` ayarlayın (başarıdan sonra devre dışı kalırlar).

## Kavramlar

### İşler

Bir cron işi aşağıdakilerle saklanan bir kayıttır:

- bir **zamanlama** (ne zaman çalışacağı),
- bir **yük** (ne yapacağı),
- isteğe bağlı **iletim modu** (duyur veya hiçbiri).
- isteğe bağlı **ajan bağlama** (`agentId`): işi belirli bir ajan altında çalıştırır; yoksa
  veya bilinmiyorsa gateway varsayılan ajana geri döner.

İşler, kararlı bir `jobId` ile tanımlanır (CLI/Gateway API’leri tarafından kullanılır).
Ajan araç çağrılarında `jobId` kanoniktir; uyumluluk için eski `id` kabul edilir.
Tek seferlik işler varsayılan olarak başarıdan sonra otomatik silinir; saklamak için `deleteAfterRun: false` ayarlayın.

### Zamanlamalar

Cron üç zamanlama türünü destekler:

- `at`: `schedule.at` (ISO 8601) ile tek seferlik zaman damgası.
- `every`: sabit aralık (ms).
- `cron`: isteğe bağlı IANA saat dilimi ile 5 alanlı cron ifadesi.

Cron ifadeleri `croner` kullanır. Saat dilimi belirtilmezse, Gateway ana makinesinin
yerel saat dilimi kullanılır.

### Ana vs izole yürütme

#### Ana oturum işleri (sistem olayları)

Ana işler bir sistem olayını kuyruğa alır ve isteğe bağlı olarak heartbeat çalıştırıcısını uyandırır.
`payload.kind = "systemEvent"` kullanmaları gerekir.

- `wakeMode: "now"` (varsayılan): olay anında bir heartbeat çalıştırmasını tetikler.
- `wakeMode: "next-heartbeat"`: olay bir sonraki planlı heartbeat’i bekler.

Normal heartbeat istemi + ana oturum bağlamını istediğinizde en uygun seçenektir.
[Heartbeat](/gateway/heartbeat).

#### İzole işler (adanmış cron oturumları)

İzole işler, `cron:<jobId>` oturumunda adanmış bir ajan dönüşü çalıştırır.

Temel davranışlar:

- İzlenebilirlik için istem `[cron:<jobId> <job name>]` ile öneklenir.
- Her çalıştırma **yeni bir oturum kimliği** başlatır (önceki konuşma taşınmaz).
- Varsayılan davranış: `delivery` atlanırsa, izole işler bir özet duyurur (`delivery.mode = "announce"`).
- `delivery.mode` (yalnızca izole) ne olacağını seçer:
  - `announce`: hedef kanala bir özet iletir ve ana oturuma kısa bir özet gönderir.
  - `none`: yalnızca dahili (iletim yok, ana oturum özeti yok).
- `wakeMode`, ana oturum özetinin ne zaman gönderileceğini kontrol eder:
  - `now`: anında heartbeat.
  - `next-heartbeat`: bir sonraki planlı heartbeat’i bekler.

Ana sohbet geçmişinizi spamlamaması gereken gürültülü, sık veya “arka plan işleri” için izole işleri kullanın.

### Yük şekilleri (ne çalışır)

İki yük türü desteklenir:

- `systemEvent`: yalnızca ana oturum, heartbeat istemi üzerinden yönlendirilir.
- `agentTurn`: yalnızca izole oturum, adanmış bir ajan dönüşü çalıştırır.

Yaygın `agentTurn` alanları:

- `message`: gerekli metin istemi.
- `model` / `thinking`: isteğe bağlı geçersiz kılmalar (aşağıya bakın).
- `timeoutSeconds`: isteğe bağlı zaman aşımı geçersiz kılması.

İletim yapılandırması (yalnızca izole işler):

- `delivery.mode`: `none` | `announce`.
- `delivery.channel`: `last` veya belirli bir kanal.
- `delivery.to`: kanala özgü hedef (telefon/sohbet/kanal kimliği).
- `delivery.bestEffort`: duyuru iletimi başarısız olursa işi başarısız saymaktan kaçın.

Duyuru iletimi, çalıştırma sırasında mesajlaşma araç gönderimlerini bastırır; sohbeti hedeflemek için
`delivery.channel`/`delivery.to` kullanın. `delivery.mode = "none"` olduğunda ana oturuma özet gönderilmez.

İzole işler için `delivery` atlanırsa, OpenClaw varsayılan olarak `announce` kullanır.

#### Duyuru iletimi akışı

`delivery.mode = "announce"` olduğunda, cron doğrudan çıkış kanalı bağdaştırıcıları üzerinden iletir.
Ana ajan mesajı oluşturmak veya iletmek için başlatılmaz.

Davranış ayrıntıları:

- İçerik: iletim, izole çalıştırmanın çıkış yüklerini (metin/medya) normal parçalama ve
  kanal biçimlendirmesiyle kullanır.
- Yalnızca heartbeat yanıtları (`HEARTBEAT_OK` ve gerçek içerik yoksa) iletilmez.
- İzole çalıştırma, mesaj aracıyla aynı hedefe zaten mesaj gönderdiyse, yinelemeleri önlemek için iletim atlanır.
- Eksik veya geçersiz iletim hedefleri, `delivery.bestEffort = true` olmadıkça işi başarısız kılar.
- Ana oturuma kısa bir özet yalnızca `delivery.mode = "announce"` olduğunda gönderilir.
- Ana oturum özeti `wakeMode`’a uyar: `now` anında heartbeat tetikler,
  `next-heartbeat` ise bir sonraki planlı heartbeat’i bekler.

### Model ve düşünme geçersiz kılmaları

İzole işler (`agentTurn`) modeli ve düşünme düzeyini geçersiz kılabilir:

- `model`: Sağlayıcı/model dizesi (örn. `anthropic/claude-sonnet-4-20250514`) veya takma ad (örn. `opus`)
- `thinking`: Düşünme düzeyi (`off`, `minimal`, `low`, `medium`, `high`, `xhigh`; yalnızca GPT-5.2 + Codex modelleri)

Not: Ana oturum işler için de `model` ayarlayabilirsiniz, ancak bu paylaşılan ana
oturum modelini değiştirir. Beklenmeyen bağlam kaymalarını önlemek için model geçersiz kılmalarını
yalnızca izole işler için öneririz.

Çözüm önceliği:

1. İş yükü geçersiz kılması (en yüksek)
2. Kancaya özgü varsayılanlar (örn. `hooks.gmail.model`)
3. Ajan yapılandırması varsayılanı

### İletim (kanal + hedef)

İzole işler, üst düzey `delivery` yapılandırmasıyla çıktıyı bir kanala iletebilir:

- `delivery.mode`: `announce` (bir özet iletir) veya `none`.
- `delivery.channel`: `whatsapp` / `telegram` / `discord` / `slack` / `mattermost` (eklenti) / `signal` / `imessage` / `last`.
- `delivery.to`: kanala özgü alıcı hedefi.

İletim yapılandırması yalnızca izole işler için geçerlidir (`sessionTarget: "isolated"`).

`delivery.channel` veya `delivery.to` atlanırsa, cron ana oturumun
“son rotasına” (ajanın en son yanıt verdiği yer) geri dönebilir.

Hedef biçimi hatırlatmaları:

- Slack/Discord/Mattermost (eklenti) hedefleri, belirsizliği önlemek için açık önekler kullanmalıdır (örn. `channel:<id>`, `user:<id>`).
- Telegram konuları `:topic:` biçimini kullanmalıdır (aşağıya bakın).

#### Telegram iletim hedefleri (konular / forum iş parçacıkları)

Telegram, `message_thread_id` üzerinden forum konularını destekler. Cron iletimi için,
konu/iş parçacığını `to` alanına kodlayabilirsiniz:

- `-1001234567890` (yalnızca sohbet kimliği)
- `-1001234567890:topic:123` (tercih edilen: açık konu işaretleyici)
- `-1001234567890:123` (kısa yol: sayısal sonek)

`telegram:...` / `telegram:group:...` gibi önekli hedefler de kabul edilir:

- `telegram:group:-1001234567890:topic:123`

## Araç çağrıları için JSON şeması

Gateway `cron.*` araçlarını doğrudan çağırırken (ajan araç çağrıları veya RPC) bu şekilleri kullanın.
CLI bayrakları `20m` gibi insan dostu süreleri kabul eder; ancak araç çağrıları
`schedule.at` için ISO 8601 dizesi ve `schedule.everyMs` için milisaniye kullanmalıdır.

### cron.add parametreleri

Tek seferlik, ana oturum işi (sistem olayı):

```json
{
  "name": "Reminder",
  "schedule": { "kind": "at", "at": "2026-02-01T16:00:00Z" },
  "sessionTarget": "main",
  "wakeMode": "now",
  "payload": { "kind": "systemEvent", "text": "Reminder text" },
  "deleteAfterRun": true
}
```

Yinelenen, iletimli izole iş:

```json
{
  "name": "Morning brief",
  "schedule": { "kind": "cron", "expr": "0 7 * * *", "tz": "America/Los_Angeles" },
  "sessionTarget": "isolated",
  "wakeMode": "next-heartbeat",
  "payload": {
    "kind": "agentTurn",
    "message": "Summarize overnight updates."
  },
  "delivery": {
    "mode": "announce",
    "channel": "slack",
    "to": "channel:C1234567890",
    "bestEffort": true
  }
}
```

Notlar:

- `schedule.kind`: `at` (`at`), `every` (`everyMs`) veya `cron` (`expr`, isteğe bağlı `tz`).
- `schedule.at` ISO 8601 kabul eder (saat dilimi isteğe bağlı; atlanırsa UTC olarak değerlendirilir).
- `everyMs` milisaniyedir.
- `sessionTarget`, `"main"` veya `"isolated"` olmalı ve `payload.kind` ile eşleşmelidir.
- İsteğe bağlı alanlar: `agentId`, `description`, `enabled`, `deleteAfterRun` (`at` için varsayılan true),
  `delivery`.
- `wakeMode`, atlandığında `"now"` varsayılanını alır.

### cron.update parametreleri

```json
{
  "jobId": "job-123",
  "patch": {
    "enabled": false,
    "schedule": { "kind": "every", "everyMs": 3600000 }
  }
}
```

Notlar:

- `jobId` kanoniktir; uyumluluk için `id` kabul edilir.
- Bir ajan bağlamasını temizlemek için yama içinde `agentId: null` kullanın.

### cron.run ve cron.remove parametreleri

```json
{ "jobId": "job-123", "mode": "force" }
```

```json
{ "jobId": "job-123" }
```

## Depolama ve geçmiş

- İş deposu: `~/.openclaw/cron/jobs.json` (Gateway tarafından yönetilen JSON).
- Çalıştırma geçmişi: `~/.openclaw/cron/runs/<jobId>.jsonl` (JSONL, otomatik budanır).
- Depo yolunu geçersiz kıl: yapılandırmada `cron.store`.

## Yapılandırma

```json5
{
  cron: {
    enabled: true, // default true
    store: "~/.openclaw/cron/jobs.json",
    maxConcurrentRuns: 1, // default 1
  },
}
```

Cron’u tamamen devre dışı bırakın:

- `cron.enabled: false` (yapılandırma)
- `OPENCLAW_SKIP_CRON=1` (env)

## CLI hızlı başlangıç

Tek seferlik hatırlatıcı (UTC ISO, başarıdan sonra otomatik silinir):

```bash
openclaw cron add \
  --name "Send reminder" \
  --at "2026-01-12T18:00:00Z" \
  --session main \
  --system-event "Reminder: submit expense report." \
  --wake now \
  --delete-after-run
```

Tek seferlik hatırlatıcı (ana oturum, hemen uyandır):

```bash
openclaw cron add \
  --name "Calendar check" \
  --at "20m" \
  --session main \
  --system-event "Next heartbeat: check calendar." \
  --wake now
```

Yinelenen izole iş (WhatsApp’e duyur):

```bash
openclaw cron add \
  --name "Morning status" \
  --cron "0 7 * * *" \
  --tz "America/Los_Angeles" \
  --session isolated \
  --message "Summarize inbox + calendar for today." \
  --announce \
  --channel whatsapp \
  --to "+15551234567"
```

Yinelenen izole iş (Telegram konusuna ilet):

```bash
openclaw cron add \
  --name "Nightly summary (topic)" \
  --cron "0 22 * * *" \
  --tz "America/Los_Angeles" \
  --session isolated \
  --message "Summarize today; send to the nightly topic." \
  --announce \
  --channel telegram \
  --to "-1001234567890:topic:123"
```

Model ve düşünme geçersiz kılmalı izole iş:

```bash
openclaw cron add \
  --name "Deep analysis" \
  --cron "0 6 * * 1" \
  --tz "America/Los_Angeles" \
  --session isolated \
  --message "Weekly deep analysis of project progress." \
  --model "opus" \
  --thinking high \
  --announce \
  --channel whatsapp \
  --to "+15551234567"
```

Ajan seçimi (çoklu ajan kurulumları):

```bash
# Pin a job to agent "ops" (falls back to default if that agent is missing)
openclaw cron add --name "Ops sweep" --cron "0 6 * * *" --session isolated --message "Check ops queue" --agent ops

# Switch or clear the agent on an existing job
openclaw cron edit <jobId> --agent ops
openclaw cron edit <jobId> --clear-agent
```

Manuel çalıştırma (zorla varsayılandır; yalnızca zamanı geldiğinde çalıştırmak için `--due` kullanın):

```bash
openclaw cron run <jobId>
openclaw cron run <jobId> --due
```

Mevcut bir işi düzenleyin (alanları yamalayın):

```bash
openclaw cron edit <jobId> \
  --message "Updated prompt" \
  --model "opus" \
  --thinking low
```

Çalıştırma geçmişi:

```bash
openclaw cron runs --id <jobId> --limit 50
```

Bir iş oluşturmadan anında sistem olayı:

```bash
openclaw system event --mode now --text "Next heartbeat: check battery."
```

## Gateway API yüzeyi

- `cron.list`, `cron.status`, `cron.add`, `cron.update`, `cron.remove`
- `cron.run` (zorla veya zamanı geldiğinde), `cron.runs`
  Bir iş olmadan anında sistem olayları için [`openclaw system event`](/cli/system) kullanın.

## Sorun giderme

### “Hiçbir şey çalışmıyor”

- Cron’un etkin olduğunu kontrol edin: `cron.enabled` ve `OPENCLAW_SKIP_CRON`.
- Gateway’in sürekli çalıştığını kontrol edin (cron Gateway süreci içinde çalışır).
- `cron` zamanlamaları için: saat dilimini (`--tz`) ana makine saat dilimiyle karşılaştırın.

### Yinelenen bir iş hatalardan sonra sürekli gecikiyor

- OpenClaw, ardışık hatalardan sonra yinelenen işler için üstel yeniden deneme gecikmesi uygular:
  denemeler arasında 30 sn, 1 dk, 5 dk, 15 dk, ardından 60 dk.
- Gecikme, bir sonraki başarılı çalıştırmadan sonra otomatik olarak sıfırlanır.
- Tek seferlik (`at`) işler, terminal bir çalıştırmadan sonra (`ok`, `error` veya `skipped`) devre dışı kalır ve yeniden deneme yapmaz.

### Telegram yanlış yere iletiyor

- Forum konuları için açık ve belirsizliği önlemek adına `-100…:topic:<id>` kullanın.
- Günlüklerde veya saklanan “son rota” hedeflerinde `telegram:...` önekleri görürseniz bu normaldir;
  cron iletimi bunları kabul eder ve konu kimliklerini yine doğru şekilde ayrıştırır.
