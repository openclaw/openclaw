---
summary: "Cấu hình Moonshot K2 so với Kimi Coding (nhà cung cấp + khóa riêng)"
read_when:
  - Bạn muốn thiết lập Moonshot K2 (Moonshot Open Platform) so với Kimi Coding
  - Bạn cần hiểu các endpoint, khóa và tham chiếu mô hình riêng biệt
  - Bạn muốn cấu hình sao chép/dán cho từng nhà cung cấp
title: "Moonshot AI"
---

# Moonshot AI (Kimi)

Moonshot provides the Kimi API with OpenAI-compatible endpoints. Configure the
provider and set the default model to `moonshot/kimi-k2.5`, or use
Kimi Coding with `kimi-coding/k2p5`.

Các ID mô hình Kimi K2 hiện tại:

{/_moonshot-kimi-k2-ids:start_/ && null}

- `kimi-k2.5`
- `kimi-k2-0905-preview`
- `kimi-k2-turbo-preview`
- `kimi-k2-thinking`
- `kimi-k2-thinking-turbo`
  {/_moonshot-kimi-k2-ids:end_/ && null}

```bash
openclaw onboard --auth-choice moonshot-api-key
```

Kimi Coding:

```bash
openclaw onboard --auth-choice kimi-code-api-key
```

9. Lưu ý: Moonshot và Kimi Coding là các nhà cung cấp riêng biệt. Keys are not interchangeable, endpoints differ, and model refs differ (Moonshot uses `moonshot/...`, Kimi Coding uses `kimi-coding/...`).

## Đoạn cấu hình (Moonshot API)

```json5
{
  env: { MOONSHOT_API_KEY: "sk-..." },
  agents: {
    defaults: {
      model: { primary: "moonshot/kimi-k2.5" },
      models: {
        // moonshot-kimi-k2-aliases:start
        "moonshot/kimi-k2.5": { alias: "Kimi K2.5" },
        "moonshot/kimi-k2-0905-preview": { alias: "Kimi K2" },
        "moonshot/kimi-k2-turbo-preview": { alias: "Kimi K2 Turbo" },
        "moonshot/kimi-k2-thinking": { alias: "Kimi K2 Thinking" },
        "moonshot/kimi-k2-thinking-turbo": { alias: "Kimi K2 Thinking Turbo" },
        // moonshot-kimi-k2-aliases:end
      },
    },
  },
  models: {
    mode: "merge",
    providers: {
      moonshot: {
        baseUrl: "https://api.moonshot.ai/v1",
        apiKey: "${MOONSHOT_API_KEY}",
        api: "openai-completions",
        models: [
          // moonshot-kimi-k2-models:start
          {
            id: "kimi-k2.5",
            name: "Kimi K2.5",
            reasoning: false,
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 256000,
            maxTokens: 8192,
          },
          {
            id: "kimi-k2-0905-preview",
            name: "Kimi K2 0905 Preview",
            reasoning: false,
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 256000,
            maxTokens: 8192,
          },
          {
            id: "kimi-k2-turbo-preview",
            name: "Kimi K2 Turbo",
            reasoning: false,
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 256000,
            maxTokens: 8192,
          },
          {
            id: "kimi-k2-thinking",
            name: "Kimi K2 Thinking",
            reasoning: true,
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 256000,
            maxTokens: 8192,
          },
          {
            id: "kimi-k2-thinking-turbo",
            name: "Kimi K2 Thinking Turbo",
            reasoning: true,
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 256000,
            maxTokens: 8192,
          },
          // moonshot-kimi-k2-models:end
        ],
      },
    },
  },
}
```

## Kimi Coding

```json5
{
  env: { KIMI_API_KEY: "sk-..." },
  agents: {
    defaults: {
      model: { primary: "kimi-coding/k2p5" },
      models: {
        "kimi-coding/k2p5": { alias: "Kimi K2.5" },
      },
    },
  },
}
```

## Ghi chú

- 11. Tham chiếu mô hình Moonshot sử dụng `moonshot/<modelId>`. Kimi Coding model refs use `kimi-coding/<modelId>`.
- Ghi đè metadata về giá và ngữ cảnh trong `models.providers` nếu cần.
- Nếu Moonshot công bố giới hạn ngữ cảnh khác cho một mô hình, hãy điều chỉnh
  `contextWindow` cho phù hợp.
- Dùng `https://api.moonshot.ai/v1` cho endpoint quốc tế, và `https://api.moonshot.cn/v1` cho endpoint Trung Quốc.
