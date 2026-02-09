---
summary: "Sử dụng các mô hình Venice AI tập trung vào quyền riêng tư trong OpenClaw"
read_when:
  - Bạn muốn suy luận tập trung vào quyền riêng tư trong OpenClaw
  - Bạn muốn hướng dẫn thiết lập Venice AI
title: "Venice AI"
---

# Venice AI (Điểm nổi bật của Venice)

**Venice** là thiết lập Venice nổi bật của chúng tôi cho suy luận ưu tiên quyền riêng tư, với tùy chọn truy cập ẩn danh vào các mô hình độc quyền.

Venice AI provides privacy-focused AI inference with support for uncensored models and access to major proprietary models through their anonymized proxy. 32. Mọi suy luận đều riêng tư theo mặc định—không huấn luyện trên dữ liệu của bạn, không ghi log.

## Vì sao chọn Venice trong OpenClaw

- **Suy luận riêng tư** cho các mô hình mã nguồn mở (không ghi log).
- **Mô hình không kiểm duyệt** khi bạn cần.
- **Truy cập ẩn danh** vào các mô hình độc quyền (Opus/GPT/Gemini) khi chất lượng là yếu tố quan trọng.
- Các endpoint `/v1` tương thích OpenAI.

## Chế độ quyền riêng tư

Venice cung cấp hai mức quyền riêng tư — hiểu rõ điều này là chìa khóa để chọn mô hình:

| Chế độ         | Mô tả                                                                                                                                                                                     | Mô hình                                                                        |
| -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| **Private**    | 33. Hoàn toàn riêng tư. 34. Prompt/phản hồi **không bao giờ được lưu trữ hoặc ghi log**. Tạm thời. | Llama, Qwen, DeepSeek, Venice Uncensored, v.v. |
| **Anonymized** | Proxied through Venice with metadata stripped. The underlying provider (OpenAI, Anthropic) sees anonymized requests.                   | Claude, GPT, Gemini, Grok, Kimi, MiniMax                                       |

## Tính năng

- **Tập trung vào quyền riêng tư**: Chọn giữa chế độ "private" (hoàn toàn riêng tư) và "anonymized" (qua proxy)
- **Mô hình không kiểm duyệt**: Truy cập các mô hình không có hạn chế nội dung
- **Truy cập mô hình lớn**: Dùng Claude, GPT-5.2, Gemini, Grok qua proxy ẩn danh của Venice
- **API tương thích OpenAI**: Các endpoint `/v1` tiêu chuẩn để tích hợp dễ dàng
- **Streaming**: ✅ Hỗ trợ trên tất cả các mô hình
- **Function calling**: ✅ Hỗ trợ trên một số mô hình (kiểm tra khả năng của mô hình)
- **Vision**: ✅ Hỗ trợ trên các mô hình có khả năng vision
- **Không giới hạn tốc độ cứng**: Có thể áp dụng throttling theo fair-use khi sử dụng cực lớn

## Thiết lập

### 1. Get API Key

