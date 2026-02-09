---
summary: "OpenClaw’ı güvenlik uyarılarıyla birlikte kişisel asistan olarak çalıştırmak için uçtan uca rehber"
read_when:
  - Yeni bir asistan örneğinin sisteme alınması
  - Güvenlik/izin etkileri gözden geçirilirken
title: "Kişisel Asistan Kurulumu"
---

# OpenClaw ile kişisel bir asistan oluşturma

OpenClaw, **Pi** ajanları için bir WhatsApp + Telegram + Discord + iMessage gateway’idir. Eklentiler Mattermost ekler. Bu rehber, “kişisel asistan” kurulumunu anlatır: her zaman açık ajanınız gibi davranan, tek bir özel WhatsApp numarası.

## ⚠️ Önce güvenlik

Bir ajanı şu konuma yerleştiriyorsunuz:

- makinenizde komutlar çalıştırma (Pi araç kurulumunuza bağlı olarak)
- çalışma alanınızdaki dosyaları okuma/yazma
- WhatsApp/Telegram/Discord/Mattermost (eklenti) üzerinden dışarı mesaj gönderme

Temkinli başlayın:

- Her zaman `channels.whatsapp.allowFrom` ayarlayın (kişisel Mac’inizde asla dünyaya açık çalıştırmayın).
- Asistan için özel bir WhatsApp numarası kullanın.
- Heartbeat’ler artık varsayılan olarak her 30 dakikada birdir. Kuruluma güvenene kadar `agents.defaults.heartbeat.every: "0m"` ayarlayarak devre dışı bırakın.

## Ön koşullar

- OpenClaw kurulmuş ve devreye alınmış olmalı — henüz yapmadıysanız [Getting Started](/start/getting-started) bölümüne bakın
- Asistan için ikinci bir telefon numarası (SIM/eSIM/ön ödemeli)

## İki telefonlu kurulum (önerilen)

İstediğiniz şey şu:

```
Your Phone (personal)          Second Phone (assistant)
┌─────────────────┐           ┌─────────────────┐
│  Your WhatsApp  │  ──────▶  │  Assistant WA   │
│  +1-555-YOU     │  message  │  +1-555-ASSIST  │
└─────────────────┘           └────────┬────────┘
                                       │ linked via QR
                                       ▼
                              ┌─────────────────┐
                              │  Your Mac       │
                              │  (openclaw)      │
                              │    Pi agent     │
                              └─────────────────┘
```

Kişisel WhatsApp’ınızı OpenClaw’a bağlarsanız, size gelen her mesaj “ajan girdisi” olur. Bu nadiren istenen bir durumdur.

## 5 dakikalık hızlı başlangıç

1. WhatsApp Web’i eşleştirin (QR gösterir; asistan telefonuyla tarayın):

```bash
openclaw channels login
```

2. Gateway’i başlatın (çalışır halde bırakın):

```bash
openclaw gateway --port 18789
```

3. `~/.openclaw/openclaw.json` içine minimal bir yapılandırma koyun:

```json5
{
  channels: { whatsapp: { allowFrom: ["+15555550123"] } },
}
```

Şimdi izin listesine alınmış telefonunuzdan asistan numarasına mesaj gönderin.

Devreye alma tamamlandığında panoyu otomatik olarak açar ve temiz (belirteç içermeyen) bir bağlantı yazdırırız. Kimlik doğrulama isterse, `gateway.auth.token` içindeki belirteci Control UI ayarlarına yapıştırın. Daha sonra yeniden açmak için: `openclaw dashboard`.

## Ajana bir çalışma alanı verin (AGENTS)

OpenClaw, çalışma alanı dizininden işletim talimatlarını ve “hafızayı” okur.

Varsayılan olarak OpenClaw, ajan çalışma alanı olarak `~/.openclaw/workspace` kullanır ve kurulumda/ilk ajan çalıştırmada bunu (artı başlangıç `AGENTS.md`, `SOUL.md`, `TOOLS.md`, `IDENTITY.md`, `USER.md`, `HEARTBEAT.md`) otomatik oluşturur. `BOOTSTRAP.md` yalnızca çalışma alanı tamamen yeniyken oluşturulur (sildikten sonra geri gelmemelidir). `MEMORY.md` isteğe bağlıdır (otomatik oluşturulmaz); mevcutsa normal oturumlar için yüklenir. Alt ajan oturumları yalnızca `AGENTS.md` ve `TOOLS.md` enjekte eder.

İpucu: bu klasörü OpenClaw’ın “hafızası” gibi düşünün ve (tercihen özel) bir git deposu yapın; böylece `AGENTS.md` + hafıza dosyalarınız yedeklenmiş olur. Git kuruluysa, yepyeni çalışma alanları otomatik olarak başlatılır.

```bash
openclaw setup
```

Tam çalışma alanı düzeni + yedekleme rehberi: [Agent workspace](/concepts/agent-workspace)  
Hafıza iş akışı: [Memory](/concepts/memory)

İsteğe bağlı: `agents.defaults.workspace` ile farklı bir çalışma alanı seçin (`~` destekler).

```json5
{
  agent: {
    workspace: "~/.openclaw/workspace",
  },
}
```

