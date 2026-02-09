---
summary: "Gelen sesli notlar için Deepgram transkripsiyonu"
read_when:
  - Ses ekleri için Deepgram konuşmadan metne istiyorsanız
  - Hızlı bir Deepgram yapılandırma örneğine ihtiyacınız varsa
title: "Deepgram"
---

# Deepgram (Ses Transkripsiyonu)

Deepgram bir konuşmadan metne API’sidir. OpenClaw’da **gelen ses/sesli not
transkripsiyonu** için `tools.media.audio` üzerinden kullanılır.

Etkinleştirildiğinde, OpenClaw ses dosyasını Deepgram’e yükler ve transkripti
yanıt hattına enjekte eder (`{{Transcript}}` + `[Audio]` bloğu). Bu **akış değildir**;
önceden kaydedilmiş transkripsiyon uç noktasını kullanır.

Web sitesi: [https://deepgram.com](https://deepgram.com)  
Dokümanlar: [https://developers.deepgram.com](https://developers.deepgram.com)

## Hızlı başlangıç

1. API anahtarınızı ayarlayın:

```
DEEPGRAM_API_KEY=dg_...
```

2. Sağlayıcıyı etkinleştirin:

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

## Seçenekler

- `model`: Deepgram model kimliği (varsayılan: `nova-3`)
- `language`: dil ipucu (isteğe bağlı)
- `tools.media.audio.providerOptions.deepgram.detect_language`: dil algılamayı etkinleştir (isteğe bağlı)
- `tools.media.audio.providerOptions.deepgram.punctuate`: noktalama işaretlerini etkinleştir (isteğe bağlı)
- `tools.media.audio.providerOptions.deepgram.smart_format`: akıllı biçimlendirmeyi etkinleştir (isteğe bağlı)

Dil ile örnek:

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

Deepgram seçenekleriyle örnek:

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

## Notlar

- Kimlik doğrulama standart sağlayıcı yetkilendirme sırasını izler; `DEEPGRAM_API_KEY` en basit yoldur.
- Bir proxy kullanırken uç noktaları veya başlıkları `tools.media.audio.baseUrl` ve `tools.media.audio.headers` ile geçersiz kılın.
- Çıktı, diğer sağlayıcılarla aynı ses kurallarını izler (boyut sınırları, zaman aşımları, transkript enjeksiyonu).
