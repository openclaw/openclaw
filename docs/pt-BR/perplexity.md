---
summary: "Configuração do Perplexity Sonar para web_search"
read_when:
  - Você quer usar o Perplexity Sonar para busca na web
  - Você precisa de PERPLEXITY_API_KEY ou configuração do OpenRouter
title: "Perplexity Sonar"
---

# Perplexity Sonar

O OpenClaw pode usar o Perplexity Sonar para a ferramenta `web_search`. Você pode se conectar
pela API direta do Perplexity ou via OpenRouter.

## Opções de API

### Perplexity (direto)

- URL base: [https://api.perplexity.ai](https://api.perplexity.ai)
- Variável de ambiente: `PERPLEXITY_API_KEY`

### OpenRouter (alternativa)

- URL base: [https://openrouter.ai/api/v1](https://openrouter.ai/api/v1)
- Variável de ambiente: `OPENROUTER_API_KEY`
- Suporta créditos pré-pagos/cripto.

## Exemplo de configuração

```json5
{
  tools: {
    web: {
      search: {
        provider: "perplexity",
        perplexity: {
          apiKey: "pplx-...",
          baseUrl: "https://api.perplexity.ai",
          model: "perplexity/sonar-pro",
        },
      },
    },
  },
}
```

## Migração a partir do Brave

```json5
{
  tools: {
    web: {
      search: {
        provider: "perplexity",
        perplexity: {
          apiKey: "pplx-...",
          baseUrl: "https://api.perplexity.ai",
        },
      },
    },
  },
}
```

Se tanto `PERPLEXITY_API_KEY` quanto `OPENROUTER_API_KEY` estiverem definidos, defina
`tools.web.search.perplexity.baseUrl` (ou `tools.web.search.perplexity.apiKey`)
para desambiguar.

Se nenhuma URL base estiver definida, o OpenClaw escolhe um padrão com base na origem da chave de API:

- `PERPLEXITY_API_KEY` ou `pplx-...` → Perplexity direto (`https://api.perplexity.ai`)
- `OPENROUTER_API_KEY` ou `sk-or-...` → OpenRouter (`https://openrouter.ai/api/v1`)
- Formatos de chave desconhecidos → OpenRouter (fallback seguro)

## Modelos

- `perplexity/sonar` — perguntas e respostas rápidas com busca na web
- `perplexity/sonar-pro` (padrão) — raciocínio em várias etapas + busca na web
- `perplexity/sonar-reasoning-pro` — pesquisa profunda

Veja [Ferramentas da web](/tools/web) para a configuração completa de web_search.
