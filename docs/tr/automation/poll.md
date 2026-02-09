---
summary: "Gateway + CLI üzerinden anket gönderimi"
read_when:
  - Anket desteği eklerken veya değiştirirken
  - CLI veya gateway üzerinden anket gönderimlerini hata ayıklarken
title: "Anketler"
---

# Anketler

## Desteklenen kanallar

- WhatsApp (web kanalı)
- Discord
- MS Teams (Adaptive Cards)

## CLI

```bash
# WhatsApp
openclaw message poll --target +15555550123 \
  --poll-question "Lunch today?" --poll-option "Yes" --poll-option "No" --poll-option "Maybe"
openclaw message poll --target 123456789@g.us \
  --poll-question "Meeting time?" --poll-option "10am" --poll-option "2pm" --poll-option "4pm" --poll-multi

# Discord
openclaw message poll --channel discord --target channel:123456789 \
  --poll-question "Snack?" --poll-option "Pizza" --poll-option "Sushi"
openclaw message poll --channel discord --target channel:123456789 \
  --poll-question "Plan?" --poll-option "A" --poll-option "B" --poll-duration-hours 48

# MS Teams
openclaw message poll --channel msteams --target conversation:19:abc@thread.tacv2 \
  --poll-question "Lunch?" --poll-option "Pizza" --poll-option "Sushi"
```

Seçenekler:

- `--channel`: `whatsapp` (varsayılan), `discord` veya `msteams`
- `--poll-multi`: birden fazla seçeneğin seçilmesine izin verir
- `--poll-duration-hours`: yalnızca Discord (atlanırsa varsayılan 24)

## Gateway RPC

Yöntem: `poll`

Parametreler:

- `to` (string, gerekli)
- `question` (string, gerekli)
- `options` (string[], gerekli)
- `maxSelections` (number, isteğe bağlı)
- `durationHours` (number, isteğe bağlı)
- `channel` (string, isteğe bağlı, varsayılan: `whatsapp`)
- `idempotencyKey` (string, gerekli)

## Kanal farklılıkları

- WhatsApp: 2-12 seçenek, `maxSelections` seçenek sayısı içinde olmalıdır, `durationHours` yok sayılır.
- Discord: 2-10 seçenek, `durationHours` 1-768 saat aralığına sıkıştırılır (varsayılan 24). `maxSelections > 1` çoklu seçimi etkinleştirir; Discord katı bir seçim sayısını desteklemez.
- MS Teams: Adaptive Card anketleri (OpenClaw tarafından yönetilir). Yerel bir anket API’si yoktur; `durationHours` yok sayılır.

## Ajan aracı (Mesaj)

`message` aracını `poll` eylemiyle kullanın (`to`, `pollQuestion`, `pollOption`, isteğe bağlı `pollMulti`, `pollDurationHours`, `channel`).

Not: Discord’da “tam olarak N seç” modu yoktur; `pollMulti` çoklu seçime eşlenir.
Teams anketleri Adaptive Cards olarak oluşturulur ve oyların `~/.openclaw/msteams-polls.json` içinde kaydedilmesi için gateway’in çevrimiçi kalması gerekir.
