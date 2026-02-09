---
summary: "Sử dụng OAuth Qwen (gói miễn phí) trong OpenClaw"
read_when:
  - Bạn muốn dùng Qwen với OpenClaw
  - Bạn muốn truy cập OAuth gói miễn phí cho Qwen Coder
title: "Qwen"
---

# Qwen

Qwen cung cấp luồng OAuth gói miễn phí cho các mô hình Qwen Coder và Qwen Vision
(2.000 yêu cầu/ngày, tùy theo giới hạn tốc độ của Qwen).

## Bật plugin

```bash
openclaw plugins enable qwen-portal-auth
```

Khởi động lại Gateway sau khi bật.

## Xác thực

```bash
openclaw models auth login --provider qwen-portal --set-default
```

Lệnh này chạy luồng OAuth mã thiết bị của Qwen và ghi một mục nhà cung cấp vào
`models.json` (kèm theo một bí danh `qwen` để chuyển nhanh).

## ID mô hình

- `qwen-portal/coder-model`
- `qwen-portal/vision-model`

Chuyển mô hình bằng:

```bash
openclaw models set qwen-portal/coder-model
```

## Tái sử dụng đăng nhập Qwen Code CLI

If you already logged in with the Qwen Code CLI, OpenClaw will sync credentials
from `~/.qwen/oauth_creds.json` when it loads the auth store. You still need a
`models.providers.qwen-portal` entry (use the login command above to create one).

## Ghi chú

- Token tự động làm mới; hãy chạy lại lệnh đăng nhập nếu làm mới thất bại hoặc quyền truy cập bị thu hồi.
- URL cơ sở mặc định: `https://portal.qwen.ai/v1` (ghi đè bằng
  `models.providers.qwen-portal.baseUrl` nếu Qwen cung cấp endpoint khác).
- Xem [Model providers](/concepts/model-providers) để biết các quy tắc áp dụng cho toàn bộ nhà cung cấp.
