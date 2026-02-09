---
summary: "Udostępnij zgodny z OpenResponses punkt końcowy HTTP /v1/responses z Gateway"
read_when:
  - Integrujesz klientów mówiących w API OpenResponses
  - Chcesz używać wejść opartych na elementach, wywołań narzędzi po stronie klienta lub zdarzeń SSE
title: "API OpenResponses"
---

# API OpenResponses (HTTP)

Gateway OpenClaw może udostępniać zgodny z OpenResponses punkt końcowy `POST /v1/responses`.

Ten punkt końcowy jest **domyślnie wyłączony**. Najpierw włącz go w konfiguracji.

- `POST /v1/responses`
- Ten sam port co Gateway (multipleksowanie WS + HTTP): `http://<gateway-host>:<port>/v1/responses`

Pod maską żądania są wykonywane jak zwykłe uruchomienie agenta Gateway (ta sama ścieżka kodu co
`openclaw agent`), więc routowanie/uprawnienia/konfiguracja są zgodne z Twoim Gateway.

## Uwierzytelnianie

Korzysta z konfiguracji uwierzytelniania Gateway. Wyślij token bearer:

- `Authorization: Bearer <token>`

Uwagi:

- Gdy `gateway.auth.mode="token"`, użyj `gateway.auth.token` (lub `OPENCLAW_GATEWAY_TOKEN`).
- Gdy `gateway.auth.mode="password"`, użyj `gateway.auth.password` (lub `OPENCLAW_GATEWAY_PASSWORD`).

## Wybór agenta

Nie są wymagane niestandardowe nagłówki: zakoduj identyfikator agenta w polu OpenResponses `model`:

- `model: "openclaw:<agentId>"` (przykład: `"openclaw:main"`, `"openclaw:beta"`)
- `model: "agent:<agentId>"` (alias)

Albo wskaż konkretny agent OpenClaw nagłówkiem:

- `x-openclaw-agent-id: <agentId>` (domyślnie: `main`)

Zaawansowane:

- `x-openclaw-session-key: <sessionKey>` do pełnej kontroli routingu sesji.

## Włączanie punktu końcowego

Ustaw `gateway.http.endpoints.responses.enabled` na `true`:

```json5
{
  gateway: {
    http: {
      endpoints: {
        responses: { enabled: true },
      },
    },
  },
}
```

## Wyłączanie punktu końcowego

Ustaw `gateway.http.endpoints.responses.enabled` na `false`:

```json5
{
  gateway: {
    http: {
      endpoints: {
        responses: { enabled: false },
      },
    },
  },
}
```

## Zachowanie sesji

Domyślnie punkt końcowy jest **bezstanowy dla każdego żądania** (dla każdego wywołania generowany jest nowy klucz sesji).

Jeśli żądanie zawiera ciąg OpenResponses `user`, Gateway wyprowadza z niego stabilny klucz sesji,
dzięki czemu powtarzane wywołania mogą współdzielić sesję agenta.

## Kształt żądania (obsługiwany)

Żądanie jest zgodne z API OpenResponses z wejściem opartym na elementach. Obecne wsparcie:

- `input`: string lub tablica obiektów elementów.
- `instructions`: scalane z promptem systemowym.
- `tools`: definicje narzędzi po stronie klienta (narzędzia funkcyjne).
- `tool_choice`: filtrowanie lub wymaganie narzędzi klienta.
- `stream`: włącza strumieniowanie SSE.
- `max_output_tokens`: limit wyjścia w trybie best-effort (zależny od dostawcy).
- `user`: stabilne routowanie sesji.

Akceptowane, ale **obecnie ignorowane**:

- `max_tool_calls`
- `reasoning`
- `metadata`
- `store`
- `previous_response_id`
- `truncation`

## Elementy (wejście)

### `message`

Role: `system`, `developer`, `user`, `assistant`.

- `system` oraz `developer` są dołączane do promptu systemowego.
- Najnowszy element `user` lub `function_call_output` staje się „bieżącą wiadomością”.
- Wcześniejsze wiadomości użytkownika/asystenta są dołączane jako historia dla kontekstu.

### `function_call_output` (narzędzia turowe)

Prześlij wyniki narzędzi z powrotem do modelu:

```json
{
  "type": "function_call_output",
  "call_id": "call_123",
  "output": "{\"temperature\": \"72F\"}"
}
```

### `reasoning` oraz `item_reference`

Akceptowane dla zgodności schematu, ale ignorowane podczas budowania promptu.

## Narzędzia (narzędzia funkcyjne po stronie klienta)

Dostarczaj narzędzia za pomocą `tools: [{ type: "function", function: { name, description?, parameters? } }]`.

Jeśli agent zdecyduje się wywołać narzędzie, odpowiedź zwraca element wyjściowy `function_call`.
Następnie wyślij kolejne żądanie z `function_call_output`, aby kontynuować turę.

## Obrazy (`input_image`)

Obsługuje źródła base64 lub URL:

