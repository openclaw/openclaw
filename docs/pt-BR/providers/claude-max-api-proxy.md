---
summary: "Use a assinatura Claude Max/Pro como um endpoint de API compatível com OpenAI"
read_when:
  - Você quer usar a assinatura Claude Max com ferramentas compatíveis com OpenAI
  - Você quer um servidor de API local que encapsule a Claude Code CLI
  - Você quer economizar usando assinatura em vez de chaves de API
title: "Proxy de API Claude Max"
---

# Proxy de API Claude Max

**claude-max-api-proxy** é uma ferramenta da comunidade que expõe sua assinatura Claude Max/Pro como um endpoint de API compatível com OpenAI. Isso permite usar sua assinatura com qualquer ferramenta que suporte o formato da API OpenAI.

## Por que usar isso?

| Abordagem             | Custo                                                                                                    | Ideal para                                  |
| --------------------- | -------------------------------------------------------------------------------------------------------- | ------------------------------------------- |
| API da Anthropic      | Pagamento por token (~US$15/M de entrada, US$75/M de saída para Opus) | Apps em produção, alto volume               |
| Assinatura Claude Max | US$200/mês fixo                                                                                          | Uso pessoal, desenvolvimento, uso ilimitado |

Se você tem uma assinatura Claude Max e quer usá-la com ferramentas compatíveis com OpenAI, este proxy pode economizar uma quantia significativa.

## Como funciona

```
Your App → claude-max-api-proxy → Claude Code CLI → Anthropic (via subscription)
     (OpenAI format)              (converts format)      (uses your login)
```

O proxy:

1. Aceita requisições no formato OpenAI em `http://localhost:3456/v1/chat/completions`
2. Converte para comandos da Claude Code CLI
3. Retorna respostas no formato OpenAI (com suporte a streaming)

## Instalação

```bash
# Requires Node.js 20+ and Claude Code CLI
npm install -g claude-max-api-proxy

# Verify Claude CLI is authenticated
claude --version
```

## Uso

### Iniciar o servidor

```bash
claude-max-api
# Server runs at http://localhost:3456
```

### Testar

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

### Com o OpenClaw

Você pode apontar o OpenClaw para o proxy como um endpoint personalizado compatível com OpenAI:

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

## Modelos disponíveis

| ID do modelo      | Mapeia para     |
| ----------------- | --------------- |
| `claude-opus-4`   | Claude Opus 4   |
| `claude-sonnet-4` | Claude Sonnet 4 |
| `claude-haiku-4`  | Claude Haiku 4  |

## Inicialização automática no macOS

Crie um LaunchAgent para executar o proxy automaticamente:

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

## Links

- **npm:** [https://www.npmjs.com/package/claude-max-api-proxy](https://www.npmjs.com/package/claude-max-api-proxy)
- **GitHub:** [https://github.com/atalovesyou/claude-max-api-proxy](https://github.com/atalovesyou/claude-max-api-proxy)
- **Issues:** [https://github.com/atalovesyou/claude-max-api-proxy/issues](https://github.com/atalovesyou/claude-max-api-proxy/issues)

## Notas

- Esta é uma **ferramenta da comunidade**, não oficialmente suportada pela Anthropic ou pelo OpenClaw
- Requer uma assinatura ativa Claude Max/Pro com a Claude Code CLI autenticada
- O proxy roda localmente e não envia dados para servidores de terceiros
- Respostas em streaming são totalmente suportadas

## Veja também

- [Provedor Anthropic](/providers/anthropic) - Integração nativa do OpenClaw com Claude usando setup-token ou chaves de API
- [Provedor OpenAI](/providers/openai) - Para assinaturas OpenAI/Codex
