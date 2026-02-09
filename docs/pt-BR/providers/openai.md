---
summary: "Use a OpenAI por meio de chaves de API ou assinatura do Codex no OpenClaw"
read_when:
  - Você quer usar modelos da OpenAI no OpenClaw
  - Você quer autenticação por assinatura do Codex em vez de chaves de API
title: "OpenAI"
---

# OpenAI

A OpenAI fornece APIs para desenvolvedores para modelos GPT. O Codex oferece **login com ChatGPT** para acesso por assinatura ou **login com chave de API** para acesso baseado em uso. A nuvem do Codex exige login com ChatGPT.

## Opção A: Chave de API da OpenAI (OpenAI Platform)

**Melhor para:** acesso direto à API e faturamento baseado em uso.
Obtenha sua chave de API no painel da OpenAI.

### Configuração da CLI

```bash
openclaw onboard --auth-choice openai-api-key
# or non-interactive
openclaw onboard --openai-api-key "$OPENAI_API_KEY"
```

### Trecho de configuração

```json5
{
  env: { OPENAI_API_KEY: "sk-..." },
  agents: { defaults: { model: { primary: "openai/gpt-5.1-codex" } } },
}
```

## Opção B: Assinatura do OpenAI Code (Codex)

**Melhor para:** usar acesso por assinatura do ChatGPT/Codex em vez de uma chave de API.
A nuvem do Codex exige login com ChatGPT, enquanto a CLI do Codex oferece suporte a login com ChatGPT ou com chave de API.

### Configuração da CLI (OAuth do Codex)

```bash
# Run Codex OAuth in the wizard
openclaw onboard --auth-choice openai-codex

# Or run OAuth directly
openclaw models auth login --provider openai-codex
```

### Trecho de configuração (assinatura do Codex)

```json5
{
  agents: { defaults: { model: { primary: "openai-codex/gpt-5.3-codex" } } },
}
```

## Notas

- As referências de modelo sempre usam `provider/model` (veja [/concepts/models](/concepts/models)).
- Detalhes de autenticação e regras de reutilização estão em [/concepts/oauth](/concepts/oauth).