```json
{
  "type": "input_image",
  "source": { "type": "url", "url": "https://example.com/image.png" }
}
```

Dozwolone typy MIME (obecnie): `image/jpeg`, `image/png`, `image/gif`, `image/webp`.
Maksymalny rozmiar (obecnie): 10MB.

## Pliki (`input_file`)

Obsługuje źródła base64 lub URL:

```json
{
  "type": "input_file",
  "source": {
    "type": "base64",
    "media_type": "text/plain",
    "data": "SGVsbG8gV29ybGQh",
    "filename": "hello.txt"
  }
}
```

Dozwolone typy MIME (obecnie): `text/plain`, `text/markdown`, `text/html`, `text/csv`,
`application/json`, `application/pdf`.

Maksymalny rozmiar (obecnie): 5MB.

Obecne zachowanie:

- Zawartość pliku jest dekodowana i dodawana do **promptu systemowego**, a nie do wiadomości użytkownika,
  dzięki czemu pozostaje efemeryczna (nie jest utrwalana w historii sesji).
- Pliki PDF są parsowane pod kątem tekstu. Jeśli znaleziono niewiele tekstu, pierwsze strony są rasteryzowane
  do obrazów i przekazywane do modelu.

Parsowanie PDF wykorzystuje przyjazną dla Node’a wersję legacy `pdfjs-dist` (bez workera). Nowoczesna
wersja PDF.js oczekuje workerów przeglądarki/globalnych DOM, więc nie jest używana w Gateway.

Domyślne ustawienia pobierania URL:

- `files.allowUrl`: `true`
- `images.allowUrl`: `true`
- Żądania są chronione (rozwiązywanie DNS, blokowanie prywatnych IP, limity przekierowań, timeouty).

## Limity plików i obrazów (konfiguracja)

Ustawienia domyślne można dostroić w `gateway.http.endpoints.responses`:

```json5
{
  gateway: {
    http: {
      endpoints: {
        responses: {
          enabled: true,
          maxBodyBytes: 20000000,
          files: {
            allowUrl: true,
            allowedMimes: [
              "text/plain",
              "text/markdown",
              "text/html",
              "text/csv",
              "application/json",
              "application/pdf",
            ],
            maxBytes: 5242880,
            maxChars: 200000,
            maxRedirects: 3,
            timeoutMs: 10000,
            pdf: {
              maxPages: 4,
              maxPixels: 4000000,
              minTextChars: 200,
            },
          },
          images: {
            allowUrl: true,
            allowedMimes: ["image/jpeg", "image/png", "image/gif", "image/webp"],
            maxBytes: 10485760,
            maxRedirects: 3,
            timeoutMs: 10000,
          },
        },
      },
    },
  },
}
```

Domyślne wartości, gdy pominięte:

- `maxBodyBytes`: 20MB
- `files.maxBytes`: 5MB
- `files.maxChars`: 200k
- `files.maxRedirects`: 3
- `files.timeoutMs`: 10s
- `files.pdf.maxPages`: 4
- `files.pdf.maxPixels`: 4,000,000
- `files.pdf.minTextChars`: 200
- `images.maxBytes`: 10MB
- `images.maxRedirects`: 3
- `images.timeoutMs`: 10s

## Strumieniowanie (SSE)

Ustaw `stream: true`, aby otrzymywać zdarzenia Server-Sent Events (SSE):

- `Content-Type: text/event-stream`
- Każda linia zdarzenia to `event: <type>` oraz `data: <json>`
- Strumień kończy się `data: [DONE]`

Obecnie emitowane typy zdarzeń:

- `response.created`
- `response.in_progress`
- `response.output_item.added`
- `response.content_part.added`
- `response.output_text.delta`
- `response.output_text.done`
- `response.content_part.done`
- `response.output_item.done`
- `response.completed`
- `response.failed` (w przypadku błędu)

## Użycie

`usage` jest wypełniane, gdy bazowy dostawca raportuje liczbę tokenów.

## Błędy

Błędy używają obiektu JSON w postaci:

```json
{ "error": { "message": "...", "type": "invalid_request_error" } }
```

Typowe przypadki:

- `401` brak/nieprawidłowe uwierzytelnianie
- `400` nieprawidłowe ciało żądania
- `405` niewłaściwa metoda

## Przykłady

Bez strumieniowania:

```bash
curl -sS http://127.0.0.1:18789/v1/responses \
  -H 'Authorization: Bearer YOUR_TOKEN' \
  -H 'Content-Type: application/json' \
  -H 'x-openclaw-agent-id: main' \
  -d '{
    "model": "openclaw",
    "input": "hi"
  }'
```

Strumieniowanie:

```bash
curl -N http://127.0.0.1:18789/v1/responses \
  -H 'Authorization: Bearer YOUR_TOKEN' \
  -H 'Content-Type: application/json' \
  -H 'x-openclaw-agent-id: main' \
  -d '{
    "model": "openclaw",
    "stream": true,
    "input": "hi"
  }'
```
