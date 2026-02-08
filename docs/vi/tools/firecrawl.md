---
summary: "Dự phòng Firecrawl cho web_fetch (chống bot + trích xuất có bộ nhớ đệm)"
read_when:
  - Bạn muốn trích xuất web dựa trên Firecrawl
  - Bạn cần khóa API Firecrawl
  - Bạn muốn trích xuất chống bot cho web_fetch
title: "Firecrawl"
x-i18n:
  source_path: tools/firecrawl.md
  source_hash: 08a7ad45b41af412
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T09:40:24Z
---

# Firecrawl

OpenClaw có thể dùng **Firecrawl** làm bộ trích xuất dự phòng cho `web_fetch`. Đây là dịch vụ trích xuất nội dung được lưu trữ, hỗ trợ vượt qua bot và bộ nhớ đệm, giúp xử lý các trang nhiều JS hoặc các trang chặn việc fetch HTTP thông thường.

## Lấy khóa API

1. Tạo tài khoản Firecrawl và tạo khóa API.
2. Lưu khóa trong cấu hình hoặc đặt `FIRECRAWL_API_KEY` trong môi trường gateway.

## Cấu hình Firecrawl

```json5
{
  tools: {
    web: {
      fetch: {
        firecrawl: {
          apiKey: "FIRECRAWL_API_KEY_HERE",
          baseUrl: "https://api.firecrawl.dev",
          onlyMainContent: true,
          maxAgeMs: 172800000,
          timeoutSeconds: 60,
        },
      },
    },
  },
}
```

Ghi chú:

- `firecrawl.enabled` mặc định là true khi có khóa API.
- `maxAgeMs` kiểm soát độ cũ tối đa của kết quả trong bộ nhớ đệm (ms). Mặc định là 2 ngày.

## Stealth / vượt qua bot

Firecrawl cung cấp tham số **proxy mode** để vượt qua bot (`basic`, `stealth`, hoặc `auto`).
OpenClaw luôn dùng `proxy: "auto"` cùng với `storeInCache: true` cho các yêu cầu Firecrawl.
Nếu bỏ qua proxy, Firecrawl mặc định dùng `auto`. `auto` sẽ thử lại với proxy stealth nếu lần thử cơ bản thất bại, điều này có thể tiêu tốn nhiều credit hơn so với chỉ scrape cơ bản.

## Cách `web_fetch` dùng Firecrawl

Thứ tự trích xuất của `web_fetch`:

1. Readability (cục bộ)
2. Firecrawl (nếu đã cấu hình)
3. Dọn dẹp HTML cơ bản (dự phòng cuối cùng)

Xem [Web tools](/tools/web) để biết thiết lập đầy đủ cho công cụ web.
