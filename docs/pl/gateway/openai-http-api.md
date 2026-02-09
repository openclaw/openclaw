---
summary: "Udostępnij zgodny z OpenAI punkt końcowy HTTP /v1/chat/completions z poziomu Gateway"
read_when:
  - Integracja narzędzi oczekujących OpenAI Chat Completions
title: "OpenAI Chat Completions"
---

# OpenAI Chat Completions (HTTP)

Gateway OpenClaw może udostępniać niewielki, zgodny z OpenAI punkt końcowy Chat Completions.

Ten punkt końcowy jest **domyślnie wyłączony**. Najpierw włącz go w konfiguracji.

- `POST /v1/chat/completions`
- Ten sam port co Gateway (multipleks WS + HTTP): `http://<gateway-host>:<port>/v1/chat/completions`

Pod spodem żądania są wykonywane jako zwykłe uruchomienie agenta Gateway (ta sama ścieżka kodu co `openclaw agent`), więc routing/uprawnienia/konfiguracja odpowiadają Twojemu Gateway.

## Uwierzytelnianie

Korzysta z konfiguracji uwierzytelniania Gateway. Wyślij token typu bearer:

- `Authorization: Bearer <token>`

Uwagi:

- Gdy `gateway.auth.mode="token"`, użyj `gateway.auth.token` (lub `OPENCLAW_GATEWAY_TOKEN`).
- Gdy `gateway.auth.mode="password"`, użyj `gateway.auth.password` (lub `OPENCLAW_GATEWAY_PASSWORD`).

## Wybór agenta

Nie są wymagane niestandardowe nagłówki: zakoduj identyfikator agenta w polu OpenAI `model`:

- `model: "openclaw:<agentId>"` (przykład: `"openclaw:main"`, `"openclaw:beta"`)
- `model: "agent:<agentId>"` (alias)

Albo wskaż konkretny agent OpenClaw za pomocą nagłówka:

- `x-openclaw-agent-id: <agentId>` (domyślnie: `main`)

Zaawansowane:

- `x-openclaw-session-key: <sessionKey>` w celu pełnej kontroli routingu sesji.

## Włączanie punktu końcowego

Ustaw `gateway.http.endpoints.chatCompletions.enabled` na `true`:

```json5
{
  gateway: {
    http: {
      endpoints: {
        chatCompletions: { enabled: true },
      },
    },
  },
}
```

## Wyłączanie punktu końcowego

Ustaw `gateway.http.endpoints.chatCompletions.enabled` na `false`:

```json5
{
  gateway: {
    http: {
      endpoints: {
        chatCompletions: { enabled: false },
      },
    },
  },
}
```

## Zachowanie sesji

Domyślnie punkt końcowy jest **bezstanowy dla każdego żądania** (dla każdego wywołania generowany jest nowy klucz sesji).

Jeśli żądanie zawiera ciąg OpenAI `user`, Gateway wyprowadza z niego stabilny klucz sesji, dzięki czemu powtarzane wywołania mogą współdzielić sesję agenta.

## Strumieniowanie (SSE)

Ustaw `stream: true`, aby otrzymywać zdarzenia Server-Sent Events (SSE):

- `Content-Type: text/event-stream`
- Każda linia zdarzenia to `data: <json>`
- Strumień kończy się `data: [DONE]`

## Przykłady

Bez strumieniowania:

```bash
curl -sS http://127.0.0.1:18789/v1/chat/completions \
  -H 'Authorization: Bearer YOUR_TOKEN' \
  -H 'Content-Type: application/json' \
  -H 'x-openclaw-agent-id: main' \
  -d '{
    "model": "openclaw",
    "messages": [{"role":"user","content":"hi"}]
  }'
```

Strumieniowanie:

```bash
curl -N http://127.0.0.1:18789/v1/chat/completions \
  -H 'Authorization: Bearer YOUR_TOKEN' \
  -H 'Content-Type: application/json' \
  -H 'x-openclaw-agent-id: main' \
  -d '{
    "model": "openclaw",
    "stream": true,
    "messages": [{"role":"user","content":"hi"}]
  }'
```
