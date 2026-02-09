---
summary: "Korzystaj z modeli Venice AI ukierunkowanych na prywatność w OpenClaw"
read_when:
  - Chcesz wnioskowania ukierunkowanego na prywatność w OpenClaw
  - Chcesz wskazówek konfiguracji Venice AI
title: "Venice AI"
---

# Venice AI (wyróżnienie Venice)

**Venice** to nasze wyróżnione wdrożenie Venice do wnioskowania „privacy-first” z opcjonalnym, zanonimizowanym dostępem do modeli własnościowych.

Venice AI zapewnia wnioskowanie AI ukierunkowane na prywatność, ze wsparciem dla modeli bez cenzury oraz dostępem do głównych modeli własnościowych poprzez ich zanonimizowany proxy. Całe wnioskowanie jest domyślnie prywatne — brak trenowania na Twoich danych, brak logowania.

## Dlaczego Venice w OpenClaw

- **Prywatne wnioskowanie** dla modeli open-source (bez logowania).
- **Modele bez cenzury**, gdy są potrzebne.
- **Zanonimizowany dostęp** do modeli własnościowych (Opus/GPT/Gemini), gdy liczy się jakość.
- Punkty końcowe **zgodne z OpenAI** `/v1`.

## Tryby prywatności

Venice oferuje dwa poziomy prywatności — ich zrozumienie jest kluczowe przy wyborze modelu:

| Tryb               | Opis                                                                                                                                                                    | Modele                                                        |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| **Prywatny**       | W pełni prywatny. Prompty/odpowiedzi **nigdy nie są przechowywane ani logowane**. Efemeryczne.                          | Llama, Qwen, DeepSeek, Venice Uncensored itp. |
| **Zanonimizowany** | Przekazywany przez Venice z usuniętymi metadanymi. Dostawca bazowy (OpenAI, Anthropic) widzi zanonimizowane żądania. | Claude, GPT, Gemini, Grok, Kimi, MiniMax                      |

## Funkcje

- **Ukierunkowanie na prywatność**: wybór między trybami „private” (w pełni prywatny) i „anonymized” (przez proxy)
- **Modele bez cenzury**: dostęp do modeli bez ograniczeń treści
- **Dostęp do głównych modeli**: używaj Claude, GPT-5.2, Gemini, Grok przez zanonimizowany proxy Venice
- **API zgodne z OpenAI**: standardowe punkty końcowe `/v1` dla łatwej integracji
- **Strumieniowanie**: ✅ obsługiwane dla wszystkich modeli
- **Wywoływanie funkcji**: ✅ obsługiwane w wybranych modelach (sprawdź możliwości modelu)
- **Wizja**: ✅ obsługiwana w modelach z funkcją wizji
- **Brak twardych limitów szybkości**: przy skrajnym użyciu może obowiązywać dławienie fair‑use

## Konfiguracja

### 1. Uzyskaj klucz API

