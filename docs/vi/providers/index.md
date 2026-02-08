---
summary: "Các nhà cung cấp mô hình (LLM) được OpenClaw hỗ trợ"
read_when:
  - Bạn muốn chọn một nhà cung cấp mô hình
  - Bạn cần tổng quan nhanh về các backend LLM được hỗ trợ
title: "Nhà cung cấp mô hình"
x-i18n:
  source_path: providers/index.md
  source_hash: af168e89983fab19
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T09:39:51Z
---

# Nhà cung cấp mô hình

OpenClaw có thể sử dụng nhiều nhà cung cấp LLM. Hãy chọn một nhà cung cấp, xác thực, sau đó đặt
mô hình mặc định là `provider/model`.

Bạn đang tìm tài liệu về các kênh chat (WhatsApp/Telegram/Discord/Slack/Mattermost (plugin)/v.v.)? Xem [Channels](/channels).

## Nổi bật: Venice (Venice AI)

Venice là thiết lập Venice AI được chúng tôi khuyến nghị cho suy luận ưu tiên quyền riêng tư, với tùy chọn dùng Opus cho các tác vụ khó.

- Mặc định: `venice/llama-3.3-70b`
- Tốt nhất tổng thể: `venice/claude-opus-45` (Opus vẫn là mạnh nhất)

Xem [Venice AI](/providers/venice).

## Khởi động nhanh

1. Xác thực với nhà cung cấp (thường qua `openclaw onboard`).
2. Đặt mô hình mặc định:

```json5
{
  agents: { defaults: { model: { primary: "anthropic/claude-opus-4-6" } } },
}
```

## Tài liệu nhà cung cấp

- [OpenAI (API + Codex)](/providers/openai)
- [Anthropic (API + Claude Code CLI)](/providers/anthropic)
- [Qwen (OAuth)](/providers/qwen)
- [OpenRouter](/providers/openrouter)
- [Vercel AI Gateway](/providers/vercel-ai-gateway)
- [Cloudflare AI Gateway](/providers/cloudflare-ai-gateway)
- [Moonshot AI (Kimi + Kimi Coding)](/providers/moonshot)
- [OpenCode Zen](/providers/opencode)
- [Amazon Bedrock](/providers/bedrock)
- [Z.AI](/providers/zai)
- [Xiaomi](/providers/xiaomi)
- [GLM models](/providers/glm)
- [MiniMax](/providers/minimax)
- [Venice (Venice AI, tập trung vào quyền riêng tư)](/providers/venice)
- [Ollama (mô hình cục bộ)](/providers/ollama)
- [Qianfan](/providers/qianfan)

## Nhà cung cấp phiên âm

- [Deepgram (phiên âm âm thanh)](/providers/deepgram)

## Công cụ cộng đồng

- [Claude Max API Proxy](/providers/claude-max-api-proxy) - Sử dụng gói đăng ký Claude Max/Pro như một endpoint API tương thích OpenAI

Để xem danh mục đầy đủ các nhà cung cấp (xAI, Groq, Mistral, v.v.) và cấu hình nâng cao,
xem [Model providers](/concepts/model-providers).
