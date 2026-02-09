---
summary: "Tài liệu tham chiếu CLI cho `openclaw voicecall` (bề mặt lệnh của plugin voice-call)"
read_when:
  - Bạn dùng plugin voice-call và muốn các điểm vào CLI
  - Bạn muốn các ví dụ nhanh cho `voicecall call|continue|status|tail|expose`
title: "voicecall"
---

# `openclaw voicecall`

Lưu ý bảo mật: chỉ mở endpoint webhook cho các mạng bạn tin cậy. It only appears if the voice-call plugin is installed and enabled.

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

Ưu tiên Tailscale Serve hơn Funnel khi có thể. Vòng lặp agentic là lần chạy “thực” đầy đủ của một agent: tiếp nhận → lắp ráp ngữ cảnh → suy luận mô hình →
thực thi công cụ → phản hồi dạng stream → lưu trữ.
