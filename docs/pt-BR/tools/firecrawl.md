---
summary: "Fallback do Firecrawl para web_fetch (anti-bot + extração em cache)"
read_when:
  - Você quer extração web com Firecrawl
  - Você precisa de uma chave de API do Firecrawl
  - Você quer extração anti-bot para web_fetch
title: "Firecrawl"
---

# Firecrawl

O OpenClaw pode usar o **Firecrawl** como um extrator de fallback para `web_fetch`. É um serviço hospedado de
extração de conteúdo que oferece suporte à evasão de bots e cache, o que ajuda
com sites pesados em JS ou páginas que bloqueiam buscas HTTP simples.

## Obter uma chave de API

1. Crie uma conta no Firecrawl e gere uma chave de API.
2. Armazene-a na configuração ou defina `FIRECRAWL_API_KEY` no ambiente do gateway.

## Configurar o Firecrawl

```json5
{
  tools: {
    web: {
      fetch: {
        firecrawl: {
          apiKey: "FIRECRAWL_API_KEY_HERE",
          baseUrl: "https://api.firecrawl.dev",
          onlyMainContent: true,
          maxAgeMs: 172800000,
          timeoutSeconds: 60,
        },
      },
    },
  },
}
```

Notas:

- `firecrawl.enabled` assume true por padrão quando uma chave de API está presente.
- `maxAgeMs` controla quão antigos os resultados em cache podem ser (ms). O padrão é 2 dias.

## Stealth / evasão de bots

O Firecrawl expõe um parâmetro de **modo proxy** para evasão de bots (`basic`, `stealth` ou `auto`).
O OpenClaw sempre usa `proxy: "auto"` mais `storeInCache: true` para requisições ao Firecrawl.
Se o proxy for omitido, o Firecrawl usa por padrão `auto`. `auto` tenta novamente com proxies stealth se uma tentativa básica falhar, o que pode usar mais créditos
do que a coleta apenas básica.

## Como `web_fetch` usa o Firecrawl

Ordem de extração do `web_fetch`:

1. Readability (local)
2. Firecrawl (se configurado)
3. Limpeza básica de HTML (último fallback)

Veja [Ferramentas web](/tools/web) para a configuração completa das ferramentas web.
