---
summary: "Narzędzia wyszukiwania i pobierania z sieci (Brave Search API, Perplexity direct/OpenRouter)"
read_when:
  - Chcesz włączyć web_search lub web_fetch
  - Potrzebujesz konfiguracji klucza API Brave Search
  - Chcesz używać Perplexity Sonar do wyszukiwania w sieci
title: "Narzędzia webowe"
---

# Narzędzia webowe

OpenClaw dostarcza dwa lekkie narzędzia webowe:

- `web_search` — Wyszukiwanie w sieci przez Brave Search API (domyślnie) lub Perplexity Sonar (bezpośrednio lub przez OpenRouter).
- `web_fetch` — Pobieranie HTTP + ekstrakcja czytelnej treści (HTML → markdown/tekst).

To **nie** jest automatyzacja przeglądarki. Dla stron intensywnie wykorzystujących JS lub wymagających logowania użyj
[narzędzia Browser](/tools/browser).

## Jak to działa

- `web_search` wywołuje skonfigurowanego dostawcę i zwraca wyniki.
  - **Brave** (domyślnie): zwraca ustrukturyzowane wyniki (tytuł, URL, fragment).
  - **Perplexity**: zwraca odpowiedzi syntetyzowane przez AI z cytowaniami z wyszukiwania w czasie rzeczywistym.
- Wyniki są buforowane według zapytania przez 15 minut (konfigurowalne).
- `web_fetch` wykonuje zwykłe HTTP GET i wyodrębnia czytelną treść
  (HTML → markdown/tekst). **Nie** wykonuje JavaScriptu.
- `web_fetch` jest włączone domyślnie (chyba że zostanie jawnie wyłączone).

## Wybór dostawcy wyszukiwania

| Dostawca                                | Zalety                                                         | Koty                                        | Klucz API                                     |
| --------------------------------------- | -------------------------------------------------------------- | ------------------------------------------- | --------------------------------------------- |
| **Brave** (domyślny) | Szybkie, ustrukturyzowane wyniki, darmowy tier                 | Tradycyjne wyniki wyszukiwania              | `BRAVE_API_KEY`                               |
| **Perplexity**                          | Odpowiedzi syntetyzowane przez AI, cytowania, czas rzeczywisty | Wymaga dostępu do Perplexity lub OpenRouter | `OPENROUTER_API_KEY` lub `PERPLEXITY_API_KEY` |

Zobacz [konfigurację Brave Search](/brave-search) oraz [Perplexity Sonar](/perplexity) po szczegóły specyficzne dla dostawców.

Ustaw dostawcę w konfiguracji:

```json5
{
  tools: {
    web: {
      search: {
        provider: "brave", // or "perplexity"
      },
    },
  },
}
```

Przykład: przełączenie na Perplexity Sonar (bezpośrednie API):

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

## Uzyskanie klucza API Brave

