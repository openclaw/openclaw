---
summary: "Tài liệu tham chiếu CLI cho `openclaw voicecall` (bề mặt lệnh của plugin voice-call)"
read_when:
  - Bạn dùng plugin voice-call và muốn các điểm vào CLI
  - Bạn muốn các ví dụ nhanh cho `voicecall call|continue|status|tail|expose`
title: "voicecall"
x-i18n:
  source_path: cli/voicecall.md
  source_hash: d93aaee6f6f5c9ac
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T09:38:30Z
---

# `openclaw voicecall`

`voicecall` là một lệnh do plugin cung cấp. Lệnh này chỉ xuất hiện khi plugin voice-call được cài đặt và bật.

Tài liệu chính:

- Plugin voice-call: [Voice Call](/plugins/voice-call)

## Lệnh phổ biến

```bash
openclaw voicecall status --call-id <id>
openclaw voicecall call --to "+15555550123" --message "Hello" --mode notify
openclaw voicecall continue --call-id <id> --message "Any questions?"
openclaw voicecall end --call-id <id>
```

## Mở webhook (Tailscale)

```bash
openclaw voicecall expose --mode serve
openclaw voicecall expose --mode funnel
openclaw voicecall unexpose
```

Lưu ý bảo mật: chỉ mở endpoint webhook cho các mạng bạn tin cậy. Ưu tiên Tailscale Serve thay vì Funnel khi có thể.
