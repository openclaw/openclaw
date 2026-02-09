---
summary: "Cách các ghi chú âm thanh/giọng nói đầu vào được tải xuống, phiên âm và chèn vào phản hồi"
read_when:
  - Thay đổi phiên âm âm thanh hoặc xử lý media
title: "Âm thanh và Ghi chú giọng nói"
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

To disable auto-detection, set `tools.media.audio.enabled: false`.
To customize, set `tools.media.audio.models`.
Lưu ý: Việc phát hiện nhị phân là best‑effort trên macOS/Linux/Windows; hãy đảm bảo CLI nằm trong `PATH` (chúng tôi mở rộng `~`), hoặc đặt một mô hình CLI tường minh với đường dẫn lệnh đầy đủ.

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
- Default size cap is 20MB (`tools.media.audio.maxBytes`). Oversize audio is skipped for that model and the next entry is tried.
- Default `maxChars` for audio is **unset** (full transcript). Set `tools.media.audio.maxChars` or per-entry `maxChars` to trim output.
- Mặc định tự động của OpenAI là `gpt-4o-mini-transcribe`; đặt `model: "gpt-4o-transcribe"` để có độ chính xác cao hơn.
- Dùng `tools.media.audio.attachments` để xử lý nhiều ghi chú giọng nói (`mode: "all"` + `maxAttachments`).
- Bản phiên âm có sẵn cho các template dưới dạng `{{Transcript}}`.
- stdout của CLI bị giới hạn (5MB); hãy giữ đầu ra CLI ngắn gọn.

## Các điểm dễ sai

- Scope rules use first-match wins. `chatType` is normalized to `direct`, `group`, or `room`.
- Đảm bảo CLI của bạn thoát với mã 0 và in văn bản thuần; JSON cần được xử lý lại qua `jq -r .text`.
- Giữ thời gian chờ ở mức hợp lý (`timeoutSeconds`, mặc định 60s) để tránh chặn hàng đợi phản hồi.
