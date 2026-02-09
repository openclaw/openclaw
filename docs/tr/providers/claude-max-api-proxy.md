---
summary: "Claude Max/Pro aboneliğini OpenAI uyumlu bir API uç noktası olarak kullanın"
read_when:
  - OpenAI uyumlu araçlarla Claude Max aboneliğini kullanmak istiyorsunuz
  - Claude Code CLI’yi saran yerel bir API sunucusu istiyorsunuz
  - API anahtarları yerine abonelik kullanarak maliyetlerden tasarruf etmek istiyorsunuz
title: "Claude Max API Proxy"
---

# Claude Max API Proxy

**claude-max-api-proxy**, Claude Max/Pro aboneliğinizi OpenAI uyumlu bir API uç noktası olarak sunan bir topluluk aracıdır. Bu sayede OpenAI API formatını destekleyen herhangi bir araçla aboneliğinizi kullanabilirsiniz.

## Neden Bunu Kullanmalısınız?

| Yaklaşım             | Maliyet                                                                                     | En İyisi                                        |
| -------------------- | ------------------------------------------------------------------------------------------- | ----------------------------------------------- |
| Anthropic API        | Token başına ödeme (~$15/M giriş, Opus için $75/M çıkış) | Üretim uygulamaları, yüksek hacim               |
| Claude Max aboneliği | Aylık sabit $200                                                                            | Kişisel kullanım, geliştirme, sınırsız kullanım |

Claude Max aboneliğiniz varsa ve bunu OpenAI uyumlu araçlarla kullanmak istiyorsanız, bu proxy önemli ölçüde tasarruf etmenizi sağlayabilir.

## Nasıl Çalışır

```
Your App → claude-max-api-proxy → Claude Code CLI → Anthropic (via subscription)
     (OpenAI format)              (converts format)      (uses your login)
```

Proxy şu işlemleri yapar:

1. `http://localhost:3456/v1/chat/completions` adresinde OpenAI formatındaki istekleri kabul eder
2. Bunları Claude Code CLI komutlarına dönüştürür
3. Yanıtları OpenAI formatında döndürür (akış desteklenir)

## Kurulum

```bash
# Requires Node.js 20+ and Claude Code CLI
npm install -g claude-max-api-proxy

# Verify Claude CLI is authenticated
claude --version
```

## Kullanım

### Sunucuyu başlatma

```bash
claude-max-api
# Server runs at http://localhost:3456
```

### Test etme

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

### OpenClaw ile

OpenClaw’ı, OpenAI uyumlu özel bir uç nokta olarak proxy’ye yönlendirebilirsiniz:

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

## Kullanılabilir Modeller

| Model Kimliği     | Eşlenir         |
| ----------------- | --------------- |
| `claude-opus-4`   | Claude Opus 4   |
| `claude-sonnet-4` | Claude Sonnet 4 |
| `claude-haiku-4`  | Claude Haiku 4  |

## macOS’te Otomatik Başlatma

Proxy’yi otomatik olarak çalıştırmak için bir LaunchAgent oluşturun:

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

## Bağlantılar

- **npm:** [https://www.npmjs.com/package/claude-max-api-proxy](https://www.npmjs.com/package/claude-max-api-proxy)
- **GitHub:** [https://github.com/atalovesyou/claude-max-api-proxy](https://github.com/atalovesyou/claude-max-api-proxy)
- **Issues:** [https://github.com/atalovesyou/claude-max-api-proxy/issues](https://github.com/atalovesyou/claude-max-api-proxy/issues)

## Notlar

- Bu, Anthropic veya OpenClaw tarafından resmi olarak desteklenmeyen bir **topluluk aracıdır**
- Claude Code CLI’nin kimlik doğrulaması yapılmış, etkin bir Claude Max/Pro aboneliği gerektirir
- Proxy yerel olarak çalışır ve verileri herhangi bir üçüncü taraf sunucuya göndermez
- Akışlı yanıtlar tamamen desteklenir

## Ayrıca Bkz.

- [Anthropic sağlayıcısı](/providers/anthropic) - setup-token veya API anahtarları ile Claude için yerel OpenClaw entegrasyonu
- [OpenAI sağlayıcısı](/providers/openai) - OpenAI/Codex abonelikleri için
