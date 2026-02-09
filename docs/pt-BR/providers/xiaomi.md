---
summary: "Use o Xiaomi MiMo (mimo-v2-flash) com o OpenClaw"
read_when:
  - Voce quer modelos Xiaomi MiMo no OpenClaw
  - Voce precisa configurar a XIAOMI_API_KEY
title: "Xiaomi MiMo"
---

# Xiaomi MiMo

O Xiaomi MiMo é a plataforma de API para modelos **MiMo**. Ele fornece APIs REST compatíveis com os formatos OpenAI e Anthropic e usa chaves de API para autenticação. Crie sua chave de API no [console do Xiaomi MiMo](https://platform.xiaomimimo.com/#/console/api-keys). O OpenClaw usa o provedor `xiaomi` com uma chave de API do Xiaomi MiMo.

## Visão geral do modelo

- **mimo-v2-flash**: janela de contexto de 262.144 tokens, compatível com a Anthropic Messages API.
- URL base: `https://api.xiaomimimo.com/anthropic`
- Autorização: `Bearer $XIAOMI_API_KEY`

## Configuração da CLI

```bash
openclaw onboard --auth-choice xiaomi-api-key
# or non-interactive
openclaw onboard --auth-choice xiaomi-api-key --xiaomi-api-key "$XIAOMI_API_KEY"
```

## Trecho de configuração

```json5
{
  env: { XIAOMI_API_KEY: "your-key" },
  agents: { defaults: { model: { primary: "xiaomi/mimo-v2-flash" } } },
  models: {
    mode: "merge",
    providers: {
      xiaomi: {
        baseUrl: "https://api.xiaomimimo.com/anthropic",
        api: "anthropic-messages",
        apiKey: "XIAOMI_API_KEY",
        models: [
          {
            id: "mimo-v2-flash",
            name: "Xiaomi MiMo V2 Flash",
            reasoning: false,
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 262144,
            maxTokens: 8192,
          },
        ],
      },
    },
  },
}
```

## Notas

- Referência do modelo: `xiaomi/mimo-v2-flash`.
- O provedor é injetado automaticamente quando `XIAOMI_API_KEY` é definido (ou quando existe um perfil de autenticação).
- Veja [/concepts/model-providers](/concepts/model-providers) para regras de provedores.
