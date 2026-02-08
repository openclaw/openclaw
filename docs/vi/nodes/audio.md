---
summary: "Cách các ghi chú âm thanh/giọng nói đầu vào được tải xuống, phiên âm và chèn vào phản hồi"
read_when:
  - Thay đổi phiên âm âm thanh hoặc xử lý media
title: "Âm thanh và Ghi chú giọng nói"
x-i18n:
  source_path: nodes/audio.md
  source_hash: b926c47989ab0d1e
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T09:39:28Z
---

# Âm thanh / Ghi chú giọng nói — 2026-01-17

## Những gì hoạt động

- **Hiểu media (âm thanh)**: Nếu tính năng hiểu âm thanh được bật (hoặc tự động phát hiện), OpenClaw:
  1. Xác định tệp đính kèm âm thanh đầu tiên (đường dẫn cục bộ hoặc URL) và tải xuống nếu cần.
  2. Áp dụng `maxBytes` trước khi gửi đến từng mục mô hình.
  3. Chạy mục mô hình đủ điều kiện đầu tiên theo thứ tự (nhà cung cấp hoặc CLI).
  4. Nếu thất bại hoặc bị bỏ qua (kích thước/thời gian chờ), sẽ thử mục tiếp theo.
  5. Khi thành công, thay thế `Body` bằng một khối `[Audio]` và đặt `{{Transcript}}`.
- **Phân tích lệnh**: Khi phiên âm thành công, `CommandBody`/`RawBody` được đặt thành bản phiên âm để các lệnh gạch chéo vẫn hoạt động.
- **Ghi log chi tiết**: Trong `--verbose`, chúng tôi ghi lại khi phiên âm chạy và khi nó thay thế nội dung.

## Tự động phát hiện (mặc định)

Nếu bạn **không cấu hình mô hình** và `tools.media.audio.enabled` **không** được đặt thành `false`,
OpenClaw sẽ tự động phát hiện theo thứ tự sau và dừng ở tùy chọn đầu tiên hoạt động:

1. **CLI cục bộ** (nếu đã cài)
   - `sherpa-onnx-offline` (yêu cầu `SHERPA_ONNX_MODEL_DIR` với encoder/decoder/joiner/tokens)
   - `whisper-cli` (từ `whisper-cpp`; dùng `WHISPER_CPP_MODEL` hoặc mô hình tiny đi kèm)
   - `whisper` (CLI Python; tự động tải mô hình)
2. **Gemini CLI** (`gemini`) sử dụng `read_many_files`
3. **Khóa nhà cung cấp** (OpenAI → Groq → Deepgram → Google)

Để tắt tự động phát hiện, đặt `tools.media.audio.enabled: false`.
Để tùy chỉnh, đặt `tools.media.audio.models`.
Lưu ý: Việc phát hiện binary là nỗ lực tốt nhất trên macOS/Linux/Windows; hãy đảm bảo CLI nằm trên `PATH` (chúng tôi mở rộng `~`), hoặc đặt một mô hình CLI rõ ràng với đường dẫn lệnh đầy đủ.

## Ví dụ cấu hình

### Nhà cung cấp + dự phòng CLI (OpenAI + Whisper CLI)

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

### Chỉ nhà cung cấp với giới hạn phạm vi

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

### Chỉ nhà cung cấp (Deepgram)

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

## Ghi chú & giới hạn

- Xác thực nhà cung cấp tuân theo thứ tự xác thực mô hình tiêu chuẩn (hồ sơ xác thực, biến môi trường, `models.providers.*.apiKey`).
- Deepgram sử dụng `DEEPGRAM_API_KEY` khi dùng `provider: "deepgram"`.
- Chi tiết thiết lập Deepgram: [Deepgram (phiên âm âm thanh)](/providers/deepgram).
- Các nhà cung cấp âm thanh có thể ghi đè `baseUrl`, `headers` và `providerOptions` thông qua `tools.media.audio`.
- Giới hạn kích thước mặc định là 20MB (`tools.media.audio.maxBytes`). Âm thanh vượt kích thước sẽ bị bỏ qua cho mô hình đó và thử mục tiếp theo.
- `maxChars` mặc định cho âm thanh là **không đặt** (toàn bộ bản phiên âm). Đặt `tools.media.audio.maxChars` hoặc theo từng mục `maxChars` để cắt bớt đầu ra.
- Mặc định tự động của OpenAI là `gpt-4o-mini-transcribe`; đặt `model: "gpt-4o-transcribe"` để có độ chính xác cao hơn.
- Dùng `tools.media.audio.attachments` để xử lý nhiều ghi chú giọng nói (`mode: "all"` + `maxAttachments`).
- Bản phiên âm có sẵn cho các template dưới dạng `{{Transcript}}`.
- stdout của CLI bị giới hạn (5MB); hãy giữ đầu ra CLI ngắn gọn.

## Các điểm dễ sai

- Quy tắc phạm vi dùng nguyên tắc khớp đầu tiên. `chatType` được chuẩn hóa thành `direct`, `group` hoặc `room`.
- Đảm bảo CLI của bạn thoát với mã 0 và in văn bản thuần; JSON cần được xử lý lại qua `jq -r .text`.
- Giữ thời gian chờ ở mức hợp lý (`timeoutSeconds`, mặc định 60s) để tránh chặn hàng đợi phản hồi.
