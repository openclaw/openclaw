---
summary: "İş akışları için yalnızca JSON LLM görevleri (isteğe bağlı eklenti aracı)"
read_when:
  - İş akışları içinde yalnızca JSON kullanan bir LLM adımı istediğinizde
  - Otomasyon için şema doğrulamalı LLM çıktısına ihtiyaç duyduğunuzda
title: "LLM Görevi"
---

# LLM Görevi

`llm-task`, yalnızca JSON kullanan bir LLM görevini çalıştıran ve
yapılandırılmış çıktı döndüren (**isteğe bağlı olarak JSON Schema’ya göre doğrulanmış**) **isteğe bağlı bir eklenti aracıdır**.

Bu, Lobster gibi iş akışı motorları için idealdir: her iş akışı için özel OpenClaw kodu yazmadan tek bir LLM adımı ekleyebilirsiniz.

## Eklentiyi etkinleştirme

1. Eklentiyi etkinleştirin:

```json
{
  "plugins": {
    "entries": {
      "llm-task": { "enabled": true }
    }
  }
}
```

2. Aracı izin listesine ekleyin ( `optional: true` ile kayıtlıdır):

```json
{
  "agents": {
    "list": [
      {
        "id": "main",
        "tools": { "allow": ["llm-task"] }
      }
    ]
  }
}
```

## Yapılandırma (isteğe bağlı)

```json
{
  "plugins": {
    "entries": {
      "llm-task": {
        "enabled": true,
        "config": {
          "defaultProvider": "openai-codex",
          "defaultModel": "gpt-5.2",
          "defaultAuthProfileId": "main",
          "allowedModels": ["openai-codex/gpt-5.3-codex"],
          "maxTokens": 800,
          "timeoutMs": 30000
        }
      }
    }
  }
}
```

`allowedModels`, `provider/model` dizgelerinden oluşan bir izin listesidir. Ayarlanırsa,
liste dışındaki tüm istekler reddedilir.

## Araç parametreleri

- `prompt` (string, gerekli)
- `input` (any, isteğe bağlı)
- `schema` (object, isteğe bağlı JSON Schema)
- `provider` (string, isteğe bağlı)
- `model` (string, isteğe bağlı)
- `authProfileId` (string, isteğe bağlı)
- `temperature` (number, isteğe bağlı)
- `maxTokens` (number, isteğe bağlı)
- `timeoutMs` (number, isteğe bağlı)

## Çıktı

Ayrıştırılmış JSON’u içeren `details.json` döndürür (sağlandığında
`schema`’e göre doğrular).

## Örnek: Lobster iş akışı adımı

```lobster
openclaw.invoke --tool llm-task --action json --args-json '{
  "prompt": "Given the input email, return intent and draft.",
  "input": {
    "subject": "Hello",
    "body": "Can you help?"
  },
  "schema": {
    "type": "object",
    "properties": {
      "intent": { "type": "string" },
      "draft": { "type": "string" }
    },
    "required": ["intent", "draft"],
    "additionalProperties": false
  }
}'
```

## Güvenli kullanım notları

- Araç **yalnızca JSON** üretir ve modeli yalnızca JSON çıktısı vermesi için yönlendirir (kod blokları yok, açıklama yok).
- Bu çalıştırma için modele hiçbir araç sunulmaz.
- `schema` ile doğrulamadıkça çıktıyı güvenilmez kabul edin.
- Yan etki oluşturan herhangi bir adımdan (gönderme, paylaşma, çalıştırma) önce onayları ekleyin.
