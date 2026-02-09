---
summary: "Giden yanıtlar için metinden konuşmaya (TTS)"
read_when:
  - Yanıtlar için metinden konuşmayı etkinleştirme
  - TTS sağlayıcılarını veya sınırlarını yapılandırma
  - /tts komutlarını kullanma
title: "Metinden Konuşmaya"
---

# Metinden konuşmaya (TTS)

OpenClaw, giden yanıtları ElevenLabs, OpenAI veya Edge TTS kullanarak sese dönüştürebilir.
OpenClaw’ın ses gönderebildiği her yerde çalışır; Telegram’da yuvarlak bir sesli not balonu görünür.

## Desteklenen hizmetler

- **ElevenLabs** (birincil veya yedek sağlayıcı)
- **OpenAI** (birincil veya yedek sağlayıcı; özetler için de kullanılır)
- **Edge TTS** (birincil veya yedek sağlayıcı; `node-edge-tts` kullanır, API anahtarı yokken varsayılandır)

### Edge TTS notları

Edge TTS, `node-edge-tts` kütüphanesi aracılığıyla Microsoft Edge’in çevrimiçi nöral TTS hizmetini kullanır. Barındırılan bir hizmettir (yerel değildir), Microsoft’un uç noktalarını kullanır ve bir API anahtarı gerektirmez. `node-edge-tts` konuşma yapılandırma seçeneklerini ve çıktı biçimlerini sunar; ancak tüm seçenekler Edge hizmeti tarafından desteklenmez. citeturn2search0

Edge TTS yayımlanmış bir SLA veya kota olmadan herkese açık bir web hizmeti olduğundan, en iyi çaba esasına göre değerlendirin. Garantili sınırlar ve destek gerekiyorsa OpenAI veya ElevenLabs kullanın.
Microsoft’un Speech REST API belgeleri istek başına 10 dakikalık ses sınırı belirtir; Edge TTS sınır yayımlamaz, bu nedenle benzer veya daha düşük sınırlar varsayılmalıdır. citeturn0search3

## İsteğe bağlı anahtarlar

OpenAI veya ElevenLabs istiyorsanız:

- `ELEVENLABS_API_KEY` (veya `XI_API_KEY`)
- `OPENAI_API_KEY`

Edge TTS bir API anahtarı **gerektirmez**. Hiçbir API anahtarı bulunmazsa OpenClaw varsayılan olarak Edge TTS’ye geçer ( `messages.tts.edge.enabled=false` ile devre dışı bırakılmadıkça).

Birden fazla sağlayıcı yapılandırılmışsa, seçilen sağlayıcı önce kullanılır ve diğerleri yedek seçeneklerdir.
Otomatik özet, yapılandırılmış `summaryModel` (veya `agents.defaults.model.primary`) kullanır;
bu nedenle özetleri etkinleştirirseniz o sağlayıcı da kimlik doğrulanmış olmalıdır.

## Hizmet bağlantıları

