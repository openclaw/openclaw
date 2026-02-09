---
summary: "Плагин Voice Call: исходящие и входящие звонки через Twilio/Telnyx/Plivo (установка плагина + конфигурация + CLI)"
read_when:
  - Вы хотите совершить исходящий голосовой звонок из OpenClaw
  - Вы настраиваете или разрабатываете плагин voice-call
title: "Плагин Voice Call"
---

# Voice Call (плагин)

Голосовые звонки для OpenClaw через плагин. Поддерживает исходящие уведомления и
многоходовые диалоги с политиками входящих вызовов.

Текущие провайдеры:

- `twilio` (Programmable Voice + Media Streams)
- `telnyx` (Call Control v2)
- `plivo` (Voice API + XML transfer + GetInput speech)
- `mock` (dev/без сети)

Быстрая ментальная модель:

- Установить плагин
- Перезапустить Gateway (шлюз)
- Настроить в разделе `plugins.entries.voice-call.config`
- Использовать `openclaw voicecall ...` или инструмент `voice_call`

## Где выполняется (локально vs удалённо)

Плагин Voice Call выполняется **внутри процесса Gateway (шлюз)**.

Если вы используете удалённый Gateway (шлюз), установите/настройте плагин на **машине, где запущен Gateway (шлюз)**, затем перезапустите Gateway (шлюз) для его загрузки.

## Установка

### Вариант A: установка из npm (рекомендуется)

```bash
openclaw plugins install @openclaw/voice-call
```

После этого перезапустите Gateway (шлюз).

### Вариант B: установка из локальной папки (dev, без копирования)

```bash
openclaw plugins install ./extensions/voice-call
cd ./extensions/voice-call && pnpm install
```

После этого перезапустите Gateway (шлюз).

## Конфигурация

Задайте конфигурацию в разделе `plugins.entries.voice-call.config`:

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

Примечания:

- Twilio/Telnyx требуют **публично доступный** URL вебхука.
- Plivo требует **публично доступный** URL вебхука.
- `mock` — локальный dev‑провайдер (без сетевых вызовов).
- `skipSignatureVerification` — только для локального тестирования.
- Если вы используете бесплатный тариф ngrok, установите `publicUrl` в точный URL ngrok; проверка подписи выполняется всегда.
- `tunnel.allowNgrokFreeTierLoopbackBypass: true` разрешает вебхуки Twilio с недействительными подписями **только** когда `tunnel.provider="ngrok"` и `serve.bind` — loopback (локальный агент ngrok). Используйте только для локальной разработки.
- URL бесплатного тарифа ngrok может меняться или добавлять промежуточные страницы; если `publicUrl` «уплывает», подписи Twilio будут недействительны. Для продакшена предпочтительнее стабильный домен или Tailscale funnel.

## Безопасность вебхуков

Когда перед Gateway (шлюз) находится прокси или туннель, плагин реконструирует
публичный URL для проверки подписи. Эти параметры управляют тем, какие
пробрасываемые заголовки считаются доверенными.

`webhookSecurity.allowedHosts` добавляет хосты в allowlist из заголовков проксирования.

`webhookSecurity.trustForwardingHeaders` доверяет пробрасываемым заголовкам без allowlist.

`webhookSecurity.trustedProxyIPs` доверяет пробрасываемым заголовкам только когда удалённый IP
запроса совпадает со списком.

Пример со стабильным публичным хостом:

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

## TTS для звонков

Voice Call использует базовую конфигурацию `messages.tts` (OpenAI или ElevenLabs)
для потокового синтеза речи в звонках. Вы можете переопределить её в конфигурации
плагина с **той же структурой** — выполняется глубокое слияние с `messages.tts`.

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

Примечания:

- **Edge TTS игнорируется для голосовых звонков** (телефонный звук требует PCM; вывод Edge ненадёжен).
- Базовый TTS используется, когда включён медиастриминг Twilio; в противном случае звонки используют нативные голоса провайдера.

### Дополнительные примеры

Использовать только базовый TTS (без переопределений):

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

Переопределить на ElevenLabs только для звонков (сохранив базовый вариант в остальных местах):

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

Переопределить только модель OpenAI для звонков (пример глубокого слияния):

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

## Входящие звонки

Политика входящих вызовов по умолчанию — `disabled`. Чтобы включить входящие звонки, установите:

```json5
{
  inboundPolicy: "allowlist",
  allowFrom: ["+15550001234"],
  inboundGreeting: "Hello! How can I help?",
}
```

Автоответы используют систему агентов. Настраивается с помощью:

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

## Инструмент агента

Имя инструмента: `voice_call`

Действия:

- `initiate_call` (message, to?, mode?)
- `continue_call` (callId, message)
- `speak_to_user` (callId, message)
- `end_call` (callId)
- `get_status` (callId)

В этом репозитории также есть соответствующая документация по Skills: `skills/voice-call/SKILL.md`.

## Gateway RPC

- `voicecall.initiate` (`to?`, `message`, `mode?`)
- `voicecall.continue` (`callId`, `message`)
- `voicecall.speak` (`callId`, `message`)
- `voicecall.end` (`callId`)
- `voicecall.status` (`callId`)
