---
summary: "Công cụ tìm kiếm web + tải nội dung (Brave Search API, Perplexity trực tiếp/OpenRouter)"
read_when:
  - Bạn muốn bật web_search hoặc web_fetch
  - Bạn cần thiết lập khóa Brave Search API
  - Bạn muốn dùng Perplexity Sonar cho tìm kiếm web
title: "Công cụ Web"
---

# Công cụ web

OpenClaw cung cấp hai công cụ web gọn nhẹ:

- `web_search` — Tìm kiếm web qua Brave Search API (mặc định) hoặc Perplexity Sonar (trực tiếp hoặc qua OpenRouter).
- `web_fetch` — Tải HTTP + trích xuất nội dung dễ đọc (HTML → markdown/text).

These are **not** browser automation. For JS-heavy sites or logins, use the
[Browser tool](/tools/browser).

## Cách hoạt động

- `web_search` gọi nhà cung cấp bạn đã cấu hình và trả về kết quả.
  - **Brave** (mặc định): trả về kết quả có cấu trúc (tiêu đề, URL, đoạn trích).
  - **Perplexity**: trả về câu trả lời do AI tổng hợp kèm trích dẫn từ tìm kiếm web thời gian thực.
- Kết quả được cache theo truy vấn trong 15 phút (có thể cấu hình).
- `web_fetch` does a plain HTTP GET and extracts readable content
  (HTML → markdown/text). It does **not** execute JavaScript.
- `web_fetch` được bật theo mặc định (trừ khi bị tắt rõ ràng).

## Chọn nhà cung cấp tìm kiếm

| Nhà cung cấp                            | Ưu điểm                                               | Nhược điểm                                    | Khóa API                                       |
| --------------------------------------- | ----------------------------------------------------- | --------------------------------------------- | ---------------------------------------------- |
| **Brave** (mặc định) | Nhanh, kết quả có cấu trúc, có gói miễn phí           | Kết quả tìm kiếm truyền thống                 | `BRAVE_API_KEY`                                |
| **Perplexity**                          | Câu trả lời AI tổng hợp, có trích dẫn, thời gian thực | Cần quyền truy cập Perplexity hoặc OpenRouter | `OPENROUTER_API_KEY` hoặc `PERPLEXITY_API_KEY` |

Xem [Thiết lập Brave Search](/brave-search) và [Perplexity Sonar](/perplexity) để biết chi tiết theo từng nhà cung cấp.

Đặt nhà cung cấp trong cấu hình:

```json5
{
  tools: {
    web: {
      search: {
        provider: "brave", // or "perplexity"
      },
    },
  },
}
```

Ví dụ: chuyển sang Perplexity Sonar (API trực tiếp):

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

## Lấy khóa Brave API

