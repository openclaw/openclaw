---
summary: "Tài liệu tham khảo CLI cho `openclaw config` (lấy/đặt/bỏ đặt giá trị cấu hình)"
read_when:
  - Bạn muốn đọc hoặc chỉnh sửa cấu hình theo cách không tương tác
title: "config"
---

# `openclaw config`

Config helpers: get/set/unset values by path. Chạy mà không có subcommand để mở trình hướng dẫn cấu hình (giống `openclaw configure`).

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

Giá trị được phân tích là JSON5 khi có thể; nếu không, chúng được xử lý như chuỗi.
Dùng `--json` để yêu cầu phân tích JSON5.

```bash
openclaw config set agents.defaults.heartbeat.every "0m"
openclaw config set gateway.port 19001 --json
openclaw config set channels.whatsapp.groups '["*"]' --json
```

Khởi động lại gateway (cổng kết nối) sau khi chỉnh sửa.
