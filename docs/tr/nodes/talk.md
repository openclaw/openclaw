---
summary: "Talk modu: ElevenLabs TTS ile sürekli sesli konuşmalar"
read_when:
  - macOS/iOS/Android üzerinde Talk modunun uygulanması
  - Ses/TTS/kesinti davranışının değiştirilmesi
title: "Talk Modu"
---

# Talk Modu

Talk modu, sürekli bir sesli konuşma döngüsüdür:

1. Konuşmayı dinler
2. Dökümü modele gönderir (ana oturum, chat.send)
3. Wait for the response
4. ElevenLabs üzerinden konuşur (akışlı oynatma)

## Davranış (macOS)

- Talk modu etkinleştirildiğinde **her zaman açık kaplama**.
- **Dinleme → Düşünme → Konuşma** aşama geçişleri.
- **Kısa bir duraklamada** (sessizlik penceresi), mevcut döküm gönderilir.
- Yanıtlar **WebChat’e yazılır** (yazmakla aynı).
- **Konuşmada kesme** (varsayılan açık): kullanıcı asistan konuşurken konuşmaya başlarsa, oynatmayı durdururuz ve bir sonraki istem için kesinti zaman damgasını not ederiz.

## Yanıtlarda ses yönergeleri

Asistan, sesi kontrol etmek için yanıtının başına **tek bir JSON satırı** ekleyebilir:

```json
{ "voice": "<voice-id>", "once": true }
```

Kurallar:

- Yalnızca ilk boş olmayan satır.
- Bilinmeyen anahtarlar yok sayılır.
- `once: true` yalnızca mevcut yanıt için geçerlidir.
- `once` olmadan, ses Talk modu için yeni varsayılan olur.
- JSON satırı, TTS oynatımı öncesinde kaldırılır.

Desteklenen anahtarlar:

- `voice` / `voice_id` / `voiceId`
- `model` / `model_id` / `modelId`
- `speed`, `rate` (WPM), `stability`, `similarity`, `style`, `speakerBoost`
- `seed`, `normalize`, `lang`, `output_format`, `latency_tier`
- `once`

## Yapılandırma (`~/.openclaw/openclaw.json`)

```json5
{
  talk: {
    voiceId: "elevenlabs_voice_id",
    modelId: "eleven_v3",
    outputFormat: "mp3_44100_128",
    apiKey: "elevenlabs_api_key",
    interruptOnSpeech: true,
  },
}
```

Varsayılanlar:

- `interruptOnSpeech`: true
- `voiceId`: `ELEVENLABS_VOICE_ID` / `SAG_VOICE_ID`’ya geri düşer (veya API anahtarı mevcut olduğunda ilk ElevenLabs sesi)
- `modelId`: ayarlanmadığında `eleven_v3`’e varsayılan olur
- `apiKey`: `ELEVENLABS_API_KEY`’a geri düşer (veya mevcutsa gateway kabuk profili)
- `outputFormat`: macOS/iOS’ta `pcm_44100`, Android’de `pcm_24000`’e varsayılan olur (MP3 akışını zorlamak için `mp3_*`’ü ayarlayın)

## macOS Arayüzü

- Menü çubuğu anahtarı: **Talk**
- Yapılandırma sekmesi: **Talk Modu** grubu (ses kimliği + kesinti anahtarı)
- Kaplama:
  - **Dinleme**: mikrofon seviyesine göre nabız atan bulut
  - **Düşünme**: aşağı çöken animasyon
  - **Konuşma**: yayılan halkalar
  - Buluta tıkla: konuşmayı durdur
  - X’e tıkla: Talk modundan çık

## Notlar

- Konuşma + Mikrofon izinleri gerektirir.
- Oturum anahtarı `main`’ya karşı `chat.send` kullanır.
- TTS, daha düşük gecikme için macOS/iOS/Android’de `ELEVENLABS_API_KEY` ile ElevenLabs akış API’sini ve artımlı oynatımı kullanır.
- `eleven_v3` için `stability`, `0.0`, `0.5` veya `1.0` olarak doğrulanır; diğer modeller `0..1`’ü kabul eder.
- `latency_tier`, ayarlandığında `0..4` olarak doğrulanır.
- Android, düşük gecikmeli AudioTrack akışı için `pcm_16000`, `pcm_22050`, `pcm_24000` ve `pcm_44100` çıktı biçimlerini destekler.