1. Zarejestruj się na [venice.ai](https://venice.ai)
2. Przejdź do **Settings → API Keys → Create new key**
3. Skopiuj klucz API (format: `vapi_xxxxxxxxxxxx`)

### 2) Skonfiguruj OpenClaw

**Opcja A: Zmienna środowiskowa**

```bash
export VENICE_API_KEY="vapi_xxxxxxxxxxxx"
```

**Opcja B: Konfiguracja interaktywna (zalecane)**

```bash
openclaw onboard --auth-choice venice-api-key
```

Spowoduje to:

1. Monit o klucz API (lub użycie istniejącego `VENICE_API_KEY`)
2. Wyświetlenie wszystkich dostępnych modeli Venice
3. Wybór domyślnego modelu
4. Automatyczną konfigurację dostawcy

**Opcja C: Nieinterakcyjna**

```bash
openclaw onboard --non-interactive \
  --auth-choice venice-api-key \
  --venice-api-key "vapi_xxxxxxxxxxxx"
```

### 3. Zweryfikuj konfigurację

```bash
openclaw chat --model venice/llama-3.3-70b "Hello, are you working?"
```

## Wybór modelu

Po konfiguracji OpenClaw pokazuje wszystkie dostępne modele Venice. Wybierz zgodnie z potrzebami:

- **Domyślny (nasz wybór)**: `venice/llama-3.3-70b` — prywatny, zrównoważona wydajność.
- **Najlepsza ogólna jakość**: `venice/claude-opus-45` — do trudnych zadań (Opus pozostaje najsilniejszy).
- **Prywatność**: wybieraj modele „private” dla w pełni prywatnego wnioskowania.
- **Możliwości**: wybieraj modele „anonymized”, aby uzyskać dostęp do Claude, GPT, Gemini przez proxy Venice.

Zmieniaj domyślny model w dowolnym momencie:

```bash
openclaw models set venice/claude-opus-45
openclaw models set venice/llama-3.3-70b
```

Wyświetl wszystkie dostępne modele:

```bash
openclaw models list | grep venice
```

## Konfiguracja przez `openclaw configure`

1. Uruchom `openclaw configure`
2. Wybierz **Model/auth**
3. Wybierz **Venice AI**

## Który model wybrać?

| Przypadek użycia               | Rekomendowany model              | Dlaczego                                          |
| ------------------------------ | -------------------------------- | ------------------------------------------------- |
| **Czat ogólny**                | `llama-3.3-70b`                  | Dobry do wszystkiego, w pełni prywatny            |
| **Najlepsza ogólna jakość**    | `claude-opus-45`                 | Opus pozostaje najsilniejszy do trudnych zadań    |
| **Prywatność + jakość Claude** | `claude-opus-45`                 | Najlepsze wnioskowanie przez zanonimizowany proxy |
| **Programowanie**              | `qwen3-coder-480b-a35b-instruct` | Zoptymalizowany pod kod, kontekst 262k            |
| **Zadania wizji**              | `qwen3-vl-235b-a22b`             | Najlepszy prywatny model wizji                    |
| **Bez cenzury**                | `venice-uncensored`              | Brak ograniczeń treści                            |
| **Szybki + tani**              | `qwen3-4b`                       | Lekki, nadal wydajny                              |
| **Złożone wnioskowanie**       | `deepseek-v3.2`                  | Silne wnioskowanie, prywatny                      |

## Dostępne modele (łącznie 25)

### Modele prywatne (15) — W pełni prywatne, bez logowania

| ID modelu                        | Nazwa                                      | Kontekst (tokeny) | Funkcje                     |
| -------------------------------- | ------------------------------------------ | ------------------------------------ | --------------------------- |
| `llama-3.3-70b`                  | Llama 3.3 70B              | 131k                                 | Ogólne                      |
| `llama-3.2-3b`                   | Llama 3.2 3B               | 131k                                 | Szybki, lekki               |
| `hermes-3-llama-3.1-405b`        | Hermes 3 Llama 3.1 405B    | 131k                                 | Złożone zadania             |
| `qwen3-235b-a22b-thinking-2507`  | Qwen3 235B Thinking                        | 131k                                 | Rozumowanie                 |
| `qwen3-235b-a22b-instruct-2507`  | Qwen3 235B Instruct                        | 131k                                 | Ogólne                      |
| `qwen3-coder-480b-a35b-instruct` | Qwen3 Coder 480B                           | 262k                                 | Kod                         |
| `qwen3-next-80b`                 | Qwen3 Next 80B                             | 262k                                 | Ogólne                      |
| `qwen3-vl-235b-a22b`             | Qwen3 VL 235B                              | 262k                                 | Wizja                       |
| `qwen3-4b`                       | Venice Small (Qwen3 4B) | 32k                                  | Szybkie rozumowanie         |
| `deepseek-v3.2`                  | DeepSeek V3.2              | 163k                                 | Rozumowanie                 |
| `venice-uncensored`              | Venice Uncensored                          | 32k                                  | Niecenzurowane              |
| `mistral-31-24b`                 | Venice Medium (Mistral) | 131k                                 | Wizja                       |
| `google-gemma-3-27b-it`          | Gemma 3 27B Instruct                       | 202k                                 | Wizja                       |
| `openai-gpt-oss-120b`            | OpenAI GPT OSS 120B                        | 131k                                 | Ogólne                      |
| `zai-org-glm-4.7`                | GLM 4.7                    | 202k                                 | Wnioskowanie, wielojęzyczne |

### Modele zanonimizowane (10) — przez proxy Venice

| ID modelu                | Oryginał                          | Kontekst (tokeny) | Funkcje             |
| ------------------------ | --------------------------------- | ------------------------------------ | ------------------- |
| `claude-opus-45`         | Claude Opus 4.5   | 202k                                 | Wnioskowanie, wizja |
| `claude-sonnet-45`       | Claude Sonnet 4.5 | 202k                                 | Wnioskowanie, wizja |
| `openai-gpt-52`          | GPT-5.2           | 262k                                 | Rozumowanie         |
| `openai-gpt-52-codex`    | GPT-5.2 Codex     | 262k                                 | Wnioskowanie, wizja |
| `gemini-3-pro-preview`   | Gemini 3 Pro                      | 202k                                 | Wnioskowanie, wizja |
| `gemini-3-flash-preview` | Gemini 3 Flash                    | 262k                                 | Wnioskowanie, wizja |
| `grok-41-fast`           | Grok 4.1 Fast     | 262k                                 | Wnioskowanie, wizja |
| `grok-code-fast-1`       | Grok Code Fast 1                  | 262k                                 | Wnioskowanie, kod   |
| `kimi-k2-thinking`       | Kimi K2 Thinking                  | 262k                                 | Rozumowanie         |
| `minimax-m21`            | MiniMax M2.1      | 202k                                 | Rozumowanie         |

## Wykrywanie modeli

OpenClaw automatycznie wykrywa modele z API Venice, gdy ustawione jest `VENICE_API_KEY`. Jeśli API jest niedostępne, następuje powrót do statycznego katalogu.

Punkt końcowy `/models` jest publiczny (lista bez uwierzytelniania), ale wnioskowanie wymaga ważnego klucza API.

## Strumieniowanie i wsparcie narzędzi

| Funkcja                 | Wsparcie                                                                        |
| ----------------------- | ------------------------------------------------------------------------------- |
| **Strumieniowanie**     | ✅ Wszystkie modele                                                              |
| **Wywoływanie funkcji** | ✅ Większość modeli (sprawdź `supportsFunctionCalling` w API) |
| **Wizja/obrazy**        | ✅ Modele oznaczone funkcją „Vision”                                             |
| **Tryb JSON**           | ✅ Obsługiwany przez `response_format`                                           |

## Cennik

Venice korzysta z systemu opartego na kredytach. Aktualne stawki znajdziesz na [venice.ai/pricing](https://venice.ai/pricing):

- **Modele prywatne**: zwykle niższy koszt
- **Modele zanonimizowane**: zbliżone do bezpośrednich cen API + niewielka opłata Venice

## Porównanie: Venice vs bezpośrednie API

| Aspekt          | Venice (zanonimizowane) | Bezpośrednie API  |
| --------------- | ------------------------------------------ | ----------------- |
| **Prywatność**  | Metadane usunięte, anonimizacja            | Konto powiązane   |
| **Opóźnienie**  | +10–50 ms (proxy)       | Bezpośrednie      |
| **Funkcje**     | Większość funkcji obsługiwana              | Pełne funkcje     |
| **Rozliczenia** | Kredyty Venice                             | Rachunek dostawcy |

## Przykłady użycia

```bash
# Use default private model
openclaw chat --model venice/llama-3.3-70b

# Use Claude via Venice (anonymized)
openclaw chat --model venice/claude-opus-45

# Use uncensored model
openclaw chat --model venice/venice-uncensored

# Use vision model with image
openclaw chat --model venice/qwen3-vl-235b-a22b

# Use coding model
openclaw chat --model venice/qwen3-coder-480b-a35b-instruct
```

## Rozwiązywanie problemów

### Klucz API nie jest rozpoznawany

```bash
echo $VENICE_API_KEY
openclaw models list | grep venice
```

Upewnij się, że klucz zaczyna się od `vapi_`.

### Model niedostępny

Katalog modeli Venice aktualizuje się dynamicznie. Uruchom `openclaw models list`, aby zobaczyć aktualnie dostępne modele. Niektóre modele mogą być tymczasowo offline.

### Problemy z połączeniem

API Venice znajduje się pod adresem `https://api.venice.ai/api/v1`. Upewnij się, że Twoja sieć zezwala na połączenia HTTPS.

## Przykład pliku konfiguracyjnego

```json5
{
  env: { VENICE_API_KEY: "vapi_..." },
  agents: { defaults: { model: { primary: "venice/llama-3.3-70b" } } },
  models: {
    mode: "merge",
    providers: {
      venice: {
        baseUrl: "https://api.venice.ai/api/v1",
        apiKey: "${VENICE_API_KEY}",
        api: "openai-completions",
        models: [
          {
            id: "llama-3.3-70b",
            name: "Llama 3.3 70B",
            reasoning: false,
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 131072,
            maxTokens: 8192,
          },
        ],
      },
    },
  },
}
```

## Linki

- [Venice AI](https://venice.ai)
- [Dokumentacja API](https://docs.venice.ai)
- [Cennik](https://venice.ai/pricing)
- [Status](https://status.venice.ai)
