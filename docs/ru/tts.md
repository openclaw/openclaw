---
summary: "Преобразование текста в речь (TTS) для исходящих ответов"
read_when:
  - Включение преобразования текста в речь для ответов
  - Настройка провайдеров TTS или ограничений
  - Использование команд /tts
title: "Преобразование текста в речь"
---

# Преобразование текста в речь (TTS)

OpenClaw может преобразовывать исходящие ответы в аудио с помощью ElevenLabs, OpenAI или Edge TTS.
Это работает везде, где OpenClaw может отправлять аудио; в Telegram это отображается как круглое голосовое сообщение.

## Поддерживаемые сервисы

- **ElevenLabs** (основной или резервный провайдер)
- **OpenAI** (основной или резервный провайдер; также используется для кратких резюме)
- **Edge TTS** (основной или резервный провайдер; использует `node-edge-tts`, по умолчанию при отсутствии ключей API)

### Примечания по Edge TTS

Edge TTS использует онлайн‑сервис нейронного TTS Microsoft Edge через библиотеку `node-edge-tts`. Это хостируемый сервис (не локальный), использует конечные точки Microsoft и не требует ключа API. `node-edge-tts` предоставляет параметры конфигурации речи и форматы вывода, однако не все параметры поддерживаются сервисом Edge. citeturn2search0

Поскольку Edge TTS является публичным веб‑сервисом без опубликованного SLA или квот, следует рассматривать его как best‑effort. Если вам нужны гарантированные лимиты и поддержка, используйте OpenAI или ElevenLabs.
В документации Microsoft Speech REST API указан лимит 10 минут аудио на запрос; Edge TTS не публикует лимиты, поэтому следует предполагать аналогичные или более низкие ограничения. citeturn0search3

## Необязательные ключи

Если вы хотите использовать OpenAI или ElevenLabs:

- `ELEVENLABS_API_KEY` (или `XI_API_KEY`)
- `OPENAI_API_KEY`

Edge TTS **не** требует ключа API. Если ключи API не найдены, OpenClaw по умолчанию использует Edge TTS (если он не отключён через `messages.tts.edge.enabled=false`).

Если настроено несколько провайдеров, сначала используется выбранный провайдер, а остальные служат резервными.
Автоматическое резюмирование использует настроенный `summaryModel` (или `agents.defaults.model.primary`),
поэтому при включении резюме этот провайдер также должен быть аутентифицирован.

## Ссылки на сервисы

