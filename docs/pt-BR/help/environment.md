---
summary: "Onde o OpenClaw carrega variáveis de ambiente e a ordem de precedência"
read_when:
  - Você precisa saber quais variáveis de ambiente são carregadas e em que ordem
  - Você está depurando chaves de API ausentes no Gateway
  - Você está documentando autenticação de provedores ou ambientes de implantação
title: "Variáveis de ambiente"
x-i18n:
  source_path: help/environment.md
  source_hash: b49ae50e5d306612
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T09:31:00Z
---

# Variáveis de ambiente

O OpenClaw obtém variáveis de ambiente de múltiplas fontes. A regra é **nunca sobrescrever valores existentes**.

## Precedência (mais alta → mais baixa)

1. **Ambiente do processo** (o que o processo do Gateway já possui do shell/daemon pai).
2. **`.env` no diretório de trabalho atual** (padrão do dotenv; não sobrescreve).
3. **`.env` global** em `~/.openclaw/.env` (também conhecido como `$OPENCLAW_STATE_DIR/.env`; não sobrescreve).
4. **Bloco de Configuração `env`** em `~/.openclaw/openclaw.json` (aplicado apenas se estiver ausente).
5. **Importação opcional do shell de login** (`env.shellEnv.enabled` ou `OPENCLAW_LOAD_SHELL_ENV=1`), aplicada apenas para chaves esperadas ausentes.

Se o arquivo de configuração estiver totalmente ausente, a etapa 4 é ignorada; a importação do shell ainda é executada se estiver habilitada.

## Bloco de Configuração `env`

Duas formas equivalentes de definir variáveis de ambiente inline (ambas não sobrescrevem):

```json5
{
  env: {
    OPENROUTER_API_KEY: "sk-or-...",
    vars: {
      GROQ_API_KEY: "gsk-...",
    },
  },
}
```

## Importação de env do shell

`env.shellEnv` executa seu shell de login e importa apenas chaves esperadas **ausentes**:

```json5
{
  env: {
    shellEnv: {
      enabled: true,
      timeoutMs: 15000,
    },
  },
}
```

Equivalentes em variáveis de ambiente:

- `OPENCLAW_LOAD_SHELL_ENV=1`
- `OPENCLAW_SHELL_ENV_TIMEOUT_MS=15000`

## Substituição de variáveis de ambiente na configuração

Você pode referenciar variáveis de ambiente diretamente em valores de string da configuração usando a sintaxe `${VAR_NAME}`:

```json5
{
  models: {
    providers: {
      "vercel-gateway": {
        apiKey: "${VERCEL_GATEWAY_API_KEY}",
      },
    },
  },
}
```

Veja [Configuração: Substituição de variáveis de ambiente](/gateway/configuration#env-var-substitution-in-config) para todos os detalhes.

## Relacionados

- [Configuração do Gateway](/gateway/configuration)
- [Perguntas frequentes: variáveis de ambiente e carregamento de .env](/help/faq#env-vars-and-env-loading)
- [Visão geral de modelos](/concepts/models)
