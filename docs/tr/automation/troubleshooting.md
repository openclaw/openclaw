---
summary: "Cron ve heartbeat zamanlama ve teslimat sorunlarını giderme"
read_when:
  - Cron çalışmadı
  - Cron çalıştı ancak mesaj teslim edilmedi
  - Heartbeat sessiz görünüyor veya atlandı
title: "Otomasyon Sorun Giderme"
---

# Otomasyon sorun giderme

Zamanlayıcı ve teslimat sorunları için bu sayfayı kullanın (`cron` + `heartbeat`).

## Komut merdiveni

```bash
openclaw status
openclaw gateway status
openclaw logs --follow
openclaw doctor
openclaw channels status --probe
```

Ardından otomasyon kontrollerini çalıştırın:

```bash
openclaw cron status
openclaw cron list
openclaw system heartbeat last
```

## Cron tetiklenmiyor

```bash
openclaw cron status
openclaw cron list
openclaw cron runs --id <jobId> --limit 20
openclaw logs --follow
```

İyi bir çıktı şu şekilde görünür:

- `cron status`, etkin olduğunu ve gelecekte bir `nextWakeAtMs` raporlar.
- İş etkin ve geçerli bir zamanlama/saat dilimine sahiptir.
- `cron runs`, `ok` veya açık bir atlama nedeni gösterir.

Yaygın imzalar:

- `cron: scheduler disabled; jobs will not run automatically` → cron yapılandırma/ortamda devre dışı.
- `cron: timer tick failed` → zamanlayıcı tick’i çöktü; çevredeki stack/log bağlamını inceleyin.
- Çalıştırma çıktısında `reason: not-due` → manuel çalıştırma `--force` olmadan çağrıldı ve iş henüz zamanı gelmedi.

## Cron tetiklendi ancak teslimat yok

```bash
openclaw cron runs --id <jobId> --limit 20
openclaw cron list
openclaw channels status --probe
openclaw logs --follow
```

İyi bir çıktı şu şekilde görünür:

- Çalıştırma durumu `ok`.
- İzole işler için teslimat modu/hedefi ayarlanmıştır.
- Kanal yoklaması hedef kanalın bağlı olduğunu bildirir.

Yaygın imzalar:

- Çalıştırma başarılı ancak teslimat modu `none` → harici bir mesaj beklenmez.
- Teslimat hedefi eksik/geçersiz (`channel`/`to`) → çalıştırma dahili olarak başarılı olabilir ancak dışa gönderim atlanır.
- Kanal kimlik doğrulama hataları (`unauthorized`, `missing_scope`, `Forbidden`) → teslimat kanal kimlik bilgileri/izinleri nedeniyle engellendi.

## Heartbeat bastırıldı veya atlandı

```bash
openclaw system heartbeat last
openclaw logs --follow
openclaw config get agents.defaults.heartbeat
openclaw channels status --probe
```

İyi bir çıktı şu şekilde görünür:

- Heartbeat, sıfırdan büyük bir aralıkla etkin.
- Son heartbeat sonucu `ran` (veya atlama nedeni anlaşılmıştır).

Yaygın imzalar:

- `heartbeat skipped` ile `reason=quiet-hours` → `activeHours` dışında.
- `requests-in-flight` → ana hat meşgul; heartbeat ertelendi.
- `empty-heartbeat-file` → `HEARTBEAT.md` mevcut ancak eyleme geçirilebilir içerik yok.
- `alerts-disabled` → görünürlük ayarları dışa giden heartbeat mesajlarını bastırır.

## Saat dilimi ve activeHours tuzakları

```bash
openclaw config get agents.defaults.heartbeat.activeHours
openclaw config get agents.defaults.heartbeat.activeHours.timezone
openclaw config get agents.defaults.userTimezone || echo "agents.defaults.userTimezone not set"
openclaw cron list
openclaw logs --follow
```

Hızlı kurallar:

- `Config path not found: agents.defaults.userTimezone` anahtarın ayarlı olmadığı anlamına gelir; heartbeat ana makine saat dilimine (veya ayarlıysa `activeHours.timezone`) geri düşer.
- `--tz` olmadan cron, gateway ana makinesi saat dilimini kullanır.
- Heartbeat `activeHours`, yapılandırılmış saat dilimi çözümlemesini kullanır (`user`, `local` veya açık IANA tz).
- Saat dilimi içermeyen ISO zaman damgaları, cron `at` zamanlamaları için UTC olarak ele alınır.

Yaygın imzalar:

- Ana makine saat dilimi değişikliklerinden sonra işler yanlış duvar saati zamanında çalışır.
- `activeHours.timezone` yanlış olduğu için heartbeat gündüz saatleriniz boyunca her zaman atlanır.

İlgili:

- [/automation/cron-jobs](/automation/cron-jobs)
- [/gateway/heartbeat](/gateway/heartbeat)
- [/automation/cron-vs-heartbeat](/automation/cron-vs-heartbeat)
- [/concepts/timezone](/concepts/timezone)
