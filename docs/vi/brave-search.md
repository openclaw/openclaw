---
summary: "Thiết lập API Brave Search cho web_search"
read_when:
  - Bạn muốn dùng Brave Search cho web_search
  - Bạn cần BRAVE_API_KEY hoặc thông tin gói
title: "Brave Search"
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
