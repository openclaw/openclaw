---
summary: "Referencja: specyficzne dla dostawców zasady sanityzacji i naprawy transkryptów"
read_when:
  - Debugujesz odrzucenia żądań przez dostawców powiązane z kształtem transkryptu
  - Zmieniasz logikę sanityzacji transkryptów lub naprawy wywołań narzędzi
  - Badasz niezgodności identyfikatorów wywołań narzędzi między dostawcami
title: "Higiena transkryptu"
---

# Higiena transkryptu (poprawki specyficzne dla dostawców)

Ten dokument opisuje **poprawki specyficzne dla dostawców** stosowane do transkryptów przed uruchomieniem
(budowaniem kontekstu modelu). Są to korekty **w pamięci**, używane w celu spełnienia rygorystycznych
wymagań dostawców. Te kroki higieny **nie** przepisują zapisanego na dysku transkryptu JSONL; jednak
oddzielny etap naprawy pliku sesji może przepisać wadliwe pliki JSONL, usuwając nieprawidłowe linie
przed załadowaniem sesji. Gdy dochodzi do naprawy, oryginalny plik jest archiwizowany obok pliku sesji.

Zakres obejmuje:

- Sanityzację identyfikatorów wywołań narzędzi
- Sprawdzanie poprawności danych wejściowych
- Naprawę parowania wyników narzędzi
- Włącz sprawdzanie / zamawianie
- Czyszczenie sygnatur myśli
- Sanityzację ładunków obrazów

Jeśli potrzebujesz szczegółów dotyczących przechowywania transkryptów, zobacz:

- [/reference/session-management-compaction](/reference/session-management-compaction)

---

## Gdzie to działa

Cała higiena transkryptu jest scentralizowana w osadzonym runnerze:

- Wybór polityki: `src/agents/transcript-policy.ts`
- Zastosowanie sanityzacji/napraw: `sanitizeSessionHistory` w `src/agents/pi-embedded-runner/google.ts`

Polityka używa `provider`, `modelApi` oraz `modelId`, aby zdecydować, co zastosować.

Niezależnie od higieny transkryptu, pliki sesji są naprawiane (jeśli to konieczne) przed załadowaniem:

- `repairSessionFileIfNeeded` w `src/agents/session-file-repair.ts`
- Wywoływane z `run/attempt.ts` oraz `compact.ts` (osadzony runner)

---

## Reguła globalna: sanityzacja obrazów

Ładunki obrazów są zawsze sanityzowane, aby zapobiec odrzuceniu po stronie dostawcy z powodu limitów
rozmiaru (skalowanie w dół/ponowna kompresja zbyt dużych obrazów base64).

Implementacja:

- `sanitizeSessionMessagesImages` w `src/agents/pi-embedded-helpers/images.ts`
- `sanitizeContentBlocksImages` w `src/agents/tool-images.ts`

---

## Reguła globalna: wadliwe wywołania narzędzi

Bloki wywołań narzędzi asystenta, którym brakuje jednocześnie `input` i `arguments`, są
usuwane przed zbudowaniem kontekstu modelu. Zapobiega to odrzuceniom przez dostawców wynikającym z
częściowo utrwalonych wywołań narzędzi (na przykład po awarii związanej z limitem szybkości).

Implementacja:

- `sanitizeToolCallInputs` w `src/agents/session-transcript-repair.ts`
- Stosowane w `sanitizeSessionHistory` w `src/agents/pi-embedded-runner/google.ts`

---

## Macierz dostawców (aktualne zachowanie)

**OpenAI / OpenAI Codex**

- Tylko sanityzacja obrazów.
- Przy przełączeniu modelu na OpenAI Responses/Codex: usuwanie osieroconych sygnatur rozumowania (samodzielne elementy rozumowania bez następującego bloku treści).
- Brak sanityzacji identyfikatorów wywołań narzędzi.
- Brak naprawy parowania wyników narzędzi.
- Brak walidacji lub zmiany kolejności tur.
- Brak syntetycznych wyników narzędzi.
- Brak usuwania sygnatur myśli.

**Google (Generative AI / Gemini CLI / Antigravity)**

- Sanityzacja identyfikatorów wywołań narzędzi: ścisła alfanumeryczna.
- Naprawa parowania wyników narzędzi oraz syntetyczne wyniki narzędzi.
- Walidacja tur (naprzemienność tur w stylu Gemini).
- Poprawka kolejności tur Google (dodanie na początku minimalnego bootstrapu użytkownika, jeśli historia zaczyna się od asystenta).
- Antigravity Claude: normalizacja sygnatur myślenia; usuwanie niepodpisanych bloków myślenia.

**Anthropic / Minimax (zgodne z Anthropic)**

- Naprawa parowania wyników narzędzi oraz syntetyczne wyniki narzędzi.
- Walidacja tur (łączenie kolejnych tur użytkownika w celu spełnienia ścisłej naprzemienności).

**Mistral (w tym wykrywanie oparte na identyfikatorze modelu)**

- Sanityzacja identyfikatorów wywołań narzędzi: strict9 (alfanumeryczna długości 9).

**OpenRouter Gemini**

- Czyszczenie sygnatur myśli: usuwanie wartości `thought_signature` innych niż base64 (zachowanie base64).

**Wszystko pozostałe**

- Tylko sanityzacja obrazów.

---

## Zachowanie historyczne (przed 2026.1.22)

Przed wydaniem 2026.1.22 OpenClaw stosował wiele warstw higieny transkryptu:

- **Rozszerzenie transcript-sanitize** uruchamiało się przy każdym budowaniu kontekstu i mogło:
  - Naprawiać parowanie użycia narzędzi z wynikami.
  - Sanityzować identyfikatory wywołań narzędzi (w tym tryb niestriktny, który zachowywał `_`/`-`).
- Runner również wykonywał sanityzację specyficzną dla dostawców, co dublowało pracę.
- Dodatkowe mutacje zachodziły poza polityką dostawcy, w tym:
  - Usuwanie tagów `<final>` z tekstu asystenta przed utrwaleniem.
  - Usuwanie pustych tur błędów asystenta.
  - Przycinanie treści asystenta po wywołaniach narzędzi.

Ta złożoność powodowała regresje między dostawcami (w szczególności parowanie
`openai-responses` / `call_id|fc_id`). Porządki z 2026.1.22 usunęły rozszerzenie, scentralizowały
logikę w runnerze i uczyniły OpenAI **bez ingerencji** poza sanityzacją obrazów.
