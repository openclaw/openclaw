---
summary: "Audyt tego, co może generować koszty, jakie klucze są używane oraz jak przeglądać użycie"
read_when:
  - Chcesz zrozumieć, które funkcje mogą wywoływać płatne API
  - Musisz przeprowadzić audyt kluczy, kosztów i widoczności użycia
  - Wyjaśniasz raportowanie kosztów w /status lub /usage
title: "Użycie API i koszty"
---

# Użycie API i koszty

Ten dokument wymienia **funkcje, które mogą wywoływać klucze API**, oraz miejsca, w których pojawiają się ich koszty. Skupia się na
funkcjach OpenClaw, które mogą generować użycie po stronie dostawców lub płatne wywołania API.

## Gdzie pojawiają się koszty (chat + CLI)

**Migawka kosztów na sesję**

- `/status` pokazuje bieżący model sesji, użycie kontekstu oraz tokeny ostatniej odpowiedzi.
- Jeśli model używa **uwierzytelniania kluczem API**, `/status` pokazuje także **szacowany koszt** ostatniej odpowiedzi.

**Stopka kosztów na wiadomość**

- `/usage full` dołącza stopkę użycia do każdej odpowiedzi, w tym **szacowany koszt** (tylko klucz API).
- `/usage tokens` pokazuje wyłącznie tokeny; przepływy OAuth ukrywają koszt w dolarach.

**Okna użycia w CLI (limity dostawców)**

- `openclaw status --usage` oraz `openclaw channels list` pokazują **okna użycia** dostawcy
  (migawki limitów, a nie koszty per wiadomość).

Zobacz [Użycie tokenów i koszty](/reference/token-use), aby poznać szczegóły i przykłady.

## Jak wykrywane są klucze

OpenClaw może pobierać poświadczenia z:

- **Profilów uwierzytelniania** (per-agent, przechowywane w `auth-profiles.json`).
- **Zmiennych środowiskowych** (np. `OPENAI_API_KEY`, `BRAVE_API_KEY`, `FIRECRAWL_API_KEY`).
- **Konfiguracji** (`models.providers.*.apiKey`, `tools.web.search.*`, `tools.web.fetch.firecrawl.*`,
  `memorySearch.*`, `talk.apiKey`).
- **Skills** (`skills.entries.<name>.apiKey`), które mogą eksportować klucze do środowiska procesu skill.

## Funkcje, które mogą generować koszty kluczy

### 1. Odpowiedzi rdzeniowego modelu (chat + narzędzia)

Każda odpowiedź lub wywołanie narzędzia używa **bieżącego dostawcy modelu** (OpenAI, Anthropic itd.). Jest to
główne źródło użycia i kosztów.

Zobacz [Modele](/providers/models) w zakresie konfiguracji cen oraz [Użycie tokenów i koszty](/reference/token-use) w zakresie prezentacji.

### 2. Rozumienie multimediów (audio/obraz/wideo)

Media wejściowe mogą zostać podsumowane lub przetranskrybowane przed wygenerowaniem odpowiedzi. Wykorzystuje to API modeli/dostawców.

- Audio: OpenAI / Groq / Deepgram (obecnie **włączone automatycznie**, gdy istnieją klucze).
- Obraz: OpenAI / Anthropic / Google.
- Wideo: Google.

Zobacz [Rozumienie multimediów](/nodes/media-understanding).

### 3. Osadzania pamięci + wyszukiwanie semantyczne

Semantyczne wyszukiwanie pamięci używa **API osadzeń**, gdy jest skonfigurowane dla zdalnych dostawców:

- `memorySearch.provider = "openai"` → osadzenia OpenAI
- `memorySearch.provider = "gemini"` → osadzenia Gemini
- `memorySearch.provider = "voyage"` → osadzenia Voyage
- Opcjonalny fallback do zdalnego dostawcy, jeśli lokalne osadzenia zawiodą

Możesz pozostać lokalnie, używając `memorySearch.provider = "local"` (brak użycia API).

Zobacz [Pamięć](/concepts/memory).

### 4. Narzędzie wyszukiwania w sieci (Brave / Perplexity przez OpenRouter)

`web_search` używa kluczy API i może generować opłaty za użycie:

- **Brave Search API**: `BRAVE_API_KEY` lub `tools.web.search.apiKey`
- **Perplexity** (przez OpenRouter): `PERPLEXITY_API_KEY` lub `OPENROUTER_API_KEY`

**Odzyskaj wolny poziom (hojny):**

- **2 000 zapytań/miesiąc**
- **1 zapytanie/sekundę**
- **Wymagana karta kredytowa** do weryfikacji (brak opłat, chyba że dokonasz aktualizacji)

Zobacz [Narzędzia webowe](/tools/web).

### 5. Narzędzie pobierania stron (Firecrawl)

`web_fetch` może wywoływać **Firecrawl**, gdy obecny jest klucz API:

- `FIRECRAWL_API_KEY` lub `tools.web.fetch.firecrawl.apiKey`

Jeśli Firecrawl nie jest skonfigurowany, narzędzie przełącza się na bezpośrednie pobieranie + readability (bez płatnego API).

Zobacz [Narzędzia webowe](/tools/web).

### 6. Migawki użycia dostawców (status/zdrowie)

Niektóre polecenia statusu wywołują **endpointy użycia dostawców**, aby wyświetlić okna limitów lub stan uwierzytelniania.
Zazwyczaj są to wywołania o niskim wolumenie, ale nadal trafiają w API dostawców:

- `openclaw status --usage`
- `openclaw models status --json`

Zobacz [CLI modeli](/cli/models).

### 7. Zabezpieczenie kompakcji — podsumowanie

Zabezpieczenie kompakcji może podsumowywać historię sesji przy użyciu **bieżącego modelu**, co
powoduje wywołania API dostawcy, gdy mechanizm się uruchomi.

Zobacz [Zarządzanie sesją + kompakcja](/reference/session-management-compaction).

### 8. Skanowanie / sondowanie modeli

`openclaw models scan` może sondować modele OpenRouter i używa `OPENROUTER_API_KEY`, gdy
sondowanie jest włączone.

Zobacz [CLI modeli](/cli/models).

### 9. Talk (mowa)

Tryb Talk może wywoływać **ElevenLabs**, gdy jest skonfigurowany:

- `ELEVENLABS_API_KEY` lub `talk.apiKey`

Zobacz [Tryb Talk](/nodes/talk).

### 10. Skills (API firm trzecich)

Skills mogą przechowywać `apiKey` w `skills.entries.<name>.apiKey`. Jeśli skill używa tego klucza do zewnętrznych
API, może generować koszty zgodnie z zasadami dostawcy danego skill.

Zobacz [Skills](/tools/skills).
