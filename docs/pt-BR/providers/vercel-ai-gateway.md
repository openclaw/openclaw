---
title: "Vercel AI Gateway"
summary: "Configuração do Vercel AI Gateway (autenticação + seleção de modelo)"
read_when:
  - Voce quer usar o Vercel AI Gateway com o OpenClaw
  - Voce precisa da variável de ambiente da chave de API ou da opção de autenticação da CLI
---

# Vercel AI Gateway

O [Vercel AI Gateway](https://vercel.com/ai-gateway) fornece uma API unificada para acessar centenas de modelos por meio de um único endpoint.

- Provedor: `vercel-ai-gateway`
- Autenticação: `AI_GATEWAY_API_KEY`
- API: compatível com Anthropic Messages

## Início Rápido

1. Defina a chave de API (recomendado: armazená-la para o Gateway):

```bash
openclaw onboard --auth-choice ai-gateway-api-key
```

2. Defina um modelo padrão:

```json5
{
  agents: {
    defaults: {
      model: { primary: "vercel-ai-gateway/anthropic/claude-opus-4.6" },
    },
  },
}
```

## Exemplo não interativo

```bash
openclaw onboard --non-interactive \
  --mode local \
  --auth-choice ai-gateway-api-key \
  --ai-gateway-api-key "$AI_GATEWAY_API_KEY"
```

## Nota sobre o ambiente

Se o Gateway for executado como um daemon (launchd/systemd), verifique se `AI_GATEWAY_API_KEY`
está disponível para esse processo (por exemplo, em `~/.openclaw/.env` ou via
`env.shellEnv`).