1. Tạo tài khoản Brave Search API tại [https://brave.com/search/api/](https://brave.com/search/api/)
2. Trong bảng điều khiển, chọn gói **Data for Search** (không phải “Data for AI”) và tạo khóa API.
3. Chạy `openclaw configure --section web` để lưu khóa vào cấu hình (khuyến nghị), hoặc đặt `BRAVE_API_KEY` trong môi trường của bạn.

Brave cung cấp gói miễn phí cùng các gói trả phí; hãy kiểm tra cổng Brave API để biết
giới hạn và giá hiện hành.

### Nơi đặt khóa (khuyến nghị)

**Recommended:** run `openclaw configure --section web`. It stores the key in
`~/.openclaw/openclaw.json` under `tools.web.search.apiKey`.

**Environment alternative:** set `BRAVE_API_KEY` in the Gateway process
environment. For a gateway install, put it in `~/.openclaw/.env` (or your
service environment). See [Env vars](/help/faq#how-does-openclaw-load-environment-variables).

## Dùng Perplexity (trực tiếp hoặc qua OpenRouter)

Perplexity Sonar models have built-in web search capabilities and return AI-synthesized
answers with citations. You can use them via OpenRouter (no credit card required - supports
crypto/prepaid).

### Lấy khóa OpenRouter API

1. Tạo tài khoản tại [https://openrouter.ai/](https://openrouter.ai/)
2. Nạp tín dụng (hỗ trợ crypto, trả trước hoặc thẻ tín dụng)
3. Tạo khóa API trong phần cài đặt tài khoản

### Thiết lập tìm kiếm Perplexity

```json5
{
  tools: {
    web: {
      search: {
        enabled: true,
        provider: "perplexity",
        perplexity: {
          // API key (optional if OPENROUTER_API_KEY or PERPLEXITY_API_KEY is set)
          apiKey: "sk-or-v1-...",
          // Base URL (key-aware default if omitted)
          baseUrl: "https://openrouter.ai/api/v1",
          // Model (defaults to perplexity/sonar-pro)
          model: "perplexity/sonar-pro",
        },
      },
    },
  },
}
```

**Environment alternative:** set `OPENROUTER_API_KEY` or `PERPLEXITY_API_KEY` in the Gateway
environment. For a gateway install, put it in `~/.openclaw/.env`.

Nếu không đặt base URL, OpenClaw sẽ chọn mặc định dựa trên nguồn khóa API:

- `PERPLEXITY_API_KEY` hoặc `pplx-...` → `https://api.perplexity.ai`
- `OPENROUTER_API_KEY` hoặc `sk-or-...` → `https://openrouter.ai/api/v1`
- Định dạng khóa không xác định → OpenRouter (phương án an toàn)

### Các mô hình Perplexity khả dụng

| Mô hình                                              | Mô tả                                | Phù hợp nhất     |
| ---------------------------------------------------- | ------------------------------------ | ---------------- |
| `perplexity/sonar`                                   | Hỏi–đáp nhanh với tìm kiếm web       | Tra cứu nhanh    |
| `perplexity/sonar-pro` (mặc định) | Lập luận nhiều bước với tìm kiếm web | Câu hỏi phức tạp |
| `perplexity/sonar-reasoning-pro`                     | Phân tích chain-of-thought           | Nghiên cứu sâu   |

## web_search

Tìm kiếm web bằng nhà cung cấp đã cấu hình.

### Yêu cầu

- `tools.web.search.enabled` không được là `false` (mặc định: bật)
- Khóa API cho nhà cung cấp bạn chọn:
  - **Brave**: `BRAVE_API_KEY` hoặc `tools.web.search.apiKey`
  - **Perplexity**: `OPENROUTER_API_KEY`, `PERPLEXITY_API_KEY`, hoặc `tools.web.search.perplexity.apiKey`

### Cấu hình

```json5
{
  tools: {
    web: {
      search: {
        enabled: true,
        apiKey: "BRAVE_API_KEY_HERE", // optional if BRAVE_API_KEY is set
        maxResults: 5,
        timeoutSeconds: 30,
        cacheTtlMinutes: 15,
      },
    },
  },
}
```

### Tham số công cụ

- `query` (bắt buộc)
- `count` (1–10; mặc định theo cấu hình)
- `country` (optional): 2-letter country code for region-specific results (e.g., "DE", "US", "ALL"). If omitted, Brave chooses its default region.
- `search_lang` (tùy chọn): mã ngôn ngữ ISO cho kết quả tìm kiếm (ví dụ: "de", "en", "fr")
- `ui_lang` (tùy chọn): mã ngôn ngữ ISO cho các thành phần UI
- `freshness` (tùy chọn, chỉ Brave): lọc theo thời điểm khám phá (`pd`, `pw`, `pm`, `py`, hoặc `YYYY-MM-DDtoYYYY-MM-DD`)

**Ví dụ:**

```javascript
// German-specific search
await web_search({
  query: "TV online schauen",
  count: 10,
  country: "DE",
  search_lang: "de",
});

// French search with French UI
await web_search({
  query: "actualités",
  country: "FR",
  search_lang: "fr",
  ui_lang: "fr",
});

// Recent results (past week)
await web_search({
  query: "TMBG interview",
  freshness: "pw",
});
```

## web_fetch

Tải một URL và trích xuất nội dung dễ đọc.

### Yêu cầu của web_fetch

- `tools.web.fetch.enabled` không được là `false` (mặc định: bật)
- Tùy chọn dự phòng Firecrawl: đặt `tools.web.fetch.firecrawl.apiKey` hoặc `FIRECRAWL_API_KEY`.

### Cấu hình web_fetch

```json5
{
  tools: {
    web: {
      fetch: {
        enabled: true,
        maxChars: 50000,
        maxCharsCap: 50000,
        timeoutSeconds: 30,
        cacheTtlMinutes: 15,
        maxRedirects: 3,
        userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_7_2) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
        readability: true,
        firecrawl: {
          enabled: true,
          apiKey: "FIRECRAWL_API_KEY_HERE", // optional if FIRECRAWL_API_KEY is set
          baseUrl: "https://api.firecrawl.dev",
          onlyMainContent: true,
          maxAgeMs: 86400000, // ms (1 day)
          timeoutSeconds: 60,
        },
      },
    },
  },
}
```

### Tham số công cụ web_fetch

- `url` (bắt buộc, chỉ http/https)
- `extractMode` (`markdown` | `text`)
- `maxChars` (cắt bớt trang dài)

Ghi chú:

- `web_fetch` uses Readability (main-content extraction) first, then Firecrawl (if configured). If both fail, the tool returns an error.
- Các yêu cầu Firecrawl dùng chế độ vượt qua chặn bot và mặc định cache kết quả.
- `web_fetch` gửi User-Agent giống Chrome và `Accept-Language` theo mặc định; ghi đè `userAgent` nếu cần.
- `web_fetch` chặn hostname riêng tư/nội bộ và kiểm tra lại chuyển hướng (giới hạn bằng `maxRedirects`).
- `maxChars` được kẹp ở `tools.web.fetch.maxCharsCap`.
- `web_fetch` là trích xuất theo khả năng; một số trang sẽ cần công cụ browser.
- Xem [Firecrawl](/tools/firecrawl) để biết cách thiết lập khóa và chi tiết dịch vụ.
- Phản hồi được cache (mặc định 15 phút) để giảm tải việc tải lặp lại.
- Nếu bạn dùng hồ sơ công cụ/danh sách cho phép, hãy thêm `web_search`/`web_fetch` hoặc `group:web`.
- Nếu thiếu khóa Brave, `web_search` sẽ trả về gợi ý thiết lập ngắn kèm liên kết tài liệu.
