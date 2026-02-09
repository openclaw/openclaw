---
summary: "Tài liệu tham chiếu CLI cho `openclaw onboard` (trình hướng dẫn onboarding tương tác)"
read_when:
  - Bạn muốn thiết lập có hướng dẫn cho gateway, workspace, xác thực, kênh và skills
title: "onboard"
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
`--json` không ngụ ý chế độ không tương tác. Dùng `--non-interactive` cho script.
</Note>
