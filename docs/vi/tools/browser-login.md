---
summary: "Đăng nhập thủ công cho tự động hóa trình duyệt + đăng bài lên X/Twitter"
read_when:
  - Bạn cần đăng nhập vào các trang cho tự động hóa trình duyệt
  - Bạn muốn đăng cập nhật lên X/Twitter
title: "Đăng nhập trình duyệt"
x-i18n:
  source_path: tools/browser-login.md
  source_hash: c30faa9da6c6ef70
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T09:40:15Z
---

# Đăng nhập trình duyệt + đăng bài lên X/Twitter

## Đăng nhập thủ công (khuyến nghị)

Khi một trang yêu cầu đăng nhập, hãy **đăng nhập thủ công** trong hồ sơ trình duyệt **host** (trình duyệt openclaw).

**Không** cung cấp thông tin đăng nhập cho mô hình. Đăng nhập tự động thường kích hoạt cơ chế chống bot và có thể khóa tài khoản.

Quay lại tài liệu trình duyệt chính: [Browser](/tools/browser).

## Dùng hồ sơ Chrome nào?

OpenClaw điều khiển một **hồ sơ Chrome chuyên dụng** (tên `openclaw`, giao diện tông cam). Hồ sơ này tách biệt với hồ sơ trình duyệt hằng ngày của bạn.

Hai cách đơn giản để truy cập:

1. **Yêu cầu tác tử mở trình duyệt** rồi tự bạn đăng nhập.
2. **Mở qua CLI**:

```bash
openclaw browser start
openclaw browser open https://x.com
```

Nếu bạn có nhiều hồ sơ, truyền `--browser-profile <name>` (mặc định là `openclaw`).

## X/Twitter: quy trình khuyến nghị

- **Đọc/tìm kiếm/chuỗi bài:** dùng trình duyệt **host** (đăng nhập thủ công).
- **Đăng cập nhật:** dùng trình duyệt **host** (đăng nhập thủ công).

## Sandboxing + truy cập trình duyệt host

Các phiên trình duyệt trong sandbox **dễ** kích hoạt phát hiện bot hơn. Với X/Twitter (và các trang nghiêm ngặt khác), hãy ưu tiên trình duyệt **host**.

Nếu tác tử đang ở sandbox, công cụ trình duyệt mặc định dùng sandbox. Để cho phép điều khiển host:

```json5
{
  agents: {
    defaults: {
      sandbox: {
        mode: "non-main",
        browser: {
          allowHostControl: true,
        },
      },
    },
  },
}
```

Sau đó nhắm tới trình duyệt host:

```bash
openclaw browser open https://x.com --browser-profile openclaw --target host
```

Hoặc tắt sandboxing cho tác tử đăng bài cập nhật.
