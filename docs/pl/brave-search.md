---
summary: "„Konfiguracja API Brave Search dla web_search”"
read_when:
  - Chcesz używać Brave Search do web_search
  - Potrzebujesz klucza BRAVE_API_KEY lub informacji o planach
title: "„Brave Search”"
---

# API Brave Search

OpenClaw używa Brave Search jako domyślnego dostawcy dla `web_search`.

## Uzyskaj klucz API

1. Utwórz konto Brave Search API na stronie [https://brave.com/search/api/](https://brave.com/search/api/)
2. W panelu wybierz plan **Data for Search** i wygeneruj klucz API.
3. Zapisz klucz w konfiguracji (zalecane) lub ustaw `BRAVE_API_KEY` w środowisku Gateway.

## Przykład konfiguracji

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

## Uwagi

- Plan Data for AI **nie** jest kompatybilny z `web_search`.
- Brave oferuje bezpłatny poziom oraz plany płatne; sprawdź aktualne limity w portalu Brave API.

Zobacz [Web tools](/tools/web), aby uzyskać pełną konfigurację web_search.
