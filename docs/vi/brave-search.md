---
summary: "Thiết lập API Brave Search cho web_search"
read_when:
  - Bạn muốn dùng Brave Search cho web_search
  - Bạn cần BRAVE_API_KEY hoặc thông tin gói
title: "Brave Search"
x-i18n:
  source_path: brave-search.md
  source_hash: 81cd0a13239c13f4
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T09:37:47Z
---

# API Brave Search

OpenClaw dùng Brave Search làm nhà cung cấp mặc định cho `web_search`.

## Lấy khóa API

1. Tạo tài khoản Brave Search API tại [https://brave.com/search/api/](https://brave.com/search/api/)
2. Trong bảng điều khiển, chọn gói **Data for Search** và tạo khóa API.
3. Lưu khóa vào cấu hình (khuyến nghị) hoặc đặt `BRAVE_API_KEY` trong biến môi trường của Gateway.

## Ví dụ cấu hình

```json5
{
  tools: {
    web: {
      search: {
        provider: "brave",
        apiKey: "BRAVE_API_KEY_HERE",
        maxResults: 5,
        timeoutSeconds: 30,
      },
    },
  },
}
```

## Ghi chú

- Gói Data for AI **không** tương thích với `web_search`.
- Brave cung cấp gói miễn phí cùng các gói trả phí; hãy kiểm tra cổng Brave API để biết giới hạn hiện tại.

Xem [Công cụ web](/tools/web) để biết cấu hình web_search đầy đủ.
