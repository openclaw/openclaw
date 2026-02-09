---
summary: "Các nhà cung cấp mô hình (LLM) được OpenClaw hỗ trợ"
read_when:
  - Bạn muốn chọn một nhà cung cấp mô hình
  - Bạn cần tổng quan nhanh về các backend LLM được hỗ trợ
title: "Nhà cung cấp mô hình"
---

# Nhà cung cấp mô hình

OpenClaw can use many LLM providers. Chọn một nhà cung cấp, xác thực, sau đó đặt
mô hình mặc định là `provider/model`.

1. Đang tìm tài liệu về các kênh chat (WhatsApp/Telegram/Discord/Slack/Mattermost (plugin)/v.v.)? 2. Xem [Channels](/channels).

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

For the full provider catalog (xAI, Groq, Mistral, etc.) and advanced configuration,
see [Model providers](/concepts/model-providers).
