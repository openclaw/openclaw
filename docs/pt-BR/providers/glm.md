---
summary: "Visão geral da família de modelos GLM + como usá-la no OpenClaw"
read_when:
  - Você quer modelos GLM no OpenClaw
  - Você precisa da convenção de nomenclatura do modelo e da configuração
title: "Modelos GLM"
---

# Modelos GLM

GLM é uma **família de modelos** (não uma empresa) disponível por meio da plataforma Z.AI. No OpenClaw, os
modelos GLM são acessados por meio do provedor `zai` e IDs de modelo como `zai/glm-4.7`.

## Configuração da CLI

```bash
openclaw onboard --auth-choice zai-api-key
```

## Trecho de configuração

```json5
{
  env: { ZAI_API_KEY: "sk-..." },
  agents: { defaults: { model: { primary: "zai/glm-4.7" } } },
}
```

## Notas

- As versões e a disponibilidade do GLM podem mudar; consulte a documentação da Z.AI para obter as informações mais recentes.
- Exemplos de IDs de modelo incluem `glm-4.7` e `glm-4.6`.
- Para detalhes do provedor, veja [/providers/zai](/providers/zai).