1. Đăng ký tại [venice.ai](https://venice.ai)
2. Vào **Settings → API Keys → Create new key**
3. Sao chép khóa API của bạn (định dạng: `vapi_xxxxxxxxxxxx`)

### 2) Cấu hình OpenClaw

**Tùy chọn A: Biến môi trường**

```bash
export VENICE_API_KEY="vapi_xxxxxxxxxxxx"
```

**Tùy chọn B: Thiết lập tương tác (Khuyến nghị)**

```bash
openclaw onboard --auth-choice venice-api-key
```

Việc này sẽ:

1. Yêu cầu nhập khóa API của bạn (hoặc dùng `VENICE_API_KEY` hiện có)
2. Hiển thị tất cả các mô hình Venice khả dụng
3. Cho phép bạn chọn mô hình mặc định
4. Tự động cấu hình nhà cung cấp

**Tùy chọn C: Không tương tác**

```bash
openclaw onboard --non-interactive \
  --auth-choice venice-api-key \
  --venice-api-key "vapi_xxxxxxxxxxxx"
```

### 38. 3. Verify Setup

```bash
openclaw chat --model venice/llama-3.3-70b "Hello, are you working?"
```

## Chọn mô hình

After setup, OpenClaw shows all available Venice models. Pick based on your needs:

- **Mặc định (chúng tôi khuyên dùng)**: `venice/llama-3.3-70b` cho chế độ private, hiệu năng cân bằng.
- **Chất lượng tổng thể tốt nhất**: `venice/claude-opus-45` cho các tác vụ khó (Opus vẫn là mạnh nhất).
- **Quyền riêng tư**: Chọn các mô hình "private" để suy luận hoàn toàn riêng tư.
- **Năng lực**: Chọn các mô hình "anonymized" để truy cập Claude, GPT, Gemini qua proxy của Venice.

Thay đổi mô hình mặc định bất cứ lúc nào:

```bash
openclaw models set venice/claude-opus-45
openclaw models set venice/llama-3.3-70b
```

Liệt kê tất cả các mô hình khả dụng:

```bash
openclaw models list | grep venice
```

## Cấu hình qua `openclaw configure`

1. Chạy `openclaw configure`
2. Chọn **Model/auth**
3. Chọn **Venice AI**

## Nên dùng mô hình nào?

| Trường hợp sử dụng                     | Mô hình khuyến nghị              | Lý do                               |
| -------------------------------------- | -------------------------------- | ----------------------------------- |
| **Chat chung**                         | `llama-3.3-70b`                  | Tốt toàn diện, hoàn toàn riêng tư   |
| **Chất lượng tổng thể tốt nhất**       | `claude-opus-45`                 | Opus vẫn mạnh nhất cho tác vụ khó   |
| **Quyền riêng tư + chất lượng Claude** | `claude-opus-45`                 | Lập luận tốt nhất qua proxy ẩn danh |
| **Lập trình**                          | `qwen3-coder-480b-a35b-instruct` | Tối ưu cho code, ngữ cảnh 262k      |
| **Tác vụ vision**                      | `qwen3-vl-235b-a22b`             | Mô hình vision private tốt nhất     |
| **Không kiểm duyệt**                   | `venice-uncensored`              | Không hạn chế nội dung              |
| **Nhanh + rẻ**                         | `qwen3-4b`                       | Nhẹ, vẫn đủ khả năng                |
| **Lập luận phức tạp**                  | `deepseek-v3.2`                  | Lập luận mạnh, private              |

## Các mô hình khả dụng (Tổng 25)

### Mô hình Private (15) — Hoàn toàn riêng tư, không ghi log

| Model ID                         | Tên                                        | Ngữ cảnh (token) | Tính năng             |
| -------------------------------- | ------------------------------------------ | ----------------------------------- | --------------------- |
| `llama-3.3-70b`                  | Llama 3.3 70B              | 131k                                | Chung                 |
| `llama-3.2-3b`                   | Llama 3.2 3B               | 131k                                | Nhanh, nhẹ            |
| `hermes-3-llama-3.1-405b`        | Hermes 3 Llama 3.1 405B    | 131k                                | Tác vụ phức tạp       |
| `qwen3-235b-a22b-thinking-2507`  | Qwen3 235B Thinking                        | 131k                                | Lập luận              |
| `qwen3-235b-a22b-instruct-2507`  | Qwen3 235B Instruct                        | 131k                                | Chung                 |
| `qwen3-coder-480b-a35b-instruct` | Qwen3 Coder 480B                           | 262k                                | Code                  |
| `qwen3-next-80b`                 | Qwen3 Next 80B                             | 262k                                | Chung                 |
| `qwen3-vl-235b-a22b`             | Qwen3 VL 235B                              | 262k                                | Vision                |
| `qwen3-4b`                       | Venice Small (Qwen3 4B) | 32k                                 | Nhanh, lập luận       |
| `deepseek-v3.2`                  | DeepSeek V3.2              | 163k                                | Lập luận              |
| `venice-uncensored`              | Venice Uncensored                          | 32k                                 | Không kiểm duyệt      |
| `mistral-31-24b`                 | Venice Medium (Mistral) | 131k                                | Vision                |
| `google-gemma-3-27b-it`          | Gemma 3 27B Instruct                       | 202k                                | Vision                |
| `openai-gpt-oss-120b`            | OpenAI GPT OSS 120B                        | 131k                                | Chung                 |
| `zai-org-glm-4.7`                | GLM 4.7                    | 202k                                | Lập luận, đa ngôn ngữ |

### Mô hình Anonymized (10) — Qua proxy của Venice

| Model ID                 | Gốc                               | Ngữ cảnh (token) | Tính năng        |
| ------------------------ | --------------------------------- | ----------------------------------- | ---------------- |
| `claude-opus-45`         | Claude Opus 4.5   | 202k                                | Lập luận, vision |
| `claude-sonnet-45`       | Claude Sonnet 4.5 | 202k                                | Lập luận, vision |
| `openai-gpt-52`          | GPT-5.2           | 262k                                | Lập luận         |
| `openai-gpt-52-codex`    | GPT-5.2 Codex     | 262k                                | Lập luận, vision |
| `gemini-3-pro-preview`   | Gemini 3 Pro                      | 202k                                | Lập luận, vision |
| `gemini-3-flash-preview` | Gemini 3 Flash                    | 262k                                | Lập luận, vision |
| `grok-41-fast`           | Grok 4.1 Fast     | 262k                                | Lập luận, vision |
| `grok-code-fast-1`       | Grok Code Fast 1                  | 262k                                | Lập luận, code   |
| `kimi-k2-thinking`       | Kimi K2 Thinking                  | 262k                                | Lập luận         |
| `minimax-m21`            | MiniMax M2.1      | 202k                                | Lập luận         |

## Khám phá mô hình

OpenClaw automatically discovers models from the Venice API when `VENICE_API_KEY` is set. If the API is unreachable, it falls back to a static catalog.

Endpoint `/models` là công khai (không cần xác thực để liệt kê), nhưng suy luận yêu cầu khóa API hợp lệ.

## Streaming & hỗ trợ công cụ

| Tính năng            | Hỗ trợ                                                                                  |
| -------------------- | --------------------------------------------------------------------------------------- |
| **Streaming**        | ✅ Tất cả các mô hình                                                                    |
| **Function calling** | ✅ Hầu hết các mô hình (kiểm tra `supportsFunctionCalling` trong API) |
| **Vision/Images**    | ✅ Các mô hình được đánh dấu tính năng "Vision"                                          |
| **JSON mode**        | ✅ Hỗ trợ qua `response_format`                                                          |

## Giá

Venice uses a credit-based system. Check [venice.ai/pricing](https://venice.ai/pricing) for current rates:

- **Mô hình Private**: Thường chi phí thấp hơn
- **Mô hình Anonymized**: Tương tự giá API trực tiếp + phí nhỏ của Venice

## So sánh: Venice vs API trực tiếp

| Khía cạnh          | Venice (Anonymized) | API trực tiếp                |
| ------------------ | -------------------------------------- | ---------------------------- |
| **Quyền riêng tư** | Metadata bị loại bỏ, ẩn danh           | Liên kết với tài khoản       |
| **Độ trễ**         | +10–50ms (proxy)    | Trực tiếp                    |
| **Tính năng**      | Hỗ trợ hầu hết tính năng               | Đầy đủ tính năng             |
| **Thanh toán**     | Credit của Venice                      | Thanh toán theo nhà cung cấp |

## Ví dụ sử dụng

```bash
# Use default private model
openclaw chat --model venice/llama-3.3-70b

# Use Claude via Venice (anonymized)
openclaw chat --model venice/claude-opus-45

# Use uncensored model
openclaw chat --model venice/venice-uncensored

# Use vision model with image
openclaw chat --model venice/qwen3-vl-235b-a22b

# Use coding model
openclaw chat --model venice/qwen3-coder-480b-a35b-instruct
```

## Xử lý sự cố

### Khóa API không được nhận diện

```bash
echo $VENICE_API_KEY
openclaw models list | grep venice
```

Đảm bảo khóa bắt đầu bằng `vapi_`.

### Mô hình không khả dụng

Chạy `openclaw models list` để xem các mô hình hiện có. Một số mô hình có thể tạm thời ngoại tuyến. Venice API ở `https://api.venice.ai/api/v1`.

### Sự cố kết nối

41. Venice API tại `https://api.venice.ai/api/v1`. 42. Đảm bảo mạng của bạn cho phép các kết nối HTTPS.

## Ví dụ tệp cấu hình

```json5
{
  env: { VENICE_API_KEY: "vapi_..." },
  agents: { defaults: { model: { primary: "venice/llama-3.3-70b" } } },
  models: {
    mode: "merge",
    providers: {
      venice: {
        baseUrl: "https://api.venice.ai/api/v1",
        apiKey: "${VENICE_API_KEY}",
        api: "openai-completions",
        models: [
          {
            id: "llama-3.3-70b",
            name: "Llama 3.3 70B",
            reasoning: false,
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 131072,
            maxTokens: 8192,
          },
        ],
      },
    },
  },
}
```

## Liên kết

- [Venice AI](https://venice.ai)
- [Tài liệu API](https://docs.venice.ai)
- [Giá](https://venice.ai/pricing)
- [Trạng thái](https://status.venice.ai)