- [Руководство OpenAI по Text-to-Speech](https://platform.openai.com/docs/guides/text-to-speech)
- [Справочник OpenAI Audio API](https://platform.openai.com/docs/api-reference/audio)
- [ElevenLabs Text to Speech](https://elevenlabs.io/docs/api-reference/text-to-speech)
- [Аутентификация ElevenLabs](https://elevenlabs.io/docs/api-reference/authentication)
- [node-edge-tts](https://github.com/SchneeHertz/node-edge-tts)
- [Форматы вывода Microsoft Speech](https://learn.microsoft.com/azure/ai-services/speech-service/rest-text-to-speech#audio-outputs)

## Включено ли это по умолчанию?

Нет. Авто‑TTS **выключено** по умолчанию. Включите его в конфиге с помощью
`messages.tts.auto` или для конкретного сеанса с помощью `/tts always` (псевдоним: `/tts on`).

Edge TTS **включён** по умолчанию после включения TTS и используется автоматически,
когда недоступны ключи API OpenAI или ElevenLabs.

## Конфигурация

Конфигурация TTS находится в разделе `messages.tts` файла `openclaw.json`.
Полная схема приведена в разделе [Конфигурация Gateway (шлюза)](/gateway/configuration).

### Минимальный конфиг (включение + провайдер)

```json5
{
  messages: {
    tts: {
      auto: "always",
      provider: "elevenlabs",
    },
  },
}
```

### OpenAI как основной с резервом ElevenLabs

```json5
{
  messages: {
    tts: {
      auto: "always",
      provider: "openai",
      summaryModel: "openai/gpt-4.1-mini",
      modelOverrides: {
        enabled: true,
      },
      openai: {
        apiKey: "openai_api_key",
        model: "gpt-4o-mini-tts",
        voice: "alloy",
      },
      elevenlabs: {
        apiKey: "elevenlabs_api_key",
        baseUrl: "https://api.elevenlabs.io",
        voiceId: "voice_id",
        modelId: "eleven_multilingual_v2",
        seed: 42,
        applyTextNormalization: "auto",
        languageCode: "en",
        voiceSettings: {
          stability: 0.5,
          similarityBoost: 0.75,
          style: 0.0,
          useSpeakerBoost: true,
          speed: 1.0,
        },
      },
    },
  },
}
```

### Edge TTS как основной (без ключа API)

```json5
{
  messages: {
    tts: {
      auto: "always",
      provider: "edge",
      edge: {
        enabled: true,
        voice: "en-US-MichelleNeural",
        lang: "en-US",
        outputFormat: "audio-24khz-48kbitrate-mono-mp3",
        rate: "+10%",
        pitch: "-5%",
      },
    },
  },
}
```

### Отключить Edge TTS

```json5
{
  messages: {
    tts: {
      edge: {
        enabled: false,
      },
    },
  },
}
```

### Пользовательские лимиты + путь prefs

```json5
{
  messages: {
    tts: {
      auto: "always",
      maxTextLength: 4000,
      timeoutMs: 30000,
      prefsPath: "~/.openclaw/settings/tts.json",
    },
  },
}
```

### Отвечать аудио только после входящего голосового сообщения

```json5
{
  messages: {
    tts: {
      auto: "inbound",
    },
  },
}
```

### Отключить авто‑резюме для длинных ответов

```json5
{
  messages: {
    tts: {
      auto: "always",
    },
  },
}
```

Затем выполните:

```
/tts summary off
```

### Примечания по полям

- `auto`: режим авто‑TTS (`off`, `always`, `inbound`, `tagged`).
  - `inbound` отправляет аудио только после входящего голосового сообщения.
  - `tagged` отправляет аудио только когда ответ содержит теги `[[tts]]`.
- `enabled`: устаревший переключатель (doctor мигрирует его в `auto`).
- `mode`: `"final"` (по умолчанию) или `"all"` (включает ответы инструментов/блоков).
- `provider`: `"elevenlabs"`, `"openai"` или `"edge"` (резерв выбирается автоматически).
- Если `provider` **не задан**, OpenClaw предпочитает `openai` (если есть ключ), затем `elevenlabs` (если есть ключ),
  иначе `edge`.
- `summaryModel`: необязательная недорогая модель для авто‑резюме; по умолчанию `agents.defaults.model.primary`.
  - Принимает `provider/model` или настроенный алиас модели.
- `modelOverrides`: разрешить модели выдавать директивы TTS (включено по умолчанию).
- `maxTextLength`: жёсткий предел входа TTS (символы). `/tts audio` завершается ошибкой при превышении.
- `timeoutMs`: таймаут запроса (мс).
- `prefsPath`: переопределить путь к локальному JSON prefs (провайдер/лимиты/резюме).
- Значения `apiKey` берутся из переменных окружения (`ELEVENLABS_API_KEY`/`XI_API_KEY`, `OPENAI_API_KEY`).
- `elevenlabs.baseUrl`: переопределить базовый URL API ElevenLabs.
- `elevenlabs.voiceSettings`:
  - `stability`, `similarityBoost`, `style`: `0..1`
  - `useSpeakerBoost`: `true|false`
  - `speed`: `0.5..2.0` (1.0 = нормально)
- `elevenlabs.applyTextNormalization`: `auto|on|off`
- `elevenlabs.languageCode`: двухбуквенный ISO 639‑1 (например, `en`, `de`)
- `elevenlabs.seed`: целое число `0..4294967295` (best‑effort детерминизм)
- `edge.enabled`: разрешить использование Edge TTS (по умолчанию `true`; без ключа API).
- `edge.voice`: имя нейронного голоса Edge (например, `en-US-MichelleNeural`).
- `edge.lang`: код языка (например, `en-US`).
- `edge.outputFormat`: формат вывода Edge (например, `audio-24khz-48kbitrate-mono-mp3`).
  - Допустимые значения см. в форматах вывода Microsoft Speech; не все форматы поддерживаются Edge.
- `edge.rate` / `edge.pitch` / `edge.volume`: процентные строки (например, `+10%`, `-5%`).
- `edge.saveSubtitles`: записывать JSON‑субтитры рядом с аудиофайлом.
- `edge.proxy`: URL прокси для запросов Edge TTS.
- `edge.timeoutMs`: переопределение таймаута запроса (мс).

## Переопределения, управляемые моделью (включено по умолчанию)

По умолчанию модель **может** выдавать директивы TTS для одного ответа.
Когда `messages.tts.auto` имеет значение `tagged`, эти директивы обязательны для запуска аудио.

При включении модель может выдавать директивы `[[tts:...]]` для переопределения голоса
для одного ответа, а также необязательный блок `[[tts:text]]...[[/tts:text]]` для
передачи выразительных тегов (смех, подсказки пения и т. п.), которые должны присутствовать только в аудио.

Пример полезной нагрузки ответа:

```
Here you go.

[[tts:provider=elevenlabs voiceId=pMsXgVXv3BLzUgSXRplE model=eleven_v3 speed=1.1]]
[[tts:text]](laughs) Read the song once more.[[/tts:text]]
```

Доступные ключи директив (когда включено):

- `provider` (`openai` | `elevenlabs` | `edge`)
- `voice` (голос OpenAI) или `voiceId` (ElevenLabs)
- `model` (модель TTS OpenAI или id модели ElevenLabs)
- `stability`, `similarityBoost`, `style`, `speed`, `useSpeakerBoost`
- `applyTextNormalization` (`auto|on|off`)
- `languageCode` (ISO 639‑1)
- `seed`

Отключить все переопределения модели:

```json5
{
  messages: {
    tts: {
      modelOverrides: {
        enabled: false,
      },
    },
  },
}
```

Необязательный список разрешённых (отключить отдельные переопределения, сохранив теги включёнными):

```json5
{
  messages: {
    tts: {
      modelOverrides: {
        enabled: true,
        allowProvider: false,
        allowSeed: false,
      },
    },
  },
}
```

## Пользовательские предпочтения

Команды со слэшем записывают локальные переопределения в `prefsPath` (по умолчанию:
`~/.openclaw/settings/tts.json`, переопределяется с помощью `OPENCLAW_TTS_PREFS` или
`messages.tts.prefsPath`).

Сохраняемые поля:

- `enabled`
- `provider`
- `maxLength` (порог резюме; по умолчанию 1500 символов)
- `summarize` (по умолчанию `true`)

Они переопределяют `messages.tts.*` для данного хоста.

## Форматы вывода (фиксированные)

- **Telegram**: голосовое сообщение Opus (`opus_48000_64` от ElevenLabs, `opus` от OpenAI).
  - 48 кГц / 64 кбит/с — хороший компромисс для голосовых сообщений и требуется для круглого пузыря.
- **Другие каналы**: MP3 (`mp3_44100_128` от ElevenLabs, `mp3` от OpenAI).
  - 44,1 кГц / 128 кбит/с — баланс по умолчанию для разборчивости речи.
- **Edge TTS**: использует `edge.outputFormat` (по умолчанию `audio-24khz-48kbitrate-mono-mp3`).
  - `node-edge-tts` принимает `outputFormat`, но не все форматы доступны
    в сервисе Edge. citeturn2search0
  - Значения форматов вывода соответствуют форматам Microsoft Speech (включая Ogg/WebM Opus). citeturn1search0
  - Telegram `sendVoice` принимает OGG/MP3/M4A; используйте OpenAI/ElevenLabs, если нужны
    гарантированные голосовые сообщения Opus. citeturn1search1
  - Если настроенный формат вывода Edge не срабатывает, OpenClaw повторяет попытку с MP3.

Форматы OpenAI/ElevenLabs фиксированы; Telegram ожидает Opus для UX голосовых сообщений.

## Поведение авто‑TTS

При включении OpenClaw:

- пропускает TTS, если ответ уже содержит медиа или директиву `MEDIA:`.
- пропускает очень короткие ответы (< 10 символов).
- при включении резюмирует длинные ответы с использованием `agents.defaults.model.primary` (или `summaryModel`).
- прикрепляет сгенерированное аудио к ответу.

Если ответ превышает `maxLength` и резюме выключено (или нет ключа API для
модели резюме), аудио
пропускается и отправляется обычный текстовый ответ.

## Диаграмма потока

```
Reply -> TTS enabled?
  no  -> send text
  yes -> has media / MEDIA: / short?
          yes -> send text
          no  -> length > limit?
                   no  -> TTS -> attach audio
                   yes -> summary enabled?
                            no  -> send text
                            yes -> summarize (summaryModel or agents.defaults.model.primary)
                                      -> TTS -> attach audio
```

## Использование команд со слэшем

Существует одна команда: `/tts`.
Подробности включения см. в разделе [Команды со слэшем](/tools/slash-commands).

Примечание для Discord: `/tts` — это встроенная команда Discord, поэтому OpenClaw регистрирует
`/voice` как нативную команду там. Текстовая команда `/tts ...` по‑прежнему работает.

```
/tts off
/tts always
/tts inbound
/tts tagged
/tts status
/tts provider openai
/tts limit 2000
/tts summary off
/tts audio Hello from OpenClaw
```

Примечания:

- Команды требуют авторизованного отправителя (правила списка разрешённых/владельца сохраняются).
- Должны быть включены `commands.text` или регистрация нативных команд.
- `off|always|inbound|tagged` — это переключатели на сеанс (`/tts on` является псевдонимом для `/tts always`).
- `limit` и `summary` сохраняются в локальных prefs, а не в основном конфиге.
- `/tts audio` генерирует разовый аудио‑ответ (не включает TTS).

## Инструмент агента

Инструмент `tts` преобразует текст в речь и возвращает путь `MEDIA:`. Когда
результат совместим с Telegram, инструмент включает `[[audio_as_voice]]`, чтобы
Telegram отправлял голосовой пузырь.

## Gateway RPC

Методы Gateway:

- `tts.status`
- `tts.enable`
- `tts.disable`
- `tts.convert`
- `tts.setProvider`
- `tts.providers`
