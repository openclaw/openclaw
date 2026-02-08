---
summary: "Tài liệu tham khảo CLI cho `openclaw config` (lấy/đặt/bỏ đặt giá trị cấu hình)"
read_when:
  - Bạn muốn đọc hoặc chỉnh sửa cấu hình theo cách không tương tác
title: "config"
x-i18n:
  source_path: cli/config.md
  source_hash: d60a35f5330f22bc
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T09:38:11Z
---

# `openclaw config`

Các trợ giúp cấu hình: lấy/đặt/bỏ đặt giá trị theo đường dẫn. Chạy không kèm lệnh con để mở
trình hướng dẫn cấu hình (giống như `openclaw configure`).

## Ví dụ

```bash
openclaw config get browser.executablePath
openclaw config set browser.executablePath "/usr/bin/google-chrome"
openclaw config set agents.defaults.heartbeat.every "2h"
openclaw config set agents.list[0].tools.exec.node "node-id-or-name"
openclaw config unset tools.web.search.apiKey
```

## Đường dẫn

Đường dẫn dùng ký pháp dấu chấm hoặc ngoặc:

```bash
openclaw config get agents.defaults.workspace
openclaw config get agents.list[0].id
```

Dùng chỉ mục trong danh sách agent để nhắm tới một agent cụ thể:

```bash
openclaw config get agents.list
openclaw config set agents.list[1].tools.exec.node "node-id-or-name"
```

## Giá trị

Giá trị được phân tích cú pháp dưới dạng JSON5 khi có thể; nếu không thì được coi là chuỗi.
Dùng `--json` để yêu cầu phân tích cú pháp JSON5.

```bash
openclaw config set agents.defaults.heartbeat.every "0m"
openclaw config set gateway.port 19001 --json
openclaw config set channels.whatsapp.groups '["*"]' --json
```

Khởi động lại gateway (cổng kết nối) sau khi chỉnh sửa.
