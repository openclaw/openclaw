---
summary: "Gelen ses/sesli notların nasıl indirildiği, yazıya döküldüğü ve yanıtlara enjekte edildiği"
read_when:
  - Ses yazıya dökümü veya medya işleme değiştirildiğinde
title: "Ses ve Sesli Notlar"
---

# Ses / Sesli Notlar — 2026-01-17

## What works

- **Medya anlama (ses)**: Ses anlama etkinse (veya otomatik algılanıyorsa), OpenClaw:
  1. İlk ses ekini (yerel yol veya URL) bulur ve gerekirse indirir.
  2. Her model girdisine göndermeden önce `maxBytes` uygular.
  3. Uygun ilk model girdisini sırayla çalıştırır (sağlayıcı veya CLI).
  4. Başarısız olursa veya atlanırsa (boyut/zaman aşımı), bir sonraki girdiyi dener.
  5. Başarı durumunda `Body` öğesini bir `[Audio]` bloğu ile değiştirir ve `{{Transcript}}` ayarlar.
- **Komut ayrıştırma**: Yazıya döküm başarılı olduğunda, eğik çizgi komutları çalışmaya devam etsin diye `CommandBody`/`RawBody` transkript olarak ayarlanır.
- **Ayrıntılı günlükleme**: `--verbose` içinde, yazıya dökümün ne zaman çalıştığını ve gövdeyi ne zaman değiştirdiğini günlüğe kaydederiz.

## Otomatik algılama (varsayılan)

**Modelleri yapılandırmazsanız** ve `tools.media.audio.enabled` **`false` olarak ayarlı değilse**,  
OpenClaw aşağıdaki sırayla otomatik algılar ve çalışan ilk seçenekte durur:

1. **Local CLIs** (if installed)
   - `sherpa-onnx-offline` (kodlayıcı/kod çözücü/birleştirici/tokenlar ile `SHERPA_ONNX_MODEL_DIR` gerektirir)
   - `whisper-cli` (`whisper-cpp` kaynağından; `WHISPER_CPP_MODEL` veya paketlenmiş tiny modeli kullanır)
   - `whisper` (Python CLI; modelleri otomatik indirir)
2. **Gemini CLI** (`gemini`) kullanılarak `read_many_files`
3. **Sağlayıcı anahtarları** (OpenAI → Groq → Deepgram → Google)

Otomatik algılamayı devre dışı bırakmak için `tools.media.audio.enabled: false` ayarlayın.
Özelleştirmek için `tools.media.audio.models` ayarlayın.
Not: İkili dosya algılama macOS/Linux/Windows genelinde en iyi çaba ile yapılır; CLI'nin `PATH` üzerinde olduğundan emin olun (`~` genişletilir) veya tam komut yoluyla açık bir CLI modeli ayarlayın.

## Yapılandırma örnekleri

### Sağlayıcı + CLI geri dönüşü (OpenAI + Whisper CLI)

```json5
{
  tools: {
    media: {
      audio: {
        enabled: true,
        maxBytes: 20971520,
        models: [
          { provider: "openai", model: "gpt-4o-mini-transcribe" },
          {
            type: "cli",
            command: "whisper",
            args: ["--model", "base", "{{MediaPath}}"],
            timeoutSeconds: 45,
          },
        ],
      },
    },
  },
}
```

### Kapsam geçitli yalnızca sağlayıcı

```json5
{
  tools: {
    media: {
      audio: {
        enabled: true,
        scope: {
          default: "allow",
          rules: [{ action: "deny", match: { chatType: "group" } }],
        },
        models: [{ provider: "openai", model: "gpt-4o-mini-transcribe" }],
      },
    },
  },
}
```

### Yalnızca sağlayıcı (Deepgram)

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

## Notlar ve sınırlar

- Sağlayıcı kimlik doğrulaması, standart model kimlik doğrulama sırasını izler (kimlik doğrulama profilleri, ortam değişkenleri, `models.providers.*.apiKey`).
- `provider: "deepgram"` kullanıldığında Deepgram, `DEEPGRAM_API_KEY` değerini alır.
- Deepgram kurulum ayrıntıları: [Deepgram (ses yazıya dökümü)](/providers/deepgram).
- Ses sağlayıcıları, `tools.media.audio` aracılığıyla `baseUrl`, `headers` ve `providerOptions` değerlerini geçersiz kılabilir.
- Varsayılan boyut üst sınırı 20MB'dir (`tools.media.audio.maxBytes`). Aşırı büyük ses, o model için atlanır ve bir sonraki girdi denenir.
- Ses için varsayılan `maxChars` **ayarlı değildir** (tam transkript). Çıktıyı kırpmak için `tools.media.audio.maxChars` veya girdi başına `maxChars` ayarlayın.
- OpenAI otomatik varsayılanı `gpt-4o-mini-transcribe`’tir; daha yüksek doğruluk için `model: "gpt-4o-transcribe"` ayarlayın.
- Birden fazla sesli notu işlemek için `tools.media.audio.attachments` kullanın (`mode: "all"` + `maxAttachments`).
- Transkript, şablonlara `{{Transcript}}` olarak sunulur.
- CLI stdout çıktısı sınırlandırılmıştır (5MB); CLI çıktısını kısa tutun.

## Gotchas

- Kapsam kuralları ilk eşleşme kazanır. `chatType`, `direct`, `group` veya `room` olarak normalize edilir.
- CLI'nizin 0 koduyla çıkmasını ve düz metin yazdırmasını sağlayın; JSON çıktısı `jq -r .text` ile uyarlanmalıdır.
- Yanıt kuyruğunu engellememek için zaman aşımlarını makul tutun (`timeoutSeconds`, varsayılan 60 sn).
