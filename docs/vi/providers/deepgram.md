---
summary: "Phiên âm Deepgram cho tin nhắn thoại đến"
read_when:
  - Bạn muốn dùng Deepgram chuyển giọng nói thành văn bản cho tệp âm thanh đính kèm
  - Bạn cần một ví dụ cấu hình Deepgram nhanh
title: "Deepgram"
x-i18n:
  source_path: providers/deepgram.md
  source_hash: dabd1f6942c339fb
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T09:39:50Z
---

# Deepgram (Phiên âm âm thanh)

Deepgram là một API chuyển giọng nói thành văn bản. Trong OpenClaw, nó được dùng cho **phiên âm âm thanh/tin nhắn thoại đến**
thông qua `tools.media.audio`.

Khi được bật, OpenClaw tải tệp âm thanh lên Deepgram và chèn bản phiên âm
vào pipeline phản hồi (`{{Transcript}}` + khối `[Audio]`). Đây **không phải streaming**;
nó sử dụng endpoint phiên âm cho bản ghi đã được ghi sẵn.

Website: [https://deepgram.com](https://deepgram.com)  
Docs: [https://developers.deepgram.com](https://developers.deepgram.com)

## Khởi động nhanh

1. Thiết lập khóa API của bạn:

```
DEEPGRAM_API_KEY=dg_...
```

2. Bật nhà cung cấp:

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

## Tùy chọn

- `model`: id mô hình Deepgram (mặc định: `nova-3`)
- `language`: gợi ý ngôn ngữ (tùy chọn)
- `tools.media.audio.providerOptions.deepgram.detect_language`: bật phát hiện ngôn ngữ (tùy chọn)
- `tools.media.audio.providerOptions.deepgram.punctuate`: bật dấu câu (tùy chọn)
- `tools.media.audio.providerOptions.deepgram.smart_format`: bật định dạng thông minh (tùy chọn)

Ví dụ với ngôn ngữ:

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

Ví dụ với các tùy chọn Deepgram:

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

## Ghi chú

- Xác thực tuân theo thứ tự xác thực tiêu chuẩn của nhà cung cấp; `DEEPGRAM_API_KEY` là cách đơn giản nhất.
- Ghi đè endpoint hoặc header bằng `tools.media.audio.baseUrl` và `tools.media.audio.headers` khi dùng proxy.
- Đầu ra tuân theo cùng các quy tắc âm thanh như các nhà cung cấp khác (giới hạn kích thước, timeout, chèn bản phiên âm).
