---
summary: "Tài liệu tham chiếu CLI cho `openclaw onboard` (trình hướng dẫn onboarding tương tác)"
read_when:
  - Bạn muốn thiết lập có hướng dẫn cho gateway, workspace, xác thực, kênh và skills
title: "onboard"
x-i18n:
  source_path: cli/onboard.md
  source_hash: 69a96accb2d571ff
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T09:38:27Z
---

# `openclaw onboard`

Trình hướng dẫn onboarding tương tác (thiết lập Gateway cục bộ hoặc từ xa).

## Hướng dẫn liên quan

- Trung tâm onboarding CLI: [Onboarding Wizard (CLI)](/start/wizard)
- Tham chiếu onboarding CLI: [CLI Onboarding Reference](/start/wizard-cli-reference)
- Tự động hóa CLI: [CLI Automation](/start/wizard-cli-automation)
- Onboarding trên macOS: [Onboarding (macOS App)](/start/onboarding)

## Ví dụ

```bash
openclaw onboard
openclaw onboard --flow quickstart
openclaw onboard --flow manual
openclaw onboard --mode remote --remote-url ws://gateway-host:18789
```

Ghi chú luồng:

- `quickstart`: lời nhắc tối thiểu, tự động tạo token gateway.
- `manual`: đầy đủ lời nhắc cho cổng/bind/xác thực (bí danh của `advanced`).
- Bắt đầu chat nhanh nhất: `openclaw dashboard` (UI điều khiển, không cần thiết lập kênh).

## Các lệnh tiếp theo phổ biến

```bash
openclaw configure
openclaw agents add <name>
```

<Note>
`--json` không có nghĩa là chế độ không tương tác. Dùng `--non-interactive` cho script.
</Note>
