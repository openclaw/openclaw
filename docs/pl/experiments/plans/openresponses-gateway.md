---
summary: "Plan: Dodanie punktu końcowego OpenResponses /v1/responses i czyste wycofanie chat completions"
owner: "openclaw"
status: "draft"
last_updated: "2026-01-19"
title: "Plan Gateway OpenResponses"
---

# Plan integracji Gateway OpenResponses

## Kontekst

Gateway OpenClaw obecnie udostępnia minimalny punkt końcowy Chat Completions zgodny z OpenAI pod adresem
`/v1/chat/completions` (zob. [OpenAI Chat Completions](/gateway/openai-http-api)).

Open Responses to otwarty standard inferencji oparty na API OpenAI Responses. Został zaprojektowany
z myślą o przepływach pracy agentowych i wykorzystuje wejścia oparte na elementach oraz semantyczne
zdarzenia strumieniowe. Specyfikacja OpenResponses definiuje `/v1/responses`, a nie `/v1/chat/completions`.

## Cele

- Dodać punkt końcowy `/v1/responses`, który jest zgodny z semantyką OpenResponses.
- Zachować Chat Completions jako warstwę kompatybilności, którą łatwo wyłączyć i ostatecznie usunąć.
- Standaryzować walidację i analizowanie z izolowanymi schematami wielokrotnego użytku.

## Inne cele

- Pełna zgodność funkcjonalna z OpenResponses w pierwszym etapie (obrazy, pliki, narzędzia hostowane).
- Zastępowanie wewnętrznej logiki wykonywania agentów lub orkiestracji narzędzi.
- Zmiana istniejącego zachowania `/v1/chat/completions` w pierwszej fazie.

## Podsumowanie badań

Źródła: OpenAPI OpenResponses, strona specyfikacji OpenResponses oraz wpis na blogu Hugging Face.

Wyodrębniono kluczowe punkty:

- `POST /v1/responses` akceptuje pola `CreateResponseBody` takie jak `model`, `input` (ciąg znaków lub
  `ItemParam[]`), `instructions`, `tools`, `tool_choice`, `stream`, `max_output_tokens` oraz
  `max_tool_calls`.
- `ItemParam` jest sumą rozłączną (discriminated union) obejmującą:
  - elementy `message` z rolami `system`, `developer`, `user`, `assistant`
  - `function_call` oraz `function_call_output`
  - `reasoning`
  - `item_reference`
- Pomyślne odpowiedzi zwracają `ResponseResource` z elementami `object: "response"`, `status` oraz
  `output`.
- Strumieniowanie wykorzystuje zdarzenia semantyczne takie jak:
  - `response.created`, `response.in_progress`, `response.completed`, `response.failed`
  - `response.output_item.added`, `response.output_item.done`
  - `response.content_part.added`, `response.content_part.done`
  - `response.output_text.delta`, `response.output_text.done`
- Specyfikacja wymaga:
  - `Content-Type: text/event-stream`
  - `event:` musi odpowiadać polu JSON `type`
  - zdarzenie końcowe musi być literałem `[DONE]`
- Elementy rozumowania mogą ujawniać `content`, `encrypted_content` oraz `summary`.
- Przykłady HF zawierają `OpenResponses-Version: latest` w żądaniach (opcjonalny nagłówek).

## Proponowana architektura

- Dodać `src/gateway/open-responses.schema.ts` zawierający wyłącznie schematy Zod (bez importów gateway).
- Dodać `src/gateway/openresponses-http.ts` (lub `open-responses-http.ts`) dla `/v1/responses`.
- Zachować `src/gateway/openai-http.ts` bez zmian jako adapter kompatybilności wstecznej.
- Dodać konfigurację `gateway.http.endpoints.responses.enabled` (domyślnie `false`).
- Zachować niezależność `gateway.http.endpoints.chatCompletions.enabled`; umożliwić osobne
  przełączanie obu punktów końcowych.
- Emitować ostrzeżenie przy starcie, gdy Chat Completions jest włączone, aby zasygnalizować status legacy.

## Ścieżka wycofywania Chat Completions

- Utrzymać ścisłe granice modułów: brak współdzielonych typów schematów między responses a chat completions.
- Uczynić Chat Completions opcją konfiguracyjną (opt-in), aby można je było wyłączyć bez zmian w kodzie.
- Zaktualizować dokumentację, aby oznaczyć Chat Completions jako legacy, gdy `/v1/responses` będzie stabilne.
- Opcjonalny przyszły krok: mapowanie żądań Chat Completions na obsługę Responses w celu uproszczenia
  ścieżki usuwania.

## Faza 1 Podzestaw wsparcia

- Akceptować `input` jako ciąg znaków lub `ItemParam[]` z rolami wiadomości oraz `function_call_output`.
- Wyodrębniać wiadomości systemowe i deweloperskie do `extraSystemPrompt`.
- Wykorzystywać najnowsze `user` lub `function_call_output` jako bieżącą wiadomość dla uruchomień agentów.
- Odrzucać nieobsługiwane części treści (obraz/plik) z `invalid_request_error`.
- Zwracać pojedynczą wiadomość asystenta z treścią `output_text`.
- Zwracać `usage` z wyzerowanymi wartościami do czasu podłączenia rozliczania tokenów.

## Strategia walidacji (bez SDK)

- Zaimplementować schematy Zod dla obsługiwanego podzbioru:
  - `CreateResponseBody`
  - `ItemParam` + unie części treści wiadomości
  - `ResponseResource`
  - Kształty zdarzeń strumieniowych używane przez gateway
- Przechowywać schematy w jednym, odizolowanym module, aby uniknąć dryfu i umożliwić przyszłe generowanie kodu.

## Implementacja strumieniowania (faza 1)

- Linie SSE z `event:` oraz `data:`.
- Wymagana sekwencja (minimum wykonalne):
  - `response.created`
  - `response.output_item.added`
  - `response.content_part.added`
  - `response.output_text.delta` (powtarzać w razie potrzeby)
  - `response.output_text.done`
  - `response.content_part.done`
  - `response.completed`
  - `[DONE]`

## Testy i plan weryfikacji

- Dodać pokrycie e2e dla `/v1/responses`:
  - Wymagane uwierzytelnianie
  - Kształt odpowiedzi niestrumieniowanej
  - Kolejność zdarzeń strumienia i `[DONE]`
  - Trasowanie sesji z nagłówkami i `user`
- Zachować `src/gateway/openai-http.e2e.test.ts` bez zmian.
- Ręcznie: curl do `/v1/responses` z `stream: true` i zweryfikować kolejność zdarzeń oraz końcowe
  `[DONE]`.

## Aktualizacje dokumentacji (kolejny etap)

- Dodać nową stronę dokumentacji dla użycia i przykładów `/v1/responses`.
- Zaktualizować `/gateway/openai-http-api` o adnotację legacy i odnośnik do `/v1/responses`.
