---
summary: "Sử dụng API tương thích Anthropic của Synthetic trong OpenClaw"
read_when:
  - Bạn muốn sử dụng Synthetic làm nhà cung cấp mô hình
  - Bạn cần thiết lập khóa API hoặc base URL của Synthetic
title: "Synthetic"
---

# Synthetic

Synthetic exposes Anthropic-compatible endpoints. OpenClaw registers it as the
`synthetic` provider and uses the Anthropic Messages API.

## Thiết lập nhanh

1. Đặt `SYNTHETIC_API_KEY` (hoặc chạy trình hướng dẫn bên dưới).
2. Chạy hướng dẫn ban đầu:

```bash
openclaw onboard --auth-choice synthetic-api-key
```

Mô hình mặc định được đặt là:

```
synthetic/hf:MiniMaxAI/MiniMax-M2.1
```

## Ví dụ cấu hình

```json5
{
  env: { SYNTHETIC_API_KEY: "sk-..." },
  agents: {
    defaults: {
      model: { primary: "synthetic/hf:MiniMaxAI/MiniMax-M2.1" },
      models: { "synthetic/hf:MiniMaxAI/MiniMax-M2.1": { alias: "MiniMax M2.1" } },
    },
  },
  models: {
    mode: "merge",
    providers: {
      synthetic: {
        baseUrl: "https://api.synthetic.new/anthropic",
        apiKey: "${SYNTHETIC_API_KEY}",
        api: "anthropic-messages",
        models: [
          {
            id: "hf:MiniMaxAI/MiniMax-M2.1",
            name: "MiniMax M2.1",
            reasoning: false,
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 192000,
            maxTokens: 65536,
          },
        ],
      },
    },
  },
}
```

29. Lưu ý: Ứng dụng client Anthropic của OpenClaw sẽ thêm `/v1` vào base URL, vì vậy hãy dùng `https://api.synthetic.new/anthropic` (không phải `/anthropic/v1`). If Synthetic changes
    its base URL, override `models.providers.synthetic.baseUrl`.

## Danh mục mô hình

Tất cả các mô hình dưới đây đều dùng chi phí `0` (input/output/cache).

| Model ID                                               | Cửa sổ ngữ cảnh | Số token tối đa | Lập luận | Đầu vào      |
| ------------------------------------------------------ | --------------- | --------------- | -------- | ------------ |
| `hf:MiniMaxAI/MiniMax-M2.1`                            | 192000          | 65536           | false    | text         |
| `hf:moonshotai/Kimi-K2-Thinking`                       | 256000          | 8192            | true     | text         |
| `hf:zai-org/GLM-4.7`                                   | 198000          | 128000          | false    | text         |
| `hf:deepseek-ai/DeepSeek-R1-0528`                      | 128000          | 8192            | false    | text         |
| `hf:deepseek-ai/DeepSeek-V3-0324`                      | 128000          | 8192            | false    | text         |
| `hf:deepseek-ai/DeepSeek-V3.1`                         | 128000          | 8192            | false    | text         |
| `hf:deepseek-ai/DeepSeek-V3.1-Terminus`                | 128000          | 8192            | false    | text         |
| `hf:deepseek-ai/DeepSeek-V3.2`                         | 159000          | 8192            | false    | text         |
| `hf:meta-llama/Llama-3.3-70B-Instruct`                 | 128000          | 8192            | false    | text         |
| `hf:meta-llama/Llama-4-Maverick-17B-128E-Instruct-FP8` | 524000          | 8192            | false    | text         |
| `hf:moonshotai/Kimi-K2-Instruct-0905`                  | 256000          | 8192            | false    | text         |
| `hf:openai/gpt-oss-120b`                               | 128000          | 8192            | false    | text         |
| `hf:Qwen/Qwen3-235B-A22B-Instruct-2507`                | 256000          | 8192            | false    | text         |
| `hf:Qwen/Qwen3-Coder-480B-A35B-Instruct`               | 256000          | 8192            | false    | text         |
| `hf:Qwen/Qwen3-VL-235B-A22B-Instruct`                  | 250000          | 8192            | false    | text + image |
| `hf:zai-org/GLM-4.5`                                   | 128000          | 128000          | false    | text         |
| `hf:zai-org/GLM-4.6`                                   | 198000          | 128000          | false    | text         |
| `hf:deepseek-ai/DeepSeek-V3`                           | 128000          | 8192            | false    | text         |
| `hf:Qwen/Qwen3-235B-A22B-Thinking-2507`                | 256000          | 8192            | true     | text         |

## Ghi chú

- Tham chiếu mô hình dùng `synthetic/<modelId>`.
- Nếu bạn bật danh sách cho phép mô hình (`agents.defaults.models`), hãy thêm mọi mô hình bạn
  dự định sử dụng.
- Xem [Model providers](/concepts/model-providers) để biết các quy tắc của nhà cung cấp.
