---
summary: "Chuyển văn bản thành giọng nói (TTS) cho các phản hồi gửi đi"
read_when:
  - Bật chuyển văn bản thành giọng nói cho phản hồi
  - Cấu hình nhà cung cấp TTS hoặc giới hạn
  - Sử dụng lệnh /tts
title: "Chuyển văn bản thành giọng nói"
---

# Chuyển văn bản thành giọng nói (TTS)

OpenClaw can convert outbound replies into audio using ElevenLabs, OpenAI, or Edge TTS.
It works anywhere OpenClaw can send audio; Telegram gets a round voice-note bubble.

## Dịch vụ được hỗ trợ

- **ElevenLabs** (nhà cung cấp chính hoặc dự phòng)
- **OpenAI** (nhà cung cấp chính hoặc dự phòng; cũng dùng cho tóm tắt)
- **Edge TTS** (nhà cung cấp chính hoặc dự phòng; dùng `node-edge-tts`, mặc định khi không có khóa API)

### Ghi chú về Edge TTS

Edge TTS uses Microsoft Edge's online neural TTS service via the `node-edge-tts`
library. It's a hosted service (not local), uses Microsoft’s endpoints, and does
not require an API key. `node-edge-tts` exposes speech configuration options and
output formats, but not all options are supported by the Edge service. citeturn2search0

Vì Edge TTS là một dịch vụ web công cộng không có SLA hoặc hạn mức được công bố, hãy xem nó như cơ chế best‑effort. 23. Nếu bạn cần giới hạn và hỗ trợ được đảm bảo, hãy dùng OpenAI hoặc ElevenLabs.
Microsoft Speech REST API tài liệu hóa giới hạn âm thanh 10 phút cho mỗi yêu cầu; Edge TTS không công bố giới hạn, vì vậy hãy giả định các giới hạn tương tự hoặc thấp hơn. 24. citeturn0search3

## Khóa tùy chọn

Nếu bạn muốn dùng OpenAI hoặc ElevenLabs:

- `ELEVENLABS_API_KEY` (hoặc `XI_API_KEY`)
- `OPENAI_API_KEY`

Edge TTS **không** yêu cầu khóa API. 37. Nếu không tìm thấy khóa API nào, OpenClaw mặc định
sử dụng Edge TTS (trừ khi bị vô hiệu hóa qua `messages.tts.edge.enabled=false`).

Nếu cấu hình nhiều nhà cung cấp, nhà cung cấp được chọn sẽ được dùng trước và các nhà cung cấp còn lại là phương án dự phòng.
Tự động tóm tắt sử dụng `summaryModel` đã cấu hình (hoặc `agents.defaults.model.primary`), vì vậy nhà cung cấp đó cũng phải được xác thực nếu bạn bật tóm tắt.

## Liên kết dịch vụ

