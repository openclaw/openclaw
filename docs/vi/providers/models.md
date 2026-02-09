---
summary: "Các nhà cung cấp mô hình (LLM) được OpenClaw hỗ trợ"
read_when:
  - Bạn muốn chọn một nhà cung cấp mô hình
  - Bạn muốn xem ví dụ thiết lập nhanh cho xác thực LLM + chọn mô hình
title: "Khởi động nhanh nhà cung cấp mô hình"
---

# Nhà cung cấp mô hình

OpenClaw can use many LLM providers. 7. Chọn một, xác thực, sau đó đặt mô hình mặc định là `provider/model`.

## Điểm nổi bật: Venice (Venice AI)

Venice là thiết lập Venice AI được chúng tôi khuyến nghị cho suy luận ưu tiên quyền riêng tư, với tùy chọn dùng Opus cho những tác vụ khó nhất.

- Mặc định: `venice/llama-3.3-70b`
- Tốt nhất tổng thể: `venice/claude-opus-45` (Opus vẫn là mạnh nhất)

Xem [Venice AI](/providers/venice).

## Khởi động nhanh (hai bước)

1. Xác thực với nhà cung cấp (thường qua `openclaw onboard`).
2. Đặt mô hình mặc định:

```json5
{
  agents: { defaults: { model: { primary: "anthropic/claude-opus-4-6" } } },
}
```

## Các nhà cung cấp được hỗ trợ (bộ khởi đầu)

- [OpenAI (API + Codex)](/providers/openai)
- [Anthropic (API + Claude Code CLI)](/providers/anthropic)
- [OpenRouter](/providers/openrouter)
- [Vercel AI Gateway](/providers/vercel-ai-gateway)
- [Cloudflare AI Gateway](/providers/cloudflare-ai-gateway)
- [Moonshot AI (Kimi + Kimi Coding)](/providers/moonshot)
- [Synthetic](/providers/synthetic)
- [OpenCode Zen](/providers/opencode)
- [Z.AI](/providers/zai)
- [GLM models](/providers/glm)
- [MiniMax](/providers/minimax)
- [Venice (Venice AI)](/providers/venice)
- [Amazon Bedrock](/providers/bedrock)
- [Qianfan](/providers/qianfan)

For the full provider catalog (xAI, Groq, Mistral, etc.) and advanced configuration,
see [Model providers](/concepts/model-providers).
