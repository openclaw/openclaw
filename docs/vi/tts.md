---
summary: "Chuyển văn bản thành giọng nói (TTS) cho các phản hồi gửi đi"
read_when:
  - Bật chuyển văn bản thành giọng nói cho phản hồi
  - Cấu hình nhà cung cấp TTS hoặc giới hạn
  - Sử dụng lệnh /tts
title: "Chuyển văn bản thành giọng nói"
x-i18n:
  source_path: tts.md
  source_hash: 070ff0cc8592f64c
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T09:40:53Z
---

# Chuyển văn bản thành giọng nói (TTS)

OpenClaw có thể chuyển các phản hồi gửi đi thành âm thanh bằng ElevenLabs, OpenAI hoặc Edge TTS.
Tính năng này hoạt động ở mọi nơi OpenClaw có thể gửi âm thanh; Telegram sẽ hiển thị bong bóng ghi âm tròn.

## Dịch vụ được hỗ trợ

- **ElevenLabs** (nhà cung cấp chính hoặc dự phòng)
- **OpenAI** (nhà cung cấp chính hoặc dự phòng; cũng dùng cho tóm tắt)
- **Edge TTS** (nhà cung cấp chính hoặc dự phòng; dùng `node-edge-tts`, mặc định khi không có khóa API)

### Ghi chú về Edge TTS

Edge TTS sử dụng dịch vụ TTS thần kinh trực tuyến của Microsoft Edge thông qua thư viện
`node-edge-tts`. Đây là dịch vụ được lưu trữ (không chạy cục bộ), sử dụng các endpoint của Microsoft và
không yêu cầu khóa API. `node-edge-tts` cung cấp các tùy chọn cấu hình giọng nói và
định dạng đầu ra, nhưng không phải tất cả các tùy chọn đều được dịch vụ Edge hỗ trợ. citeturn2search0

Vì Edge TTS là dịch vụ web công khai không có SLA hoặc hạn mức được công bố, hãy xem đây là
best-effort. Nếu bạn cần giới hạn đảm bảo và hỗ trợ, hãy dùng OpenAI hoặc ElevenLabs.
Tài liệu Speech REST API của Microsoft nêu giới hạn âm thanh 10 phút mỗi yêu cầu; Edge TTS
không công bố giới hạn, vì vậy hãy giả định giới hạn tương tự hoặc thấp hơn. citeturn0search3

## Khóa tùy chọn

Nếu bạn muốn dùng OpenAI hoặc ElevenLabs:

- `ELEVENLABS_API_KEY` (hoặc `XI_API_KEY`)
- `OPENAI_API_KEY`

Edge TTS **không** yêu cầu khóa API. Nếu không tìm thấy khóa API nào, OpenClaw mặc định
dùng Edge TTS (trừ khi bị tắt qua `messages.tts.edge.enabled=false`).

Nếu cấu hình nhiều nhà cung cấp, nhà cung cấp được chọn sẽ được dùng trước và các nhà cung cấp còn lại là phương án dự phòng.
Tự động tóm tắt sử dụng `summaryModel` (hoặc `agents.defaults.model.primary`) đã cấu hình,
vì vậy nhà cung cấp đó cũng phải được xác thực nếu bạn bật tóm tắt.

## Liên kết dịch vụ

- [Hướng dẫn Text-to-Speech của OpenAI](https://platform.openai.com/docs/guides/text-to-speech)
- [Tham chiếu OpenAI Audio API](https://platform.openai.com/docs/api-reference/audio)
- [Text to Speech của ElevenLabs](https://elevenlabs.io/docs/api-reference/text-to-speech)
- [Xác thực ElevenLabs](https://elevenlabs.io/docs/api-reference/authentication)
- [node-edge-tts](https://github.com/SchneeHertz/node-edge-tts)
- [Định dạng đầu ra Microsoft Speech](https://learn.microsoft.com/azure/ai-services/speech-service/rest-text-to-speech#audio-outputs)

## Mặc định có bật không?

Không. Auto‑TTS **tắt** theo mặc định. Hãy bật trong cấu hình bằng
`messages.tts.auto` hoặc theo từng phiên với `/tts always` (bí danh: `/tts on`).

Edge TTS **được** bật theo mặc định khi TTS được bật, và sẽ tự động được dùng
khi không có khóa API OpenAI hoặc ElevenLabs.

## Cấu hình

Cấu hình TTS nằm dưới `messages.tts` trong `openclaw.json`.
Schema đầy đủ có trong [Cấu hình Gateway](/gateway/configuration).

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
- `maxTextLength`: giới hạn cứng cho đầu vào TTS (ký tự). `/tts audio` sẽ thất bại nếu vượt quá.
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

Theo mặc định, mô hình **có thể** phát ra chỉ thị TTS cho một phản hồi đơn lẻ.
Khi `messages.tts.auto` là `tagged`, các chỉ thị này là bắt buộc để kích hoạt âm thanh.

Khi bật, mô hình có thể phát ra các chỉ thị `[[tts:...]]` để ghi đè giọng nói
cho một phản hồi, kèm theo khối `[[tts:text]]...[[/tts:text]]` tùy chọn để
cung cấp thẻ biểu cảm (tiếng cười, gợi ý hát, v.v.) chỉ xuất hiện trong âm thanh.

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
  - `node-edge-tts` chấp nhận một `outputFormat`, nhưng không phải mọi định dạng đều khả dụng
    từ dịch vụ Edge. citeturn2search0
  - Giá trị định dạng đầu ra tuân theo Microsoft Speech output formats (bao gồm Ogg/WebM Opus). citeturn1search0
  - Telegram `sendVoice` chấp nhận OGG/MP3/M4A; hãy dùng OpenAI/ElevenLabs nếu bạn cần
    ghi chú giọng Opus được đảm bảo. citeturn1search1
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
Xem [Slash commands](/tools/slash-commands) để biết chi tiết bật tính năng.

Ghi chú Discord: `/tts` là lệnh tích hợp sẵn của Discord, vì vậy OpenClaw đăng ký
`/voice` làm lệnh gốc tại đó. Văn bản `/tts ...` vẫn hoạt động.

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

Công cụ `tts` chuyển văn bản thành giọng nói và trả về một đường dẫn `MEDIA:`. Khi
kết quả tương thích với Telegram, công cụ sẽ bao gồm `[[audio_as_voice]]` để
Telegram gửi bong bóng ghi âm.

## Gateway RPC

Các phương thức Gateway:

- `tts.status`
- `tts.enable`
- `tts.disable`
- `tts.convert`
- `tts.setProvider`
- `tts.providers`