- [Hướng dẫn Text-to-Speech của OpenAI](https://platform.openai.com/docs/guides/text-to-speech)
- [Tham chiếu OpenAI Audio API](https://platform.openai.com/docs/api-reference/audio)
- [Text to Speech của ElevenLabs](https://elevenlabs.io/docs/api-reference/text-to-speech)
- [Xác thực ElevenLabs](https://elevenlabs.io/docs/api-reference/authentication)
- [node-edge-tts](https://github.com/SchneeHertz/node-edge-tts)
- [Định dạng đầu ra Microsoft Speech](https://learn.microsoft.com/azure/ai-services/speech-service/rest-text-to-speech#audio-outputs)

## Mặc định có bật không?

Không. 38. Auto‑TTS **tắt** theo mặc định. 39. Bật trong cấu hình với
`messages.tts.auto` hoặc theo từng phiên bằng `/tts always` (bí danh: `/tts on`).

Edge TTS **được** bật theo mặc định khi TTS được bật, và sẽ tự động được dùng
khi không có khóa API OpenAI hoặc ElevenLabs.

## Cấu hình

Cấu hình TTS nằm dưới `messages.tts` trong `openclaw.json`.
Schema đầy đủ ở [Gateway configuration](/gateway/configuration).

### Cấu hình tối thiểu (bật + nhà cung cấp)

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

### OpenAI làm chính với ElevenLabs dự phòng

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

### Edge TTS làm chính (không cần khóa API)

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

### Tắt Edge TTS

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

### Giới hạn tùy chỉnh + đường dẫn prefs

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

### Chỉ trả lời bằng âm thanh sau một ghi âm đầu vào

```json5
{
  messages: {
    tts: {
      auto: "inbound",
    },
  },
}
```

### Tắt tự động tóm tắt cho phản hồi dài

```json5
{
  messages: {
    tts: {
      auto: "always",
    },
  },
}
```

Sau đó chạy:

```
/tts summary off
```

### Ghi chú về các trường

- `auto`: chế độ auto‑TTS (`off`, `always`, `inbound`, `tagged`).
  - `inbound` chỉ gửi âm thanh sau một ghi âm đầu vào.
  - `tagged` chỉ gửi âm thanh khi phản hồi có thẻ `[[tts]]`.
- `enabled`: công tắc cũ (doctor sẽ chuyển sang `auto`).
- `mode`: `"final"` (mặc định) hoặc `"all"` (bao gồm phản hồi tool/block).
- `provider`: `"elevenlabs"`, `"openai"` hoặc `"edge"` (tự động dự phòng).
- Nếu `provider` **chưa đặt**, OpenClaw ưu tiên `openai` (nếu có khóa), sau đó `elevenlabs` (nếu có khóa),
  nếu không thì `edge`.
- `summaryModel`: mô hình rẻ tùy chọn cho auto‑summary; mặc định là `agents.defaults.model.primary`.
  - Chấp nhận `provider/model` hoặc một bí danh mô hình đã cấu hình.
- `modelOverrides`: cho phép mô hình phát ra chỉ thị TTS (bật theo mặc định).
- 40. `maxTextLength`: giới hạn cứng cho đầu vào TTS (ký tự). `/tts audio` sẽ thất bại nếu vượt quá.
- `timeoutMs`: thời gian chờ yêu cầu (ms).
- `prefsPath`: ghi đè đường dẫn JSON prefs cục bộ (nhà cung cấp/giới hạn/tóm tắt).
- Các giá trị `apiKey` sẽ dùng biến môi trường (`ELEVENLABS_API_KEY`/`XI_API_KEY`, `OPENAI_API_KEY`).
- `elevenlabs.baseUrl`: ghi đè URL API gốc của ElevenLabs.
- `elevenlabs.voiceSettings`:
  - `stability`, `similarityBoost`, `style`: `0..1`
  - `useSpeakerBoost`: `true|false`
  - `speed`: `0.5..2.0` (1.0 = bình thường)
- `elevenlabs.applyTextNormalization`: `auto|on|off`
- `elevenlabs.languageCode`: ISO 639-1 2 ký tự (ví dụ `en`, `de`)
- `elevenlabs.seed`: số nguyên `0..4294967295` (tính quyết định best‑effort)
- `edge.enabled`: cho phép dùng Edge TTS (mặc định `true`; không cần khóa API).
- `edge.voice`: tên giọng Edge neural (ví dụ `en-US-MichelleNeural`).
- `edge.lang`: mã ngôn ngữ (ví dụ `en-US`).
- `edge.outputFormat`: định dạng đầu ra Edge (ví dụ `audio-24khz-48kbitrate-mono-mp3`).
  - Xem Microsoft Speech output formats để biết các giá trị hợp lệ; không phải mọi định dạng đều được Edge hỗ trợ.
- `edge.rate` / `edge.pitch` / `edge.volume`: chuỗi phần trăm (ví dụ `+10%`, `-5%`).
- `edge.saveSubtitles`: ghi phụ đề JSON kèm theo tệp âm thanh.
- `edge.proxy`: URL proxy cho các yêu cầu Edge TTS.
- `edge.timeoutMs`: ghi đè thời gian chờ yêu cầu (ms).

## Ghi đè do mô hình điều khiển (bật mặc định)

Theo mặc định, mô hình **có thể** phát ra các chỉ thị TTS cho một phản hồi duy nhất.
Khi `messages.tts.auto` là `tagged`, các chỉ thị này là bắt buộc để kích hoạt âm thanh.

Khi được bật, mô hình có thể phát ra các chỉ thị `[[tts:...]]` để ghi đè giọng nói cho một phản hồi duy nhất, cùng với khối tùy chọn `[[tts:text]]...[[/tts:text]]` để cung cấp các thẻ biểu cảm (cười, gợi ý hát, v.v.) chỉ xuất hiện trong âm thanh.

Ví dụ payload phản hồi:

```
Here you go.

[[tts:provider=elevenlabs voiceId=pMsXgVXv3BLzUgSXRplE model=eleven_v3 speed=1.1]]
[[tts:text]](laughs) Read the song once more.[[/tts:text]]
```

Các khóa chỉ thị khả dụng (khi bật):

- `provider` (`openai` | `elevenlabs` | `edge`)
- `voice` (giọng OpenAI) hoặc `voiceId` (ElevenLabs)
- `model` (mô hình TTS OpenAI hoặc id mô hình ElevenLabs)
- `stability`, `similarityBoost`, `style`, `speed`, `useSpeakerBoost`
- `applyTextNormalization` (`auto|on|off`)
- `languageCode` (ISO 639-1)
- `seed`

Tắt tất cả các ghi đè của mô hình:

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

Allowlist tùy chọn (tắt các ghi đè cụ thể trong khi vẫn giữ thẻ):

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

## Tùy chọn theo người dùng

Các lệnh slash ghi các ghi đè cục bộ vào `prefsPath` (mặc định:
`~/.openclaw/settings/tts.json`, ghi đè bằng `OPENCLAW_TTS_PREFS` hoặc
`messages.tts.prefsPath`).

Các trường được lưu:

- `enabled`
- `provider`
- `maxLength` (ngưỡng tóm tắt; mặc định 1500 ký tự)
- `summarize` (mặc định `true`)

Các giá trị này ghi đè `messages.tts.*` cho máy chủ đó.

## Định dạng đầu ra (cố định)

- **Telegram**: ghi chú giọng Opus (`opus_48000_64` từ ElevenLabs, `opus` từ OpenAI).
  - 48kHz / 64kbps là cân bằng tốt cho voice‑note và là yêu cầu để có bong bóng tròn.
- **Các kênh khác**: MP3 (`mp3_44100_128` từ ElevenLabs, `mp3` từ OpenAI).
  - 44.1kHz / 128kbps là cân bằng mặc định cho độ rõ của giọng nói.
- **Edge TTS**: dùng `edge.outputFormat` (mặc định `audio-24khz-48kbitrate-mono-mp3`).
  - 41. `node-edge-tts` chấp nhận một `outputFormat`, nhưng không phải tất cả các định dạng đều khả dụng
        từ dịch vụ Edge. 42. citeturn2search0
  - 43. Giá trị định dạng đầu ra tuân theo các định dạng đầu ra Microsoft Speech (bao gồm Ogg/WebM Opus). citeturn1search0
  - 25. Telegram `sendVoice` chấp nhận OGG/MP3/M4A; hãy dùng OpenAI/ElevenLabs nếu bạn cần
        các ghi chú giọng nói Opus được đảm bảo. 45. citeturn1search1
  - Nếu định dạng đầu ra Edge đã cấu hình thất bại, OpenClaw sẽ thử lại với MP3.

Các định dạng OpenAI/ElevenLabs là cố định; Telegram mong đợi Opus cho UX voice‑note.

## Hành vi Auto‑TTS

Khi bật, OpenClaw sẽ:

- bỏ qua TTS nếu phản hồi đã chứa media hoặc một chỉ thị `MEDIA:`.
- bỏ qua các phản hồi rất ngắn (< 10 ký tự).
- tóm tắt các phản hồi dài khi bật bằng `agents.defaults.model.primary` (hoặc `summaryModel`).
- đính kèm âm thanh được tạo vào phản hồi.

Nếu phản hồi vượt quá `maxLength` và tóm tắt đang tắt (hoặc không có khóa API cho
mô hình tóm tắt), âm thanh
sẽ bị bỏ qua và phản hồi văn bản bình thường được gửi.

## Sơ đồ luồng

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

## Cách dùng lệnh slash

Chỉ có một lệnh: `/tts`.
Xem [Slash commands](/tools/slash-commands) để biết chi tiết kích hoạt.

Lưu ý Discord: `/tts` là lệnh tích hợp sẵn của Discord, vì vậy OpenClaw đăng ký `/voice` làm lệnh gốc ở đó. 46. Văn bản `/tts ...` vẫn hoạt động.

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

Ghi chú:

- Lệnh yêu cầu người gửi được ủy quyền (quy tắc allowlist/chủ sở hữu vẫn áp dụng).
- Phải bật `commands.text` hoặc đăng ký lệnh gốc.
- `off|always|inbound|tagged` là các công tắc theo phiên (`/tts on` là bí danh của `/tts always`).
- `limit` và `summary` được lưu trong prefs cục bộ, không phải cấu hình chính.
- `/tts audio` tạo một phản hồi âm thanh một lần (không bật/tắt TTS).

## Công cụ tác tử

Công cụ `tts` chuyển văn bản thành giọng nói và trả về một đường dẫn `MEDIA:`. Khi kết quả tương thích với Telegram, công cụ sẽ bao gồm `[[audio_as_voice]]` để Telegram gửi bong bóng thoại.

## Gateway RPC

Các phương thức Gateway:

- `tts.status`
- `tts.enable`
- `tts.disable`
- `tts.convert`
- `tts.setProvider`
- `tts.providers`