Kendi çalışma alanı dosyalarınızı zaten bir depodan sağlıyorsanız, önyükleme dosyası oluşturmayı tamamen devre dışı bırakabilirsiniz:

```json5
{
  agent: {
    skipBootstrap: true,
  },
}
```

## Onu “bir asistana” dönüştüren yapılandırma

OpenClaw varsayılan olarak iyi bir asistan kurulumuyla gelir, ancak genellikle şunları ayarlamak istersiniz:

- `SOUL.md` içindeki persona/talimatlar
- düşünme varsayılanları (istenirse)
- heartbeat’ler (güvendikten sonra)

Örnek:

```json5
{
  logging: { level: "info" },
  agent: {
    model: "anthropic/claude-opus-4-6",
    workspace: "~/.openclaw/workspace",
    thinkingDefault: "high",
    timeoutSeconds: 1800,
    // Start with 0; enable later.
    heartbeat: { every: "0m" },
  },
  channels: {
    whatsapp: {
      allowFrom: ["+15555550123"],
      groups: {
        "*": { requireMention: true },
      },
    },
  },
  routing: {
    groupChat: {
      mentionPatterns: ["@openclaw", "openclaw"],
    },
  },
  session: {
    scope: "per-sender",
    resetTriggers: ["/new", "/reset"],
    reset: {
      mode: "daily",
      atHour: 4,
      idleMinutes: 10080,
    },
  },
}
```

## Oturumlar ve hafıza

- Oturum dosyaları: `~/.openclaw/agents/<agentId>/sessions/{{SessionId}}.jsonl`
- Oturum metaverisi (belirteç kullanımı, son rota, vb.): `~/.openclaw/agents/<agentId>/sessions/sessions.json` (eski: `~/.openclaw/sessions/sessions.json`)
- `/new` veya `/reset`, o sohbet için yeni bir oturum başlatır (`resetTriggers` ile yapılandırılabilir). Tek başına gönderilirse, ajan sıfırlamayı onaylamak için kısa bir selamla yanıt verir.
- `/compact [instructions]`, oturum bağlamını sıkıştırır ve kalan bağlam bütçesini bildirir.

## Heartbeat’ler (proaktif mod)

Varsayılan olarak OpenClaw, şu istemle her 30 dakikada bir heartbeat çalıştırır:
`Read HEARTBEAT.md if it exists (workspace context). Follow it strictly. Do not infer or repeat old tasks from prior chats. If nothing needs attention, reply HEARTBEAT_OK.`  
Devre dışı bırakmak için `agents.defaults.heartbeat.every: "0m"` ayarlayın.

- `HEARTBEAT.md` mevcutsa ancak fiilen boşsa (yalnızca boş satırlar ve `# Heading` gibi markdown başlıkları), OpenClaw API çağrılarını azaltmak için heartbeat çalışmasını atlar.
- Dosya yoksa, heartbeat yine çalışır ve model ne yapacağına karar verir.
- Ajan `HEARTBEAT_OK` ile yanıt verirse (isteğe bağlı kısa dolgu ile; bkz. `agents.defaults.heartbeat.ackMaxChars`), OpenClaw bu heartbeat için dışa gönderimi bastırır.
- Heartbeat’ler tam ajan dönüşleri çalıştırır — daha kısa aralıklar daha fazla belirteç yakar.

```json5
{
  agent: {
    heartbeat: { every: "30m" },
  },
}
```

## Medya giriş ve çıkışı

Gelen ekler (görseller/ses/belgeler) şablonlar aracılığıyla komutunuza yüzeye çıkarılabilir:

- `{{MediaPath}}` (yerel geçici dosya yolu)
- `{{MediaUrl}}` (sözde URL)
- `{{Transcript}}` (ses dökümü etkinse)

Ajan tarafından gönderilen ekler: kendi satırında (boşluk olmadan) `MEDIA:<path-or-url>` ekleyin. Örnek:

```
Here’s the screenshot.
MEDIA:https://example.com/screenshot.png
```

OpenClaw bunları çıkarır ve metnin yanında medya olarak gönderir.

## Operasyon kontrol listesi

```bash
openclaw status          # local status (creds, sessions, queued events)
openclaw status --all    # full diagnosis (read-only, pasteable)
openclaw status --deep   # adds gateway health probes (Telegram + Discord)
openclaw health --json   # gateway health snapshot (WS)
```

Günlükler `/tmp/openclaw/` altında bulunur (varsayılan: `openclaw-YYYY-MM-DD.log`).

## Sonraki adımlar

- WebChat: [WebChat](/web/webchat)
- Gateway operasyonları: [Gateway runbook](/gateway)
- Cron + uyandırmalar: [Cron jobs](/automation/cron-jobs)
- macOS menü çubuğu yardımcı uygulaması: [OpenClaw macOS app](/platforms/macos)
- iOS düğüm uygulaması: [iOS app](/platforms/ios)
- Android düğüm uygulaması: [Android app](/platforms/android)
- Windows durumu: [Windows (WSL2)](/platforms/windows)
- Linux durumu: [Linux app](/platforms/linux)
- Güvenlik: [Security](/gateway/security)