- [OpenAI Text-to-Speech guide](https://platform.openai.com/docs/guides/text-to-speech)
- [OpenAI Audio API reference](https://platform.openai.com/docs/api-reference/audio)
- [ElevenLabs Text to Speech](https://elevenlabs.io/docs/api-reference/text-to-speech)
- [ElevenLabs Authentication](https://elevenlabs.io/docs/api-reference/authentication)
- [node-edge-tts](https://github.com/SchneeHertz/node-edge-tts)
- [Microsoft Speech output formats](https://learn.microsoft.com/azure/ai-services/speech-service/rest-text-to-speech#audio-outputs)

## Varsayılan olarak etkin mi?

Hayır. Auto‑TTS varsayılan olarak **kapalıdır**. Yapılandırmada `messages.tts.auto` ile
veya oturum başına `/tts always` (takma ad: `/tts on`) ile etkinleştirin.

TTS açıldığında Edge TTS varsayılan olarak **etkindir** ve OpenAI veya ElevenLabs API anahtarları mevcut olmadığında otomatik olarak kullanılır.

## Yapılandırma

TTS yapılandırması `openclaw.json` içinde `messages.tts` altında yer alır.
Tam şema [Gateway yapılandırması](/gateway/configuration) sayfasındadır.

### Asgari yapılandırma (etkinleştirme + sağlayıcı)

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

### OpenAI birincil, ElevenLabs yedek

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

### Edge TTS birincil (API anahtarı yok)

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

### Edge TTS’yi devre dışı bırak

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

### Özel sınırlar + prefs yolu

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

### Yalnızca gelen bir sesli nottan sonra sesli yanıt ver

```json5
{
  messages: {
    tts: {
      auto: "inbound",
    },
  },
}
```

### Uzun yanıtlar için otomatik özeti devre dışı bırak

```json5
{
  messages: {
    tts: {
      auto: "always",
    },
  },
}
```

Ardından çalıştırın:

```
/tts summary off
```

### Alanlara ilişkin notlar

- `auto`: auto‑TTS modu (`off`, `always`, `inbound`, `tagged`).
  - `inbound` yalnızca gelen bir sesli nottan sonra ses gönderir.
  - `tagged` yalnızca yanıt `[[tts]]` etiketlerini içerdiğinde ses gönderir.
- `enabled`: eski anahtar (doctor bunu `auto`’ya taşır).
- `mode`: `"final"` (varsayılan) veya `"all"` (araç/blok yanıtlarını içerir).
- `provider`: `"elevenlabs"`, `"openai"` veya `"edge"` (yedek otomatik).
- `provider` **ayarlanmadıysa**, OpenClaw `openai`’i (anahtar varsa), ardından `elevenlabs`’yı (anahtar varsa),
  aksi halde `edge`’yi tercih eder.
- `summaryModel`: otomatik özet için isteğe bağlı ucuz model; varsayılan `agents.defaults.model.primary`.
  - `provider/model` veya yapılandırılmış bir model takma adını kabul eder.
- `modelOverrides`: modelin TTS yönergeleri üretmesine izin ver (varsayılan açık).
- `maxTextLength`: TTS girişi için katı üst sınır (karakter). Aşılırsa `/tts audio` başarısız olur.
- `timeoutMs`: istek zaman aşımı (ms).
- `prefsPath`: yerel prefs JSON yolunu geçersiz kıl (sağlayıcı/sınır/özet).
- `apiKey` değerleri ortam değişkenlerine geri düşer (`ELEVENLABS_API_KEY`/`XI_API_KEY`, `OPENAI_API_KEY`).
- `elevenlabs.baseUrl`: ElevenLabs API temel URL’sini geçersiz kıl.
- `elevenlabs.voiceSettings`:
  - `stability`, `similarityBoost`, `style`: `0..1`
  - `useSpeakerBoost`: `true|false`
  - `speed`: `0.5..2.0` (1.0 = normal)
- `elevenlabs.applyTextNormalization`: `auto|on|off`
- `elevenlabs.languageCode`: 2 harfli ISO 639-1 (örn. `en`, `de`)
- `elevenlabs.seed`: tamsayı `0..4294967295` (en iyi çaba ile determinizm)
- `edge.enabled`: Edge TTS kullanımına izin ver (varsayılan `true`; API anahtarı yok).
- `edge.voice`: Edge nöral ses adı (örn. `en-US-MichelleNeural`).
- `edge.lang`: dil kodu (örn. `en-US`).
- `edge.outputFormat`: Edge çıktı biçimi (örn. `audio-24khz-48kbitrate-mono-mp3`).
  - Geçerli değerler için Microsoft Speech çıktı biçimlerine bakın; tüm biçimler Edge tarafından desteklenmez.
- `edge.rate` / `edge.pitch` / `edge.volume`: yüzde dizgeleri (örn. `+10%`, `-5%`).
- `edge.saveSubtitles`: ses dosyasının yanına JSON altyazıları yaz.
- `edge.proxy`: Edge TTS istekleri için proxy URL’si.
- `edge.timeoutMs`: istek zaman aşımı geçersiz kılma (ms).

## Model güdümlü geçersiz kılmalar (varsayılan açık)

Varsayılan olarak model tek bir yanıt için TTS yönergeleri **üretebilir**.
`messages.tts.auto` `tagged` olduğunda, sesi tetiklemek için bu yönergeler gereklidir.

Etkinleştirildiğinde model, tek bir yanıt için sesi geçersiz kılmak üzere `[[tts:...]]` yönergeleri
ve ayrıca yalnızca seste görünmesi gereken ifadeleri (kahkaha, şarkı söyleme ipuçları vb.) sağlamak için isteğe bağlı bir `[[tts:text]]...[[/tts:text]]` bloğu üretebilir.

Örnek yanıt yükü:

```
Here you go.

[[tts:provider=elevenlabs voiceId=pMsXgVXv3BLzUgSXRplE model=eleven_v3 speed=1.1]]
[[tts:text]](laughs) Read the song once more.[[/tts:text]]
```

Kullanılabilir yönerge anahtarları (etkin olduğunda):

- `provider` (`openai` | `elevenlabs` | `edge`)
- `voice` (OpenAI sesi) veya `voiceId` (ElevenLabs)
- `model` (OpenAI TTS modeli veya ElevenLabs model kimliği)
- `stability`, `similarityBoost`, `style`, `speed`, `useSpeakerBoost`
- `applyTextNormalization` (`auto|on|off`)
- `languageCode` (ISO 639-1)
- `seed`

Tüm model geçersiz kılmalarını devre dışı bırak:

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

İsteğe bağlı izin listesi (etiketler açık kalırken belirli geçersiz kılmaları devre dışı bırak):

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

## Kullanıcı başına tercihler

Slash komutları yerel geçersiz kılmaları `prefsPath`’e yazar (varsayılan:
`~/.openclaw/settings/tts.json`, `OPENCLAW_TTS_PREFS` veya
`messages.tts.prefsPath` ile geçersiz kılın).

Saklanan alanlar:

- `enabled`
- `provider`
- `maxLength` (özet eşiği; varsayılan 1500 karakter)
- `summarize` (varsayılan `true`)

Bunlar, o ana makine için `messages.tts.*`’yi geçersiz kılar.

## Çıktı biçimleri (sabit)

- **Telegram**: Opus sesli not (`opus_48000_64` ElevenLabs’tan, `opus` OpenAI’dan).
  - 48kHz / 64kbps, sesli not için iyi bir dengedir ve yuvarlak balon için gereklidir.
- **Diğer kanallar**: MP3 (`mp3_44100_128` ElevenLabs’tan, `mp3` OpenAI’dan).
  - 44.1kHz / 128kbps, konuşma netliği için varsayılan dengedir.
- **Edge TTS**: `edge.outputFormat` kullanır (varsayılan `audio-24khz-48kbitrate-mono-mp3`).
  - `node-edge-tts`, bir `outputFormat` kabul eder; ancak tüm biçimler
    Edge hizmetinden kullanılamaz. citeturn2search0
  - Çıktı biçimi değerleri Microsoft Speech çıktı biçimlerini izler (Ogg/WebM Opus dahil). citeturn1search0
  - Telegram `sendVoice`, OGG/MP3/M4A kabul eder; garantili Opus sesli notlar
    gerekiyorsa OpenAI/ElevenLabs kullanın. citeturn1search1
  - Yapılandırılan Edge çıktı biçimi başarısız olursa, OpenClaw MP3 ile yeniden dener.

OpenAI/ElevenLabs biçimleri sabittir; Telegram, sesli not UX’i için Opus bekler.

## Auto‑TTS davranışı

Etkinleştirildiğinde OpenClaw:

- yanıt zaten medya veya bir `MEDIA:` yönergesi içeriyorsa TTS’yi atlar.
- çok kısa yanıtları (< 10 karakter) atlar.
- etkinse uzun yanıtları `agents.defaults.model.primary` (veya `summaryModel`) kullanarak özetler.
- üretilen sesi yanıta ekler.

Yanıt `maxLength`’i aşarsa ve özet kapalıysa (veya
özet modeli için API anahtarı yoksa), ses
atlanır ve normal metin yanıtı gönderilir.

## Akış diyagramı

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

## Slash komutu kullanımı

Tek bir komut vardır: `/tts`.
Etkinleştirme ayrıntıları için [Slash komutları](/tools/slash-commands) sayfasına bakın.

Discord notu: `/tts` Discord’un yerleşik bir komutudur, bu nedenle OpenClaw
orada yerel komut olarak `/voice`’i kaydeder. Metin `/tts ...` yine çalışır.

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

Notlar:

- Komutlar yetkili bir gönderen gerektirir (izin listesi/sahip kuralları geçerlidir).
- `commands.text` veya yerel komut kaydı etkin olmalıdır.
- `off|always|inbound|tagged` oturum başına anahtarlardır (`/tts on`, `/tts always` için bir takma addır).
- `limit` ve `summary` ana yapılandırmada değil, yerel prefs’te saklanır.
- `/tts audio` tek seferlik bir sesli yanıt üretir (TTS’yi açık/kapalı yapmaz).

## Ajan aracı

`tts` aracı metni konuşmaya dönüştürür ve bir `MEDIA:` yolu döndürür. Sonuç
Telegram ile uyumluysa, araç `[[audio_as_voice]]` içerir ve
Telegram bir ses balonu gönderir.

## Gateway RPC

Gateway yöntemleri:

- `tts.status`
- `tts.enable`
- `tts.disable`
- `tts.convert`
- `tts.setProvider`
- `tts.providers`
