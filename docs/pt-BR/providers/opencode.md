---
summary: "Use o OpenCode Zen (modelos selecionados) com o OpenClaw"
read_when:
  - Você quer o OpenCode Zen para acesso a modelos
  - Você quer uma lista selecionada de modelos amigáveis para codificação
title: "OpenCode Zen"
---

# OpenCode Zen

O OpenCode Zen é uma **lista selecionada de modelos** recomendados pela equipe do OpenCode para agentes de codificação.
É um caminho opcional e hospedado de acesso a modelos que usa uma chave de API e o provedor `opencode`.
No momento, o Zen está em beta.

## Configuração da CLI

```bash
openclaw onboard --auth-choice opencode-zen
# or non-interactive
openclaw onboard --opencode-zen-api-key "$OPENCODE_API_KEY"
```

## Trecho de configuração

```json5
{
  env: { OPENCODE_API_KEY: "sk-..." },
  agents: { defaults: { model: { primary: "opencode/claude-opus-4-6" } } },
}
```

## Notas

- `OPENCODE_ZEN_API_KEY` também é compatível.
- Você faz login no Zen, adiciona os detalhes de faturamento e copia sua chave de API.
- O OpenCode Zen cobra por solicitação; verifique o painel do OpenCode para obter detalhes.
