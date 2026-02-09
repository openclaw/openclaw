---
summary: "Thiết lập Perplexity Sonar cho web_search"
read_when:
  - Bạn muốn dùng Perplexity Sonar cho tìm kiếm web
  - Bạn cần PERPLEXITY_API_KEY hoặc thiết lập OpenRouter
title: "Perplexity Sonar"
---

# Perplexity Sonar

4. OpenClaw có thể dùng Perplexity Sonar cho công cụ `web_search`. 5. Bạn có thể kết nối
   thông qua API trực tiếp của Perplexity hoặc qua OpenRouter.

## Tùy chọn API

### Perplexity (trực tiếp)

- Base URL: [https://api.perplexity.ai](https://api.perplexity.ai)
- Biến môi trường: `PERPLEXITY_API_KEY`

### OpenRouter (thay thế)

- Base URL: [https://openrouter.ai/api/v1](https://openrouter.ai/api/v1)
- Biến môi trường: `OPENROUTER_API_KEY`
- Hỗ trợ tín dụng trả trước/tiền mã hóa.

## Ví dụ cấu hình

```json5
{
  tools: {
    web: {
      search: {
        provider: "perplexity",
        perplexity: {
          apiKey: "pplx-...",
          baseUrl: "https://api.perplexity.ai",
          model: "perplexity/sonar-pro",
        },
      },
    },
  },
}
```

## Chuyển từ Brave

```json5
{
  tools: {
    web: {
      search: {
        provider: "perplexity",
        perplexity: {
          apiKey: "pplx-...",
          baseUrl: "https://api.perplexity.ai",
        },
      },
    },
  },
}
```

Nếu cả `PERPLEXITY_API_KEY` và `OPENROUTER_API_KEY` đều được thiết lập, hãy đặt
`tools.web.search.perplexity.baseUrl` (hoặc `tools.web.search.perplexity.apiKey`)
để phân biệt.

Nếu không đặt base URL, OpenClaw sẽ chọn mặc định dựa trên nguồn khóa API:

- `PERPLEXITY_API_KEY` hoặc `pplx-...` → Perplexity trực tiếp (`https://api.perplexity.ai`)
- `OPENROUTER_API_KEY` hoặc `sk-or-...` → OpenRouter (`https://openrouter.ai/api/v1`)
- Định dạng khóa không xác định → OpenRouter (phương án an toàn)

## Mô hình

- `perplexity/sonar` — Hỏi & đáp nhanh với tìm kiếm web
- `perplexity/sonar-pro` (mặc định) — lập luận nhiều bước + tìm kiếm web
- `perplexity/sonar-reasoning-pro` — nghiên cứu chuyên sâu

Xem [Web tools](/tools/web) để biết cấu hình web_search đầy đủ.
