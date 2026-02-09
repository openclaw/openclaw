---
summary: "Sử dụng OpenAI qua khóa API hoặc đăng ký Codex trong OpenClaw"
read_when:
  - Bạn muốn dùng các mô hình OpenAI trong OpenClaw
  - Bạn muốn xác thực bằng đăng ký Codex thay vì khóa API
title: "OpenAI"
---

# OpenAI

18. OpenAI cung cấp các API dành cho nhà phát triển cho các mô hình GPT. 19. Codex hỗ trợ **đăng nhập ChatGPT** để truy cập theo gói đăng ký hoặc **đăng nhập bằng API key** để truy cập theo mức sử dụng. Codex cloud requires ChatGPT sign-in.

## Tùy chọn A: Khóa API OpenAI (OpenAI Platform)

**Best for:** direct API access and usage-based billing.
Get your API key from the OpenAI dashboard.

### Thiết lập CLI

```bash
openclaw onboard --auth-choice openai-api-key
# or non-interactive
openclaw onboard --openai-api-key "$OPENAI_API_KEY"
```

### Đoạn cấu hình

```json5
{
  env: { OPENAI_API_KEY: "sk-..." },
  agents: { defaults: { model: { primary: "openai/gpt-5.1-codex" } } },
}
```

## Tùy chọn B: Đăng ký OpenAI Code (Codex)

20. **Phù hợp nhất cho:** sử dụng quyền truy cập gói đăng ký ChatGPT/Codex thay vì API key.
21. Codex cloud yêu cầu đăng nhập ChatGPT, trong khi Codex CLI hỗ trợ đăng nhập bằng ChatGPT hoặc API key.

### Thiết lập CLI (Codex OAuth)

```bash
# Run Codex OAuth in the wizard
openclaw onboard --auth-choice openai-codex

# Or run OAuth directly
openclaw models auth login --provider openai-codex
```

### Đoạn cấu hình (đăng ký Codex)

```json5
{
  agents: { defaults: { model: { primary: "openai-codex/gpt-5.3-codex" } } },
}
```

## Ghi chú

- Tham chiếu mô hình luôn dùng `provider/model` (xem [/concepts/models](/concepts/models)).
- Chi tiết xác thực và quy tắc tái sử dụng nằm trong [/concepts/oauth](/concepts/oauth).
