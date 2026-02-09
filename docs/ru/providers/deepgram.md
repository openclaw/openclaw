---
summary: "Транскрипция входящих голосовых заметок с помощью Deepgram"
read_when:
  - Вам нужен speech-to-text Deepgram для аудиовложений
  - Вам нужен быстрый пример конфигурации Deepgram
title: "Deepgram"
---

# Deepgram (Транскрипция аудио)

Deepgram — это API для преобразования речи в текст. В OpenClaw он используется для **транскрипции входящих аудио/голосовых заметок**
через `tools.media.audio`.

При включении OpenClaw загружает аудиофайл в Deepgram и внедряет расшифровку
в конвейер ответа (блок `{{Transcript}}` + `[Audio]`). Это **не потоковая** обработка;
используется эндпоинт транскрипции предварительно записанного аудио.

Сайт: [https://deepgram.com](https://deepgram.com)  
Документация: [https://developers.deepgram.com](https://developers.deepgram.com)

## Быстрый старт

1. Задайте ваш ключ API:

```
DEEPGRAM_API_KEY=dg_...
```

2. Включите провайдер:

```json5
{
  tools: {
    media: {
      audio: {
        enabled: true,
        models: [{ provider: "deepgram", model: "nova-3" }],
      },
    },
  },
}
```

## Параметры

- `model`: идентификатор модели Deepgram (по умолчанию: `nova-3`)
- `language`: подсказка языка (необязательно)
- `tools.media.audio.providerOptions.deepgram.detect_language`: включить определение языка (необязательно)
- `tools.media.audio.providerOptions.deepgram.punctuate`: включить пунктуацию (необязательно)
- `tools.media.audio.providerOptions.deepgram.smart_format`: включить умное форматирование (необязательно)

Пример с указанием языка:

```json5
{
  tools: {
    media: {
      audio: {
        enabled: true,
        models: [{ provider: "deepgram", model: "nova-3", language: "en" }],
      },
    },
  },
}
```

Пример с параметрами Deepgram:

```json5
{
  tools: {
    media: {
      audio: {
        enabled: true,
        providerOptions: {
          deepgram: {
            detect_language: true,
            punctuate: true,
            smart_format: true,
          },
        },
        models: [{ provider: "deepgram", model: "nova-3" }],
      },
    },
  },
}
```

## Примечания

- Аутентификация следует стандартному порядку провайдеров; `DEEPGRAM_API_KEY` — самый простой путь.
- Переопределяйте эндпоинты или заголовки с помощью `tools.media.audio.baseUrl` и `tools.media.audio.headers` при использовании прокси.
- Вывод соответствует тем же правилам обработки аудио, что и у других провайдеров (ограничения размера, тайм-ауты, внедрение транскрипта).
