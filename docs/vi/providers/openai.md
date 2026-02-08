---
summary: "Sử dụng OpenAI qua khóa API hoặc đăng ký Codex trong OpenClaw"
read_when:
  - Bạn muốn dùng các mô hình OpenAI trong OpenClaw
  - Bạn muốn xác thực bằng đăng ký Codex thay vì khóa API
title: "OpenAI"
x-i18n:
  source_path: providers/openai.md
  source_hash: 6d78698351c3d2f5
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T09:39:52Z
---

# OpenAI

OpenAI cung cấp các API dành cho nhà phát triển cho các mô hình GPT. Codex hỗ trợ **đăng nhập ChatGPT** cho quyền truy cập theo đăng ký hoặc **đăng nhập bằng khóa API** cho truy cập tính phí theo mức sử dụng. Codex cloud yêu cầu đăng nhập ChatGPT.

## Tùy chọn A: Khóa API OpenAI (OpenAI Platform)

**Phù hợp nhất cho:** truy cập API trực tiếp và thanh toán theo mức sử dụng.
Lấy khóa API của bạn từ bảng điều khiển OpenAI.

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

**Phù hợp nhất cho:** sử dụng quyền truy cập theo đăng ký ChatGPT/Codex thay vì khóa API.
Codex cloud yêu cầu đăng nhập ChatGPT, trong khi Codex CLI hỗ trợ đăng nhập bằng ChatGPT hoặc khóa API.

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