1. Utwórz konto Brave Search API na [https://brave.com/search/api/](https://brave.com/search/api/)
2. W panelu wybierz plan **Data for Search** (nie „Data for AI”) i wygeneruj klucz API.
3. Uruchom `openclaw configure --section web`, aby zapisać klucz w konfiguracji (zalecane), lub ustaw `BRAVE_API_KEY` w swoim środowisku.

Brave oferuje darmowy tier oraz plany płatne; sprawdź portal API Brave, aby poznać
aktualne limity i ceny.

### Gdzie ustawić klucz (zalecane)

**Zalecane:** uruchom `openclaw configure --section web`. Zapisuje on klucz w
`~/.openclaw/openclaw.json` pod `tools.web.search.apiKey`.

**Alternatywa środowiskowa:** ustaw `BRAVE_API_KEY` w środowisku procesu Gateway. Dla instalacji gateway umieść go w `~/.openclaw/.env` (lub w środowisku usługi). Zobacz [zmienne środowiskowe](/help/faq#how-does-openclaw-load-environment-variables).

## Używanie Perplexity (bezpośrednio lub przez OpenRouter)

Modele Perplexity Sonar mają wbudowane możliwości wyszukiwania w sieci i zwracają
odpowiedzi syntetyzowane przez AI z cytowaniami. Możesz używać ich przez OpenRouter
(nie wymaga karty kredytowej — obsługuje kryptowaluty/przedpłaty).

### Uzyskanie klucza API OpenRouter

1. Utwórz konto na [https://openrouter.ai/](https://openrouter.ai/)
2. Doładuj środki (obsługuje kryptowaluty, przedpłaty lub kartę kredytową)
3. Wygeneruj klucz API w ustawieniach konta

### Konfiguracja wyszukiwania Perplexity

```json5
{
  tools: {
    web: {
      search: {
        enabled: true,
        provider: "perplexity",
        perplexity: {
          // API key (optional if OPENROUTER_API_KEY or PERPLEXITY_API_KEY is set)
          apiKey: "sk-or-v1-...",
          // Base URL (key-aware default if omitted)
          baseUrl: "https://openrouter.ai/api/v1",
          // Model (defaults to perplexity/sonar-pro)
          model: "perplexity/sonar-pro",
        },
      },
    },
  },
}
```

**Alternatywa środowiskowa:** ustaw `OPENROUTER_API_KEY` lub `PERPLEXITY_API_KEY` w środowisku Gateway. Dla instalacji gateway umieść go w `~/.openclaw/.env`.

Jeśli nie ustawiono bazowego URL, OpenClaw wybiera domyślny na podstawie źródła klucza API:

- `PERPLEXITY_API_KEY` lub `pplx-...` → `https://api.perplexity.ai`
- `OPENROUTER_API_KEY` lub `sk-or-...` → `https://openrouter.ai/api/v1`
- Nieznane formaty kluczy → OpenRouter (bezpieczny fallback)

### Dostępne modele Perplexity

| Model                                                | Opis                                                    | Najlepsze do       |
| ---------------------------------------------------- | ------------------------------------------------------- | ------------------ |
| `perplexity/sonar`                                   | Szybkie Q&A z wyszukiwaniem w sieci | Szybkich sprawdzeń |
| `perplexity/sonar-pro` (domyślny) | Wieloetapowe rozumowanie z wyszukiwaniem w sieci        | Złożonych pytań    |
| `perplexity/sonar-reasoning-pro`                     | Analiza typu chain-of-thought                           | Dogłębnych badań   |

## web_search

Wyszukuj w sieci przy użyciu skonfigurowanego dostawcy.

### Wymagania

- `tools.web.search.enabled` nie może być `false` (domyślnie: włączone)
- Klucz API dla wybranego dostawcy:
  - **Brave**: `BRAVE_API_KEY` lub `tools.web.search.apiKey`
  - **Perplexity**: `OPENROUTER_API_KEY`, `PERPLEXITY_API_KEY` lub `tools.web.search.perplexity.apiKey`

### Konfiguracja

```json5
{
  tools: {
    web: {
      search: {
        enabled: true,
        apiKey: "BRAVE_API_KEY_HERE", // optional if BRAVE_API_KEY is set
        maxResults: 5,
        timeoutSeconds: 30,
        cacheTtlMinutes: 15,
      },
    },
  },
}
```

### Parametry narzędzia

- `query` (wymagane)
- `count` (1–10; domyślnie z konfiguracji)
- `country` (opcjonalne): 2‑literowy kod kraju dla wyników regionalnych (np. „DE”, „US”, „ALL”). Jeśli pominięto, Brave wybiera region domyślny.
- `search_lang` (opcjonalne): kod języka ISO dla wyników wyszukiwania (np. „de”, „en”, „fr”)
- `ui_lang` (opcjonalne): kod języka ISO dla elementów interfejsu
- `freshness` (opcjonalne, tylko Brave): filtr według czasu wykrycia (`pd`, `pw`, `pm`, `py` lub `YYYY-MM-DDtoYYYY-MM-DD`)

**Przykłady:**

```javascript
// German-specific search
await web_search({
  query: "TV online schauen",
  count: 10,
  country: "DE",
  search_lang: "de",
});

// French search with French UI
await web_search({
  query: "actualités",
  country: "FR",
  search_lang: "fr",
  ui_lang: "fr",
});

// Recent results (past week)
await web_search({
  query: "TMBG interview",
  freshness: "pw",
});
```

## web_fetch

Pobierz URL i wyodrębnij czytelną treść.

### Wymagania web_fetch

- `tools.web.fetch.enabled` nie może być `false` (domyślnie: włączone)
- Opcjonalny fallback Firecrawl: ustaw `tools.web.fetch.firecrawl.apiKey` lub `FIRECRAWL_API_KEY`.

### Konfiguracja web_fetch

```json5
{
  tools: {
    web: {
      fetch: {
        enabled: true,
        maxChars: 50000,
        maxCharsCap: 50000,
        timeoutSeconds: 30,
        cacheTtlMinutes: 15,
        maxRedirects: 3,
        userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_7_2) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
        readability: true,
        firecrawl: {
          enabled: true,
          apiKey: "FIRECRAWL_API_KEY_HERE", // optional if FIRECRAWL_API_KEY is set
          baseUrl: "https://api.firecrawl.dev",
          onlyMainContent: true,
          maxAgeMs: 86400000, // ms (1 day)
          timeoutSeconds: 60,
        },
      },
    },
  },
}
```

### Parametry narzędzia web_fetch

- `url` (wymagane, tylko http/https)
- `extractMode` (`markdown` | `text`)
- `maxChars` (obcinanie długich stron)

Uwagi:

- `web_fetch` najpierw używa Readability (ekstrakcja głównej treści), następnie Firecrawl (jeśli skonfigurowano). Jeśli oba zawiodą, narzędzie zwraca błąd.
- Zapytania Firecrawl używają trybu omijania zabezpieczeń botów i domyślnie buforują wyniki.
- `web_fetch` wysyła domyślnie User‑Agent podobny do Chrome oraz `Accept-Language`; w razie potrzeby nadpisz `userAgent`.
- `web_fetch` blokuje prywatne/wewnętrzne nazwy hostów i ponownie sprawdza przekierowania (limit z `maxRedirects`).
- `maxChars` jest ograniczane do `tools.web.fetch.maxCharsCap`.
- `web_fetch` to ekstrakcja „best‑effort”; niektóre witryny będą wymagały narzędzia przeglądarki.
- Zobacz [Firecrawl](/tools/firecrawl) po konfigurację klucza i szczegóły usługi.
- Odpowiedzi są buforowane (domyślnie 15 minut), aby ograniczyć powtarzane pobrania.
- Jeśli używasz profili narzędzi/list dozwolonych, dodaj `web_search`/`web_fetch` lub `group:web`.
- Jeśli brakuje klucza Brave, `web_search` zwraca krótką wskazówkę konfiguracji z linkiem do dokumentacji.
