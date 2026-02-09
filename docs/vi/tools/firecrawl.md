---
summary: "Dự phòng Firecrawl cho web_fetch (chống bot + trích xuất có bộ nhớ đệm)"
read_when:
  - Bạn muốn trích xuất web dựa trên Firecrawl
  - Bạn cần khóa API Firecrawl
  - Bạn muốn trích xuất chống bot cho web_fetch
title: "Firecrawl"
---

# Firecrawl

OpenClaw can use **Firecrawl** as a fallback extractor for `web_fetch`. It is a hosted
content extraction service that supports bot circumvention and caching, which helps
with JS-heavy sites or pages that block plain HTTP fetches.

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
- `maxAgeMs` controls how old cached results can be (ms). Default is 2 days.

## Stealth / vượt qua bot

Firecrawl exposes a **proxy mode** parameter for bot circumvention (`basic`, `stealth`, or `auto`).
OpenClaw always uses `proxy: "auto"` plus `storeInCache: true` for Firecrawl requests.
If proxy is omitted, Firecrawl defaults to `auto`. `auto` retries with stealth proxies if a basic attempt fails, which may use more credits
than basic-only scraping.

## Cách `web_fetch` dùng Firecrawl

Thứ tự trích xuất của `web_fetch`:

1. Readability (cục bộ)
2. Firecrawl (nếu đã cấu hình)
3. Dọn dẹp HTML cơ bản (dự phòng cuối cùng)

Xem [Web tools](/tools/web) để biết thiết lập đầy đủ cho công cụ web.
