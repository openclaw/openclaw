---
summary: "Đăng nhập thủ công cho tự động hóa trình duyệt + đăng bài lên X/Twitter"
read_when:
  - Bạn cần đăng nhập vào các trang cho tự động hóa trình duyệt
  - Bạn muốn đăng cập nhật lên X/Twitter
title: "Đăng nhập trình duyệt"
---

# Đăng nhập trình duyệt + đăng bài lên X/Twitter

## Đăng nhập thủ công (khuyến nghị)

Khi một trang yêu cầu đăng nhập, hãy **đăng nhập thủ công** trong hồ sơ trình duyệt **host** (trình duyệt openclaw).

Do **not** give the model your credentials. Automated logins often trigger anti‑bot defenses and can lock the account.

Quay lại tài liệu trình duyệt chính: [Browser](/tools/browser).

## Dùng hồ sơ Chrome nào?

OpenClaw controls a **dedicated Chrome profile** (named `openclaw`, orange‑tinted UI). This is separate from your daily browser profile.

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

Sandboxed browser sessions are **more likely** to trigger bot detection. For X/Twitter (and other strict sites), prefer the **host** browser.

If the agent is sandboxed, the browser tool defaults to the sandbox. To allow host control:

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
