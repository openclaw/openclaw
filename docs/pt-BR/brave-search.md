---
summary: "Configuração da API do Brave Search para web_search"
read_when:
  - Você quer usar o Brave Search para web_search
  - Você precisa de uma BRAVE_API_KEY ou detalhes de plano
title: "Brave Search"
---

# API do Brave Search

O OpenClaw usa o Brave Search como o provedor padrão para `web_search`.

## Obter uma chave de API

1. Crie uma conta da API do Brave Search em [https://brave.com/search/api/](https://brave.com/search/api/)
2. No painel, escolha o plano **Data for Search** e gere uma chave de API.
3. Armazene a chave na configuração (recomendado) ou defina `BRAVE_API_KEY` no ambiente do Gateway.

## Exemplo de configuração

```json5
{
  tools: {
    web: {
      search: {
        provider: "brave",
        apiKey: "BRAVE_API_KEY_HERE",
        maxResults: 5,
        timeoutSeconds: 30,
      },
    },
  },
}
```

## Notas

- O plano Data for AI **não** é compatível com `web_search`.
- O Brave oferece um nível gratuito além de planos pagos; verifique o portal da API do Brave para os limites atuais.

Veja [Web tools](/tools/web) para a configuração completa de web_search.
