---
summary: "Voice Call eklentisi: Twilio/Telnyx/Plivo üzerinden giden + gelen aramalar (eklenti kurulumu + yapılandırma + CLI)"
read_when:
  - OpenClaw’dan giden bir sesli arama yapmak istiyorsunuz
  - voice-call eklentisini yapılandırıyor veya geliştiriyorsunuz
title: "Voice Call Eklentisi"
---

# Voice Call (eklenti)

OpenClaw için bir eklenti aracılığıyla sesli aramalar. Giden bildirimleri ve gelen politikalara sahip çok turlu konuşmaları destekler.

Mevcut sağlayıcılar:

- `twilio` (Programmable Voice + Media Streams)
- `telnyx` (Call Control v2)
- `plivo` (Voice API + XML transfer + GetInput speech)
- `mock` (dev/ağ yok)

Hızlı zihinsel model:

- Eklentiyi yükleyin
- Gateway’i yeniden başlatın
- `plugins.entries.voice-call.config` altında yapılandırın
- `openclaw voicecall ...` veya `voice_call` aracını kullanın

## Nerede çalışır (yerel vs uzak)

Voice Call eklentisi **Gateway sürecinin içinde** çalışır.

Uzak bir Gateway kullanıyorsanız, eklentiyi **Gateway’i çalıştıran makinede** kurup yapılandırın, ardından yüklenmesi için Gateway’i yeniden başlatın.

## Yükleme

### Seçenek A: npm’den yükleme (önerilen)

```bash
openclaw plugins install @openclaw/voice-call
```

Ardından Gateway’i yeniden başlatın.

### Seçenek B: yerel klasörden yükleme (dev, kopyalama yok)

```bash
openclaw plugins install ./extensions/voice-call
cd ./extensions/voice-call && pnpm install
```

Ardından Gateway’i yeniden başlatın.

## Yapılandırma

Yapılandırmayı `plugins.entries.voice-call.config` altında ayarlayın:

```json5
{
  plugins: {
    entries: {
      "voice-call": {
        enabled: true,
        config: {
          provider: "twilio", // or "telnyx" | "plivo" | "mock"
          fromNumber: "+15550001234",
          toNumber: "+15550005678",

          twilio: {
            accountSid: "ACxxxxxxxx",
            authToken: "...",
          },

          plivo: {
            authId: "MAxxxxxxxxxxxxxxxxxxxx",
            authToken: "...",
          },

          // Webhook server
          serve: {
            port: 3334,
            path: "/voice/webhook",
          },

          // Webhook security (recommended for tunnels/proxies)
          webhookSecurity: {
            allowedHosts: ["voice.example.com"],
            trustedProxyIPs: ["100.64.0.1"],
          },

          // Public exposure (pick one)
          // publicUrl: "https://example.ngrok.app/voice/webhook",
          // tunnel: { provider: "ngrok" },
          // tailscale: { mode: "funnel", path: "/voice/webhook" }

          outbound: {
            defaultMode: "notify", // notify | conversation
          },

          streaming: {
            enabled: true,
            streamPath: "/voice/stream",
          },
        },
      },
    },
  },
}
```

Notlar:

- Twilio/Telnyx **herkese açık erişilebilir** bir webhook URL’si gerektirir.
- Plivo **herkese açık erişilebilir** bir webhook URL’si gerektirir.
- `mock` yerel bir geliştirme sağlayıcısıdır (ağ çağrısı yok).
- `skipSignatureVerification` yalnızca yerel testler içindir.
- Ngrok ücretsiz katmanını kullanıyorsanız, `publicUrl`’yi tam ngrok URL’sine ayarlayın; imza doğrulaması her zaman zorunludur.
- `tunnel.allowNgrokFreeTierLoopbackBypass: true`, Twilio webhook’larına **yalnızca** `tunnel.provider="ngrok"` ve `serve.bind` loopback (ngrok yerel ajan) olduğunda geçersiz imzalarla izin verir. Yalnızca yerel geliştirme için kullanın.
- Ngrok ücretsiz katman URL’leri değişebilir veya ara sayfa davranışı ekleyebilir; `publicUrl` saparsa Twilio imzaları başarısız olur. Üretim için kararlı bir alan adı veya Tailscale funnel tercih edin.

## Webhook Güvenliği

