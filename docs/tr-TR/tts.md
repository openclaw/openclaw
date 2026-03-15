---
summary: "Giden yanıtlar için Text-to-speech (TTS)"
read_when:
  - Yanıtlar için metin okuma özelliğini etkinleştirirken
  - TTS sağlayıcılarını veya sınırlarını yapılandırırken
  - /tts komutlarını kullanırken
title: "Text-to-Speech"
---

# Text-to-speech (TTS)

OpenClaw, giden yanıtları ElevenLabs, OpenAI veya Edge TTS kullanarak sese dönüştürebilir.
OpenClaw'un ses gönderebildiği her yerde çalışır; Telegram yuvarlak ses notu baloncuğu alır.

## Desteklenen Servisler

- **ElevenLabs** (birincil veya fallback sağlayıcı)
- **OpenAI** (birincil veya fallback sağlayıcı; özetler için de kullanılır)
- **Edge TTS** (birincil veya fallback sağlayıcı; `node-edge-tts` kullanır, API anahtarı olmadığında varsayılan)

### Edge TTS Notları

Edge TTS, `node-edge-tts` kütüphanesi aracılığıyla Microsoft Edge'in çevrimiçi sinirsel TTS servisini kullanır.
Barındırılan bir servistir (yerel değil), Microsoft'un uç noktalarını kullanır ve API anahtarı gerektirmez. `node-edge-tts` konuşma yapılandırma seçenekleri ve çıktı formatlarını ortaya çıkarır, ancak tüm seçenekler Edge servisi tarafından desteklenmez.

Edge TTS yayınlanmış bir SLA veya kota olmadan genel bir web servisi olduğundan, en iyi çabayla davranın. Garanti edilmiş sınırlar ve destek gerekiyorsa, OpenAI veya ElevenLabs kullanın. Microsoft'un Konuşma REST API'si istek başına 10 dakikalık bir ses limiti belgeler; Edge TTS limitleri yayınlamaz, bu nedenle benzer veya daha düşük limitler varsayın.

## İsteğe Bağlı Anahtarlar

OpenAI veya ElevenLabs isterseniz:

- `ELEVENLABS_API_KEY` (veya `XI_API_KEY`)
- `OPENAI_API_KEY`

Edge TTS API anahtarı gerektirmez. API anahtarı bulunamazsa, OpenClaw Edge TTS'yi varsayılan olarak kullanır (aksi takdirde `messages.tts.edge.enabled=false` ile devre dışı bırakılmadıkça).

Birden fazla sağlayıcı yapılandırılmışsa, seçilen sağlayıcı önce kullanılır ve diğerleri fallback seçeneklerdir.
Otomatik özet, yapılandırılmış `summaryModel` (veya `agents.defaults.model.primary`) kullandığından, özetleri etkinleştirirseniz o sağlayıcının da kimlik doğrulaması yapılmış olmalıdır.

## Servis Bağlantıları

- [OpenAI Text-to-Speech kılavuzu](https://platform.openai.com/docs/guides/text-to-speech)
- [OpenAI Audio API referansı](https://platform.openai.com/docs/api-reference/audio)

## Aktif Etme

TTS'yi etkinleştirmek için:

```json5
{
  messages: {
    tts: {
      enabled: true,
    },
  },
}
```

## Sesli Yanıt Verme

Ajan yanıt verirken TTS tetiklemek için:

1. Ajanı oluştururken veya yapılandırırken TTS'yi etkinleştirin
2. Yanıt otomatik olarak sese dönüştürülür
3. Kullanıcı sesli yanıt olarak dinler

## Komutlar

- `/tts on` - TTS'yi aç
- `/tts off` - TTS'yi kapat
- `/tts [sağlayıcı]` - Belirli sağlayıcıya geç (örn. `/tts elevenlabs`)

## Sorun Giderme

- TTS çalışmıyorsa, API anahtarlarınızı kontrol edin
- Ses kalitesi düşükse, farklı bir sağlayıcı deneyin
- Edge TTS sınırlarına dikkat edin
