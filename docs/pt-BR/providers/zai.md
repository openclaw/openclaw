---
summary: "Use Z.AI (modelos GLM) com o OpenClaw"
read_when:
  - Você quer modelos Z.AI / GLM no OpenClaw
  - Você precisa de uma configuração simples do ZAI_API_KEY
title: "Z.AI"
---

# Z.AI

Z.AI é a plataforma de API para modelos **GLM**. Ela fornece APIs REST para GLM e usa chaves de API
para autenticação. Crie sua chave de API no console da Z.AI. O OpenClaw usa o provedor `zai`
com uma chave de API da Z.AI.

## Configuração da CLI

```bash
openclaw onboard --auth-choice zai-api-key
# or non-interactive
openclaw onboard --zai-api-key "$ZAI_API_KEY"
```

## Trecho de configuração

```json5
{
  env: { ZAI_API_KEY: "sk-..." },
  agents: { defaults: { model: { primary: "zai/glm-4.7" } } },
}
```

## Notas

- Modelos GLM estão disponíveis como `zai/<model>` (exemplo: `zai/glm-4.7`).
- Veja [/providers/glm](/providers/glm) para uma visão geral da família de modelos.
- A Z.AI usa autenticação Bearer com sua chave de API.