Gateway’in önünde bir proxy veya tünel bulunduğunda, eklenti imza doğrulaması için
genel URL’yi yeniden oluşturur. Bu seçenekler, hangi iletilen başlıkların
güvenildiğini denetler.

`webhookSecurity.allowedHosts` iletilen başlıklardan ana makineleri izin listesine alır.

`webhookSecurity.trustForwardingHeaders` izin listesi olmadan iletilen başlıklara güvenir.

`webhookSecurity.trustedProxyIPs` yalnızca istek uzak IP’si listeyle eşleştiğinde iletilen başlıklara güvenir.

Kararlı bir genel ana bilgisayar ile örnek:

```json5
{
  plugins: {
    entries: {
      "voice-call": {
        config: {
          publicUrl: "https://voice.example.com/voice/webhook",
          webhookSecurity: {
            allowedHosts: ["voice.example.com"],
          },
        },
      },
    },
  },
}
```

## Aramalar için TTS

Voice Call, aramalarda akışlı konuşma için çekirdek `messages.tts` yapılandırmasını
(OpenAI veya ElevenLabs) kullanır. Eklenti yapılandırması altında **aynı yapı** ile
geçersiz kılabilirsiniz — `messages.tts` ile derin birleştirme yapar.

```json5
{
  tts: {
    provider: "elevenlabs",
    elevenlabs: {
      voiceId: "pMsXgVXv3BLzUgSXRplE",
      modelId: "eleven_multilingual_v2",
    },
  },
}
```

Notlar:

- **Edge TTS sesli aramalar için yok sayılır** (telefoni sesi PCM gerektirir; Edge çıktısı güvenilir değildir).
- Twilio medya akışı etkin olduğunda çekirdek TTS kullanılır; aksi halde aramalar sağlayıcının yerel seslerine geri döner.

### Daha fazla örnek

Yalnızca çekirdek TTS kullan (geçersiz kılma yok):

```json5
{
  messages: {
    tts: {
      provider: "openai",
      openai: { voice: "alloy" },
    },
  },
}
```

Aramalar için yalnızca ElevenLabs’e geçersiz kıl (çekirdek varsayılanı başka yerlerde koru):

```json5
{
  plugins: {
    entries: {
      "voice-call": {
        config: {
          tts: {
            provider: "elevenlabs",
            elevenlabs: {
              apiKey: "elevenlabs_key",
              voiceId: "pMsXgVXv3BLzUgSXRplE",
              modelId: "eleven_multilingual_v2",
            },
          },
        },
      },
    },
  },
}
```

Aramalar için yalnızca OpenAI modelini geçersiz kıl (derin birleştirme örneği):

```json5
{
  plugins: {
    entries: {
      "voice-call": {
        config: {
          tts: {
            openai: {
              model: "gpt-4o-mini-tts",
              voice: "marin",
            },
          },
        },
      },
    },
  },
}
```

## Gelen aramalar

Gelen politika varsayılanı `disabled`’dur. Gelen aramaları etkinleştirmek için şunu ayarlayın:

```json5
{
  inboundPolicy: "allowlist",
  allowFrom: ["+15550001234"],
  inboundGreeting: "Hello! How can I help?",
}
```

Otomatik yanıtlar ajan sistemini kullanır. Şunlarla ayarlayın:

- `responseModel`
- `responseSystemPrompt`
- `responseTimeoutMs`

## CLI

```bash
openclaw voicecall call --to "+15555550123" --message "Hello from OpenClaw"
openclaw voicecall continue --call-id <id> --message "Any questions?"
openclaw voicecall speak --call-id <id> --message "One moment"
openclaw voicecall end --call-id <id>
openclaw voicecall status --call-id <id>
openclaw voicecall tail
openclaw voicecall expose --mode funnel
```

## Ajan aracı

Araç adı: `voice_call`

Eylemler:

- `initiate_call` (message, to?, mode?)
- `continue_call` (callId, message)
- `speak_to_user` (callId, message)
- `end_call` (callId)
- `get_status` (callId)

Bu depo, `skills/voice-call/SKILL.md` adresinde eşleşen bir skill dokümanı içerir.

## Gateway RPC

- `voicecall.initiate` (`to?`, `message`, `mode?`)
- `voicecall.continue` (`callId`, `message`)
- `voicecall.speak` (`callId`, `message`)
- `voicecall.end` (`callId`)
- `voicecall.status` (`callId`)
