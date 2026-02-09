---
summary: "„Przycinanie sesji: przycinanie wyników narzędzi w celu ograniczenia rozrostu kontekstu”"
read_when:
  - Chcesz ograniczyć wzrost kontekstu LLM wynikający z wyjść narzędzi
  - Dostrajanie agents.defaults.contextPruning
---

# Przycinanie sesji

Przycinanie sesji usuwa **stare wyniki narzędzi** z kontekstu w pamięci tuż przed każdym wywołaniem LLM. **Nie** przepisuje historii sesji zapisanej na dysku (`*.jsonl`).

## Kiedy działa

- Gdy `mode: "cache-ttl"` jest włączone, a ostatnie wywołanie Anthropic dla sesji jest starsze niż `ttl`.
- Wpływa wyłącznie na wiadomości wysyłane do modelu dla danego żądania.
- Aktywne tylko dla wywołań API Anthropic (oraz modeli Anthropic w OpenRouter).
- Aby uzyskać najlepsze wyniki, dopasuj `ttl` do `cacheControlTtl` modelu.
- Po przycięciu okno TTL resetuje się, więc kolejne żądania zachowują cache do ponownego wygaśnięcia `ttl`.

## Inteligentne ustawienia domyślne (Anthropic)

- Profile **OAuth lub setup-token**: włącz przycinanie `cache-ttl` i ustaw heartbeat na `1h`.
- Profile **klucza API**: włącz przycinanie `cache-ttl`, ustaw heartbeat na `30m` oraz domyślnie `cacheControlTtl` na `1h` dla modeli Anthropic.
- Jeśli ustawisz którąkolwiek z tych wartości jawnie, OpenClaw **nie** nadpisze ich.

## Co to poprawia (koszt + zachowanie cache)

- **Dlaczego przycinać:** cache’owanie promptów Anthropic obowiązuje tylko w obrębie TTL. Jeśli sesja pozostaje bezczynna dłużej niż TTL, następne żądanie ponownie cache’uje pełny prompt, o ile nie zostanie on wcześniej przycięty.
- **Co tanieje:** przycinanie zmniejsza rozmiar **cacheWrite** dla pierwszego żądania po wygaśnięciu TTL.
- **Dlaczego reset TTL ma znaczenie:** po uruchomieniu przycinania okno cache resetuje się, więc kolejne żądania mogą ponownie użyć świeżo zcache’owanego promptu zamiast ponownie cache’ować pełną historię.
- **Czego to nie robi:** przycinanie nie dodaje tokenów ani nie „podwaja” kosztów; zmienia jedynie to, co trafia do cache przy pierwszym żądaniu po TTL.

## Co może zostać przycięte

- Tylko wiadomości `toolResult`.
- Wiadomości użytkownika i asystenta **nigdy** nie są modyfikowane.
- Ostatnie `keepLastAssistants` wiadomości asystenta są chronione; wyniki narzędzi po tym progu nie są przycinane.
- Jeśli nie ma wystarczającej liczby wiadomości asystenta, aby ustalić próg, przycinanie jest pomijane.
- Wyniki narzędzi zawierające **bloki obrazów** są pomijane (nigdy nie są przycinane/czyszczone).

## Szacowanie okna kontekstu

Przycinanie używa szacowanego okna kontekstu (znaki ≈ tokeny × 4). Bazowe okno jest ustalane w następującej kolejności:

1. Nadpisanie `models.providers.*.models[].contextWindow`.
2. Definicja modelu `contextWindow` (z rejestru modeli).
3. Domyślne `200000` tokenów.

Jeśli ustawiono `agents.defaults.contextTokens`, jest ono traktowane jako limit (minimum) dla ustalonego okna.

## Tryb

### cache-ttl

- Przycinanie uruchamia się tylko wtedy, gdy ostatnie wywołanie Anthropic jest starsze niż `ttl` (domyślnie `5m`).
- Gdy działa: to samo zachowanie miękkiego przycięcia + twardego czyszczenia co wcześniej.

## Miękkie vs twarde przycinanie

- **Miękkie przycięcie**: tylko dla zbyt dużych wyników narzędzi.
  - Zachowuje początek i koniec, wstawia `...` oraz dołącza notatkę z oryginalnym rozmiarem.
  - Pomija wyniki z blokami obrazów.
- **Twarde czyszczenie**: zastępuje cały wynik narzędzia `hardClear.placeholder`.

## Wybór narzędzi

- `tools.allow` / `tools.deny` obsługują symbole wieloznaczne `*`.
- Odmów wygranej.
- Dopasowanie jest niewrażliwe na wielkość liter.
- Pusta lista dozwolonych ⇒ wszystkie narzędzia dozwolone.

## Interakcja z innymi limitami

- Wbudowane narzędzia już przycinają własne wyjścia; przycinanie sesji to dodatkowa warstwa zapobiegająca gromadzeniu nadmiernej ilości wyjść narzędzi w kontekście modelu podczas długich rozmów.
- Kompaktowanie jest odrębne: kompaktowanie streszcza i utrwala, przycinanie jest tymczasowe na żądanie. Zobacz [/concepts/compaction](/concepts/compaction).

## Ustawienia domyślne (gdy włączone)

- `ttl`: `"5m"`
- `keepLastAssistants`: `3`
- `softTrimRatio`: `0.3`
- `hardClearRatio`: `0.5`
- `minPrunableToolChars`: `50000`
- `softTrim`: `{ maxChars: 4000, headChars: 1500, tailChars: 1500 }`
- `hardClear`: `{ enabled: true, placeholder: "[Old tool result content cleared]" }`

## Przykłady

Domyślnie (wyłączone):

```json5
{
  agent: {
    contextPruning: { mode: "off" },
  },
}
```

Włącz przycinanie zależne od TTL:

```json5
{
  agent: {
    contextPruning: { mode: "cache-ttl", ttl: "5m" },
  },
}
```

Ogranicz przycinanie do określonych narzędzi:

```json5
{
  agent: {
    contextPruning: {
      mode: "cache-ttl",
      tools: { allow: ["exec", "read"], deny: ["*image*"] },
    },
  },
}
```

Zobacz referencję konfiguracji: [Gateway Configuration](/gateway/configuration)
