---
summary: "Dùng gói đăng ký Claude Max/Pro như một endpoint API tương thích OpenAI"
read_when:
  - Bạn muốn dùng gói Claude Max với các công cụ tương thích OpenAI
  - Bạn muốn một máy chủ API cục bộ bọc quanh Claude Code CLI
  - Bạn muốn tiết kiệm chi phí bằng cách dùng gói đăng ký thay vì khóa API
title: "Claude Max API Proxy"
---

# Claude Max API Proxy

**claude-max-api-proxy** là một công cụ cộng đồng cho phép xuất gói đăng ký Claude Max/Pro của bạn dưới dạng endpoint API tương thích OpenAI. Điều này cho phép bạn sử dụng gói đăng ký của mình với bất kỳ công cụ nào hỗ trợ định dạng API OpenAI.

## Vì sao nên dùng?

| Cách tiếp cận  | Chi phí                                                                                 | Phù hợp nhất                                     |
| -------------- | --------------------------------------------------------------------------------------- | ------------------------------------------------ |
| Anthropic API  | Trả theo token (~$15/M input, $75/M output cho Opus) | Ứng dụng sản xuất, lưu lượng cao                 |
| Gói Claude Max | $200/tháng cố định                                                                      | Dùng cá nhân, phát triển, sử dụng không giới hạn |

Nếu bạn có gói Claude Max và muốn dùng với các công cụ tương thích OpenAI, proxy này có thể giúp bạn tiết kiệm đáng kể.

## Cách hoạt động

```
Your App → claude-max-api-proxy → Claude Code CLI → Anthropic (via subscription)
     (OpenAI format)              (converts format)      (uses your login)
```

Proxy sẽ:

1. Nhận các yêu cầu theo định dạng OpenAI tại `http://localhost:3456/v1/chat/completions`
2. Chuyển đổi chúng thành lệnh Claude Code CLI
3. Trả về phản hồi theo định dạng OpenAI (có hỗ trợ streaming)

## Cài đặt

```bash
# Requires Node.js 20+ and Claude Code CLI
npm install -g claude-max-api-proxy

# Verify Claude CLI is authenticated
claude --version
```

## Cách dùng

### Khởi động máy chủ

```bash
claude-max-api
# Server runs at http://localhost:3456
```

### Kiểm tra

```bash
# Health check
curl http://localhost:3456/health

# List models
curl http://localhost:3456/v1/models

# Chat completion
curl http://localhost:3456/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "claude-opus-4",
    "messages": [{"role": "user", "content": "Hello!"}]
  }'
```

### Với OpenClaw

Bạn có thể trỏ OpenClaw tới proxy như một endpoint tương thích OpenAI tùy chỉnh:

```json5
{
  env: {
    OPENAI_API_KEY: "not-needed",
    OPENAI_BASE_URL: "http://localhost:3456/v1",
  },
  agents: {
    defaults: {
      model: { primary: "openai/claude-opus-4" },
    },
  },
}
```

## Các mô hình khả dụng

| ID mô hình        | Ánh xạ tới      |
| ----------------- | --------------- |
| `claude-opus-4`   | Claude Opus 4   |
| `claude-sonnet-4` | Claude Sonnet 4 |
| `claude-haiku-4`  | Claude Haiku 4  |

## Tự khởi động trên macOS

Tạo một LaunchAgent để chạy proxy tự động:

```bash
cat > ~/Library/LaunchAgents/com.claude-max-api.plist << 'EOF'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.claude-max-api</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/local/bin/node</string>
    <string>/usr/local/lib/node_modules/claude-max-api-proxy/dist/server/standalone.js</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>/usr/local/bin:/opt/homebrew/bin:~/.local/bin:/usr/bin:/bin</string>
  </dict>
</dict>
</plist>
EOF

launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.claude-max-api.plist
```

## Liên kết

- **npm:** [https://www.npmjs.com/package/claude-max-api-proxy](https://www.npmjs.com/package/claude-max-api-proxy)
- **GitHub:** [https://github.com/atalovesyou/claude-max-api-proxy](https://github.com/atalovesyou/claude-max-api-proxy)
- **Issues:** [https://github.com/atalovesyou/claude-max-api-proxy/issues](https://github.com/atalovesyou/claude-max-api-proxy/issues)

## Ghi chú

- Đây là **công cụ cộng đồng**, không được Anthropic hay OpenClaw hỗ trợ chính thức
- Yêu cầu gói đăng ký Claude Max/Pro đang hoạt động và đã xác thực Claude Code CLI
- Proxy chạy cục bộ và không gửi dữ liệu tới bất kỳ máy chủ bên thứ ba nào
- Hỗ trợ đầy đủ phản hồi streaming

## Xem thêm

- [Anthropic provider](/providers/anthropic) - Tích hợp OpenClaw gốc với Claude qua setup-token hoặc khóa API
- [OpenAI provider](/providers/openai) - Dành cho các gói đăng ký OpenAI/Codex
